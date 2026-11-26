//! What the rows of `pending_writes` hold: the writes that requests committed and that the
//! compactor applies (see src/pending.ts). A request never writes a post's bytes, meta file
//! or summary, nor a comment: it commits a row, and the compactor writes the stores from the
//! rows. The payloads here are the JSON those rows carry, as src/pending.types.ts has them.

use anyhow::{Result, bail};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::comments::Comment;
use crate::config::Dialect;
use crate::content::{ContentMeta, ContentStore};
use crate::db::{Db, Queries};
use crate::posts::{LINK_MIME, PreviewKind};

/// The `seq` of a write that took no number: before every numbered write of its post, which
/// count from 1.
pub const UNNUMBERED: i64 = 0;

/// The first key of the PostgreSQL advisory locks that a reply takes and `await_replies` waits
/// for, which keeps them apart from any other advisory lock taken in the database. The second
/// is a hash of the post's id.
const REPLY_LOCK: i64 = 1_702_258_021;

/// The kinds of write a row of `pending_writes` is of, as its `kind` names them.
pub mod kind {
    /// A write of a post: its meta file, and its bytes or the file that holds them.
    pub const POST: &str = "post";
    /// One image after the first of a write of an image post of several.
    pub const POST_FILE: &str = "post_file";
    /// A comment as it is from this write on: new, edited or accepted.
    pub const COMMENT_PUT: &str = "comment_put";
    /// The removal of a comment.
    pub const COMMENT_REMOVE: &str = "comment_remove";
    /// A like of a comment, or its taking back.
    pub const COMMENT_LIKE: &str = "comment_like";
}

/// What a `post` row holds: the post's meta file as the write made it, which the compactor
/// writes with the hashtags settled. A text post's text and a link's URL are in it; a file's
/// bytes wait under the row's `staged_key`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostPayload {
    pub meta: ContentMeta,
    /// The write's file is a video that is yet to be processed: the compactor leaves the
    /// write until the video worker has put the processed file in the row and taken this off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process: Option<bool>,
    /// The write has no file of its own, and the post keeps the bytes it has: what the video
    /// worker makes of an update whose new video couldn't be processed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keep_bytes: Option<bool>,
    /// Whatever else a row written by a later version says, which is kept as it is.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl PostPayload {
    /// Whether the write's file is a video that is yet to be processed.
    pub fn processing(&self) -> bool {
        self.process == Some(true)
    }

    /// Whether the post keeps the bytes it has.
    pub fn keeps_bytes(&self) -> bool {
        self.keep_bytes == Some(true)
    }
}

/// What a `comment_put` row holds: the comment as it is from this write on, new, edited or
/// accepted, and whether it waits in the moderation queue (`held`) or is published.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentPutPayload {
    pub comment: Comment,
    pub held: bool,
    /// On the write that made a comment with a video that is yet to be processed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process: Option<bool>,
    /// Whatever else a row written by a later version says, which is kept as it is.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl CommentPutPayload {
    /// Whether the comment came with a video that is yet to be processed.
    pub fn processing(&self) -> bool {
        self.process == Some(true)
    }
}

/// What a `comment_remove` row holds: the comment that the removed one replied to, if it was
/// a reply.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentRemovePayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
}

/// What a `comment_like` row holds: whose like of the comment the row names it is about, and
/// whether it makes the like or takes it back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentLikePayload {
    pub user_id: String,
    /// The row takes the user's like back. Left out of a like.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unlike: Option<bool>,
}

impl CommentLikePayload {
    /// Whether the row takes the like back.
    pub fn unlikes(&self) -> bool {
        self.unlike == Some(true)
    }
}

/// What a row's `payload` holds: the JSON a write stored there, as text. None for a row that
/// holds none, and for one whose payload is JSON's null.
pub fn payload_of<T: DeserializeOwned>(payload: Option<&str>) -> Result<Option<T>> {
    match payload {
        None => Ok(None),
        Some(json) => Ok(crate::json::from_str::<Option<T>>(json)?),
    }
}

/// The key of a user's like of a comment among the unnumbered writes of its post: a user's
/// second like of the comment has the same, and fails.
pub fn like_key(comment_id: &str, user_id: &str) -> String {
    format!("{comment_id}:{user_id}")
}

/// The bytes of a post that came with no file, which its meta file holds: a text post's text,
/// a link's URL, and for a repost of a post on another server the original's address, stored
/// as a link's is. With the content type they are stored as. Fails for a post whose bytes are
/// a file.
pub fn payload_bytes(meta: &ContentMeta) -> Result<(Vec<u8>, String)> {
    if let Some(origin) = &meta.origin {
        return Ok((origin.url.clone().into_bytes(), LINK_MIME.to_owned()));
    }
    match (meta.preview.kind, &meta.preview.url, &meta.text) {
        (PreviewKind::Link, Some(url), _) => Ok((url.clone().into_bytes(), LINK_MIME.to_owned())),
        (PreviewKind::Text, _, Some(text)) => Ok((text.clone().into_bytes(), meta.mime_type.clone())),
        _ => bail!("the bytes of {} are a file, which its write has to stage", meta.content_id),
    }
}

/// Waits for the replies to the post's comments that are under way to commit or fail (see
/// `replying` in src/pending.ts), and lets the ones that begin meanwhile through once they
/// have. The compactor's, before it applies the removals it has read of a post's comments.
/// From then on, every reply to one of those comments either has committed, and is among the
/// post's pending writes, or reads the comment after its removal committed, and is refused.
/// So no reply is left under a comment of which nothing is.
///
/// On PostgreSQL an advisory lock, and on MySQL the lock on the post's row. SQLite runs one
/// transaction at a time, and has nothing to wait for.
pub async fn await_replies(db: &Db, content_id: &str) -> Result<()> {
    let dialect = db.dialect();
    if dialect == Dialect::Sqlite {
        return Ok(());
    }
    let mut tx = db.begin().await?;
    if dialect == Dialect::Postgres {
        tx.fetch(
            &format!("SELECT pg_advisory_xact_lock(CAST({REPLY_LOCK} AS int4), hashtext(CAST(? AS text)))"),
            crate::params![content_id],
        )
        .await?;
    } else {
        tx.fetch("SELECT id FROM content WHERE id = ? FOR UPDATE", crate::params![content_id]).await?;
    }
    tx.commit().await
}

/// The most images a write of the post that hasn't been applied gives it: 1 if there is none,
/// and for a post that is no image post of several. A run that stopped while it applied such
/// a write may have left that many files where the post's images are kept, whatever the
/// post's meta file says, so this is what a post's deletion counts with.
pub async fn pending_images(db: &mut impl Queries, content_id: &str) -> Result<i64> {
    let payload = db.dialect().json_text("payload");
    let rows = db
        .fetch(
            &format!("SELECT {payload} AS payload FROM pending_writes WHERE content_id = ? AND kind = ?"),
            crate::params![content_id, kind::POST],
        )
        .await?;
    let mut most = 1;
    for row in rows {
        if let Some(write) = payload_of::<PostPayload>(row.opt_str("payload")?)? {
            most = most.max(write.meta.images.map_or(1, |images| i64::try_from(images.len()).unwrap_or(i64::MAX)));
        }
    }
    Ok(most)
}

/// The post's meta file as it is with every write that has committed: the newest pending
/// write's, or with none, the one in the content store. None for a post that has neither.
///
/// The rows first, then the file: the compactor writes the file before it deletes the row, so
/// a write that is in neither when its row is looked for is in the file by the time that is
/// read.
pub async fn effective_meta(db: &Db, content: &ContentStore, content_id: &str) -> Result<Option<ContentMeta>> {
    effective_meta_in(&mut &*db, content, content_id).await
}

/// As `effective_meta`, read by whatever runs statements: a transaction that writes the post
/// reads it as it is once the transaction has the post's row.
pub async fn effective_meta_in(db: &mut impl Queries, content: &ContentStore, content_id: &str) -> Result<Option<ContentMeta>> {
    let payload = db.dialect().json_text("payload");
    let newest = db
        .fetch_optional(
            &format!("SELECT {payload} AS payload FROM pending_writes WHERE content_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1"),
            crate::params![content_id, kind::POST],
        )
        .await?;
    if let Some(row) = newest
        && let Some(write) = payload_of::<PostPayload>(row.opt_str("payload")?)?
    {
        return Ok(Some(write.meta));
    }
    content.get_meta(content_id).await
}

/// What else a numbered write changes of its post's row, beside taking the number.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RowChange {
    pub ai_generated: Option<bool>,
    /// When the original of a repost of a post on another server was first found gone, or
    /// that it is there (`Some(None)`).
    pub origin_gone_at: Option<Option<i64>>,
    /// When that original's server is next asked about it.
    pub origin_check_at: Option<i64>,
}

/// Takes the post's next write number, and with it the lock on the post's row until the
/// transaction ends: what a numbered write begins with. None for content that isn't there or
/// is set for deletion: nothing is written to it, or under it, any more.
pub async fn next_seq(tx: &mut impl Queries, content_id: &str, change: RowChange) -> Result<Option<i64>> {
    let mut set = vec!["seq = seq + 1"];
    let mut params: Vec<crate::db::Value> = vec![];
    if let Some(ai_generated) = change.ai_generated {
        set.push("ai_generated = ?");
        params.push(ai_generated.into());
    }
    if let Some(gone_at) = change.origin_gone_at {
        set.push("origin_gone_at = ?");
        params.push(gone_at.into());
    }
    if let Some(check_at) = change.origin_check_at {
        set.push("origin_check_at = ?");
        params.push(check_at.into());
    }
    params.push(content_id.into());
    let updated = tx
        .execute(
            &format!("UPDATE content SET {} WHERE id = ? AND delete_requested_at IS NULL", set.join(", ")),
            &params,
        )
        .await?;
    if updated != 1 {
        return Ok(None);
    }
    let row = tx.fetch_optional("SELECT seq FROM content WHERE id = ?", crate::params![content_id]).await?;
    row.map(|row| row.i64("seq")).transpose()
}

/// A write as its row of `pending_writes` holds it.
#[derive(Debug, Clone, Default)]
pub struct PendingWrite<'a> {
    pub content_id: &'a str,
    /// The post's write number, or UNNUMBERED.
    pub seq: i64,
    /// What tells the rows of one number apart: the key of an unnumbered write, and the place
    /// of an image after the first among its write's.
    pub write_key: Option<&'a str>,
    pub kind: &'a str,
    pub comment_id: Option<&'a str>,
    /// What the row holds, as JSON.
    pub payload: Option<String>,
    /// Where the file of the write waits in the content store.
    pub staged_key: Option<&'a str>,
    pub at: i64,
}

/// Adds a write to `pending_writes`: a numbered one, in the transaction that took its number.
pub async fn insert_pending(tx: &mut impl Queries, write: &PendingWrite<'_>) -> Result<()> {
    let json = tx.dialect().json_place();
    let (key_column, key_place) = if write.write_key.is_some() { (", write_key", ", ?") } else { ("", "") };
    let mut params: Vec<crate::db::Value> = vec![write.content_id.into(), write.seq.into()];
    if let Some(key) = write.write_key {
        params.push(key.into());
    }
    params.extend([
        write.kind.into(),
        write.comment_id.into(),
        write.payload.as_deref().into(),
        write.staged_key.into(),
        write.at.into(),
    ]);
    tx.execute(
        &format!("INSERT INTO pending_writes (content_id, seq{key_column}, kind, comment_id, payload, staged_key, created_at) VALUES (?, ?{key_place}, ?, ?, {json}, ?, ?)"),
        &params,
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_like_from_a_row_that_holds_nothing() {
        assert_eq!(payload_of::<CommentLikePayload>(None).unwrap(), None);
        assert_eq!(payload_of::<CommentLikePayload>(Some("null")).unwrap(), None);
        let back = payload_of::<CommentLikePayload>(Some(r#"{"userId":"u","unlike":true}"#)).unwrap().unwrap();
        assert!(back.unlikes());
        assert_eq!(like_key("c", "u"), "c:u");
    }

    #[test]
    fn keeps_what_it_does_not_know_of_a_payload() {
        let json = r#"{"meta":{"contentId":"c","mimeType":"text/plain","size":2,"aiGenerated":false,"preview":{"kind":"text","text":"hi"},"text":"hi","tags":["news"],"updatedAt":7,"later":{"a":1}},"process":true,"more":[1,2]}"#;
        let payload = payload_of::<PostPayload>(Some(json)).unwrap().unwrap();
        assert!(payload.processing() && !payload.keeps_bytes());
        let written: Value = serde_json::to_value(&payload).unwrap();
        assert_eq!(written, serde_json::from_str::<Value>(json).unwrap());
        assert_eq!(payload_bytes(&payload.meta).unwrap(), (b"hi".to_vec(), "text/plain".to_owned()));
    }
}
