//! The server's blocked words: a post that has a word or phrase of the list its admins keep,
//! or that one of the list's patterns matches, isn't trusted at all, and neither is a
//! comment, nor what a user puts on their profile. Its text or caption or link, its filename
//! and its hashtags are read (see `scan_texts`); of a profile, the bio, the links and the
//! filename of the avatar or of the splash image.
//!
//! Each hashtag's own list, which its moderators keep, isn't a matter of trust: a post with
//! one of its words only loses that hashtag (see `moderate_post`), and a comment has no
//! hashtags, nor has a profile.

use anyhow::Result;
use async_trait::async_trait;
use evieverse_core::params;

use crate::trust::{MIN_TRUST_SCORE, TrustChange, TrustContext, TrustPlugin, TrustPost, msg};
use crate::words::{SERVER_LIST, scan_texts};

struct BlockedWords;

#[async_trait]
impl TrustPlugin for BlockedWords {
    async fn assess(&self, post: &TrustPost, ctx: &TrustContext<'_>) -> Result<Option<TrustChange>> {
        let rows = ctx.db.fetch("SELECT word FROM blocked_words WHERE tag = ?", params![SERVER_LIST]).await?;
        // With nothing blocked, nothing needs reading: the texts are scanned only where there are words.
        if rows.is_empty() {
            return Ok(None);
        }
        let words = rows.iter().map(|row| row.string("word")).collect::<Result<Vec<_>>>()?;
        let texts: Vec<String> = post.texts.iter().chain(&post.tags).cloned().collect();
        if !scan_texts(&[(SERVER_LIST.to_owned(), words)], &texts, ctx.log).contains(SERVER_LIST) {
            return Ok(None);
        }
        let key = if post.profile {
            "user.profile_blocked_word"
        } else if post.comment_on.is_none() {
            "moderation.blocked_word"
        } else {
            "comment.blocked_word"
        };
        Ok(Some(TrustChange::set(MIN_TRUST_SCORE).because(msg(key))))
    }
}

/// The plugin, as the registry asks for it (see build.rs).
pub fn plugin() -> Box<dyn TrustPlugin> {
    Box::new(BlockedWords)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::trust::tests::World;

    async fn block(world: &World, tag: &str, word: &str) {
        world.db.execute("INSERT INTO blocked_words (tag, word, created_at) VALUES (?, ?, ?)", params![tag, word, 1_i64]).await.unwrap();
    }

    fn post(texts: &[&str], tags: &[&str]) -> TrustPost {
        TrustPost { user_id: "u1".into(), texts: texts.iter().map(|t| (*t).to_owned()).collect(), tags: tags.iter().map(|t| (*t).to_owned()).collect(), ..TrustPost::default() }
    }

    #[tokio::test]
    async fn a_post_with_a_word_of_the_servers_list_is_not_trusted_at_all() {
        let world = World::new(json!({})).await;
        let plugin = plugin();
        assert_eq!(plugin.assess(&post(&["free spam"], &[]), &world.ctx()).await.unwrap(), None);
        block(&world, SERVER_LIST, "spam").await;
        block(&world, SERVER_LIST, "/垃圾|广告/").await;
        // A hashtag's list is its moderators' matter, and not one of trust.
        block(&world, "cats", "dogs").await;

        let refused = |key: &str| Some(TrustChange::set(0).because(msg(key)));
        assert_eq!(plugin.assess(&post(&["Free SPAM!"], &[]), &world.ctx()).await.unwrap(), refused("moderation.blocked_word"));
        assert_eq!(plugin.assess(&post(&["这是垃圾邮件"], &[]), &world.ctx()).await.unwrap(), refused("moderation.blocked_word"));
        // Its hashtags are read too.
        assert_eq!(plugin.assess(&post(&["fine"], &["spam"]), &world.ctx()).await.unwrap(), refused("moderation.blocked_word"));
        assert_eq!(plugin.assess(&post(&["dogs and spammers"], &["cats"]), &world.ctx()).await.unwrap(), None);

        let comment = TrustPost { comment_on: Some("p1".into()), ..post(&["spam"], &[]) };
        assert_eq!(plugin.assess(&comment, &world.ctx()).await.unwrap(), refused("comment.blocked_word"));
        let profile = TrustPost { profile: true, ..post(&["a bio of spam"], &[]) };
        assert_eq!(plugin.assess(&profile, &world.ctx()).await.unwrap(), refused("user.profile_blocked_word"));
    }
}
