//! The lease that keeps compactor runs from overlapping, across processes and machines.

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use anyhow::Result;
use evieverse_core::db::Db;
use evieverse_core::params;
use evieverse_core::time::Clock;
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use uuid::Uuid;

/// The id of the one row of `compactor_lease`, which the first migration inserts: every
/// compactor run takes, renews and frees the lease on it.
const LEASE_ID: &str = "compactor";

/// What `check` refuses a run with. To the run both are a lease that is lost: it writes
/// nothing more, and whatever passes one on passes the other on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum LeaseLost {
    /// Another run took the lease.
    #[error("another compactor run took over the lease; this run stopped before writing anything more")]
    Taken,
    /// The run was told to stop (see `Lease::stop`).
    #[error("the compactor was told to stop; this run stopped before writing anything more")]
    Stopped,
}

/// Whether an error is that of a run that may write nothing more: its lease is lost, or it
/// was told to stop. Whatever logs a failure and goes on passes this on instead.
pub fn is_lease_lost(err: &anyhow::Error) -> bool {
    err.downcast_ref::<LeaseLost>().is_some()
}

/// Whether an error is that of a run that was told to stop.
pub fn is_stopped(err: &anyhow::Error) -> bool {
    err.downcast_ref::<LeaseLost>() == Some(&LeaseLost::Stopped)
}

/// What a lease knows of itself.
struct State {
    /// When it was last renewed, by the run's clock; none before it is taken.
    renewed_at: Option<i64>,
    lost: bool,
    stopped: bool,
    /// How many renewals have ended, and what the last one failed with, if it did: what those
    /// who waited for it are told.
    renewals: u64,
    failure: Option<String>,
}

struct Inner {
    db: Db,
    ttl_ms: i64,
    now: Clock,
    holder: String,
    state: Mutex<State>,
    /// Held by the renewal under way.
    renewing: tokio::sync::Mutex<()>,
    /// Tells the renewals made on time that the lease is released.
    released: Notify,
}

/// Keeps compactor runs from overlapping, across processes and machines. A run takes the
/// lease row in the database, or skips if a live run holds it, and calls `check` before every
/// write to the stores, and before every write that publishes a head or deletes something.
///
/// The lease is renewed in two ways. For as long as it is held, a task renews it every third
/// of its lifetime, whatever the run is doing: a write that takes longer than the lifetime
/// doesn't let the lease lapse under it, as long as the process is alive and reaches the
/// database. And `check` renews it once a third of its lifetime has passed with no renewal,
/// and fails if it can't, or if another run has taken the lease. So every write starts with
/// at least two thirds of the lifetime (less clock skew between nodes) left before another
/// run could take over, and goes on being covered while it lasts.
///
/// A run that is told to stop (`stop`) is refused its next `check`, as one that lost the
/// lease is: it finishes the write it is making and makes no other.
pub struct Lease {
    inner: Arc<Inner>,
    beat: Mutex<Option<JoinHandle<()>>>,
}

impl Inner {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// One renewal at a time: whoever asks while one is under way waits for that one, and is
    /// told what became of it.
    async fn renewed(&self) -> Result<()> {
        let seen = self.state().renewals;
        let _turn = self.renewing.lock().await;
        {
            let state = self.state();
            if state.renewals != seen {
                return match (&state.failure, state.lost) {
                    (_, true) => Err(LeaseLost::Taken.into()),
                    (Some(failure), _) => Err(anyhow::anyhow!("{failure}")),
                    (None, _) => Ok(()),
                };
            }
        }
        let outcome = self.renew().await;
        let mut state = self.state();
        state.renewals += 1;
        state.failure = outcome.as_ref().err().map(|err| format!("{err:#}"));
        outcome
    }

    /// Extends the lease, provided no other run has taken it since this one did (even after
    /// it expired).
    async fn renew(&self) -> Result<()> {
        let at = (self.now)();
        let renewed = self
            .db
            .execute(
                "UPDATE compactor_lease SET expires_at = ? WHERE id = ? AND holder = ?",
                params![at + self.ttl_ms, LEASE_ID, &self.holder],
            )
            .await?;
        if renewed != 1 {
            self.state().lost = true;
            return Err(LeaseLost::Taken.into());
        }
        self.state().renewed_at = Some(at);
        Ok(())
    }
}

impl Lease {
    /// A lease of `ttl_ms`, which nothing holds yet. `now` is the clock its times are told by.
    pub fn new(db: Db, ttl_ms: i64, now: Clock) -> Self {
        Self {
            inner: Arc::new(Inner {
                db,
                ttl_ms,
                now,
                holder: Uuid::new_v4().to_string(),
                state: Mutex::new(State {
                    renewed_at: None,
                    lost: false,
                    stopped: false,
                    renewals: 0,
                    failure: None,
                }),
                renewing: tokio::sync::Mutex::new(()),
                released: Notify::new(),
            }),
            beat: Mutex::new(None),
        }
    }

    /// Takes the lease if it is free or has expired, and keeps it renewed until it is
    /// released; false if a live run holds it.
    pub async fn acquire(&self) -> Result<bool> {
        let inner = &self.inner;
        let at = (inner.now)();
        let taken = inner
            .db
            .execute(
                "UPDATE compactor_lease SET holder = ?, expires_at = ? WHERE id = ? AND expires_at <= ?",
                params![&inner.holder, at + inner.ttl_ms, LEASE_ID, at],
            )
            .await?;
        if taken != 1 {
            return Ok(false);
        }
        inner.state().renewed_at = Some(at);
        let every = Duration::from_millis((inner.ttl_ms / 3).max(1).unsigned_abs());
        let renewing = inner.clone();
        let beat = tokio::spawn(async move {
            loop {
                tokio::select! {
                    () = tokio::time::sleep(every) => {}
                    () = renewing.released.notified() => return,
                }
                // A renewal that fails here is `check`'s to find: it renews again itself, and fails with what it gets.
                let _ = renewing.renewed().await;
            }
        });
        *self.beat.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(beat);
        Ok(true)
    }

    /// Fails unless this run still holds the lease and may go on: with `LeaseLost::Taken` if
    /// another took it, `LeaseLost::Stopped` if it was told to stop.
    pub async fn check(&self) -> Result<()> {
        {
            let state = self.inner.state();
            if state.stopped {
                return Err(LeaseLost::Stopped.into());
            }
            if state.lost {
                return Err(LeaseLost::Taken.into());
            }
            // Three times the time since, against the lifetime: a third of it, whatever it divides by.
            if state
                .renewed_at
                .is_some_and(|renewed_at| ((self.inner.now)() - renewed_at).saturating_mul(3) < self.inner.ttl_ms)
            {
                return Ok(());
            }
        }
        self.inner.renewed().await
    }

    /// Has the run stop at its next `check`: the write it is making is its last.
    pub fn stop(&self) {
        self.inner.state().stopped = true;
    }

    /// Stops renewing the lease and frees it for the next run, if this run still holds it.
    pub async fn release(&self) -> Result<()> {
        let beat = self.beat.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
        if let Some(beat) = beat {
            self.inner.released.notify_one();
            // A renewal under way ends first, so that it finds the lease still this run's.
            let _ = beat.await;
        }
        drop(self.inner.renewing.lock().await);
        self.inner
            .db
            .execute(
                "UPDATE compactor_lease SET holder = ?, expires_at = 0 WHERE id = ? AND holder = ?",
                params![None::<&str>, LEASE_ID, &self.inner.holder],
            )
            .await?;
        Ok(())
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        // A lease that was never released (its run was dropped) renews no more, and expires on its own.
        if let Some(beat) = self.beat.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take() {
            beat.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicI64, Ordering};

    use evieverse_core::testing;
    use evieverse_core::time::system_clock;

    use super::*;

    /// The lifetime of the leases of these tests, in milliseconds.
    const TTL: i64 = 300;

    /// Who holds the lease, and until when.
    async fn held(db: &Db) -> (Option<String>, i64) {
        let row = db.fetch_optional("SELECT holder, expires_at FROM compactor_lease", &[]).await.unwrap().unwrap();
        (row.opt_string("holder").unwrap(), row.i64("expires_at").unwrap())
    }

    async fn pause(ms: u64) {
        tokio::time::sleep(Duration::from_millis(ms)).await;
    }

    #[tokio::test]
    async fn is_renewed_while_it_is_held_whatever_the_run_is_doing_and_no_longer() {
        let dir = tempfile::tempdir().unwrap();
        let db = testing::database(dir.path()).await;
        let lease = Lease::new(db.clone(), TTL, system_clock());
        assert!(lease.acquire().await.unwrap());
        let (holder, first) = held(&db).await;
        assert!(holder.is_some());

        // A run that makes one long write never checks: the lease outlives its lifetime all the same.
        pause(TTL.unsigned_abs() * 2).await;
        let (still, later) = held(&db).await;
        assert_eq!(still, holder);
        assert!(later > first);
        assert!(later > evieverse_core::time::system_now());
        lease.check().await.unwrap();

        // A second run finds it held.
        assert!(!Lease::new(db.clone(), TTL, system_clock()).acquire().await.unwrap());

        lease.release().await.unwrap();
        assert_eq!(held(&db).await, (None, 0));
        pause(TTL.unsigned_abs()).await;
        assert_eq!(held(&db).await, (None, 0));
        assert!(Lease::new(db.clone(), TTL, system_clock()).acquire().await.unwrap());
    }

    #[tokio::test]
    async fn is_lost_when_a_renewal_finds_another_holder_even_with_a_clock_standing_still() {
        let dir = tempfile::tempdir().unwrap();
        let db = testing::database(dir.path()).await;
        let now = Arc::new(AtomicI64::new(1_000_000));
        let clock: Clock = {
            let now = now.clone();
            Arc::new(move || now.load(Ordering::SeqCst))
        };
        let lease = Lease::new(db.clone(), TTL, clock);
        assert!(lease.acquire().await.unwrap());
        lease.check().await.unwrap();

        db.execute("UPDATE compactor_lease SET holder = ?, expires_at = ?", params!["another", i64::MAX])
            .await
            .unwrap();
        // The renewal made on time finds it, with no check asking and no time passing by the run's clock.
        pause(TTL.unsigned_abs()).await;
        let lost = lease.check().await.unwrap_err();
        assert!(is_lease_lost(&lost) && !is_stopped(&lost));

        // Releasing frees nothing that isn't its own.
        lease.release().await.unwrap();
        assert_eq!(held(&db).await, (Some("another".to_owned()), i64::MAX));
    }

    #[tokio::test]
    async fn refuses_the_next_check_of_a_run_that_was_told_to_stop() {
        let dir = tempfile::tempdir().unwrap();
        let db = testing::database(dir.path()).await;
        let lease = Lease::new(db.clone(), TTL, system_clock());
        assert!(lease.acquire().await.unwrap());
        lease.check().await.unwrap();

        lease.stop();
        let stopped = lease.check().await.unwrap_err();
        // To whatever passes a lost lease on, it is one.
        assert!(is_stopped(&stopped) && is_lease_lost(&stopped));
        assert_eq!(
            stopped.to_string(),
            "the compactor was told to stop; this run stopped before writing anything more"
        );

        // The lease is the run's until it releases it.
        assert!(held(&db).await.0.is_some());
        lease.release().await.unwrap();
        assert_eq!(held(&db).await, (None, 0));
    }
}
