//! Finishing the deletion of accounts that were closed (see src/accounts.ts): the request
//! marks the user deleted and sets their content for deletion, and the compactor deletes the
//! row once none of that content is left.

use anyhow::Result;
use evieverse_core::db::Db;
use evieverse_core::log;
use evieverse_core::params;
use serde_json::json;

use crate::deps::Deps;

/// Sets for deletion the content of a deleted account that isn't yet: what a request that was
/// under way when the account closed wrote, or what a request that closed it didn't get to.
/// Nothing new is written by an account whose keys are revoked, so this ends.
pub async fn sweep_content(deps: &Deps, user_id: &str) -> Result<()> {
    deps.db
        .execute(
            "UPDATE content SET delete_requested_at = ? WHERE user_id = ? AND delete_requested_at IS NULL",
            params![deps.now(), user_id],
        )
        .await?;
    Ok(())
}

/// Deletes what the content store holds of the avatars of the deleted accounts `user_ids`:
/// the one each has, and any that a request which died midway left under the user's id.
/// Returns the accounts it is done for, whose rows name no avatar from then on, and so can be
/// purged. One the store fails for is logged and left as it is, for a later run.
///
/// It asks the store about every account it is given, and not only those whose row names an
/// avatar: a file that no row names is found no other way.
pub async fn drop_avatars(deps: &Deps, user_ids: &[String]) -> Vec<String> {
    let mut cleared = Vec::with_capacity(user_ids.len());
    for user_id in user_ids {
        let dropped = async {
            deps.content.remove_avatars(user_id).await?;
            deps.db
                .execute(
                    "UPDATE users SET avatar_id = NULL, avatar_type = NULL WHERE id = ? AND deleted_at IS NOT NULL AND avatar_id IS NOT NULL",
                    params![user_id],
                )
                .await
        }
        .await;
        match dropped {
            Ok(_) => cleared.push(user_id.clone()),
            Err(err) => deps.log.warn(
                json!({ "err": log::err(&err), "userId": user_id }),
                "could not delete the avatar of a deleted account",
            ),
        }
    }
    cleared
}

/// Deletes the rows of the deleted accounts among `user_ids` that have no content left,
/// nothing they reposted left in their own index, and no avatar (see `drop_avatars`), and
/// returns whose. What references a user and doesn't cascade is set to null (who moderated a
/// hashtag's post, who banned a user, who sent a message, who gave a post a hashtag by
/// reposting it).
///
/// The check is part of the DELETE, not before it: an insert of content for the user that
/// comes between a check and a delete would be cascaded away, with the post's entries still
/// in the index.
pub async fn purge_accounts(db: &Db, user_ids: &[String]) -> Result<Vec<String>> {
    let mut purged = Vec::new();
    for user_id in user_ids {
        // Nor an avatar the content store may still hold: the row is what says there is one to delete. Nor a post of
        // someone else's that they reposted, still in their own index: the compactor finds those by this row.
        let deleted = db
            .execute(
                "DELETE FROM users WHERE id = ? AND deleted_at IS NOT NULL AND avatar_id IS NULL \
                 AND NOT EXISTS (SELECT content.id FROM content WHERE content.user_id = users.id) \
                 AND NOT EXISTS (SELECT reposts.content_id FROM reposts WHERE reposts.user_id = users.id AND reposts.tag LIKE '@%')",
                params![user_id],
            )
            .await?;
        if deleted > 0 {
            purged.push(user_id.clone());
        }
    }
    Ok(purged)
}
