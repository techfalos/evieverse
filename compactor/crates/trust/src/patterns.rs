//! Where blocked patterns run.
//!
//! A pattern is a regular expression an admin or a moderator wrote, and it was accepted as a
//! JavaScript one (flags `iu`: whatever its case, and by code point). So it runs in a
//! JavaScript engine's regular expressions: QuickJS, which takes every pattern the API ever
//! stored as what it was written to be (look-behind, back-references, Unicode properties).
//!
//! Some patterns take longer to say no than a server stays up (`(a+)+$`, of a row of a's that
//! ends otherwise), and nothing stops a pattern that is run as it is. QuickJS asks, as it
//! matches, whether to go on: the answer is no once the time the run was given is over, and
//! the run ends there, whatever the pattern was doing.
//!
//! The engine belongs to one thread, so it has a thread of its own, started when the first
//! pattern is run, which runs one list's patterns at a time: whoever asks waits for its turn
//! and its answer. The time a run is given starts when its turn does.

use std::cell::Cell;
use std::rc::Rc;
use std::sync::mpsc::{Receiver, Sender, SyncSender, channel, sync_channel};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result, anyhow};
use rquickjs::{Context, Ctx, Function, Runtime};

/// How long the patterns of one list get to read one post.
pub const PATTERN_BUDGET: Duration = Duration::from_millis(100);

/// The most memory the engine takes: far more than patterns of a hundred characters need,
/// and little enough that one that grew without end would stop long before it mattered.
const MEMORY_LIMIT: usize = 64 * 1024 * 1024;

/// The stack of the engine's thread: several times what the engine lets itself use of it, so
/// a pattern nested deep ends as an error of the engine's and never as the thread's.
const THREAD_STACK: usize = 8 * 1024 * 1024;

/// What the engine is given to work with. `__run` tries each pattern on each text, in order,
/// and answers the first that matches, or -1; `__at` is the pattern it is at, so the one it
/// was stopped on if its time ran out. A pattern is compiled once, and kept for the next run.
const SCRIPT: &str = r"
(() => {
  const FLAGS = 'iu';
  const compiled = new Map();
  const regexp = (source) => {
    let re = compiled.get(source);
    if (re === undefined) {
      if (compiled.size >= 4000) compiled.clear();
      re = new RegExp(source, FLAGS);
      compiled.set(source, re);
    }
    return re;
  };
  let at = 0;
  globalThis.__syntax = (source) => { new RegExp(source, FLAGS); };
  globalThis.__empty = (source) => new RegExp(source, FLAGS).test('');
  globalThis.__run = (sources, texts) => {
    for (at = 0; at < sources.length; at++) {
      const re = regexp(sources[at]);
      for (const text of texts) if (re.test(text)) return at;
    }
    return -1;
  };
  globalThis.__at = () => at;
})();
";

/// What a run of patterns came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ran {
    /// Whether one of the patterns matched one of the texts.
    pub hit: bool,
    /// The pattern the time ran out on, by its place, if it did.
    pub slow: Option<usize>,
}

/// What the engine's thread is asked, with where its answer goes.
enum Job {
    Syntax(String, SyncSender<Result<(), String>>),
    Empty(String, SyncSender<Result<bool, String>>),
    Run(Vec<String>, Vec<String>, Duration, SyncSender<Result<Ran>>),
}

/// The engine. The context is dropped before the runtime it lives in.
struct Engine {
    context: Context,
    _runtime: Runtime,
    /// When the run under way is over: what the engine's question is answered by.
    deadline: Rc<Cell<Option<Instant>>>,
}

impl Engine {
    fn new() -> Result<Self> {
        let runtime = Runtime::new().map_err(|err| anyhow!("the engine blocked patterns run in could not be made: {err}"))?;
        runtime.set_memory_limit(MEMORY_LIMIT);
        let deadline = Rc::new(Cell::new(None::<Instant>));
        let until = deadline.clone();
        runtime.set_interrupt_handler(Some(Box::new(move || until.get().is_some_and(|deadline| Instant::now() >= deadline))));
        let context = Context::full(&runtime).map_err(|err| anyhow!("the engine blocked patterns run in could not be made: {err}"))?;
        context
            .with(|ctx| ctx.eval::<(), _>(SCRIPT))
            .map_err(|err| anyhow!("the engine blocked patterns run in could not be set up: {err}"))?;
        Ok(Self {
            context,
            _runtime: runtime,
            deadline,
        })
    }

    /// Whether the run under way is out of time.
    fn out_of_time(&self) -> bool {
        self.deadline.get().is_some_and(|deadline| Instant::now() >= deadline)
    }

    /// Does `work` given `budget` of time from now.
    fn timed<T>(&self, budget: Duration, work: impl FnOnce() -> T) -> T {
        self.deadline.set(Some(Instant::now() + budget));
        let done = work();
        self.deadline.set(None);
        done
    }

    fn syntax(&self, source: &str) -> Result<(), String> {
        self.timed(PATTERN_BUDGET, || {
            self.context.with(|ctx| {
                let check: Function = ctx.globals().get("__syntax").map_err(|err| err.to_string())?;
                check.call::<_, ()>((source,)).map_err(|_| thrown(&ctx))
            })
        })
    }

    fn empty(&self, source: &str) -> Result<bool, String> {
        self.timed(PATTERN_BUDGET, || {
            self.context.with(|ctx| {
                let check: Function = ctx.globals().get("__empty").map_err(|err| err.to_string())?;
                check.call::<_, bool>((source,)).map_err(|_| {
                    let said = thrown(&ctx);
                    if self.out_of_time() {
                        "it took too long to read nothing".to_owned()
                    } else {
                        said
                    }
                })
            })
        })
    }

    fn run(&self, sources: Vec<String>, texts: Vec<String>, budget: Duration) -> Result<Ran> {
        let count = sources.len();
        self.timed(budget, || {
            self.context.with(|ctx| {
                let run: Function = ctx.globals().get("__run")?;
                match run.call::<_, i32>((sources, texts)) {
                    Ok(at) => Ok(Ran { hit: at >= 0, slow: None }),
                    Err(_) if self.out_of_time() => {
                        // What it threw is taken, so the engine is as it was for the next run,
                        // and its time is over, so asking where it was isn't stopped too.
                        let _ = ctx.catch();
                        self.deadline.set(None);
                        let at: Function = ctx.globals().get("__at")?;
                        let slow = usize::try_from(at.call::<_, i32>(())?).unwrap_or(0).min(count.saturating_sub(1));
                        Ok(Ran { hit: false, slow: Some(slow) })
                    }
                    Err(_) => Err(anyhow!("a blocked pattern could not be run: {}", thrown(&ctx))),
                }
            })
        })
    }
}

/// What the engine threw, in its own words.
fn thrown(ctx: &Ctx<'_>) -> String {
    let value = ctx.catch();
    value
        .as_exception()
        .and_then(|exception| exception.message())
        .unwrap_or_else(|| format!("{value:?}"))
}

/// The engine's thread: answers what it is asked, one at a time, for as long as anyone asks.
fn serve(jobs: Receiver<Job>) {
    let mut engine: Option<Engine> = None;
    for job in jobs {
        if engine.is_none() {
            engine = Engine::new().ok();
        }
        let Some(ready) = &engine else {
            let failed = || "the engine blocked patterns run in could not be made".to_owned();
            // Whoever asked may have stopped waiting, which is theirs to do.
            match job {
                Job::Syntax(_, answer) => drop(answer.send(Err(failed()))),
                Job::Empty(_, answer) => drop(answer.send(Err(failed()))),
                Job::Run(_, _, _, answer) => drop(answer.send(Err(anyhow!(failed())))),
            }
            continue;
        };
        match job {
            Job::Syntax(source, answer) => drop(answer.send(ready.syntax(&source))),
            Job::Empty(source, answer) => drop(answer.send(ready.empty(&source))),
            Job::Run(sources, texts, budget, answer) => drop(answer.send(ready.run(sources, texts, budget))),
        }
    }
}

/// Where the engine's thread is asked. A thread that ended (it never does, unless the engine
/// broke it) is started again by whoever asks next.
static JOBS: OnceLock<Mutex<Option<Sender<Job>>>> = OnceLock::new();

/// Asks the engine's thread, and waits for its answer.
fn ask<T>(job: impl Fn(SyncSender<T>) -> Job) -> Result<T> {
    let jobs = JOBS.get_or_init(|| Mutex::new(None));
    // Twice: once more if the thread had ended, with one started anew.
    for _ in 0..2 {
        let (answer, answered) = sync_channel(1);
        {
            let mut sender = jobs.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if sender.is_none() {
                let (send, receive) = channel();
                std::thread::Builder::new()
                    .name("blocked-patterns".to_owned())
                    .stack_size(THREAD_STACK)
                    .spawn(move || serve(receive))
                    .context("the thread blocked patterns run in could not be started")?;
                *sender = Some(send);
            }
            if sender.as_ref().expect("set above").send(job(answer)).is_err() {
                *sender = None;
                continue;
            }
        }
        match answered.recv() {
            Ok(done) => return Ok(done),
            Err(_) => *jobs.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None,
        }
    }
    Err(anyhow!("the engine blocked patterns run in stopped"))
}

/// Whether `source` is a regular expression, as the engine reads one with the flags patterns
/// run with. What isn't comes with the engine's reason.
pub fn syntax(source: &str) -> Result<(), String> {
    ask(|answer| Job::Syntax(source.to_owned(), answer)).unwrap_or_else(|err| Err(err.to_string()))
}

/// Whether the regular expression `source` matches empty text, as it would then match every
/// post. What isn't a regular expression, or doesn't answer in time, comes with the reason.
pub fn matches_empty(source: &str) -> Result<bool, String> {
    ask(|answer| Job::Empty(source.to_owned(), answer)).unwrap_or_else(|err| Err(err.to_string()))
}

/// Whether one of the regular expressions `sources` matches one of `texts`, each tried on
/// each in order, given `budget` of time for all of it. Fails for a source that is no regular
/// expression: one that is run was stored as one.
pub fn run(sources: &[String], texts: &[String], budget: Duration) -> Result<Ran> {
    if sources.is_empty() || texts.is_empty() {
        return Ok(Ran { hit: false, slow: None });
    }
    ask(|answer| Job::Run(sources.to_vec(), texts.to_vec(), budget, answer))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn reads_patterns_as_javascript_does() {
        assert_eq!(syntax(r"(?<!\w)free(?!\w)"), Ok(()));
        assert_eq!(syntax(r"(?<c>[a-z])\k<c>"), Ok(()));
        assert_eq!(syntax(r"\p{Script=Han}{2,}"), Ok(()));
        for broken in ["(", "[a-", "a{2,1}", r"\a", "a{", "}", r"\p{Nope}", r"\u{110000}"] {
            assert!(syntax(broken).is_err(), "{broken}");
        }
        assert_eq!(matches_empty("a*"), Ok(true));
        assert_eq!(matches_empty("(spam)?"), Ok(true));
        assert_eq!(matches_empty("spam"), Ok(false));
        assert!(matches_empty("(").is_err());
    }

    #[test]
    fn finds_the_first_pattern_that_matches_whatever_its_case() {
        let texts = strings(&["the lazy dog", "Buy   NOW!"]);
        assert_eq!(
            run(&strings(&["quick", r"buy\s+now"]), &texts, PATTERN_BUDGET).unwrap(),
            Ran { hit: true, slow: None }
        );
        assert_eq!(
            run(&strings(&["quick", "cat$"]), &texts, PATTERN_BUDGET).unwrap(),
            Ran { hit: false, slow: None }
        );
        assert_eq!(run(&[], &texts, PATTERN_BUDGET).unwrap(), Ran { hit: false, slow: None });
        assert!(run(&strings(&["("]), &texts, PATTERN_BUDGET).is_err());
    }

    #[test]
    fn stops_a_pattern_that_outruns_its_time_and_says_which() {
        let texts = vec![format!("{}b", "a".repeat(40))];
        let start = Instant::now();
        let ran = run(&strings(&["quick", "(a+)+$", "lazy"]), &texts, PATTERN_BUDGET).unwrap();
        let took = start.elapsed();
        assert_eq!(ran, Ran { hit: false, slow: Some(1) });
        assert!(took >= PATTERN_BUDGET, "{took:?}");
        // The engine answers the next run as if nothing had happened.
        assert_eq!(run(&strings(&["a+b"]), &texts, PATTERN_BUDGET).unwrap(), Ran { hit: true, slow: None });
    }

    #[test]
    fn answers_whichever_thread_asks() {
        let asked: Vec<_> = (0..4)
            .map(|n| std::thread::spawn(move || run(&[format!("thread {n}")], &[format!("from thread {n}")], PATTERN_BUDGET).unwrap().hit))
            .collect();
        assert!(asked.into_iter().all(|thread| thread.join().unwrap()));
    }
}
