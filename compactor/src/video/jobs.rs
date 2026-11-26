//! The videos that wait to be processed (`media_jobs`): the video worker's queue (see
//! `super::worker`), and nothing else. Whether a write waits for its video is said by the
//! write's own row of `pending_writes` (see `PostPayload::process`), which is what the
//! compactor and the routes go by. A job only names that row, so that the worker finds the
//! videos to process without reading every pending write.
//!
//! A job is added in the transaction that commits its write (`addVideoJob` in
//! src/video/jobs.ts), and deleted in the one that puts the processed file in the write's
//! row, or gives the video up. In between, a worker takes it for a while (see `claim`), and a
//! worker that died with it loses it when that time is over. A job whose post is deleted goes
//! with the post's row.

use anyhow::Result;
use evieverse_core::db::{Db, Queries};
use evieverse_core::params;
use evieverse_trust::trust::TrustClient;

/// A job, as the worker that took it has it.
#[derive(Debug, Clone)]
pub struct VideoJob {
    /// For a post's video it is also the id its processed version is kept under.
    pub id: String,
    /// The row of `pending_writes` that names the staged file: a post's own write, or the
    /// write that made a comment.
    pub content_id: String,
    pub seq: i64,
    pub key: String,
    /// The comment the video came with. None on a post's.
    pub comment_id: Option<String>,
    /// How many times a worker took it, this one counted.
    pub attempts: i64,
    /// When the write was made.
    pub created_at: i64,
    /// Who sent the request the video came in, where the job kept it (`jobClient`).
    pub client: Option<TrustClient>,
}

/// Takes the oldest job that nobody has, until `lease_ms` from now: None if there is none.
/// Taken by an update that only the worker whose it becomes makes, so two workers never have
/// one job. A job a worker took and never finished, since it died, is taken again once its
/// time is over, and counts how many times it was (`attempts`).
pub async fn claim(db: &Db, now: i64, lease_ms: i64) -> Result<Option<VideoJob>> {
    // A few of the oldest, so that a job another worker takes first doesn't leave this one with none.
    let due = db
        .fetch(
            "SELECT id, claimed_until FROM media_jobs WHERE claimed_until <= ? ORDER BY created_at, id LIMIT 5",
            params![now],
        )
        .await?;
    for row in due {
        let id = row.str("id")?;
        let taken = db
            .execute(
                "UPDATE media_jobs SET claimed_until = ?, attempts = attempts + 1 WHERE id = ? AND claimed_until = ?",
                params![now + lease_ms, id, row.i64("claimed_until")?],
            )
            .await?;
        if taken != 1 {
            continue;
        }
        let Some(job) = db.fetch_optional("SELECT * FROM media_jobs WHERE id = ?", params![id]).await? else {
            continue;
        };
        return Ok(Some(VideoJob {
            id: id.to_owned(),
            content_id: job.string("content_id")?,
            seq: job.i64("seq")?,
            key: job.string("write_key")?,
            comment_id: job.opt_string("comment_id")?,
            attempts: job.i64("attempts")?,
            created_at: job.i64("created_at")?,
            client: job
                .opt_string("client_ip")?
                .map(|ip| -> Result<TrustClient> {
                    Ok(TrustClient {
                        ip,
                        user_agent: job.opt_string("client_user_agent")?,
                    })
                })
                .transpose()?,
        }));
    }
    Ok(None)
}

/// Keeps a job its worker has for `lease_ms` more, while it works on it. False if the job is
/// no longer there: its post was deleted, and whatever the worker makes of it is for nothing.
pub async fn renew(db: &Db, id: &str, now: i64, lease_ms: i64) -> Result<bool> {
    Ok(db
        .execute("UPDATE media_jobs SET claimed_until = ? WHERE id = ?", params![now + lease_ms, id])
        .await?
        == 1)
}

/// Gives a job back before its time is over, for whoever takes it next: at `at`, which is now
/// unless the job is to wait first.
pub async fn release(db: &Db, id: &str, at: i64) -> Result<()> {
    db.execute("UPDATE media_jobs SET claimed_until = ? WHERE id = ?", params![at, id]).await?;
    Ok(())
}

/// Gives a job back as `release` does, without the try that is ending counting against the
/// video: for a try that the video is not to blame for.
pub async fn release_uncounted(db: &Db, id: &str, at: i64) -> Result<()> {
    db.execute("UPDATE media_jobs SET claimed_until = ?, attempts = attempts - 1 WHERE id = ?", params![at, id])
        .await?;
    Ok(())
}

/// Deletes a job: its video is processed, or given up. In the transaction that says so of the
/// write, where there is one.
pub async fn remove(db: &mut impl Queries, id: &str) -> Result<()> {
    db.execute("DELETE FROM media_jobs WHERE id = ?", params![id]).await?;
    Ok(())
}
