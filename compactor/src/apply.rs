//! Applying the writes that requests committed (`pending_writes`): what writes a post's
//! bytes, meta file and summary, and a comment, its likes and its image or video.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use anyhow::{Context, Result};
use evieverse_core::comments::{Comment, Gone, Removal, placeholder};
use evieverse_core::content::{BytesOwner, ContentMeta};
use evieverse_core::db::{Queries, Value, places};
use evieverse_core::log;
use evieverse_core::object::is_not_found;
use evieverse_core::params;
use evieverse_core::pending::{
    CommentLikePayload, CommentPutPayload, CommentRemovePayload, PostPayload, UNNUMBERED, await_replies, kind, payload_bytes, payload_of,
};
use evieverse_core::posts::PreviewKind;
use evieverse_core::reposts::{removed_repost_tags, repost_times, reposted_tags};
use evieverse_core::search::index_content;
use evieverse_core::summary::{SummaryRef, summary_of};
use evieverse_core::time::MINUTE;
use evieverse_core::util::{all_done, map_limit};
use indexmap::IndexMap;
use serde_json::json;
use tokio::sync::Semaphore;

use crate::deps::Deps;
use crate::lease::{Lease, is_lease_lost};
use crate::replies::{has_replies, prune, remove_comment_rows};
use crate::rows::{BATCH, CONTENT_COLUMNS, CONTENT_FROM, ContentRow, Places, values};

/// How long past the lifetime of a link an applied staged file is kept (see `settle`): for a
/// request that read the write's row just before it was applied and signs its link just
/// after, and for clocks that differ between nodes.
const LINK_MARGIN_MS: i64 = MINUTE;

/// The most staged files one run deletes of those whose time has come: the others are the
/// next run's.
const STAGED_REMOVALS: i64 = 5000;

/// The content type a comment's file is stored with where the comment names none.
const UNKNOWN_MIME: &str = "application/octet-stream";

/// What applying the pending writes did.
#[derive(Debug, Default)]
pub struct Applied {
    /// The meta files written, by the post's id: what the run reads of those posts from then on.
    pub metas: HashMap<String, ContentMeta>,
    /// The posts whose own write couldn't be applied: their rows in the feed queue wait with it.
    pub failed: HashSet<String>,
    /// The posts whose write waits for its video to be processed, and with it the rows it queued.
    pub waiting: HashSet<String>,
}

/// A row of `pending_writes`, as it is applied.
#[derive(Debug, Clone)]
struct PendingRow {
    /// Its number among its post's writes, or UNNUMBERED: then `write_key` is what tells it apart.
    seq: i64,
    write_key: String,
    kind: String,
    comment_id: Option<String>,
    payload: Option<String>,
    staged_key: Option<String>,
    /// On a comment's like: what it adds to the number of likes the store has of the comment.
    net: Option<i64>,
}

impl PendingRow {
    /// What the row holds, which a row of its kind can't be without.
    fn holds<T: serde::de::DeserializeOwned>(&self) -> Result<T> {
        payload_of::<T>(self.payload.as_deref())?.with_context(|| format!("a pending write of kind \"{}\" holds nothing", self.kind))
    }
}

/// The pending writes of one comment, which are applied together: each kind oldest first.
struct CommentWrites {
    comment_id: String,
    /// What made the comment what it is, in turn: new, edited, held, accepted. The newest is
    /// what it is now.
    puts: Vec<(PendingRow, CommentPutPayload)>,
    /// The likes of it, and the takings back of likes: a row for each user who has one
    /// waiting, which says what they last asked.
    likes: Vec<PendingRow>,
    /// What removes it. The last of its writes: nothing commits to a comment once its removal has.
    removal: Option<PendingRow>,
    /// The comment it replies to, as its puts say; none for one on the post itself, and for
    /// one with no put.
    parent_id: Option<String>,
}

/// What became of a comment's puts.
enum PutOutcome {
    Written,
    /// A reply to a comment of which nothing is left, which was removed with its rows.
    Removed,
    /// A comment that is nothing without the file it came with, which is lost.
    Lost(Box<Comment>),
}

/// What applying works with: of what a compactor has, and the run's lease.
struct Applying<'a> {
    deps: &'a Deps,
    lease: &'a Lease,
    /// Where reposts placed a piece of content, as the run reads it.
    places: &'a Places,
    /// What runs a write to a comment once it is its turn among the run's
    /// (`compact.commentWrites`).
    slot: Semaphore,
}

/// Applies the writes that requests committed and no run has applied yet (`pending_writes`):
/// it is what writes a post's bytes, meta file and summary, and a comment, its likes and its
/// image or video. Nothing else does, and a compactor run is one process at a time (see
/// `Lease`), so no two writers ever write one object, and what is written is what committed,
/// as it was when the last of it committed.
///
/// Posts are applied several at a time. Content that is set for deletion is left as it is,
/// with its rows: nothing more is written to it, and the run deletes it, its comments and the
/// files its rows staged. That is what keeps a write from bringing back what was deleted: the
/// write either committed before the deletion was set, and is never applied, or didn't commit
/// at all.
///
/// Of a post's own writes (`post`) only the newest is applied, since each is the whole post:
///
/// 1. its bytes: the staged file is copied to where the post's bytes are kept, or for a text
///    or a link, written from the row. An image post of several images has a staged file for
///    each, the ones after the first named by rows of their own (`post_file`): each is copied
///    to its place, and the images the post had past those, before an update with fewer, are
///    deleted;
/// 2. its summary, or for content that is withheld, none: the one it had is erased, which is
///    what takes a held update out of the feeds, and an entry whose original is gone from its
///    own server;
/// 3. the terms a search finds it by, which are rows of `search_terms` (see `index_content`):
///    those of the meta file as it is about to be written, withheld or not;
/// 4. its meta file, last, as what it says is there, with its hashtags settled: without the
///    ones moderators removed from the content, without the ones of a repost that was removed
///    and is yet to be taken off it, and with the ones reposts gave it, whatever the write
///    knew of any of them;
/// 5. the rows, this one and the ones it superseded, and then the files they staged.
///
/// Every step can be made again, so a run that stops anywhere leaves the row, and the next
/// run applies it. A staged file goes only after its row has: a row never names a file that
/// is gone. Where the store signs links, it goes later still, when the links given to it have
/// expired (see `settle`), and this is where the ones whose time has come are deleted, before
/// anything else.
///
/// The writes of a post's comments (`comment_put`, `comment_remove`, `comment_like`) are
/// applied a comment at a time, all the writes of one comment together (see
/// `apply_comments`). They don't wait for the post's own write, nor it for them.
///
/// A write that came with a video the server processes says so until the video worker has
/// made the staged file what is published (see `PostPayload::process`). Such a write is left
/// as it is, and so is every older write of its post: the run that finds it processed applies
/// it. A comment's is left the same way, with every other write of that comment and of its
/// replies. The worker changes the row in one commit, so a run reads a write either as it
/// waits or as it is to be applied, and never half of each.
///
/// A failure is logged and left for the next run, and fails nothing else. Returns the meta
/// files written, the posts whose own write failed, and the ones whose write waits for its
/// video.
pub async fn apply_pending(deps: &Deps, lease: &Lease, places: &Places) -> Result<Applied> {
    let applying = Applying {
        deps,
        lease,
        places,
        // Writes to comments, on whatever posts, a set number at a time: beside the posts' own, which are
        // `compact.concurrency` posts at a time.
        slot: Semaphore::new(usize::try_from(deps.config.compact.comment_writes).unwrap_or(1).max(1)),
    };
    let applied = RefCell::new(Applied::default());
    applying.remove_kept().await?;
    let ids = deps
        .db
        .fetch("SELECT DISTINCT content_id FROM pending_writes", &[])
        .await?
        .iter()
        .map(|row| row.string("content_id"))
        .collect::<Result<Vec<String>>>()?;
    map_limit(ids, deps.concurrency(), |id| {
        let (applying, applied) = (&applying, &applied);
        async move { applying.apply_content(&id, applied).await }
    })
    .await?;
    Ok(applied.into_inner())
}

/// The id of the version of its video that a meta file names, of a video post whose video the
/// server processed.
fn video_of(meta: &ContentMeta) -> Option<&str> {
    match (&meta.preview.kind, &meta.preview.video) {
        (PreviewKind::Video, Some(video)) => Some(&video.id),
        _ => None,
    }
}

/// How many images a meta file says its post has: one, unless it is an image post of several.
fn images_of(meta: &ContentMeta) -> i64 {
    meta.images.as_ref().map_or(1, |images| i64::try_from(images.len()).unwrap_or(i64::MAX))
}

impl Applying<'_> {
    /// Applies the pending writes of one post: its own, and those of its comments.
    async fn apply_content(&self, id: &str, applied: &RefCell<Applied>) -> Result<()> {
        let Deps { db, log, .. } = self.deps;
        self.lease.check().await?;
        let post = db
            .fetch_optional(&format!("SELECT {CONTENT_COLUMNS} FROM {CONTENT_FROM} WHERE content.id = ?"), params![id])
            .await?
            .map(|row| ContentRow::of(&row))
            .transpose()?;
        // Gone, and its rows with it; or set for deletion, when the run deletes it with what its rows staged.
        let Some(post) = post.filter(|post| !post.deleting()) else { return Ok(()) };
        // The ones that took no number first, in whatever order: new comments and likes, which are before the numbered
        // writes of what they are of.
        let payload = db.dialect().json_text("payload");
        let rows = db
            .fetch(
                &format!(
                    "SELECT seq, write_key, kind, comment_id, {payload} AS payload, staged_key, net FROM pending_writes WHERE content_id = ? ORDER BY seq, write_key"
                ),
                params![id],
            )
            .await?
            .iter()
            .map(|row| {
                Ok(PendingRow {
                    seq: row.i64("seq")?,
                    write_key: row.opt_string("write_key")?.unwrap_or_default(),
                    kind: row.string("kind")?,
                    comment_id: row.opt_string("comment_id")?,
                    payload: row.opt_string("payload")?,
                    staged_key: row.opt_string("staged_key")?,
                    net: row.opt_i64("net")?,
                })
            })
            .collect::<Result<Vec<PendingRow>>>()?;

        let (mut writes, mut files, mut of_comments) = (Vec::new(), Vec::new(), Vec::new());
        for row in rows {
            match row.kind.as_str() {
                kind::POST => writes.push(row),
                kind::POST_FILE => files.push(row),
                _ => of_comments.push(row),
            }
        }
        if let Some(newest) = writes.last() {
            // A video that is yet to be processed: the write waits for the video worker, and with it the rows it queued.
            if newest.holds::<PostPayload>()?.processing() {
                applied.borrow_mut().waiting.insert(id.to_owned());
            } else {
                match self.apply_post(&post, &writes, &files).await {
                    Ok(meta) => {
                        applied.borrow_mut().metas.insert(id.to_owned(), meta);
                    }
                    Err(err) if is_lease_lost(&err) => return Err(err),
                    Err(err) => {
                        applied.borrow_mut().failed.insert(id.to_owned());
                        log.error(
                            json!({ "err": log::err(&err), "contentId": id, "seq": newest.seq }),
                            "could not apply a write of a post; the next run tries again",
                        );
                    }
                }
            }
        }

        match self.apply_comments(id, of_comments).await {
            Err(err) if is_lease_lost(&err) => Err(err),
            Err(err) => {
                log.error(
                    json!({ "err": log::err(&err), "contentId": id }),
                    "could not apply the writes of a post's comments; the next run tries again",
                );
                Ok(())
            }
            Ok(()) => Ok(()),
        }
    }

    /// Deletes rows of a post that were applied, and sees to the files they staged. Each row
    /// is settled once.
    ///
    /// Where the store gives no links to its files, a staged file is deleted here, after its
    /// row: one that can't be deleted is left for the bucket to expire. Where it signs links,
    /// a reader may hold one to the staged file, given while the write waited, and a file that
    /// was deleted now would fail them. So the file stays, and what says so
    /// (`staged_removals`) commits with the deletion of the row: until then the row names the
    /// file, and from then on that does, and a run deletes the file once the last link that
    /// can have been given to it has expired (see `remove_kept`), or with its post, if that is
    /// deleted first.
    async fn settle(&self, content_id: &str, rows: &[&PendingRow]) -> Result<()> {
        let Deps { db, content, log, .. } = self.deps;
        if rows.is_empty() {
            return Ok(());
        }
        let staged: Vec<&String> = rows.iter().filter_map(|row| row.staged_key.as_ref()).collect();
        let keep_ms = content.link_ms();
        if !staged.is_empty() && keep_ms > 0 {
            let remove_at = self.deps.now() + keep_ms + LINK_MARGIN_MS;
            let mut tx = db.begin().await?;
            delete_rows(&mut tx, content_id, rows).await?;
            for keys in staged.chunks(BATCH) {
                // None is there, unless a run that had lost its lease settled the same row.
                tx.execute(
                    &format!("DELETE FROM staged_removals WHERE staged_key IN ({})", places(keys.len())),
                    &values(keys.iter().copied()),
                )
                .await?;
                let mut params = Vec::with_capacity(keys.len() * 3);
                for key in keys {
                    params.extend([Value::from(*key), Value::from(content_id), Value::from(remove_at)]);
                }
                tx.execute(
                    &format!(
                        "INSERT INTO staged_removals (staged_key, content_id, remove_at) VALUES {}",
                        vec!["(?, ?, ?)"; keys.len()].join(", ")
                    ),
                    &params,
                )
                .await?;
            }
            return tx.commit().await;
        }
        delete_rows(&mut &*db, content_id, rows).await?;
        for key in staged {
            if let Err(err) = content.remove_staged(key).await {
                log.warn(
                    json!({ "err": log::err(&err), "contentId": content_id, "staged": key }),
                    "could not delete a staged file that was applied",
                );
            }
        }
        Ok(())
    }

    /// Deletes the staged files that were kept for the links given to them (see `settle`) and
    /// whose time has come, and then what said to keep them. A file that can't be deleted is
    /// tried again by the next run, and fails nothing.
    async fn remove_kept(&self) -> Result<()> {
        let Deps { db, content, log, .. } = self.deps;
        let due = db
            .fetch(
                "SELECT staged_key FROM staged_removals WHERE remove_at <= ? ORDER BY remove_at LIMIT ?",
                params![self.deps.now(), STAGED_REMOVALS],
            )
            .await?
            .iter()
            .map(|row| row.string("staged_key"))
            .collect::<Result<Vec<String>>>()?;
        if due.is_empty() {
            return Ok(());
        }
        let removed = RefCell::new(Vec::new());
        let outcome = map_limit(due, self.deps.concurrency(), |staged| {
            let removed = &removed;
            async move {
                self.lease.check().await?;
                match content.remove_staged(&staged).await {
                    Ok(()) => removed.borrow_mut().push(staged),
                    Err(err) => log.warn(
                        json!({ "err": log::err(&err), "staged": staged }),
                        "could not delete a staged file whose links have expired; the next run tries again",
                    ),
                }
                Ok(())
            }
        })
        .await;
        for keys in removed.into_inner().chunks(BATCH) {
            db.execute(
                &format!("DELETE FROM staged_removals WHERE staged_key IN ({})", places(keys.len())),
                &values(keys),
            )
            .await?;
        }
        outcome
    }

    /// Applies the newest of a post's own writes (see `apply_pending`), and returns the meta
    /// file it wrote. `writes` are the post's, oldest first, and `files` the rows that name
    /// the images after the first of those that are of several images (`post_file`), each
    /// under its write's number.
    async fn apply_post(&self, post: &ContentRow, writes: &[PendingRow], files: &[PendingRow]) -> Result<ContentMeta> {
        let Deps {
            db,
            config,
            content,
            summaries,
            ..
        } = self.deps;
        let Some(newest) = writes.last() else {
            anyhow::bail!("{} has no write to apply", post.id)
        };
        let payload = newest.holds::<PostPayload>()?;
        let meta = &payload.meta;

        // The bytes first: the meta file, which says what they are, is written once they are there.
        if let Some(staged) = &newest.staged_key {
            content.adopt(staged, BytesOwner::Post(&post.id), &meta.mime_type).await?;
        } else if !payload.keeps_bytes() {
            // Not for an update that keeps the bytes the post has: one whose new video couldn't be processed.
            let (bytes, mime_type) = payload_bytes(meta)?;
            content.put_bytes(BytesOwner::Post(&post.id), bytes, &mime_type).await?;
        }
        // The images after the first, of an image post of several: each to its place among the post's.
        for file in files {
            let Some(staged) = file.staged_key.as_ref().filter(|_| file.seq == newest.seq) else {
                continue;
            };
            let image: i64 = file
                .write_key
                .parse()
                .with_context(|| format!("\"{}\" is not the place of an image among a post's", file.write_key))?;
            let stored = meta.images.as_ref().and_then(|images| images.get(usize::try_from(image - 1).ok()?));
            let mime_type = stored.map_or(&meta.mime_type, |image| &image.mime_type);
            content.adopt(staged, BytesOwner::Image { content_id: &post.id, image }, mime_type).await?;
        }
        // The images the post had past the ones it has now, which an update with fewer left behind. Before the meta
        // file, which is what says how many there are to delete: a run that stops here finds it as it was, and deletes
        // them again.
        let before = if newest.seq > 1 { content.get_meta(&post.id).await? } else { None };
        if let Some(before) = &before {
            for image in images_of(meta).max(1) + 1..=images_of(before) {
                content.remove_image(&post.id, image).await?;
            }
        }
        // The poster and the stream of the versions of its video that this write leaves behind: the one the post had,
        // and those of the writes this one superseded, which were never the post's. Before the meta file, for the same
        // reason.
        let video = video_of(meta);
        let mut left: Vec<String> = Vec::new();
        let superseded = writes[..writes.len() - 1]
            .iter()
            .map(|write| write.holds::<PostPayload>().map(|payload| payload.meta))
            .collect::<Result<Vec<ContentMeta>>>()?;
        for had in before.iter().chain(&superseded) {
            if let Some(id) = video_of(had).filter(|id| Some(*id) != video && !left.iter().any(|seen| seen == id)) {
                left.push(id.to_owned());
            }
        }
        for id in &left {
            content.remove_media(&post.id, Some(id)).await?;
        }

        // The hashtags as they are now, whatever the write knew: a moderator's removal stays, and so does what a repost
        // gave. What a repost that was removed had given goes, while the run is yet to take it off the post: the write
        // may hold it as the post had it, and nothing else says it isn't the publisher's own.
        let removed = db
            .fetch(
                "SELECT tag FROM tag_moderation WHERE content_id = ? AND decision = ?",
                params![&post.id, "removed"],
            )
            .await?
            .iter()
            .map(|row| row.string("tag"))
            .collect::<Result<HashSet<String>>>()?;
        let placed = self.places.placed(&post.id).await?;
        let taken = removed_repost_tags(&mut &*db, &post.id).await?;
        let given = reposted_tags(placed.iter().map(|place| place.tag.as_str()));
        let mut tags: Vec<String> = meta
            .tags
            .iter()
            .filter(|tag| !removed.contains(*tag) && !taken.contains(tag))
            .cloned()
            .collect();
        let own = tags.len();
        for tag in given {
            if !tags[..own].contains(&tag) && !removed.contains(&tag) {
                tags.push(tag);
            }
        }
        let next = ContentMeta { tags, ..meta.clone() };

        // Content that is withheld has no summary: an update that was held loses the one it had, and so does an entry
        // whose original is gone.
        let reposted_at = repost_times(&placed);
        if post.withheld() {
            summaries
                .erase(&SummaryRef {
                    content_id: post.id.clone(),
                    created_at: post.created_at,
                    reposted_at,
                })
                .await?;
        } else {
            summaries.put(&summary_of(post.posted(), &next, &config.public_base_url, &reposted_at)).await?;
        }

        // What a search finds the post by (`search_terms`), from the meta file as it is about to be written: a run that
        // stops between the two applies the write again. Withheld content has its terms too, and a search leaves it
        // out by its row.
        index_content(db, &post.id, post.created_at, &next, max_keywords(self.deps)).await?;

        // The meta file last, as for any write: what it says is there.
        content.put_meta(&next).await?;
        // With the rows of the images: of this write, and of the ones it superseded, whose files were never the post's.
        let rows: Vec<&PendingRow> = writes.iter().chain(files).collect();
        self.settle(&post.id, &rows).await?;
        Ok(next)
    }

    /// Applies the pending writes of a post's comments: `rows`, the ones that took no number
    /// first (new comments, likes), then the numbered ones in the order they committed.
    ///
    /// The writes of one comment are applied together, as what they come to:
    ///
    /// - Its puts are one write, of the comment as the newest of them has it: each is the
    ///   whole comment, so the ones before it are superseded, as a post's are.
    /// - Its likes are applied after that, several at a time: each is an object of its own,
    ///   which a like makes and its taking back deletes.
    /// - Its removal is last, as it committed last: nothing commits to a comment once its
    ///   removal has. A comment that is removed is given no likes first.
    ///
    /// Different comments are written several at a time (COMPACT_COMMENT_WRITES), in two
    /// passes:
    ///
    /// 1. The puts and the likes. A reply waits for the comment it replies to, if that one has
    ///    a put here too: a reply is never written before its comment. So a post's new
    ///    comments are written level by level, the comments on the post first.
    /// 2. The removals, one after another, in the order they committed: whether a removal
    ///    leaves a placeholder depends on what replies to the comment, and whether it takes
    ///    the placeholder above it away on what else replies to that one, which two removals
    ///    at once would both read before either had written. Before the first of them, the
    ///    run waits for the replies to the post's comments that requests are committing (see
    ///    `await_replies`), which is the one lock a run takes on a post, and only on one that
    ///    has removals: a reply that read a comment before its removal committed is then a
    ///    row, and keeps the comment's place.
    ///
    /// A write that fails is logged and left for the next run, with what depends on it: the
    /// rest of that comment's writes, and the replies that waited for it, with theirs. Every
    /// other comment of the post is applied. What is left is applied by a later run as it
    /// would have been by this one: each step looks at what the store has, and can be made
    /// again.
    ///
    /// A comment that came with a video the server is yet to process is left for a later run,
    /// with every write of it and of the comments that reply to it, until the video worker
    /// has made its file what is published. A video that can't be processed is deleted from
    /// where it was staged, and the comment is then one whose file is gone:
    ///
    /// A comment whose image or video is gone from where it was staged can never be applied
    /// as it is: the bucket expired the file, after a week, or somebody deleted it. It is then
    /// published with its text alone, or if the file was all of it, removed as a removal would
    /// remove it, so that nothing waits behind it for good. Either is logged as an error.
    async fn apply_comments(&self, post_id: &str, rows: Vec<PendingRow>) -> Result<()> {
        let log = &self.deps.log;
        let mut by_comment: IndexMap<String, CommentWrites> = IndexMap::new();
        for row in rows {
            let Some(comment_id) = row.comment_id.clone() else {
                log.error(
                    json!({ "contentId": post_id, "seq": row.seq, "kind": row.kind }),
                    "a pending write of a comment names no comment; it is left as it is",
                );
                continue;
            };
            let of = by_comment.entry(comment_id.clone()).or_insert_with(|| CommentWrites {
                comment_id,
                puts: Vec::new(),
                likes: Vec::new(),
                removal: None,
                parent_id: None,
            });
            match row.kind.as_str() {
                kind::COMMENT_PUT => {
                    let put = row.holds::<CommentPutPayload>()?;
                    of.parent_id.clone_from(&put.comment.parent_id);
                    of.puts.push((row, put));
                }
                kind::COMMENT_LIKE => of.likes.push(row),
                kind::COMMENT_REMOVE => of.removal = Some(row),
                // A kind this version doesn't know, from a server that is newer: left for a compactor that does, and
                // never taken for a removal.
                _ => log.error(
                    json!({ "contentId": post_id, "commentId": of.comment_id, "seq": row.seq, "kind": row.kind }),
                    "a pending write of a comment is of a kind this compactor does not know; it is left as it is",
                ),
            }
        }

        // The comments with a put that isn't written yet: what their replies wait for.
        let unwritten: RefCell<HashSet<&str>> = RefCell::new(HashSet::new());
        // The comments with a write that wasn't applied: their removal waits for the next run, as nothing of a comment
        // is applied after its removal.
        let stuck: RefCell<HashSet<&str>> = RefCell::new(HashSet::new());
        // The comments of which nothing is left to do: the reply to nothing that was removed with its rows.
        let over: RefCell<HashSet<&str>> = RefCell::new(HashSet::new());
        // The comments whose file is lost and that had no text: removed in the second pass, each as its newest put had it.
        let lost: RefCell<HashMap<&str, Comment>> = RefCell::new(HashMap::new());

        let mut waiting: Vec<&CommentWrites> = by_comment
            .values()
            .filter(|of| !of.puts.is_empty() || (!of.likes.is_empty() && of.removal.is_none()))
            .collect();
        unwritten
            .borrow_mut()
            .extend(waiting.iter().filter(|of| !of.puts.is_empty()).map(|of| of.comment_id.as_str()));
        // A comment whose video is yet to be processed waits for the video worker, with all of its writes: it stays
        // unwritten, so its replies wait with it, and counts as stuck, so its removal does too. Nothing is logged of
        // it: it is no failure.
        waiting.retain(|of| {
            let processing = of.puts.iter().any(|(_, put)| put.processing());
            if processing {
                stuck.borrow_mut().insert(&of.comment_id);
            }
            !processing
        });
        while !waiting.is_empty() {
            let (ready, rest): (Vec<&CommentWrites>, Vec<&CommentWrites>) = {
                let unwritten = unwritten.borrow();
                waiting
                    .iter()
                    .partition(|of| of.parent_id.as_deref().is_none_or(|parent| !unwritten.contains(parent)))
            };
            // The rest reply to a comment that couldn't be written, or to one of its replies.
            if ready.is_empty() {
                break;
            }
            waiting = rest;
            all_done(ready.into_iter().map(|of| {
                let (unwritten, stuck, over, lost) = (&unwritten, &stuck, &over, &lost);
                async move {
                    let comment_id = of.comment_id.as_str();
                    let outcome = async {
                        if !of.puts.is_empty() {
                            let outcome = {
                                let _turn = self.slot.acquire().await?;
                                self.lease.check().await?;
                                self.apply_puts(post_id, of).await?
                            };
                            unwritten.borrow_mut().remove(comment_id);
                            match outcome {
                                PutOutcome::Written => {}
                                PutOutcome::Removed => {
                                    over.borrow_mut().insert(comment_id);
                                    return Ok(());
                                }
                                PutOutcome::Lost(comment) => {
                                    lost.borrow_mut().insert(comment_id, *comment);
                                    return Ok(());
                                }
                            }
                        }
                        if !of.likes.is_empty() && of.removal.is_none() {
                            self.apply_likes(post_id, of).await?;
                        }
                        Ok(())
                    }
                    .await;
                    match outcome {
                        Err(err) if is_lease_lost(&err) => Err(err),
                        Err(err) => {
                            stuck.borrow_mut().insert(comment_id);
                            log.error(
                                json!({ "err": log::err(&err), "contentId": post_id, "commentId": comment_id }),
                                "could not apply the writes of a comment; they and the writes of its replies wait for the next run",
                            );
                            Ok(())
                        }
                        Ok(()) => Ok(()),
                    }
                }
            }))
            .await?;
        }
        stuck.borrow_mut().extend(waiting.iter().map(|of| of.comment_id.as_str()));

        let (stuck, over, lost) = (stuck.into_inner(), over.into_inner(), lost.into_inner());
        // A comment's place among the removals: where its removal committed, or for one whose file is lost, its newest put.
        let at = |of: &CommentWrites| of.removal.as_ref().or(of.puts.last().map(|(row, _)| row)).map_or(0, |row| row.seq);
        let mut removals: Vec<&CommentWrites> = by_comment
            .values()
            .filter(|of| {
                let id = of.comment_id.as_str();
                (of.removal.is_some() || lost.contains_key(id)) && !stuck.contains(id) && !over.contains(id)
            })
            .collect();
        removals.sort_by_key(|of| at(of));
        if removals.is_empty() {
            return Ok(());
        }
        // A reply takes no lock on its post, so one may be under way that read a comment before its removal committed.
        // Once for the post's removals, the run waits for those: each has then committed, and keeps its comment's
        // place, or failed.
        self.lease.check().await?;
        await_replies(&self.deps.db, post_id).await?;
        for of in removals {
            let outcome = async {
                let _turn = self.slot.acquire().await?;
                self.lease.check().await?;
                self.apply_removal(post_id, of, lost.get(of.comment_id.as_str())).await
            }
            .await;
            match outcome {
                Err(err) if is_lease_lost(&err) => return Err(err),
                Err(err) => log.error(
                    json!({ "err": log::err(&err), "contentId": post_id, "commentId": of.comment_id }),
                    "could not remove a comment; the next run tries again",
                ),
                Ok(()) => {}
            }
        }
        Ok(())
    }

    /// Applies a comment's puts (see `apply_comments`) as one write, of the comment as the
    /// newest has it, and deletes their rows. What the store has of the comment by then,
    /// published, held, or the placeholder an edit left, is what every write before these
    /// left there, and the newest put is written over it as it would have been over what the
    /// puts before it wrote.
    ///
    /// One of the puts before it counts all the same: a comment that was published by one of
    /// them and is held by the newest has a place among the post's comments, which its replies
    /// are listed under. If the store has nothing of it, that place is made, with the
    /// placeholder that holding it would have left.
    ///
    /// Returns `Written`; or `Removed`, for a reply to a comment of which nothing is left,
    /// which is removed with its rows; or `Lost` with the comment, for one that is nothing
    /// without the file it came with, which is lost. A placeholder is then left in its place,
    /// for its replies to be written under, until the removals are made (see `apply_removal`).
    async fn apply_puts(&self, post_id: &str, of: &CommentWrites) -> Result<PutOutcome> {
        let Deps {
            db, content, comments, log, ..
        } = self.deps;
        let comment_id = of.comment_id.as_str();
        let Some((_, newest)) = of.puts.last() else {
            anyhow::bail!("the comment {comment_id} has no write to apply")
        };
        let held = newest.held;
        let mut comment = newest.comment.clone();

        // Its image or video first: a comment that is there to read never lacks its file. Only the put that made the
        // comment staged one.
        for (row, _) in &of.puts {
            let Some(staged) = &row.staged_key else { continue };
            let owner = BytesOwner::Comment { post_id, comment_id };
            let mime_type = comment.media.as_ref().map_or(UNKNOWN_MIME, |media| media.mime_type.as_str());
            let Err(err) = content.adopt(staged, owner, mime_type).await else { continue };
            if !is_not_found(&err) {
                return Err(err);
            }
            // Not where it waited, and it is where it goes: a run that stopped before it deleted the row had copied it.
            if content.stat_if_there(owner).await?.is_some() {
                continue;
            }
            log.error(
                json!({ "contentId": post_id, "commentId": comment_id, "staged": staged }),
                "the file a comment came with is gone from where it waited; the comment is published with its text alone, or removed if it has none",
            );
            if comment.text.is_empty() {
                let removal = Removal {
                    keep_place: true,
                    comment: Some(comment.clone()),
                };
                comments.remove(post_id, comment_id, removal).await?;
                return Ok(PutOutcome::Lost(Box::new(comment)));
            }
            comment.media = None;
        }

        let there = comments.find(post_id, comment_id).await?.is_some();
        // For a reply: whether nothing is left of the comment it replies to, not a placeholder to list it under. No
        // request commits such a reply.
        let orphan = async || -> Result<bool> {
            match &comment.parent_id {
                Some(parent_id) => Ok(comments.find(post_id, parent_id).await?.is_none()),
                None => Ok(false),
            }
        };
        // Removes the reply to nothing, with every row of it.
        let remove_orphan = async || -> Result<PutOutcome> {
            log.warn(
                json!({ "contentId": post_id, "commentId": comment_id, "parentId": comment.parent_id }),
                "a reply was to be published under a comment of which nothing is left; it is removed",
            );
            let removal = Removal {
                keep_place: false,
                comment: Some(comment.clone()),
            };
            comments.remove(post_id, comment_id, removal).await?;
            remove_comment_rows(&mut &*db, post_id, comment_id).await?;
            let rows: Vec<&PendingRow> = of.puts.iter().map(|(row, _)| row).chain(&of.likes).chain(&of.removal).collect();
            self.settle(post_id, &rows).await?;
            Ok(PutOutcome::Removed)
        };

        if held {
            if there {
                // One that was published leaves a placeholder in its place.
                comments.hold(&comment).await?;
            } else if of.puts.iter().any(|(_, put)| !put.held) {
                // Published and then held, both since the last run: where it waits, and then the placeholder in the
                // place it had.
                if orphan().await? {
                    return remove_orphan().await;
                }
                comments.put(&comment, true).await?;
                comments.put(&placeholder(&comment, Gone::Held), false).await?;
            } else {
                // One that never was published is only where comments wait.
                comments.put(&comment, true).await?;
            }
        } else if orphan().await? {
            return remove_orphan().await;
        } else if there || comments.get_held(post_id, comment_id).await?.is_some() {
            // One that is there, waiting or as a placeholder, or as it was before an edit: published as it now is, over
            // what is there.
            comments.publish(&comment).await?;
        } else {
            // A new one, which has no likes yet: put with that number, which saves its first readers the list that
            // would say so.
            comments.put(&comment, false).await?;
        }
        let rows: Vec<&PendingRow> = of.puts.iter().map(|(row, _)| row).collect();
        self.settle(post_id, &rows).await?;
        Ok(PutOutcome::Written)
    }

    /// Applies the likes of a comment (see `apply_comments`), and settles their rows: those of
    /// the likes that were applied, if one fails. A row is a user's like of the comment, or
    /// the taking back of it (`unlike`), and a user has one for a comment: the like is made in
    /// the store, or taken away from it. A comment's likes are a comment's that is there, or
    /// that an edit took back to the queue; not a deleted one's, nor those of one that was
    /// never published, whose rows are deleted with nothing done.
    ///
    /// A row that leaves the store as it is (`net` 0: a like taken back before it was made, or
    /// one given again before its taking back was applied) is checked against the store, and
    /// applied only if the store isn't as the row says: that is so after a run that stopped
    /// half way.
    async fn apply_likes(&self, post_id: &str, of: &CommentWrites) -> Result<()> {
        let comments = &self.deps.comments;
        let comment_id = of.comment_id.as_str();
        let liked = comments.find(post_id, comment_id).await?;
        if liked.is_none_or(|comment| comment.gone == Some(Gone::Deleted)) {
            let rows: Vec<&PendingRow> = of.likes.iter().collect();
            return self.settle(post_id, &rows).await;
        }
        let applied: RefCell<Vec<(&PendingRow, bool)>> = RefCell::new(Vec::new());
        // From the first like applied to the last row settled, what a row asks is both in the store and a row: the
        // requests that count the two are told, and count again once this is over.
        let done = comments.making_likes(comment_id).await?;
        let outcome = all_done(of.likes.iter().map(|row| {
            let applied = &applied;
            async move {
                let _turn = self.slot.acquire().await?;
                self.lease.check().await?;
                let like = row.holds::<CommentLikePayload>()?;
                let unlike = like.unlikes();
                if row.net != Some(0) || comments.liked(post_id, comment_id, &like.user_id).await? == unlike {
                    if unlike {
                        comments.remove_like(post_id, comment_id, &like.user_id).await?;
                    } else {
                        comments.add_like(post_id, comment_id, &like.user_id).await?;
                    }
                }
                applied.borrow_mut().push((row, unlike));
                Ok(())
            }
        }))
        .await;
        let settled = self.settle_likes(post_id, &applied.into_inner()).await;
        outcome?;
        settled?;
        // Not after a failure: a like may then be in the store with its row still there, until the next run, which is
        // over when it says so.
        done.done().await
    }

    /// Settles the rows of a comment's likes that were applied (see `apply_likes`). A row that
    /// still says what was applied is deleted. One that the user changed meanwhile stays, for
    /// the next run, and is made to count for what it now is against the store, which has what
    /// this run applied: a like the store lacks, or the taking back of one it has
    /// (`pending_writes.net`).
    ///
    /// The rows are locked as they are read, and a request locks the row it changes, so each
    /// row is either deleted as it was applied or left as the request made it, and never
    /// deleted with a change the run didn't apply.
    async fn settle_likes(&self, post_id: &str, applied: &[(&PendingRow, bool)]) -> Result<()> {
        let db = &self.deps.db;
        let dialect = db.dialect();
        let payload = dialect.json_text("payload");
        // SQLite runs one transaction at a time, and has no rows to lock.
        let lock = if dialect == evieverse_core::db::Dialect::Sqlite { "" } else { " FOR UPDATE" };
        let of = |keys: &[&String]| {
            let mut params = vec![Value::from(post_id), Value::from(UNNUMBERED)];
            params.extend(values(keys.iter().copied()));
            (format!("content_id = ? AND seq = ? AND write_key IN ({})", places(keys.len())), params)
        };
        for batch in applied.chunks(BATCH) {
            let asked: HashMap<&str, bool> = batch.iter().map(|(row, unlike)| (row.write_key.as_str(), *unlike)).collect();
            let keys: Vec<&String> = batch.iter().map(|(row, _)| &row.write_key).collect();
            let mut tx = db.begin().await?;
            let (rows, params) = of(&keys);
            let now = tx
                .fetch(
                    &format!("SELECT write_key, {payload} AS payload FROM pending_writes WHERE {rows}{lock}"),
                    &params,
                )
                .await?;
            let (mut same, mut likes, mut unlikes) = (Vec::new(), Vec::new(), Vec::new());
            for row in &now {
                let key = row.string("write_key")?;
                let unlike = payload_of::<CommentLikePayload>(row.opt_str("payload")?)?.is_some_and(|like| like.unlikes());
                if asked.get(key.as_str()) == Some(&unlike) {
                    same.push(key);
                } else if unlike {
                    unlikes.push(key);
                } else {
                    likes.push(key);
                }
            }
            if !same.is_empty() {
                let (rows, params) = of(&same.iter().collect::<Vec<_>>());
                tx.execute(&format!("DELETE FROM pending_writes WHERE {rows}"), &params).await?;
            }
            for (keys, net) in [(&likes, 1_i64), (&unlikes, -1)] {
                if keys.is_empty() {
                    continue;
                }
                let (rows, mut params) = of(&keys.iter().collect::<Vec<_>>());
                params.insert(0, Value::from(net));
                tx.execute(&format!("UPDATE pending_writes SET net = ? WHERE {rows}"), &params).await?;
            }
            tx.commit().await?;
        }
        Ok(())
    }

    /// Removes a comment (see `apply_comments`), and deletes the rows of it that are left: its
    /// removal, and the likes that committed before that, which are made for nothing. If
    /// something replies to it, a placeholder is left in its place; if nothing does, nothing
    /// of it is left, and the placeholder of the deleted comment it replied to goes too, if
    /// this was the last reply to it.
    ///
    /// `lost` is the comment, for one that is removed because its file is lost: its puts are
    /// still rows, which go last, and what stands in its place is the placeholder `apply_puts`
    /// left.
    async fn apply_removal(&self, post_id: &str, of: &CommentWrites, lost: Option<&Comment>) -> Result<()> {
        let Deps { db, comments, .. } = self.deps;
        let comment_id = of.comment_id.as_str();
        let parent_id = match &of.removal {
            Some(removal) => payload_of::<CommentRemovePayload>(removal.payload.as_deref())?.and_then(|removal| removal.parent_id),
            None => None,
        };
        let was = match lost {
            Some(lost) => Some(lost.clone()),
            None => match comments.find(post_id, comment_id).await? {
                Some(found) => Some(found),
                None => comments.get_held(post_id, comment_id).await?,
            },
        };
        // Nothing of it, or the placeholder a run that stopped here left: there is only what follows to do.
        if let Some(was) = was.as_ref().filter(|was| lost.is_some() || was.gone != Some(Gone::Deleted)) {
            let removal = Removal {
                keep_place: has_replies(self.deps, post_id, comment_id, None).await?,
                comment: Some(was.clone()),
            };
            comments.remove(post_id, comment_id, removal).await?;
        }
        // It may have been the last reply to a deleted comment, whose placeholder then stands for nothing. Its own rows,
        // if it has any left, reply to nothing any more.
        if comments.find(post_id, comment_id).await?.is_none() {
            let above = parent_id.or_else(|| was.and_then(|was| was.parent_id));
            prune(self.deps, post_id, above, Some(comment_id)).await?;
        }
        remove_comment_rows(&mut &*db, post_id, comment_id).await?;
        let puts = of.puts.iter().map(|(row, _)| row).filter(|_| lost.is_some());
        let rows: Vec<&PendingRow> = puts.chain(&of.likes).chain(&of.removal).collect();
        self.settle(post_id, &rows).await
    }
}

/// The most words of its text a post is found by, as the settings say.
pub fn max_keywords(deps: &Deps) -> usize {
    usize::try_from(deps.config.search.max_keywords).unwrap_or(0)
}

/// Deletes rows of a post: the numbered ones by their numbers, and the ones that took none by
/// their keys.
async fn delete_rows(db: &mut impl Queries, content_id: &str, rows: &[&PendingRow]) -> Result<()> {
    let seqs: Vec<i64> = rows.iter().filter(|row| row.seq != UNNUMBERED).map(|row| row.seq).collect();
    let keys: Vec<&String> = rows.iter().filter(|row| row.seq == UNNUMBERED).map(|row| &row.write_key).collect();
    for batch in seqs.chunks(BATCH) {
        let mut params = vec![Value::from(content_id)];
        params.extend(batch.iter().map(|seq| Value::from(*seq)));
        db.execute(
            &format!("DELETE FROM pending_writes WHERE content_id = ? AND seq IN ({})", places(batch.len())),
            &params,
        )
        .await?;
    }
    for batch in keys.chunks(BATCH) {
        let mut params = vec![Value::from(content_id), Value::from(UNNUMBERED)];
        params.extend(values(batch.iter().copied()));
        db.execute(
            &format!(
                "DELETE FROM pending_writes WHERE content_id = ? AND seq = ? AND write_key IN ({})",
                places(batch.len())
            ),
            &params,
        )
        .await?;
    }
    Ok(())
}
