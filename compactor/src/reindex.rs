//! `compactor reindex`: makes every post and every user findable by GET /search, and counts
//! every post among the server's and those of each of its hashtags (GET /rules, GET /tags).
//! Run it once after upgrading a server that had posts before it had search, or before it
//! counted them, and once after the upgrade that moved the compactor to this program, which
//! cuts the words of some languages differently than the one before it did: until then those
//! posts are found by the words they were given then. It can be run while the server and the
//! compactor are up, and run again: it changes only what isn't right yet.

use std::cell::Cell;
use std::time::{Duration, Instant};

use anyhow::Result;
use evieverse_core::counts::count_post;
use evieverse_core::params;
use evieverse_core::search::{fold_username, index_content};
use evieverse_core::util::map_limit;
use serde::Serialize;

use crate::deps::Deps;
use crate::lease::Lease;
use crate::rows::{CONTENT_COLUMNS, CONTENT_FROM, ContentRow};

/// The posts, or the users, one step of a reindex reads and brings up to date.
const BATCH: usize = 500;

/// How long until the lease is asked for again when a compactor run holds it.
const LEASE_RETRY: Duration = Duration::from_millis(1000);

/// What a reindex did, or has done so far.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Reindexed {
    /// The posts whose terms, and what they count for, were brought up to their meta files.
    pub posts: u64,
    /// The posts that have no meta file yet: the compactor hasn't applied them, and gives
    /// them their terms, and counts them, when it does.
    pub pending: u64,
    /// The users whose folded name was wrong, and is now right.
    pub usernames: u64,
}

/// Brings what search reads up to what the server holds: the terms of every post
/// (`search_terms`), from its meta file, and the folded name of every user
/// (`users.username_folded`), from their username. It can be run again, at any time, and
/// beside a server and a compactor that are up: what is already right is read and left.
///
/// The posts are gone through by id, `BATCH` at a time, and the terms of each are made by
/// what the compactor makes them with (see `index_content`). Each is counted by what a run
/// counts it with, too (see `count_post`): among the server's posts and those of each of its
/// hashtags, or not at all while it is withheld, which is what counts the posts that were
/// there before posts were counted. Each batch is read and written
/// under the compactor's lease (see `Lease`), which is waited for while a run holds it and
/// given back after the batch: so no run writes a meta file while its post's terms are made
/// from the one before, and a post isn't deleted under the rows written for it. Between two
/// batches the lease is left free for as long as the batch held it, so that the compactor's
/// runs, which are skipped while it is held, get their turn about half the times they ask,
/// and posts go on being published meanwhile, a little later than they are otherwise.
///
/// A post that has no meta file is one the compactor hasn't applied yet, which gets its terms
/// when it does. `progress` is told where the work is after each batch.
pub async fn reindex(deps: &Deps, progress: &dyn Fn(Reindexed)) -> Result<Reindexed> {
    let Deps { db, config, content, now, .. } = deps;
    let max = usize::try_from(config.search.max_keywords).unwrap_or(0);
    let (posts, pending) = (Cell::new(0_u64), Cell::new(0_u64));
    let so_far = |usernames: u64| Reindexed {
        posts: posts.get(),
        pending: pending.get(),
        usernames,
    };

    let mut after = String::new();
    loop {
        let lease = Lease::new(db.clone(), config.compact.lease_seconds * 1000, now.clone());
        while !lease.acquire().await? {
            tokio::time::sleep(LEASE_RETRY).await;
        }
        let held_since = Instant::now();
        let batch = async {
            // Read under the lease: none of these is deleted, nor its meta file written, until it is given back.
            let rows = db
                .fetch(
                    &format!("SELECT {CONTENT_COLUMNS} FROM {CONTENT_FROM} WHERE content.id > ? ORDER BY content.id LIMIT {BATCH}"),
                    params![&after],
                )
                .await?
                .iter()
                .map(ContentRow::of)
                .collect::<Result<Vec<ContentRow>>>()?;
            map_limit(&rows, deps.concurrency(), |row| {
                let (lease, posts, pending) = (&lease, &posts, &pending);
                async move {
                    let id = row.id.as_str();
                    let Some(meta) = content.get_meta(id).await? else {
                        pending.set(pending.get() + 1);
                        return Ok(());
                    };
                    lease.check().await?;
                    index_content(db, id, row.created_at, &meta, max).await?;
                    // Content set for deletion keeps what it counts for until it goes, as a run leaves it.
                    if !row.deleting() {
                        count_post(db, id, (!row.withheld()).then_some(meta.tags.as_slice()), deps.now()).await?;
                    }
                    posts.set(posts.get() + 1);
                    Ok(())
                }
            })
            .await?;
            let last = rows.last().map(|row| row.id.clone());
            anyhow::Ok((rows.len() == BATCH, last))
        }
        .await;
        lease.release().await?;
        let (more, last) = batch?;
        after = last.unwrap_or(after);
        progress(so_far(0));
        if !more {
            break;
        }
        tokio::time::sleep(held_since.elapsed()).await;
    }

    let mut usernames = 0;
    let mut after = String::new();
    loop {
        let rows = db
            .fetch(
                &format!("SELECT id, username, username_folded FROM users WHERE id > ? ORDER BY id LIMIT {BATCH}"),
                params![&after],
            )
            .await?;
        for row in &rows {
            let username = row.str("username")?;
            let folded = fold_username(username);
            if row.opt_str("username_folded")? == Some(folded.as_str()) {
                continue;
            }
            // Only while the name is the one that was folded. No request renames a user, so it is: this holds whatever else writes the row.
            usernames += db
                .execute(
                    "UPDATE users SET username_folded = ? WHERE id = ? AND username = ?",
                    params![&folded, row.str("id")?, username],
                )
                .await?;
        }
        let more = rows.len() == BATCH;
        after = rows.last().map(|row| row.string("id")).transpose()?.unwrap_or(after);
        progress(so_far(usernames));
        if !more {
            break;
        }
    }
    Ok(so_far(usernames))
}

/// What `compactor reindex` prints once it is done.
pub fn summary(done: Reindexed) -> String {
    format!(
        "Reindex complete: {} posts indexed, {} not yet applied by the compactor (it indexes them), {} usernames folded.",
        done.posts, done.pending, done.usernames
    )
}
