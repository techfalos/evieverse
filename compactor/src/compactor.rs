//! The compactor as what makes passes: one at a time, under the lease, for as long as the
//! process is up.

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use anyhow::Result;
use evieverse_core::log::{self, Logger};
use serde_json::json;
use tokio::sync::watch;
use tokio::time::Instant;

use crate::deps::Deps;
use crate::lease::{Lease, is_stopped};
use crate::run::{Run, RunOptions, RunResult};

/// What tells a compactor to stop. A copy tells the same compactor, from wherever it is held:
/// the task that waits for the process's signals has one.
#[derive(Clone)]
pub struct Stopper {
    inner: Arc<Stopping>,
}

struct Stopping {
    stopped: watch::Sender<bool>,
    /// The lease of the run this process is making, if it is making one: what stops the run.
    current: Mutex<Option<Arc<Lease>>>,
}

impl Default for Stopper {
    fn default() -> Self {
        Self {
            inner: Arc::new(Stopping {
                stopped: watch::Sender::new(false),
                current: Mutex::new(None),
            }),
        }
    }
}

impl Stopper {
    fn current(&self) -> MutexGuard<'_, Option<Arc<Lease>>> {
        self.inner.current.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Has the compactor start no other run, and the one under way stop at its next step (see
    /// `Lease::stop`): it finishes the writes it is making, makes no more, and frees the lease.
    pub fn stop(&self) {
        self.inner.stopped.send_replace(true);
        if let Some(lease) = self.current().as_ref() {
            lease.stop();
        }
    }

    /// Whether the compactor was told to stop.
    pub fn is_stopped(&self) -> bool {
        *self.inner.stopped.borrow()
    }

    /// Returns once the compactor is told to stop.
    pub async fn stopped(&self) {
        let mut stopped = self.inner.stopped.subscribe();
        // The sender is this one's own, so it is there for as long as this waits.
        let _ = stopped.wait_for(|stopped| *stopped).await;
    }
}

/// Writes the feed index: it is the only thing that does. It is one process that runs for as
/// long as it is up (see `run_until_stopped`): pass after pass, never two at once, and never
/// more than one in `intervalSeconds`, which is therefore how long a write waits to reach
/// feeds.
///
/// Each tag has one index per UTC day, trimmed to a quota that halves with age down to a
/// floor, kept for `tagRetentionDays`. Each run rebuilds only the (tag, day) indexes that
/// changed: those of the content in the feed queue (`feed_queue`), where every write that
/// commits leaves a row for each index it changes the content's place in, new likes
/// (re-admitting liked content that was trimmed earlier), what tag moderators decided, and
/// content set for deletion; days whose quota shrank are re-trimmed. It then writes a new
/// manifest and swaps the head, once per tag however many writes the run took. Tags are
/// compacted many at a time (see `compact_batch`): what a run costs in round trips goes by
/// its batches, not by its tags, so a run that took a post from each of a thousand publishers
/// doesn't make a thousand of everything. It then deletes the queue's rows it took, deletes
/// content set for deletion that no day index holds any more, and deletes summaries past
/// retention (and with them, once a day, what is in users' inboxes for longer than
/// `inbox.retentionDays`). Each publisher's own index is compacted the same way, alongside
/// the hashtags of their content, but keeps each day's newest posts. Readers are never
/// blocked: a request under way keeps reading the keys it started with, which only expire a
/// minute after no node can still hold the head that named them.
///
/// It is also the only thing that writes posts and comments to the stores. A request commits
/// what it writes to the database and nothing else (`pending_writes`, src/pending.ts), and
/// each run starts by applying those writes (see `apply_pending`): a post's bytes, summary
/// and meta file, and a comment, its likes and its image or video. So one process writes them
/// all, each post and each comment as its newest write has it, and nothing is written to
/// content that is set for deletion, which the same run then deletes: no update, comment or
/// like can bring back what was deleted, or write over what a moderator removed.
///
/// An entry is never copied from what a write says: it is built from the database and the
/// content's meta file as they are when the run reads them. The queue is read before the
/// pending writes are applied, and a write commits its rows in the queue with the write
/// itself, so what a run reads of the content of a row it took is that write's, or a later
/// one's.
///
/// Should two compactor processes be up at once (a deploy replacing one, a rebuild started by
/// hand), their runs still never overlap: each holds a lease in the database (see `Lease`),
/// since a run that published its heads after a newer run would bring back what the newer run
/// deleted, and roll back its like counts.
///
/// It is also what applies moderation to the index, which feeds read instead of the
/// database. What a hashtag's moderators decided (`tag_moderation`) is applied by the next
/// run: content they approved is flagged as moderated in the hashtag's day index, and a
/// hashtag they removed is taken off the content (see `apply_decisions`). Every day index it
/// builds is built to those decisions, and without content that waits in the moderation
/// queue, so nothing it does for another reason (a like, a `--rebuild`) undoes them.
///
/// It is what makes a repost show (src/reposts.ts). A repost commits rows of `reposts`, which
/// say where it places the content, and rows in the feed queue for those indexes. The next
/// run writes the hashtags the repost added into the content's meta file and summary (see
/// `apply_reposts`), and builds the content's entry in each of those indexes at the time of
/// the repost. An update of the content that committed meanwhile is applied with them too.
///
/// And it is what makes a repost that a moderator removed go (DELETE
/// /content/:contentId/reposts/:userId). The removal deletes the repost's rows of `reposts`
/// and leaves one of `repost_removals` for each, and the next run takes the hashtags the
/// repost gave off the content's meta file and summary, and drops the entries it made (see
/// `apply_removals`).
///
/// A repost of a post on another server is hidden when that server says the post is gone, and
/// no index holds it while it is. A run brings it back where it was once the post is attested
/// again, and deletes it if it has been hidden for REPOSTS_GONE_DAYS (see `expire_gone`).
///
/// And it keeps each hashtag's related hashtags in Redis, where feeds asked to add them read
/// them: those of the hashtags whose counts in `tag_pairs` changed since its last run are
/// worked out again (see `sync_related_tags`).
///
/// And, where the server shows ads (MONETIZATION_FEED_ADS, MONETIZATION_POST_ADS), it
/// publishes the ones its admins keep to Redis, which is where feeds and posts read them (see
/// `sync_ads`): feeds read no database, so this is how an ad reaches them.
///
/// And it ends the time of a hashtag's moderators who did nothing as one for
/// TAG_MODERATOR_INACTIVE_DAYS (see `retire_moderators`).
///
/// A run that is killed leaves nothing that lasts: what it wrote for a hashtag expires unless
/// the hashtag's head was swapped, and what it hadn't finished is found again by the next run.
pub struct Compactor {
    deps: Deps,
    stopper: Stopper,
}

impl Compactor {
    /// The compactor of a database and its stores.
    pub fn new(deps: Deps) -> Self {
        Self {
            deps,
            stopper: Stopper::default(),
        }
    }

    /// What this compactor works with.
    pub fn deps(&self) -> &Deps {
        &self.deps
    }

    /// What tells this compactor to stop.
    pub fn stopper(&self) -> Stopper {
        self.stopper.clone()
    }

    /// One run. `all` rebuilds every day of every tag, and works out every hashtag's related
    /// hashtags again. `rebuild` also re-admits every content within retention from the
    /// database and the meta files, restoring summaries and publisher credits: run it after
    /// Redis lost data. Skipped while another run, in this process or any other, holds the
    /// lease.
    ///
    /// The lease is held until nothing of the run is under way: what a run does several of at
    /// once it waits for before it fails (see `map_limit`), so the run after it, here or
    /// anywhere, starts with no write of this one still to land. A run of a compactor that
    /// was told to stop makes no write, and fails with `LeaseLost::Stopped`.
    pub async fn run_once(&self, opts: RunOptions) -> Result<RunResult> {
        let Deps { db, config, now, log, .. } = &self.deps;
        let lease = Arc::new(Lease::new(db.clone(), config.compact.lease_seconds * 1000, now.clone()));
        if !lease.acquire().await? {
            log.info(json!({}), "another compactor run holds the lease; skipping this run");
            return Ok(RunResult {
                skipped: true,
                ..RunResult::default()
            });
        }
        *self.stopper.current() = Some(lease.clone());
        // After the lease is the one to stop: a stop told since then has stopped it already.
        if self.stopper.is_stopped() {
            lease.stop();
        }
        let outcome = Run::new(&self.deps, &lease, opts).run(opts).await;
        *self.stopper.current() = None;
        if let Err(err) = lease.release().await {
            log.error(json!({ "err": log::err(&err) }), "could not release the compactor lease; it expires on its own");
        }
        outcome
    }

    /// Runs for as long as the process is up, until stopped: a run starts `intervalSeconds`
    /// after the previous one started, or as soon as that one ends if it took longer. So runs
    /// never overlap, and there is never more than one in `intervalSeconds`.
    ///
    /// Stopping it (see `Stopper::stop`) starts no other run, and has the one under way stop
    /// at its next step: it finishes the writes it is making, makes no more, and frees the
    /// lease. This returns once that is done, so a process that waits for it before it exits
    /// leaves no write half made. What the run hadn't got to, the next run does: every step of
    /// a run can be made again.
    pub async fn run_until_stopped(&self) {
        let interval = Duration::from_secs(self.deps.config.compact.interval_seconds.unsigned_abs());
        pace(interval, &self.stopper, &self.deps.log, || async {
            self.run_once(RunOptions::default()).await.map(|_| ())
        })
        .await;
    }
}

/// Makes pass after pass until stopped: the first `interval` from now, and each of the others
/// `interval` after the one before it started, or as soon as that one ends if it took longer.
/// A pass that fails is logged, and the next is made all the same. Returns once it is stopped
/// and the pass under way, if there is one, has ended.
async fn pace<F, Fut>(interval: Duration, stopper: &Stopper, log: &Logger, pass: F)
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<()>>,
{
    let mut wait = interval;
    loop {
        tokio::select! {
            biased;
            () = stopper.stopped() => return,
            () = tokio::time::sleep(wait) => {}
        }
        let started = Instant::now();
        match pass().await {
            Ok(()) => {}
            Err(err) if is_stopped(&err) => log.info(json!({}), "the compactor was stopped during a run, which the next run makes again"),
            Err(err) => log.error(json!({ "err": log::err(&err) }), "compactor run failed"),
        }
        if stopper.is_stopped() {
            return;
        }
        wait = interval.saturating_sub(started.elapsed());
    }
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};

    use evieverse_core::log::Level;

    use super::*;

    /// The interval of the compactors of these tests.
    const INTERVAL: Duration = Duration::from_millis(5000);

    /// When a pass started and when it ended, in milliseconds since the compactor was started.
    type Pass = (u64, Option<u64>);

    /// What a compactor that is started does until `until` milliseconds have passed, when it
    /// is stopped: its passes take the times given, in order, and then no time, and the passes
    /// whose number is in `failing` fail. What its passes do is tested through the harness;
    /// here they only record when each started and ended. Returns the passes, and how long
    /// after it was started the compactor had stopped.
    async fn paced(durations: &[u64], failing: &[usize], until: u64) -> (Vec<Pass>, u64, Vec<(Level, String)>) {
        let stopper = Stopper::default();
        let (log, said) = Logger::collecting();
        let t0 = Instant::now();
        let since = || u64::try_from(t0.elapsed().as_millis()).unwrap();
        let passes: RefCell<Vec<Pass>> = RefCell::new(Vec::new());
        let made = Cell::new(0);
        let pass = || async {
            let number = made.replace(made.get() + 1);
            if failing.contains(&number) {
                anyhow::bail!("redis is unavailable");
            }
            let at = passes.borrow().len();
            passes.borrow_mut().push((since(), None));
            tokio::time::sleep(Duration::from_millis(durations.get(at).copied().unwrap_or(0))).await;
            passes.borrow_mut()[at].1 = Some(since());
            Ok(())
        };
        let stopping = async {
            tokio::time::sleep(Duration::from_millis(until)).await;
            stopper.stop();
        };
        tokio::join!(pace(INTERVAL, &stopper, &log, pass), stopping);
        let stopped = since();
        let said = said.take().into_iter().map(|entry| (entry.level, entry.msg)).collect();
        (passes.into_inner(), stopped, said)
    }

    #[tokio::test(start_paused = true)]
    async fn makes_pass_after_pass_for_as_long_as_it_is_up_one_every_interval() {
        let (passes, _, _) = paced(&[], &[], 26_000).await;
        assert_eq!(passes.iter().map(|pass| pass.0).collect::<Vec<_>>(), [5000, 10_000, 15_000, 20_000, 25_000]);
    }

    #[tokio::test(start_paused = true)]
    async fn never_makes_two_passes_at_once_nor_more_than_one_in_the_interval() {
        let (passes, _, _) = paced(&[12_000, 1000, 7000], &[], 40_000).await;
        assert_eq!(passes.len(), 6);
        for pair in passes.windows(2) {
            assert!(pair[1].0 >= pair[0].1.unwrap());
            assert!(pair[1].0 - pair[0].0 >= 5000);
        }
        assert_eq!(passes[0], (5000, Some(17_000)));
        // The first outlasted the interval, so the second followed as it ended.
        assert_eq!(passes[1].0, 17_000);
        // The second didn't, so the third waited the interval out.
        assert_eq!(passes[2].0, 22_000);
        assert_eq!(passes[3].0, passes[2].1.unwrap());
    }

    #[tokio::test(start_paused = true)]
    async fn carries_on_after_a_pass_that_fails() {
        let (passes, _, said) = paced(&[], &[0], 16_000).await;
        assert_eq!(passes.iter().map(|pass| pass.0).collect::<Vec<_>>(), [10_000, 15_000]);
        assert_eq!(said, [(Level::Error, "compactor run failed".to_owned())]);
    }

    #[tokio::test(start_paused = true)]
    async fn finishes_the_pass_it_is_making_when_it_is_stopped_and_starts_no_other() {
        let (passes, stopped, _) = paced(&[3000], &[], 6000).await;
        assert_eq!(passes, [(5000, Some(8000))]);
        assert_eq!(stopped, 8000);
    }

    #[tokio::test(start_paused = true)]
    async fn says_so_and_ends_when_a_pass_is_stopped_under_way() {
        let stopper = Stopper::default();
        let (log, said) = Logger::collecting();
        let pass = || async {
            stopper.stop();
            Err(crate::lease::LeaseLost::Stopped.into())
        };
        pace(INTERVAL, &stopper, &log, pass).await;
        let said: Vec<(Level, String)> = said.take().into_iter().map(|entry| (entry.level, entry.msg)).collect();
        assert_eq!(
            said,
            [(Level::Info, "the compactor was stopped during a run, which the next run makes again".to_owned())]
        );
    }
}
