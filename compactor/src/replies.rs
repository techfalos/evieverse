//! What a removal of a comment leaves: whether anything replies to it, the placeholders that
//! stand for nothing once it is gone, and its rows in the two queues (see src/comments.ts).

use anyhow::Result;
use evieverse_core::comments::{Gone, Removal};
use evieverse_core::db::Queries;
use evieverse_core::params;
use evieverse_core::pending::{CommentPutPayload, kind, payload_of};

use crate::deps::Deps;

/// Whether anything replies to a comment: a published comment, or the placeholder of one, or
/// a reply that waits in the moderation queue. One that waits is in no index, so those are
/// found by the post's rows in the queue, which are few. Not to be called inside a
/// transaction: it reads the database on its own.
///
/// It reads the comment store, as the compactor applies a removal: the post's comments that
/// were written before the removal are in the store by then, or still among the post's
/// pending writes, if one of theirs couldn't be applied or committed since the run read them.
/// A new reply takes no lock on its post, so one that read the comment before its removal
/// committed may commit after it: the run has waited for those (see `await_replies`), and
/// they are among the pending writes too. None begins later, as a comment takes no reply once
/// its removal has committed. A write that committed after the removal may also be of a reply
/// the comment had: an edit of one, or a held one that a moderator accepted, which is then
/// out of the queue and not published yet. So the post's pending writes are looked at as well.
///
/// `without` is a comment whose own pending writes don't count: one that is being removed,
/// and so replies to nothing any more, though its rows are still there.
pub async fn has_replies(deps: &Deps, post_id: &str, comment_id: &str, without: Option<&str>) -> Result<bool> {
    let Deps { db, comments, .. } = deps;
    if comments.count(post_id, Some(comment_id)).await? > 0 {
        return Ok(true);
    }
    // The queue's rows before the pending writes: accepting a reply, or an edit of one, moves it from the one to the other
    // in one commit, and so it is found in one of the two.
    let queued = db
        .fetch(
            "SELECT comment_id FROM comment_queue WHERE content_id = ? AND comment_id != ?",
            params![post_id, comment_id],
        )
        .await?;
    let payload = db.dialect().json_text("payload");
    let writes = db
        .fetch(
            &format!("SELECT {payload} AS payload FROM pending_writes WHERE content_id = ? AND kind = ?"),
            params![post_id, kind::COMMENT_PUT],
        )
        .await?;
    for write in writes {
        if let Some(put) = payload_of::<CommentPutPayload>(write.opt_str("payload")?)?
            && put.comment.parent_id.as_deref() == Some(comment_id)
            && Some(put.comment.comment_id.as_str()) != without
        {
            return Ok(true);
        }
    }
    for row in queued {
        let id = row.str("comment_id")?;
        if Some(id) != without
            && let Some(held) = comments.get_held(post_id, id).await?
            && held.parent_id.as_deref() == Some(comment_id)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Removes the placeholder of a deleted comment that nothing replies to any more, and then
/// that of the comment it replied to, and so on up. After a comment was removed altogether:
/// that may have been the last reply to a deleted comment, whose placeholder then stands for
/// nothing. `without` is the comment that was removed (see `has_replies`).
pub async fn prune(deps: &Deps, post_id: &str, parent_id: Option<String>, without: Option<&str>) -> Result<()> {
    let mut parent_id = parent_id;
    while let Some(id) = parent_id {
        let Some(parent) = deps.comments.find(post_id, &id).await? else {
            return Ok(());
        };
        if parent.gone != Some(Gone::Deleted) || has_replies(deps, post_id, &id, without).await? {
            return Ok(());
        }
        parent_id = parent.parent_id.clone();
        deps.comments
            .remove(
                post_id,
                &id,
                Removal {
                    keep_place: false,
                    comment: Some(parent),
                },
            )
            .await?;
    }
    Ok(())
}

/// Takes a comment out of the two queues: the row that says it waits in one, and the reports
/// of it.
pub async fn remove_comment_rows(db: &mut impl Queries, post_id: &str, comment_id: &str) -> Result<()> {
    db.execute(
        "DELETE FROM comment_queue WHERE comment_id = ? AND content_id = ?",
        params![comment_id, post_id],
    )
    .await?;
    db.execute(
        "DELETE FROM comment_reports WHERE comment_id = ? AND content_id = ?",
        params![comment_id, post_id],
    )
    .await?;
    Ok(())
}
