//! Moderation of what the server is sent: a post, a comment, what a user puts on their
//! profile, and a repost. Each goes through the trust plugins, which give it a score, and the
//! score says where it goes (see `route_of`); a post's hashtags are then held to what their
//! moderators keep: mutes, removals and blocked words.
//!
//! What there is to read comes as its readers read it: the API makes a text plain (without
//! its formatting, with where its links lead) before it is given here.

use std::collections::HashSet;

use anyhow::Result;
use evieverse_core::config::Config;
use evieverse_core::db::{Db, Value, places};
use evieverse_core::log::Logger;
use evieverse_core::time::Clock;
use serde::Serialize;

use crate::trust::{MAX_TRUST_SCORE, Plugins, Reason, TrustClient, TrustContext, TrustImage, TrustPost, TrustRoute, msg, route_of, trust_of};
use crate::words::scan_texts;

/// What moderation works with: the database, the settings, the trust plugins, the clock,
/// the log of the request (which is told of a blocked pattern that took too long to read the
/// post), the log of the process, and who sent the request.
#[derive(Clone, Copy)]
pub struct Moderation<'a> {
    pub db: &'a Db,
    pub config: &'a Config,
    pub plugins: &'a Plugins,
    pub now: &'a Clock,
    pub log: &'a Logger,
    pub process_log: &'a Logger,
    pub client: Option<&'a TrustClient>,
}

impl<'a> Moderation<'a> {
    fn ctx(&self) -> TrustContext<'a> {
        TrustContext {
            db: self.db,
            config: self.config,
            now: self.now,
            log: self.log,
            process_log: self.process_log,
            client: self.client,
            score: MAX_TRUST_SCORE,
        }
    }
}

/// A hashtag a post or a repost was sent with and didn't get, with why: its publisher is
/// muted on it (or, for a repost, the reposter is), a moderator removed it from this
/// content, or its blocked words.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RemovedTag {
    pub tag: String,
    pub reason: &'static str,
}

/// What moderation makes of a post it doesn't refuse, for whatever writes the post: which of
/// its hashtags it gets, and where its trust score sends it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Moderated {
    /// The hashtags the post gets.
    pub tags: Vec<String>,
    /// Those it doesn't, with why.
    pub removed_tags: Vec<RemovedTag>,
    /// How far the server trusts the post. Kept only with a post that waits in the
    /// moderation queue.
    pub trust_score: i64,
    /// Where the score sends the post: to the moderation queue, or straight to the feeds.
    pub route: TrustRoute,
}

/// Why something that was sent is refused, with nothing of it stored: what its sender is
/// told (the API answers 422 with it).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Refusal {
    pub message: Reason,
    /// For a post left with no hashtag: the ones it was sent with, and why it got none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed_tags: Option<Vec<RemovedTag>>,
}

/// What moderation ends with, when it doesn't end with an answer.
#[derive(Debug, thiserror::Error)]
pub enum Unmoderated {
    /// It was looked at, and is refused.
    #[error("it is refused")]
    Refused(Refusal),
    /// It could not be looked at: a plugin failed, or the database.
    #[error(transparent)]
    Failed(#[from] anyhow::Error),
}

fn refused(reason: Option<Reason>, otherwise: &str) -> Unmoderated {
    Unmoderated::Refused(Refusal {
        message: reason.unwrap_or_else(|| msg(otherwise)),
        removed_tags: None,
    })
}

/// A new comment, or an edit of one, as it is moderated.
#[derive(Debug, Clone, Default)]
pub struct CommentSent {
    pub user_id: String,
    /// The post it is on.
    pub content_id: String,
    /// What there is of it to read: its text, the name of the image or video it comes with,
    /// and what describes that image.
    pub texts: Vec<String>,
    /// The image it comes with, if it is one.
    pub image: Option<TrustImage>,
}

/// Moderation of a new comment, or of an edit of one. It goes through the gate a post does:
/// the same trust plugins give it a score, each told it is a comment (`comment_on`), and the
/// same thresholds say where the score sends it. Refuses a comment whose score has it
/// deleted: nothing of it is stored.
///
/// That is all of it. A comment has no hashtags, so what a hashtag's moderators keep (its
/// blocked words, its mutes) doesn't reach the comments on posts under it.
pub async fn moderate_comment(deps: &Moderation<'_>, comment: CommentSent) -> Result<(i64, TrustRoute), Unmoderated> {
    let post = TrustPost {
        user_id: comment.user_id,
        comment_on: Some(comment.content_id),
        texts: comment.texts.into_iter().filter(|text| !text.is_empty()).collect(),
        images: comment.image.into_iter().collect(),
        ..TrustPost::default()
    };
    let trust = trust_of(deps.plugins, &post, &deps.ctx()).await?;
    let route = route_of(trust.score, &deps.config.trust);
    if route == TrustRoute::Delete {
        return Err(refused(trust.reason, "comment.not_trusted"));
    }
    Ok((trust.score, route))
}

/// What a user puts on their profile, as it is moderated.
#[derive(Debug, Clone, Default)]
pub struct ProfileSent {
    pub user_id: String,
    /// What there is of it to read: the bio, the links, and the name the avatar or the splash
    /// image was sent with.
    pub texts: Vec<String>,
    /// The avatar or the splash image, if that is what is set.
    pub image: Option<TrustImage>,
    /// Whether `image` is the splash image, and not the avatar.
    pub splash: bool,
}

/// Moderation of what a user puts on their profile: a bio, links, an avatar, a splash image,
/// or whichever of them the request sets. It goes through the gate a post does, each plugin
/// told it is a profile.
///
/// A profile has no moderation queue to wait in, so the score has one of two outcomes: it is
/// published, or it is refused, which is what a post's score would have it deleted for, and
/// what a post's would have it held for: nothing of it is stored.
pub async fn moderate_profile(deps: &Moderation<'_>, profile: ProfileSent) -> Result<(), Unmoderated> {
    let post = TrustPost {
        user_id: profile.user_id,
        profile: true,
        splash: profile.splash,
        texts: profile.texts.into_iter().filter(|text| !text.is_empty()).collect(),
        images: profile.image.into_iter().collect(),
        ..TrustPost::default()
    };
    let trust = trust_of(deps.plugins, &post, &deps.ctx()).await?;
    if route_of(trust.score, &deps.config.trust) != TrustRoute::Allow {
        return Err(refused(trust.reason, "user.profile_not_trusted"));
    }
    Ok(())
}

/// A new post, or an update of one, as it is moderated.
#[derive(Debug, Clone, Default)]
pub struct PostSent {
    pub user_id: String,
    /// The content an update writes over.
    pub content_id: Option<String>,
    pub tags: Vec<String>,
    /// What there is of it to read: its text or caption, link, and filename.
    pub texts: Vec<String>,
    /// An image post's images.
    pub images: Vec<TrustImage>,
}

/// Moderation of a new post, or of an update.
///
/// The post is given a trust score by the trust plugins, each of which may lower it, and
/// the score says where the post goes. Refuses a post whose score has it deleted: nothing of
/// it is stored.
///
/// Answers the hashtags the post gets, and those it doesn't with why: one its publisher is
/// muted on, one a moderator removed from this content, and one whose blocked words it has,
/// or whose blocked patterns match it. Hashtags are scanned for blocked words too. Refuses a
/// new post that is left with no hashtag, since it needs one to be published under. An
/// update can be: the content is there already, and stays, in no hashtag's feed.
pub async fn moderate_post(deps: &Moderation<'_>, post: PostSent) -> Result<Moderated, Unmoderated> {
    let texts: Vec<String> = post.texts.into_iter().filter(|text| !text.is_empty()).collect();
    let sent = TrustPost {
        user_id: post.user_id.clone(),
        content_id: post.content_id.clone(),
        tags: post.tags.clone(),
        texts: texts.clone(),
        images: post.images,
        ..TrustPost::default()
    };
    let ctx = deps.ctx();
    let users = [post.user_id];
    let (trust, rules) = futures::try_join!(
        trust_of(deps.plugins, &sent, &ctx),
        tag_rules(deps.db, &users, post.content_id.as_deref(), &post.tags)
    )?;
    let route = route_of(trust.score, &deps.config.trust);
    if route == TrustRoute::Delete {
        return Err(refused(trust.reason, "moderation.not_trusted"));
    }
    let (tags, removed_tags) = rules.apply(&post.tags, &texts, deps.log);
    if tags.is_empty() && post.content_id.is_none() {
        return Err(Unmoderated::Refused(Refusal {
            message: msg("moderation.no_tags_left"),
            removed_tags: Some(removed_tags),
        }));
    }
    Ok(Moderated {
        tags,
        removed_tags,
        trust_score: trust.score,
        route,
    })
}

/// A repost, as its hashtags are moderated.
#[derive(Debug, Clone, Default)]
pub struct RepostSent {
    /// Who reposts.
    pub user_id: String,
    /// Whose content it is.
    pub publisher_id: String,
    pub content_id: String,
    pub tags: Vec<String>,
    /// What there is of the content to read, as for a post.
    pub texts: Vec<String>,
}

/// What a repost's hashtags are held to: what the post's publisher's own are, as far as the
/// hashtags go. Answers the ones the content gets, and those it doesn't with why: one the
/// reposter or the content's publisher is muted on (a mute keeps a user's posts out of the
/// hashtag, whoever would put them there), one a moderator removed from this content, and
/// one whose blocked words the content has.
///
/// No trust score is worked out: the content got one when it was written, and a repost
/// changes nothing of what it says.
pub async fn moderate_repost(db: &Db, log: &Logger, repost: RepostSent) -> Result<(Vec<String>, Vec<RemovedTag>)> {
    let texts: Vec<String> = repost.texts.into_iter().filter(|text| !text.is_empty()).collect();
    let rules = tag_rules(db, &[repost.user_id, repost.publisher_id], Some(&repost.content_id), &repost.tags).await?;
    Ok(rules.apply(&repost.tags, &texts, log))
}

/// What hashtags' moderators keep that says whether content gets their hashtag.
struct TagRules {
    /// Each hashtag's blocked words, phrases and patterns.
    lists: Vec<(String, Vec<String>)>,
    muted: HashSet<String>,
    removed: HashSet<String>,
}

impl TagRules {
    /// Holds `tags` to the rules, given what there is of the content to read: the hashtags
    /// it gets, and those it doesn't with why.
    fn apply(&self, tags: &[String], texts: &[String], log: &Logger) -> (Vec<String>, Vec<RemovedTag>) {
        // With no hashtag's list that applies to the post, nothing needs reading.
        let blocked = if self.lists.is_empty() {
            Default::default()
        } else {
            let read: Vec<String> = texts.iter().chain(tags).cloned().collect();
            scan_texts(&self.lists, &read, log)
        };
        let mut kept = vec![];
        let mut removed = vec![];
        for tag in tags {
            let reason = if self.muted.contains(tag) {
                "muted"
            } else if self.removed.contains(tag) {
                "removed"
            } else if blocked.contains(tag) {
                "blocked_word"
            } else {
                kept.push(tag.clone());
                continue;
            };
            removed.push(RemovedTag { tag: tag.clone(), reason });
        }
        (kept, removed)
    }
}

/// The rules of these `tags`: the mutes of `user_ids` on them, the ones a moderator removed
/// from `content_id`, and their blocked words.
async fn tag_rules(db: &Db, user_ids: &[String], content_id: Option<&str>, tags: &[String]) -> Result<TagRules> {
    let mut rules = TagRules {
        lists: vec![],
        muted: HashSet::new(),
        removed: HashSet::new(),
    };
    if tags.is_empty() {
        return Ok(rules);
    }
    let in_tags = places(tags.len());
    let tag_values = || tags.iter().map(Value::from);

    let words = db
        .fetch(
            &format!("SELECT tag, word FROM blocked_words WHERE tag IN ({in_tags})"),
            &tag_values().collect::<Vec<_>>(),
        )
        .await?;
    for row in words {
        let (tag, word) = (row.string("tag")?, row.string("word")?);
        match rules.lists.iter_mut().find(|(list, _)| *list == tag) {
            Some((_, list)) => list.push(word),
            None => rules.lists.push((tag, vec![word])),
        }
    }

    let values: Vec<Value> = user_ids.iter().map(Value::from).chain(tag_values()).collect();
    let mutes = db
        .fetch(
            &format!("SELECT tag FROM tag_mutes WHERE user_id IN ({}) AND tag IN ({in_tags})", places(user_ids.len())),
            &values,
        )
        .await?;
    for row in mutes {
        rules.muted.insert(row.string("tag")?);
    }

    if let Some(content_id) = content_id {
        let values: Vec<Value> = std::iter::once(Value::from(content_id)).chain(tag_values()).collect();
        let removals = db
            .fetch(
                &format!("SELECT tag FROM tag_moderation WHERE content_id = ? AND decision = 'removed' AND tag IN ({in_tags})"),
                &values,
            )
            .await?;
        for row in removals {
            rules.removed.insert(row.string("tag")?);
        }
    }
    Ok(rules)
}

#[cfg(test)]
mod tests {
    use evieverse_core::params;
    use evieverse_core::testing;
    use serde_json::json;

    use super::*;
    use crate::trust::load_trust_plugins;
    use crate::trust::tests::World;

    fn strings(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    async fn block(world: &World, tag: &str, word: &str) {
        world
            .db
            .execute("INSERT INTO blocked_words (tag, word, created_at) VALUES (?, ?, ?)", params![tag, word, 1_i64])
            .await
            .unwrap();
    }

    fn deps<'a>(world: &'a World, plugins: &'a Plugins) -> Moderation<'a> {
        Moderation {
            db: &world.db,
            config: &world.config,
            plugins,
            now: &world.now,
            log: &world.log,
            process_log: &world.log,
            client: None,
        }
    }

    fn refusal(result: Result<impl std::fmt::Debug, Unmoderated>) -> Refusal {
        match result {
            Err(Unmoderated::Refused(refusal)) => refusal,
            other => panic!("it was not refused: {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_post_is_refused_queued_or_published_by_its_score() {
        let world = World::new(json!({})).await;
        let plugins = load_trust_plugins(&[]).unwrap();
        let deps = deps(&world, &plugins);
        block(&world, "*", "spam").await;

        let post = |text: &str| PostSent {
            user_id: "u1".into(),
            tags: strings(&["cats"]),
            texts: strings(&[text, ""]),
            ..PostSent::default()
        };
        let published = moderate_post(&deps, post("a fine post")).await.unwrap();
        assert_eq!(
            published,
            Moderated {
                tags: strings(&["cats"]),
                removed_tags: vec![],
                trust_score: 100,
                route: TrustRoute::Allow
            }
        );
        let refused = refusal(moderate_post(&deps, post("some SPAM")).await);
        assert_eq!(
            refused,
            Refusal {
                message: msg("moderation.blocked_word"),
                removed_tags: None
            }
        );
        assert_eq!(
            serde_json::to_value(&refused).unwrap(),
            json!({ "message": { "key": "moderation.blocked_word" } })
        );

        // Where nothing is deleted on arrival, it waits.
        let lenient = World::new(json!({ "trust": { "deleteBelow": 0 } })).await;
        block(&lenient, "*", "spam").await;
        let held = moderate_post(&self::deps(&lenient, &plugins), post("some SPAM")).await.unwrap();
        assert_eq!((held.trust_score, held.route), (0, TrustRoute::Queue));
        assert_eq!(
            serde_json::to_value(&held).unwrap(),
            json!({ "tags": ["cats"], "removedTags": [], "trustScore": 0, "route": "queue" })
        );
    }

    #[tokio::test]
    async fn a_post_loses_the_hashtags_whose_moderators_keep_it_out() {
        let world = World::new(json!({})).await;
        let plugins = load_trust_plugins(&[]).unwrap();
        let deps = deps(&world, &plugins);
        for user in ["u1", "u2"] {
            testing::user(&world.db, user, user, false).await;
        }
        block(&world, "cats", "dogs").await;
        block(&world, "birds", "/wor+m/").await;
        world
            .db
            .execute(
                "INSERT INTO tag_mutes (user_id, tag, created_at) VALUES (?, ?, ?)",
                params!["u1", "news", 1_i64],
            )
            .await
            .unwrap();

        let post = PostSent {
            user_id: "u1".into(),
            tags: strings(&["cats", "news", "birds", "art"]),
            texts: strings(&["Dogs and a worrrm"]),
            ..PostSent::default()
        };
        let moderated = moderate_post(&deps, post.clone()).await.unwrap();
        assert_eq!(moderated.tags, ["art"]);
        assert_eq!(
            moderated.removed_tags,
            [
                RemovedTag {
                    tag: "cats".into(),
                    reason: "blocked_word"
                },
                RemovedTag {
                    tag: "news".into(),
                    reason: "muted"
                },
                RemovedTag {
                    tag: "birds".into(),
                    reason: "blocked_word"
                }
            ]
        );
        // Another user is not muted there, and a hashtag is read for blocked words too.
        let other = PostSent {
            user_id: "u2".into(),
            tags: strings(&["news", "cats", "dogs"]),
            texts: strings(&["fine"]),
            ..PostSent::default()
        };
        let moderated = moderate_post(&deps, other).await.unwrap();
        assert_eq!(
            (moderated.tags, moderated.removed_tags),
            (
                strings(&["news", "dogs"]),
                vec![RemovedTag {
                    tag: "cats".into(),
                    reason: "blocked_word"
                }]
            )
        );

        // A new post left with no hashtag is refused, and told which it lost; an update isn't.
        let none = PostSent {
            tags: strings(&["cats", "news"]),
            ..post.clone()
        };
        let refused = refusal(moderate_post(&deps, none.clone()).await);
        assert_eq!(refused.message, msg("moderation.no_tags_left"));
        assert_eq!(refused.removed_tags.as_ref().map(Vec::len), Some(2));
        assert_eq!(
            serde_json::to_value(&refused).unwrap(),
            json!({ "message": { "key": "moderation.no_tags_left" }, "removedTags": [{ "tag": "cats", "reason": "blocked_word" }, { "tag": "news", "reason": "muted" }] })
        );
        let update = moderate_post(
            &deps,
            PostSent {
                content_id: Some("p1".into()),
                ..none
            },
        )
        .await
        .unwrap();
        assert!(update.tags.is_empty() && update.removed_tags.len() == 2);
        let untagged = refusal(moderate_post(&deps, PostSent { tags: vec![], ..post }).await);
        assert_eq!(untagged.removed_tags, Some(vec![]));
    }

    #[tokio::test]
    async fn a_repost_is_held_to_the_mutes_of_both_and_to_what_was_removed_from_the_content() {
        let world = World::new(json!({})).await;
        for user in ["u1", "u2", "m1"] {
            testing::user(&world.db, user, user, false).await;
        }
        world
            .db
            .execute(
                "INSERT INTO tag_mutes (user_id, tag, created_at) VALUES (?, ?, ?)",
                params!["u2", "news", 1_i64],
            )
            .await
            .unwrap();
        // The content itself is no part of this: its rows are written without it.
        world.db.execute("PRAGMA foreign_keys = OFF", &[]).await.unwrap();
        for (content, tag, decision) in [("p1", "dogs", "removed"), ("p1", "cats", "kept"), ("p2", "cats", "removed")] {
            world
                .db
                .execute(
                    "INSERT INTO tag_moderation (content_id, tag, decision, moderator_id, decided_at) VALUES (?, ?, ?, ?, ?)",
                    params![content, tag, decision, "m1", 1_i64],
                )
                .await
                .unwrap();
        }
        block(&world, "art", "ugly").await;

        let repost = RepostSent {
            user_id: "u1".into(),
            publisher_id: "u2".into(),
            content_id: "p1".into(),
            tags: strings(&["news", "art", "dogs", "cats"]),
            texts: strings(&["an UGLY thing"]),
        };
        let (tags, removed) = moderate_repost(&world.db, &world.log, repost).await.unwrap();
        assert_eq!(tags, ["cats"]);
        assert_eq!(
            removed,
            [
                RemovedTag {
                    tag: "news".into(),
                    reason: "muted"
                },
                RemovedTag {
                    tag: "art".into(),
                    reason: "blocked_word"
                },
                RemovedTag {
                    tag: "dogs".into(),
                    reason: "removed"
                }
            ]
        );
    }

    #[tokio::test]
    async fn a_comment_is_refused_by_its_score_and_a_profile_by_anything_short_of_published() {
        let world = World::new(json!({ "trust": { "deleteBelow": 0 } })).await;
        let plugins = load_trust_plugins(&[]).unwrap();
        let deps = deps(&world, &plugins);
        block(&world, "*", "spam").await;

        let comment = |text: &str| CommentSent {
            user_id: "u1".into(),
            content_id: "p1".into(),
            texts: strings(&[text]),
            image: None,
        };
        assert_eq!(moderate_comment(&deps, comment("fine")).await.unwrap(), (100, TrustRoute::Allow));
        // Held, where nothing is deleted on arrival.
        assert_eq!(moderate_comment(&deps, comment("spam")).await.unwrap(), (0, TrustRoute::Queue));
        let profile = |text: &str| ProfileSent {
            user_id: "u1".into(),
            texts: strings(&[text]),
            image: None,
            splash: false,
        };
        moderate_profile(&deps, profile("a fine bio")).await.unwrap();
        // A profile has no queue to wait in.
        assert_eq!(
            refusal(moderate_profile(&deps, profile("a bio of spam")).await).message,
            msg("user.profile_blocked_word")
        );

        let strict = World::new(json!({})).await;
        block(&strict, "*", "spam").await;
        let deps = self::deps(&strict, &plugins);
        assert_eq!(refusal(moderate_comment(&deps, comment("spam")).await).message, msg("comment.blocked_word"));
    }
}
