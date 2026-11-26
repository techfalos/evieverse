//! The server's own asking after the posts it holds reposts of. An entry for a post on
//! another server says what the post was when it was last attested, and learns what the post
//! became from a later attestation. A client can bring one (POST /repost/refresh), but nothing
//! makes a client do it, so an edit or a deletion of the original would reach this server
//! only by chance. So the server asks too: every REPOSTS_REFRESH_HOURS, it gets the
//! attestation of each such post from the post's own server (GET <the post's
//! address>/attestation there, which answers anyone), checks it as the API checks one a client
//! brings, and does with it what a refresh does (see `Origins`). A post that is gone there has
//! its entry hidden, and is asked about again every GONE_RECHECK_MS until it is back or the
//! entry is deleted (REPOSTS_GONE_DAYS).
//!
//! It runs beside the compactor, in its process, and outside the compactor's lease: what it
//! changes, it commits as a request does, and the compactor applies. A second copy does no
//! harm: an entry is claimed before it is asked about, by moving the time it is next due
//! (`content.origin_check_at`).
//!
//! It asks slowly, one post at a time with a pause in between (PAUSE), which keeps it under
//! the limit another server of this software puts on that route by default, and makes it no
//! burden on anyone. That is 30 posts a minute, some 43,000 a day: a server that holds more
//! reposts of posts elsewhere than that asks about each less often than the setting says.
//!
//! The address asked is one somebody else chose, so it is asked as another server's keys are
//! (`public_fetch`): over https, at a public address, once, for a short time. It is the
//! post's address as its own server attested it when the entry was made, which was checked
//! then.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use evieverse_core::attestation::{Attested, MAX_ATTESTATION_CHARS, host_of};
use evieverse_core::log;
use evieverse_core::origin_keys::KeyFetcher;
use evieverse_core::pending::effective_meta;
use evieverse_core::public_fetch::{Answer, fetch_public_answer};
use evieverse_core::time::HOUR;
use evieverse_trust::trust::Plugins;
use futures::future::BoxFuture;
use serde_json::json;

use crate::compactor::Stopper;
use crate::deps::Deps;
use crate::origins::{Origins, Refreshed};
use crate::write::{GONE_RECHECK_MS, Unwritten};

/// How long the server waits after asking one server about a post before it asks about the
/// next.
const PAUSE: Duration = Duration::from_millis(2000);

/// How many entries one look at the database takes: the ones longest due.
const BATCH: usize = 50;

/// How long until the next look, after one that found fewer than BATCH entries due.
const IDLE: Duration = Duration::from_secs(60);

/// How long an entry isn't asked about again after its original's server gave no answer that
/// could be used, and how long none of that server's other posts are asked about either: one
/// that is down is asked once in this long, however many of its posts this server holds.
const RETRY_MS: i64 = HOUR;

/// The largest answer that is read: an attestation, and what little JSON there is around it.
const MAX_ANSWER_BYTES: usize = MAX_ATTESTATION_CHARS + 8 * 1024;

/// The most servers that are remembered as having given no answer; past it they are all
/// forgotten, and asked again.
const MAX_DOWN: usize = 1000;

/// What asks another server for a post's attestation: the answer to a GET of an address,
/// with its status. An error if there is none.
pub type AttestationFetcher = Arc<dyn Fn(String) -> BoxFuture<'static, Result<Answer>> + Send + Sync>;

/// Where a post's own server gives its attestation, from the post's address there.
fn attestation_address(url: &str) -> String {
    format!("{url}/attestation")
}

/// The attestation in a server's answer: `attestation` beside 200, `gone` beside 404 (see GET
/// /content/:id/attestation). None if there is none: a 404 that carries nothing signed says
/// nothing this server can believe.
fn attestation_in(answer: &Answer) -> Option<&str> {
    let written = answer.body.get(if answer.status == 200 { "attestation" } else { "gone" })?.as_str()?;
    (written.encode_utf16().count() <= MAX_ATTESTATION_CHARS).then_some(written)
}

/// What asks after the originals of the server's entries for posts on other servers (see the
/// top of this file).
pub struct OriginSweep {
    deps: Deps,
    origins: Origins,
    fetcher: AttestationFetcher,
    pause: Duration,
    /// The servers that gave no answer that could be used, by host, with when: none of them
    /// is asked again within RETRY_MS.
    down: Mutex<HashMap<String, i64>>,
}

impl OriginSweep {
    /// `fetcher` and `key_fetcher` are what ask other servers, and `pause` how long is waited
    /// between two, where a test gives them: the public internet is asked otherwise, slowly.
    pub fn new(
        deps: Deps,
        plugins: Arc<Plugins>,
        fetcher: Option<AttestationFetcher>,
        key_fetcher: Option<KeyFetcher>,
        pause: Option<Duration>,
    ) -> Result<Self> {
        // 200 with the attestation, or 404 with one that says the post is gone.
        let ask: AttestationFetcher = Arc::new(|address| Box::pin(async move { fetch_public_answer(&address, &[200, 404], MAX_ANSWER_BYTES).await }));
        Ok(Self {
            origins: Origins::new(deps.clone(), plugins, key_fetcher)?,
            fetcher: fetcher.unwrap_or(ask),
            pause: pause.unwrap_or(PAUSE),
            down: Mutex::default(),
            deps,
        })
    }

    /// What the original's server says of the post at `url` now, checked as an attestation a
    /// client brings is. Its keys are asked for where Redis doesn't hold them.
    async fn ask(&self, url: &str) -> Result<Attested> {
        let answer = (self.fetcher)(attestation_address(url)).await?;
        let attestation = attestation_in(&answer).context("it answered with no attestation")?;
        let said = self.origins.attested(attestation).await?;
        if said.url() != url {
            bail!("it attested {}, which is another address", said.url());
        }
        Ok(said)
    }

    /// Asks about one entry that is due, and brings it up to the answer. False if nobody was
    /// asked: another process took the entry, or its original's server gave no answer a
    /// moment ago.
    ///
    /// The entry is claimed first, by moving when it is next due to RETRY_MS from now, which
    /// holds only if it is still due as it was read. So that is when it is asked about again
    /// if anything here fails. An answer sets it to what the entry is asked by from then on:
    /// REPOSTS_REFRESH_HOURS, or GONE_RECHECK_MS for one that is hidden.
    ///
    /// An answer the entry doesn't take leaves it as it is, as a refresh a client sends
    /// would: it is no newer than what the entry holds, the post is of another type now, or
    /// what it now says is refused by its trust score.
    async fn check(&self, content_id: &str, due_at: i64) -> Result<bool> {
        let Deps { db, config, content, log, .. } = &self.deps;
        let at = self.deps.now();
        let claimed = db
            .execute(
                "UPDATE content SET origin_check_at = ? WHERE id = ? AND origin_check_at = ? AND delete_requested_at IS NULL",
                evieverse_core::params![at + RETRY_MS, content_id, due_at],
            )
            .await?;
        if claimed == 0 {
            return Ok(false);
        }
        let origin = effective_meta(db, content, content_id).await?.and_then(|meta| meta.origin);
        let Some(url) = origin.map(|origin| origin.url) else {
            log.warn(
                json!({ "contentId": content_id }),
                "an entry for a post on another server has no address of its original, so it cannot be asked about",
            );
            return Ok(false);
        };
        let host = host_of(&url).ok_or_else(|| anyhow!("the address of the original of {content_id} names no host"))?;
        let down_at = |down: &HashMap<String, i64>| down.get(&host).copied();
        if down_at(&self.down.lock().unwrap_or_else(PoisonError::into_inner)).is_some_and(|since| since > at - RETRY_MS) {
            return Ok(false);
        }

        let said = match self.ask(&url).await {
            Ok(said) => said,
            Err(err) => {
                let mut down = self.down.lock().unwrap_or_else(PoisonError::into_inner);
                if down.len() >= MAX_DOWN {
                    down.clear();
                }
                down.insert(host, at);
                log.warn(
                    json!({ "err": log::err(&err), "contentId": content_id, "origin": url }),
                    "could not get the attestation of a post from its own server, so the repost of it stays as it is: that server's posts are asked about again in an hour",
                );
                return Ok(true);
            }
        };

        let about = json!({ "contentId": content_id, "origin": url });
        match self.origins.refresh(&said).await {
            Ok(Refreshed::Gone { already: false, .. }) => log.info(about, "hid the repost of a post that its own server says it no longer publishes"),
            Ok(Refreshed::Updated { queued }) => log.info(
                json!({ "contentId": content_id, "origin": url, "queued": queued }),
                "brought the repost of a post on another server up to what the post is now",
            ),
            Ok(Refreshed::None | Refreshed::Gone { already: true, .. }) => {}
            Err(Unwritten::Refused(why)) => log.info(
                json!({ "err": { "type": "Error", "message": why }, "contentId": content_id, "origin": url }),
                "the repost of a post on another server did not take what the post is now, and stays as it is",
            ),
            Err(Unwritten::Failed(err)) => return Err(err),
        }
        // Asked again by what the entry is now, whether or not it took the answer: sooner while it is hidden.
        let entry = db
            .fetch_optional("SELECT origin_gone_at FROM content WHERE id = ?", evieverse_core::params![content_id])
            .await?;
        let hidden = entry.map(|entry| entry.opt_i64("origin_gone_at")).transpose()?.flatten().is_some();
        let next = self.deps.now() + if hidden { GONE_RECHECK_MS } else { config.reposts.refresh_hours * HOUR };
        db.execute(
            "UPDATE content SET origin_check_at = ? WHERE id = ? AND delete_requested_at IS NULL",
            evieverse_core::params![next, content_id],
        )
        .await?;
        Ok(true)
    }

    /// One look: asks about the entries whose time has come, the longest due first and of
    /// those the oldest, one after another with a pause after each that had a server asked.
    /// One that fails is logged, and left for RETRY_MS. Stops early once `stopper` is told to
    /// stop. Returns how many entries were due.
    pub async fn sweep(&self, stopper: &Stopper) -> Result<usize> {
        let Deps { db, log, .. } = &self.deps;
        let due = db
            .fetch(
                &format!(
                    "SELECT id, origin_check_at FROM content WHERE origin_hash IS NOT NULL AND delete_requested_at IS NULL \
                     AND origin_check_at <= ? ORDER BY origin_check_at, created_at LIMIT {BATCH}"
                ),
                evieverse_core::params![self.deps.now()],
            )
            .await?;
        for entry in &due {
            if stopper.is_stopped() {
                break;
            }
            let content_id = entry.str("id")?;
            let asked = match self.check(content_id, entry.i64("origin_check_at")?).await {
                Ok(asked) => asked,
                Err(err) => {
                    log.error(
                        json!({ "err": log::err(&err), "contentId": content_id }),
                        "could not bring the repost of a post on another server up to date; it is asked about again in an hour",
                    );
                    true
                }
            };
            if asked && !self.pause.is_zero() {
                tokio::select! {
                    () = stopper.stopped() => {}
                    () = tokio::time::sleep(self.pause) => {}
                }
            }
        }
        Ok(due.len())
    }

    /// Looks again and again until stopped: at once after a look that found a full batch
    /// due, else after IDLE. With REPOSTS_REFRESH_HOURS=0 it does nothing. Returns once it is
    /// stopped and the look under way has stopped.
    pub async fn run(&self, stopper: &Stopper) {
        if self.deps.config.reposts.refresh_hours == 0 {
            return;
        }
        while !stopper.is_stopped() {
            let due = match self.sweep(stopper).await {
                Ok(due) => due,
                Err(err) => {
                    self.deps.log.error(
                        json!({ "err": log::err(&err) }),
                        "could not look for the reposts of posts on other servers that are due to be asked about",
                    );
                    0
                }
            };
            tokio::select! {
                () = stopper.stopped() => {}
                () = tokio::time::sleep(if due == BATCH { self.pause } else { IDLE }) => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_attestation_a_server_answers_with() {
        let answer = |status: u16, body: serde_json::Value| Answer { status, body };
        assert_eq!(attestation_in(&answer(200, json!({ "attestation": "a.b", "gone": "c.d" }))), Some("a.b"));
        assert_eq!(attestation_in(&answer(404, json!({ "attestation": "a.b", "gone": "c.d" }))), Some("c.d"));
        // A 404 that carries nothing signed says nothing this server can believe.
        assert_eq!(attestation_in(&answer(404, json!({ "error": "Not Found" }))), None);
        assert_eq!(attestation_in(&answer(200, json!({ "attestation": 7 }))), None);
        assert_eq!(attestation_in(&answer(200, json!("a.b"))), None);
        assert_eq!(
            attestation_in(&answer(200, json!({ "attestation": "a".repeat(MAX_ATTESTATION_CHARS + 1) }))),
            None
        );
        assert_eq!(
            attestation_address("https://other.example/content/1"),
            "https://other.example/content/1/attestation"
        );
    }
}
