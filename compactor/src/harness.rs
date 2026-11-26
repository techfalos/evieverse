//! The compactor as a test drives it (`compactor harness`): what the API's tests run in place
//! of a compactor that is up, one for each test's database and stores (test/harness.ts).
//!
//! It reads the settings as any compactor does, and then takes commands from its standard
//! input, a line of JSON each, and answers each on its standard output, a line of JSON each:
//!
//!   {"id": 1, "now": 1794052800000, "cmd": "run", "rebuild": true}
//!   {"id": 1, "ok": {"tags": ["news"], "deleted": [], "skipped": false}}
//!
//! `now` is the time by the test's clock, which is the clock everything here tells the time
//! by: it stands where the last line the test sent put it, for whatever is under way. Commands
//! are made side by side, as the test sends them, so a test can have two runs under way. A
//! command that fails is answered with `error`, the failure's message.
//!
//! The commands:
//!   - `run` (`all`, `rebuild`): one pass, as `Compactor::run_once` makes it;
//!   - `apply`: what a pass starts with and nothing else of it (see `apply_pending`), under
//!     the lease: false, with nothing applied, if a run holds it;
//!   - `start` and `stop`: a compactor that makes pass after pass (`run_until_stopped`), and
//!     its end;
//!   - `watch` (`ops`): which calls to the stores the test is shown, in place of the ones it
//!     was shown before (see below);
//!   - `linkMs` (`ms`): has the content store say its links last this long;
//!   - `logs`: what was logged since this was last asked;
//!   - `sweep`: one look of the origin sweep (see `OriginSweep::sweep`), with no pause between
//!     two servers: how many entries were due;
//!   - `video` (`ffmpegPath`): has the video worker take one job (`VideoWorker::run_once`):
//!     whether one waited. `videoCheck` (`ffmpegPath`): what a process that starts the worker
//!     checks first, which fails where it has no ffmpeg;
//!   - `authorIndex`: what a process that runs the compactor does of users' indexes of their
//!     comments as it starts (see `author_index`);
//!   - `reindex`: what `compactor reindex` does: `result`, and `progress`, what it said of
//!     where it was after each step.
//!
//! A call the test watches (see `evieverse_core::probe`) is shown to it before it is made,
//!   {"probe": 7, "when": "before", "op": "hot.setMany", "args": {"keys": ["head:news"]}}
//! and waits for the test's answer, `{"reply": 7}`: with `fail`, the call fails with that
//! message, and is not made; with `mask`, a call that says which of its keys are there says
//! so only of the ones the mask keeps; with `after`, the call is shown again once it is made
//! (`"when": "after"`), and returns once that is answered, failing with `fail` if it is given.
//!
//! What this process would ask another server, it asks the test:
//!   {"fetch": 8, "kind": "keys", "address": "https://other.example/keys"}
//! (`kind` is `keys` or `attestation`), which answers `{"reply": 8, "answer": ...}` with what
//! that server would have: its keys, or `{status, body}` for an attestation; or with `fail`.
//!
//! The trust plugins are the ones the settings turn on, or the ones the test describes, in
//! EVIEVERSE_HARNESS_PLUGINS, as it describes them to the API's addon (`{testPlugins,
//! onlyTestPlugins}`).
//!
//! The process ends when its input does. It is in no build that serves (the feature `harness`).

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::rc::Rc;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError, RwLock};

use anyhow::{Context, Result, anyhow, bail};
use evieverse_core::config;
use evieverse_core::log::{Entry, Logger, Sink};
use evieverse_core::origin_keys::KeyFetcher;
use evieverse_core::probe::{Probe, Probes, Watched};
use evieverse_core::public_fetch::Answer as Fetched;
use evieverse_core::time::{Clock, system_now};
use evieverse_trust::plugins::pdq::list::KnownHashes;
use evieverse_trust::trust::Plugins;
use futures::future::BoxFuture;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::apply::apply_pending;
use crate::author_index;
use crate::compactor::{Compactor, Stopper};
use crate::deps::Deps;
use crate::lease::Lease;
use crate::reindex::reindex;
use crate::rows::Places;
use crate::run::RunOptions;
use crate::sweep::{AttestationFetcher, OriginSweep};
use crate::video::ffmpeg::Tools;
use crate::video::worker::VideoWorker;
use crate::workers;

/// With this set in the harness's environment, what it logs is also written to its standard
/// error, which is the test's: for whoever is finding out why a test fails.
const LOG_ALOUD: &str = "EVIEVERSE_HARNESS_LOG";

/// Where the test describes the trust plugins this process scores with, as JSON (see the top
/// of this file).
const PLUGINS: &str = "EVIEVERSE_HARNESS_PLUGINS";

/// How long a compactor the test left up has to end its pass, once the test is over.
const END_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

/// A line the test sent: a command, or its answer to a call it was shown.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Message {
    /// The time by the test's clock as it sent the line.
    now: Option<i64>,
    /// A command's number, which its answer has.
    id: Option<u64>,
    cmd: Option<String>,
    #[serde(default)]
    all: bool,
    #[serde(default)]
    rebuild: bool,
    #[serde(default)]
    ops: Vec<String>,
    ms: Option<i64>,
    /// Where the ffmpeg of a `video` or a `videoCheck` is, in place of the settings'.
    ffmpeg_path: Option<String>,
    /// The number of the call this answers.
    reply: Option<u64>,
    fail: Option<String>,
    #[serde(default)]
    after: bool,
    mask: Option<Vec<bool>>,
    /// What another server would have answered what the test was asked for it.
    answer: Option<Value>,
}

/// What the test answered a call it was shown with, or what it was asked for another server.
struct Answer {
    fail: Option<String>,
    after: bool,
    mask: Option<Vec<bool>>,
    answer: Option<Value>,
}

/// What the test describes of the trust plugins (see PLUGINS).
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Described {
    #[serde(default)]
    test_plugins: Vec<Value>,
    #[serde(default)]
    only_test_plugins: bool,
}

/// Writes a line to the test. One write for the line, so two tasks' lines never mix.
fn say(line: &Value) {
    let mut text = line.to_string();
    text.push('\n');
    let mut out = std::io::stdout().lock();
    // A test that is gone is nobody's to tell: the input ends next, and the process with it.
    let _ = out.write_all(text.as_bytes()).and_then(|()| out.flush());
}

/// Shows the test the calls it watches, and waits for what it says of each.
#[derive(Default)]
struct Wire {
    watched: RwLock<HashSet<String>>,
    /// The calls that wait for the test's answer, by their number.
    waiting: Mutex<HashMap<u64, oneshot::Sender<Answer>>>,
    next: AtomicU64,
}

impl Wire {
    fn watch(&self, ops: Vec<String>) {
        *self.watched.write().unwrap_or_else(PoisonError::into_inner) = ops.into_iter().collect();
    }

    /// Gives the call that waits for it the test's answer.
    fn answer(&self, call: u64, answer: Answer) {
        let waiting = self.waiting.lock().unwrap_or_else(PoisonError::into_inner).remove(&call);
        if let Some(waiting) = waiting {
            let _ = waiting.send(answer);
        }
    }

    /// Fails every call that waits for the test, which is over.
    fn end(&self) {
        self.waiting.lock().unwrap_or_else(PoisonError::into_inner).clear();
    }

    /// Sends the test a line that it answers, by the number this gives the line, and returns
    /// what it answers. Fails as the test says to.
    async fn asked(&self, what: &str, line: impl FnOnce(u64) -> Value) -> Result<Answer> {
        let call = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (answered, answer) = oneshot::channel();
        self.waiting.lock().unwrap_or_else(PoisonError::into_inner).insert(call, answered);
        say(&line(call));
        let answer = answer.await.map_err(|_| anyhow!("the test ended while {what} waited for it"))?;
        match answer.fail {
            Some(message) => bail!("{message}"),
            None => Ok(answer),
        }
    }

    /// Shows the test a call, and returns what it answers. Fails as the test says to.
    async fn ask(&self, when: &str, op: &str, args: Value) -> Result<Answer> {
        self.asked(
            &format!("a call to {op}"),
            |call| json!({ "probe": call, "when": when, "op": op, "args": args }),
        )
        .await
    }

    /// Asks the test what another server would answer: its keys, or the attestation of a post.
    async fn fetch(&self, kind: &str, address: &str) -> Result<Value> {
        let answer = self
            .asked(
                &format!("a request to {address}"),
                |call| json!({ "fetch": call, "kind": kind, "address": address }),
            )
            .await?;
        Ok(answer.answer.unwrap_or(Value::Null))
    }
}

impl Probe for Wire {
    fn watches(&self, op: &str) -> bool {
        self.watched.read().unwrap_or_else(PoisonError::into_inner).contains(op)
    }

    fn before<'a>(&'a self, op: &'static str, args: Value) -> BoxFuture<'a, Result<Watched>> {
        Box::pin(async move {
            let answer = self.ask("before", op, args).await?;
            Ok(Watched {
                after: answer.after,
                mask: answer.mask,
            })
        })
    }

    fn after<'a>(&'a self, op: &'static str, args: Value) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move { self.ask("after", op, args).await.map(|_| ()) })
    }
}

/// What the harness logs: kept for the test to ask for, and said aloud where LOG_ALOUD is set.
struct Said {
    entries: Mutex<Vec<Entry>>,
    aloud: bool,
}

impl Said {
    /// An entry as the test reads it: its level by name, what it is about, and the message.
    fn shown(entry: &Entry) -> Value {
        json!({ "level": entry.level.name(), "fields": entry.fields, "msg": entry.msg })
    }

    /// What was logged since this was last asked.
    fn take(&self) -> Vec<Value> {
        std::mem::take(&mut *self.entries.lock().unwrap_or_else(PoisonError::into_inner))
            .iter()
            .map(Self::shown)
            .collect()
    }
}

impl Sink for Said {
    fn write(&self, entry: Entry) {
        if self.aloud {
            eprintln!("compactor: {}", Self::shown(&entry));
        }
        self.entries.lock().unwrap_or_else(PoisonError::into_inner).push(entry);
    }
}

/// A compactor that makes pass after pass, and what ends it.
type Looping = (Stopper, JoinHandle<()>);

/// What the commands work with.
struct Harness {
    deps: Deps,
    /// The compactor a `start` started, until a `stop` ends it.
    looping: RefCell<Option<Looping>>,
    /// The trust plugins, and the list the pdq plugin among them shares with the video worker.
    plugins: Arc<Plugins>,
    hashes: Arc<KnownHashes>,
    wire: Arc<Wire>,
    /// The origin sweep, from the first `sweep` on: it remembers which servers gave no answer.
    sweep: tokio::sync::OnceCell<OriginSweep>,
}

impl Harness {
    /// Makes a command, and returns what it is answered with.
    async fn command(&self, cmd: &str, message: &Message) -> Result<Value> {
        match cmd {
            "run" => {
                let opts = RunOptions {
                    all: message.all,
                    rebuild: message.rebuild,
                };
                let result = Compactor::new(self.deps.clone()).run_once(opts).await?;
                Ok(serde_json::to_value(result)?)
            }
            "apply" => {
                let Deps { db, config, now, .. } = &self.deps;
                let lease = Lease::new(db.clone(), config.compact.lease_seconds * 1000, now.clone());
                if !lease.acquire().await? {
                    return Ok(json!(false));
                }
                let applied = apply_pending(&self.deps, &lease, &Places::new(db.clone())).await;
                lease.release().await?;
                applied?;
                Ok(json!(true))
            }
            "start" => {
                self.stop().await?;
                let compactor = Compactor::new(self.deps.clone());
                let stopper = compactor.stopper();
                let passes = tokio::task::spawn_local(async move { compactor.run_until_stopped().await });
                *self.looping.borrow_mut() = Some((stopper, passes));
                Ok(Value::Null)
            }
            "stop" => {
                self.stop().await?;
                Ok(Value::Null)
            }
            "sweep" => {
                let sweep = self.sweep.get_or_try_init(|| async { self.origin_sweep() }).await?;
                Ok(json!(sweep.sweep(&Stopper::default()).await?))
            }
            "video" => Ok(json!(self.video_worker(message).run_once(&Stopper::default()).await?)),
            "videoCheck" => {
                self.video_worker(message).check().await?;
                Ok(Value::Null)
            }
            "authorIndex" => {
                author_index::index_authors(&self.deps, &Stopper::default()).await?;
                Ok(Value::Null)
            }
            "reindex" => {
                let progress = RefCell::new(vec![]);
                let result = reindex(&self.deps, &|so_far| progress.borrow_mut().push(so_far)).await?;
                Ok(json!({ "result": result, "progress": progress.into_inner() }))
            }
            other => bail!("the harness has no command \"{other}\""),
        }
    }

    /// The origin sweep, asking the test in place of other servers, with no pause between two.
    fn origin_sweep(&self) -> Result<OriginSweep> {
        let asking = |kind: &'static str| {
            let wire = self.wire.clone();
            move |address: String| -> BoxFuture<'static, Result<Value>> {
                let wire = wire.clone();
                Box::pin(async move { wire.fetch(kind, &address).await })
            }
        };
        let keys: KeyFetcher = Arc::new(asking("keys"));
        let attestations = asking("attestation");
        let fetcher: AttestationFetcher = Arc::new(move |address| {
            let answered = attestations(address);
            Box::pin(async move {
                let answer = answered.await?;
                let status = answer.get("status").and_then(Value::as_u64).and_then(|status| u16::try_from(status).ok());
                Ok(Fetched {
                    status: status.context("the test answered a request for an attestation with no status")?,
                    body: answer.get("body").cloned().unwrap_or(Value::Null),
                })
            })
        });
        OriginSweep::new(
            self.deps.clone(),
            self.plugins.clone(),
            Some(fetcher),
            Some(keys),
            Some(std::time::Duration::ZERO),
        )
    }

    /// The video worker, with the ffmpeg the command names in place of the settings', if it
    /// names one.
    fn video_worker(&self, message: &Message) -> VideoWorker {
        let worker = VideoWorker::new(self.deps.clone(), self.hashes.clone());
        match &message.ffmpeg_path {
            Some(ffmpeg) => worker.with_tools(Tools {
                ffmpeg: ffmpeg.clone(),
                ffprobe: self.deps.config.video.ffprobe_path.clone(),
            }),
            None => worker,
        }
    }

    /// Stops the compactor a `start` started, if one is up, and returns once its pass has ended.
    async fn stop(&self) -> Result<()> {
        let looping = self.looping.borrow_mut().take();
        if let Some((stopper, passes)) = looping {
            stopper.stop();
            passes.await.context("the compactor's passes ended badly")?;
        }
        Ok(())
    }
}

/// Answers a command: with what it came to, or with its failure's message.
fn answer(id: u64, outcome: Result<Value>) {
    match outcome {
        Ok(ok) => say(&json!({ "id": id, "ok": ok })),
        Err(err) => say(&json!({ "id": id, "error": format!("{err:#}") })),
    }
}

/// Takes the test's commands until its input ends. To be run on a `LocalSet`: the commands
/// are made on the thread that reads them, as a pass is made on one task.
pub async fn serve() -> Result<()> {
    let config = config::load()?;
    let at = Arc::new(AtomicI64::new(system_now()));
    let clock: Clock = {
        let at = at.clone();
        Arc::new(move || at.load(Ordering::SeqCst))
    };
    let wire = Arc::new(Wire::default());
    let said = Arc::new(Said {
        entries: Mutex::new(vec![]),
        aloud: std::env::var(LOG_ALOUD).is_ok_and(|value| !value.is_empty()),
    });
    let deps = Deps::open_probed(config, clock, Logger::to(said.clone()), Probes::new(wire.clone())).await?;
    // The test's own process brought the schema up to date before it started this one.
    deps.db.wait_for_schema(|| {}).await;
    let described: Described = match std::env::var(PLUGINS) {
        Ok(json) if !json.is_empty() => serde_json::from_str(&json).context("the harness was given trust plugins it cannot read")?,
        _ => Described::default(),
    };
    let trust = if described.only_test_plugins {
        workers::Trust::none()
    } else {
        workers::Trust::load(&deps.config)?
    };
    let tested = described
        .test_plugins
        .into_iter()
        .map(serde_json::from_value)
        .collect::<Result<Vec<_>, _>>()
        .context("a test plugin is described wrongly")?;
    // What they are shown is the test's to read of the API's own, which scores what requests send.
    let plugins = trust
        .plugins
        .and(evieverse_trust::testing::plugins(tested, &evieverse_trust::testing::Seen::default()));
    let harness = Rc::new(Harness {
        deps,
        looping: RefCell::new(None),
        plugins: Arc::new(plugins),
        hashes: trust.hashes,
        wire: wire.clone(),
        sweep: tokio::sync::OnceCell::new(),
    });
    say(&json!({ "ready": true }));

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await.context("the harness could not read its input")? {
        if line.trim().is_empty() {
            continue;
        }
        let message: Message = serde_json::from_str(&line).with_context(|| format!("the harness was sent a line that is no message: {line}"))?;
        if let Some(now) = message.now {
            at.store(now, Ordering::SeqCst);
        }
        if let Some(call) = message.reply {
            wire.answer(
                call,
                Answer {
                    fail: message.fail,
                    after: message.after,
                    mask: message.mask,
                    answer: message.answer,
                },
            );
            continue;
        }
        let (Some(id), Some(cmd)) = (message.id, message.cmd.clone()) else {
            bail!("the harness was sent a line that is neither a command nor an answer: {line}");
        };
        // What says how the commands after it are made is done here, in the order it was sent in.
        match cmd.as_str() {
            "watch" => {
                wire.watch(message.ops);
                answer(id, Ok(Value::Null));
            }
            "linkMs" => {
                harness.deps.content.set_link_ms(message.ms.unwrap_or(0));
                answer(id, Ok(Value::Null));
            }
            "logs" => answer(id, Ok(Value::Array(said.take()))),
            _ => {
                let harness = harness.clone();
                tokio::task::spawn_local(async move { answer(id, harness.command(&cmd, &message).await) });
            }
        }
    }
    // The test is over: no call waits for it any longer. A compactor it left up is ended as a process's is, and what
    // else is under way ends with the process.
    wire.end();
    let _ = tokio::time::timeout(END_WAIT, harness.stop()).await;
    Ok(())
}
