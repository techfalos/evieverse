//! The writes this process commits of the server's entries for posts on other servers, as
//! the API's own writer commits them (`contentWriter` in src/write.ts): an update of an entry
//! with what its original is now (`write`), and the hiding of one whose original is gone
//! (`withhold`). They are what the origin sweep does with what the originals' servers say
//! (see `crate::sweep`), and what POST /repost/refresh does with what a client brings.
//!
//! Both commit to the database and write nothing to the entry's bytes, meta file or summary:
//! a run of the compactor does, from what they committed (see `apply_pending`). So they are
//! made outside the compactor's lease, like any request's.

use anyhow::{Context, Result};
use evieverse_core::content::ContentMeta;
use evieverse_core::db::{Queries, Tx, Value};
use evieverse_core::inbox::{Notice, notify};
use evieverse_core::layout::author_index;
use evieverse_core::log;
use evieverse_core::pending::{PendingWrite, PostPayload, RowChange, effective_meta_in, insert_pending, kind, next_seq};
use evieverse_core::reposts::{reposted_tags, reposts_of};
use evieverse_core::tags::{count_tag_pairs, touch_tags};
use evieverse_core::time::HOUR;
use serde_json::{Map, json};

use crate::deps::Deps;

/// How long after the server's entry for a post on another server was hidden, on that
/// server's word that the post is gone, the server asks it about the post again, and how long
/// after each such answer: sooner than it asks about an entry that is published
/// (REPOSTS_REFRESH_HOURS), since a post that only waited in a moderation queue there may be
/// back.
pub const GONE_RECHECK_MS: i64 = 6 * HOUR;

/// Why a write of an entry wasn't made.
#[derive(Debug, thiserror::Error)]
pub enum Unwritten {
    /// It is one the entry doesn't take, which a request would be told (4xx): nothing was
    /// written, and the entry stays as it is.
    #[error("{0}")]
    Refused(String),
    /// It could not be made at all.
    #[error(transparent)]
    Failed(#[from] anyhow::Error),
}

/// What says whether a write still holds for the entry as it is once its row is locked.
pub type Recheck<'a> = &'a (dyn Fn(&ContentMeta) -> Result<(), Unwritten> + Sync);

/// The entry is set for deletion, or gone: nothing is written to it any more.
fn pending_deletion() -> Unwritten {
    Unwritten::Refused("the entry is set for deletion, and takes no update".to_owned())
}

/// A JSON document a row holds.
fn payload(meta: ContentMeta) -> Result<String> {
    let payload = PostPayload {
        meta,
        process: None,
        keep_bytes: None,
        extra: Map::new(),
    };
    serde_json::to_string(&payload).context("could not write a post's meta file as JSON")
}

/// The tags, each once, in the order they first come.
fn unique(tags: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut all: Vec<String> = Vec::new();
    for tag in tags {
        if !all.contains(&tag) {
            all.push(tag);
        }
    }
    all
}

/// Queues the content's entry in each of these indexes (see `feed_queue`): the compactor
/// rebuilds it there on its next run. The rows are stamped as one write's, over what an
/// earlier write queued. In the transaction of the write that queues them, so a row is there
/// if and only if its write committed.
async fn enqueue(tx: &mut Tx, content_id: &str, tags: &[String], now: i64) -> Result<()> {
    if tags.is_empty() {
        return Ok(());
    }
    let token = uuid::Uuid::new_v4().to_string();
    let rows = vec!["(?, ?, ?, ?)"; tags.len()].join(", ");
    let params: Vec<Value> = tags
        .iter()
        .flat_map(|tag| [Value::from(content_id), Value::from(tag), Value::from(&token), Value::from(now)])
        .collect();
    let end = tx.dialect().upsert_end(&["content_id", "tag"], &["token", "created_at"]);
    tx.execute(
        &format!("INSERT INTO feed_queue (content_id, tag, token, created_at) VALUES {rows}{end}"),
        &params,
    )
    .await?;
    Ok(())
}

/// An update of the server's entry for a post on another server: the post attested again.
pub struct EntryWrite<'a> {
    /// The entry's owner: who reposted the post here.
    pub user_id: &'a str,
    pub username: &'a str,
    /// The entry's meta file as it was read before the write began, and the entry's write
    /// number then.
    pub previous: &'a ContentMeta,
    pub seen_seq: i64,
    pub recheck: Recheck<'a>,
    /// The hashtags that were read as given by reposts.
    pub given: &'a [String],
    /// The meta file the write makes: with the hashtags moderation left the entry, as of
    /// `updated_at`, which is when the write is made.
    pub meta: ContentMeta,
    /// The trust score of a write that is held in the moderation queue.
    pub queued: Option<i64>,
    /// The hashtags of reposts that what the entry now says is refused: they come off the
    /// entry for good.
    pub dropped_reposts: &'a [String],
}

/// What the commit of an update read, for what is done once it is committed.
struct Committed {
    seq: i64,
    tags: Vec<String>,
    /// The hashtags the entry had, and the places reposts gave it.
    had: Vec<String>,
    placed: Vec<String>,
    /// Whether the update is what put the entry in the moderation queue: it is held, and the
    /// entry didn't wait there already.
    held: bool,
}

/// Everything an update commits, in its transaction (see `write` of src/write.ts, of which
/// this is the part that writes over content that is there and has no file).
async fn commit(deps: &Deps, tx: &mut Tx, write: &EntryWrite<'_>) -> Result<Committed, Unwritten> {
    let Deps { config, content, .. } = deps;
    let content_id = write.meta.content_id.as_str();
    let ts = write.meta.updated_at;
    let own = author_index(write.user_id);
    // An entry that was hidden is published again by this, and asked about again in REPOSTS_REFRESH_HOURS.
    let change = RowChange {
        ai_generated: Some(write.meta.ai_generated),
        origin_gone_at: Some(None),
        origin_check_at: Some(ts + config.reposts.refresh_hours * HOUR),
    };
    let seq = next_seq(tx, content_id, change).await?.ok_or_else(pending_deletion)?;
    let mut had = write.previous.tags.clone();
    // Something was written to it, or under it, since it was read: its hashtags may be others by now.
    if seq != write.seen_seq + 1
        && let Some(current) = effective_meta_in(tx, content, content_id).await?
    {
        (write.recheck)(&current)?;
        had = unique(had.into_iter().chain(current.tags));
    }
    // Where reposts put it: the row is locked, so there are no more to come, and none to go, before this commits.
    let placed: Vec<String> = reposts_of(tx, content_id).await?.into_iter().map(|repost| repost.tag).collect();
    // What was read as a repost's and no repost gives any more: the repost was removed, and its hashtags with it.
    let mut written = write.meta.clone();
    written.tags.retain(|tag| !write.given.contains(tag) || placed.contains(tag));
    let tags = written.tags.clone();

    let mut held = false;
    if let Some(score) = write.queued {
        // Read with the row locked: no other write of the entry puts it in the queue, or takes it out, before this commits.
        held = tx
            .fetch_optional(
                "SELECT content_id FROM moderation_queue WHERE content_id = ?",
                evieverse_core::params![content_id],
            )
            .await?
            .is_none();
        // Content that was waiting keeps its place in the queue.
        let end = tx.dialect().upsert_end(&["content_id"], &["trust_score"]);
        tx.execute(
            &format!("INSERT INTO moderation_queue (content_id, trust_score, created_at) VALUES (?, ?, ?){end}"),
            evieverse_core::params![content_id, score, ts],
        )
        .await?;
    } else {
        tx.execute("DELETE FROM moderation_queue WHERE content_id = ?", evieverse_core::params![content_id])
            .await?;
    }
    // An update makes the content unmoderated again under its hashtags: the approvals were of what it was.
    tx.execute(
        "DELETE FROM tag_moderation WHERE content_id = ? AND decision = ?",
        evieverse_core::params![content_id, "approved"],
    )
    .await?;
    // The hashtags it is published under, not the ones it dropped: this is what /tags lists them by.
    if write.queued.is_none() {
        touch_tags(tx, &tags.iter().cloned().chain([own.clone()]).collect::<Vec<_>>(), ts).await?;
    }
    // Recorded as removals, with no moderator: the compactor takes them off the content as it does any.
    let end = tx
        .dialect()
        .upsert_end(&["content_id", "tag"], &["decision", "moderator_id", "decided_at", "applied_at"]);
    for tag in write.dropped_reposts {
        tx.execute(
            &format!("INSERT INTO tag_moderation (content_id, tag, decision, moderator_id, decided_at, applied_at) VALUES (?, ?, ?, NULL, ?, NULL){end}"),
            evieverse_core::params![content_id, tag, "removed", ts],
        )
        .await?;
    }
    let dropped = write.dropped_reposts.iter().cloned();
    let touched = if write.queued.is_some() {
        // Held: every index that may hold it, and the hashtags it has now, should an admin accept what it was before this is applied.
        unique(
            had.iter()
                .cloned()
                .chain(tags.iter().cloned())
                .chain([own])
                .chain(placed.iter().cloned())
                .chain(dropped),
        )
    } else {
        // The indexes it is published in, and the ones the update dropped.
        let left = had.iter().filter(|tag| !tags.contains(tag)).cloned();
        unique(tags.iter().cloned().chain([own]).chain(placed.iter().cloned()).chain(left).chain(dropped))
    };
    let row = PendingWrite {
        content_id,
        seq,
        kind: kind::POST,
        payload: Some(payload(written)?),
        at: ts,
        ..PendingWrite::default()
    };
    insert_pending(tx, &row).await?;
    enqueue(tx, content_id, &touched, deps.now()).await?;
    Ok(Committed { seq, tags, had, placed, held })
}

/// Whether the database holds a write whose commit reported an error: its row of
/// `pending_writes`, told by when it was made. A commit can fail yet still be applied, as
/// when the connection drops while it is made.
async fn committed(deps: &Deps, content_id: &str, seq: i64, at: i64) -> bool {
    let row = deps
        .db
        .fetch_optional(
            "SELECT staged_key, created_at FROM pending_writes WHERE content_id = ? AND seq = ? AND kind = ?",
            evieverse_core::params![content_id, seq, kind::POST],
        )
        .await;
    match row {
        Ok(Some(row)) => matches!((row.opt_str("staged_key"), row.i64("created_at")), (Ok(None), Ok(made)) if made == at),
        _ => false,
    }
}

/// Writes over the server's entry for a post on another server, with what the post is now:
/// one commit to the database, and nothing else (see the top of this file). Returns the
/// hashtags the write gives the entry: the ones it came with, but for those of a repost that
/// was removed meanwhile.
///
/// The entry's row is locked as the write takes its number, so writes of one entry commit one
/// at a time. An entry set for deletion gives no number, and the write is refused. If
/// anything was written to the entry, or under it, since it was read (`seen_seq`), its meta
/// file is read again with the row locked, and the write is asked again whether it holds
/// (`recheck`).
///
/// The entry's owner is told that it waits, by a notice in their inbox (`post_held`), once a
/// write that put it in the moderation queue has committed: it was published until then, and
/// it is the original's server that changed what it says, not them. A write of an entry that
/// waits there already tells nobody again.
pub async fn write(deps: &Deps, write: EntryWrite<'_>) -> Result<Vec<String>, Unwritten> {
    let Deps {
        db, content, publishers, log, ..
    } = deps;
    let content_id = write.meta.content_id.as_str();
    let mut tx = db.begin().await?;
    let done = commit(deps, &mut tx, &write).await?;
    if let Err(err) = tx.commit().await
        && !committed(deps, content_id, done.seq, write.meta.updated_at).await
    {
        return Err(err.into());
    }

    if let Err(err) = publishers.put(write.user_id, write.username).await {
        log.warn(
            json!({ "err": log::err(&err), "userId": write.user_id }),
            "could not refresh the publisher credit in Redis",
        );
    }
    if done.held {
        // The server held it, and nobody else: `by` is nobody's id.
        let notice = Notice {
            user_id: write.user_id,
            kind: "post_held",
            content_id: Some(content_id),
            ..Notice::default()
        };
        notify(db, content, deps.now(), &notice, log).await;
    }
    // Not the hashtags a repost gave it, which the repost counted, whether the meta file had them yet or not.
    let reposted = reposted_tags(done.placed.iter().map(String::as_str));
    let added: Vec<String> = done
        .tags
        .iter()
        .filter(|tag| !done.had.contains(tag) && !reposted.contains(tag))
        .cloned()
        .collect();
    // Stamped now, not when the write began: the compactor goes by it, and must find the rows written by then.
    if let Err(err) = count_tag_pairs(db, &done.tags, &added, deps.now()).await {
        log.warn(
            json!({ "err": log::err(&err), "contentId": content_id }),
            "could not count the hashtags of the write; related hashtags go without it",
        );
    }
    Ok(done.tags)
}

/// Hides the server's entry for a post on another server, on that server's signed word that
/// it publishes no post at the original's address. It says that of a post it deleted and of
/// one that only waits in its moderation queue, and nobody can tell which from here, so the
/// entry isn't deleted: it is withheld. Readers get 404 from the moment this commits, and the
/// compactor's next run erases the entry's summary and takes it out of every index it is in,
/// which is every one this queues. The hashtags and the places reposts gave it stay its own.
///
/// It is a numbered write of the entry, as an update is: the row is locked, the meta file is
/// read with every write that committed before, and `recheck` refuses word that is no newer
/// than what the entry holds. What it writes is the entry's meta file as it was, as of when
/// this word was signed (`issued_at`). An entry that is hidden already stays hidden from when
/// it first was: returns that time. Refused for an entry that is gone, or set for deletion.
pub async fn withhold(deps: &Deps, content_id: &str, issued_at: i64, recheck: Recheck<'_>) -> Result<i64, Unwritten> {
    let Deps { db, content, .. } = deps;
    let at = deps.now();
    let mut tx = db.begin().await?;
    let change = RowChange {
        origin_check_at: Some(at + GONE_RECHECK_MS),
        ..RowChange::default()
    };
    let seq = next_seq(&mut tx, content_id, change).await?.ok_or_else(pending_deletion)?;
    let row = tx
        .fetch_optional("SELECT user_id, origin_gone_at FROM content WHERE id = ?", evieverse_core::params![content_id])
        .await?
        .with_context(|| format!("the row of {content_id} is missing"))?;
    let meta = effective_meta_in(&mut tx, content, content_id)
        .await?
        .with_context(|| format!("the meta file of {content_id} is missing"))?;
    recheck(&meta)?;
    let gone_at = row.opt_i64("origin_gone_at")?;
    if gone_at.is_none() {
        tx.execute("UPDATE content SET origin_gone_at = ? WHERE id = ?", evieverse_core::params![at, content_id])
            .await?;
    }
    let placed = reposts_of(&mut tx, content_id).await?.into_iter().map(|repost| repost.tag);
    let touched = unique(meta.tags.iter().cloned().chain([author_index(row.str("user_id")?)]).chain(placed));
    let held = ContentMeta {
        origin_attested_at: Some(issued_at),
        ..meta
    };
    let write = PendingWrite {
        content_id,
        seq,
        kind: kind::POST,
        payload: Some(payload(held)?),
        at,
        ..PendingWrite::default()
    };
    insert_pending(&mut tx, &write).await?;
    enqueue(&mut tx, content_id, &touched, at).await?;
    tx.commit().await?;
    Ok(gone_at.unwrap_or(at))
}
