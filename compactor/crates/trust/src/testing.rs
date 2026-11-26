//! A trust plugin for tests, which does what a test says: it is no folder of src/plugins, is
//! built only with the `test-plugin` feature, and so is in no server.
//!
//! A test names its plugins, each with its rules. A rule applies to a post that has its
//! `includes` in one of its texts (to every post, if it names none), and either sets the
//! score, reduces it, or fails. Of the rules that apply, the first that sets or fails is the
//! plugin's answer; without one, the reductions add up. A plugin that records keeps each
//! post it is shown, for the test to read.

use std::sync::{Arc, Mutex};

use anyhow::{Result, bail};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::Value;

use crate::trust::{Reason, TrustChange, TrustContext, TrustPlugin, TrustPost};

/// One thing a test plugin does.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rule {
    /// What one of the post's texts has to include for the rule to apply. Every post, if none.
    #[serde(default)]
    pub includes: Option<String>,
    /// Whether that is found whatever its case.
    #[serde(default)]
    pub ignore_case: bool,
    /// Whether the rule applies to comments only.
    #[serde(default)]
    pub comments: bool,
    #[serde(default)]
    pub set: Option<i64>,
    #[serde(default)]
    pub reduce: Option<i64>,
    /// Fails the plugin, with these words.
    #[serde(default)]
    pub fails: Option<String>,
    #[serde(default)]
    pub reason: Option<Reason>,
}

/// A test plugin as a test describes it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Described {
    pub name: String,
    #[serde(default)]
    pub rules: Vec<Rule>,
    /// Whether it keeps what it is shown.
    #[serde(default)]
    pub record: bool,
    #[serde(default)]
    pub optional: bool,
    #[serde(default)]
    pub reads_images: bool,
}

/// What the test plugins that record were shown, in order: each post as JSON, with the name
/// of the plugin and the score it was told.
pub type Seen = Arc<Mutex<Vec<Value>>>;

struct TestPlugin {
    described: Described,
    seen: Seen,
}

impl Rule {
    fn applies(&self, post: &TrustPost) -> bool {
        if self.comments && post.comment_on.is_none() {
            return false;
        }
        let Some(includes) = &self.includes else { return true };
        if self.ignore_case {
            let wanted = includes.to_lowercase();
            post.texts.iter().any(|text| text.to_lowercase().contains(&wanted))
        } else {
            post.texts.iter().any(|text| text.contains(includes.as_str()))
        }
    }
}

#[async_trait]
impl TrustPlugin for TestPlugin {
    fn optional(&self) -> bool {
        self.described.optional
    }

    fn reads_images(&self) -> bool {
        self.described.reads_images
    }

    async fn assess(&self, post: &TrustPost, ctx: &TrustContext<'_>) -> Result<Option<TrustChange>> {
        if self.described.record {
            let shown = serde_json::json!({ "plugin": self.described.name, "score": ctx.score, "post": post });
            self.seen.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push(shown);
        }
        let applying: Vec<&Rule> = self.described.rules.iter().filter(|rule| rule.applies(post)).collect();
        for rule in &applying {
            if let Some(words) = &rule.fails {
                bail!("{words}");
            }
            if let Some(score) = rule.set {
                return Ok(Some(TrustChange {
                    change: crate::trust::Change::Set(score),
                    reason: rule.reason.clone(),
                }));
            }
        }
        let reductions: Vec<&&Rule> = applying.iter().filter(|rule| rule.reduce.is_some()).collect();
        if reductions.is_empty() {
            return Ok(None);
        }
        let by = reductions.iter().filter_map(|rule| rule.reduce).sum();
        let reason = reductions.iter().find_map(|rule| rule.reason.clone());
        Ok(Some(TrustChange {
            change: crate::trust::Change::Reduce(by),
            reason,
        }))
    }
}

/// The plugins a test describes, each under its name, in the order given; what they record
/// goes to `seen`.
pub fn plugins(described: Vec<Described>, seen: &Seen) -> Vec<(String, Box<dyn TrustPlugin>)> {
    described
        .into_iter()
        .map(|described| {
            (
                described.name.clone(),
                Box::new(TestPlugin { described, seen: seen.clone() }) as Box<dyn TrustPlugin>,
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::trust::tests::World;
    use crate::trust::{Plugins, Trust, msg, trust_of};

    fn described(value: Value) -> Vec<Described> {
        serde_json::from_value(value).unwrap()
    }

    #[tokio::test]
    async fn does_what_its_rules_say_and_keeps_what_it_was_shown() {
        let world = World::new(json!({})).await;
        let seen = Seen::default();
        let plugins = Plugins::of(plugins(
            described(json!([
                { "name": "shouting", "rules": [
                    { "includes": "FREE", "reduce": 30, "reason": "the post shouts too much" },
                    { "includes": "NOW", "reduce": 30 },
                    { "includes": "held", "ignoreCase": true, "set": 50, "reason": { "key": "moderation.not_trusted" } },
                    { "includes": "bad", "comments": true, "set": 10 },
                    { "includes": "boom", "fails": "boom" },
                ] },
                { "name": "watching", "record": true },
            ])),
            &seen,
        ));
        let score = async |texts: &[&str], comment: bool| {
            let post = TrustPost {
                user_id: "u1".into(),
                comment_on: comment.then(|| "p1".to_owned()),
                texts: texts.iter().map(|text| (*text).to_owned()).collect(),
                ..TrustPost::default()
            };
            trust_of(&plugins, &post, &world.ctx()).await
        };
        assert_eq!(score(&["quiet"], false).await.unwrap(), Trust { score: 100, reason: None });
        assert_eq!(
            score(&["FREE things"], false).await.unwrap(),
            Trust {
                score: 70,
                reason: Some(Reason::Words("the post shouts too much".into()))
            }
        );
        assert_eq!(score(&["FREE", "things NOW"], false).await.unwrap().score, 40);
        assert_eq!(score(&["free now"], false).await.unwrap().score, 100);
        assert_eq!(
            score(&["Held FREE"], false).await.unwrap(),
            Trust {
                score: 50,
                reason: Some(msg("moderation.not_trusted"))
            }
        );
        assert_eq!(score(&["a bad one"], false).await.unwrap().score, 100);
        assert_eq!(score(&["a bad one"], true).await.unwrap().score, 10);
        assert_eq!(score(&["boom"], false).await.unwrap_err().to_string(), "boom");

        let seen = std::mem::take(&mut *seen.lock().unwrap());
        // Not the post a plugin before it failed on.
        assert_eq!(seen.len(), 7);
        assert_eq!(
            seen[1],
            json!({ "plugin": "watching", "score": 70, "post": { "userId": "u1", "tags": [], "texts": ["FREE things"] } })
        );
        assert_eq!(
            seen[6]["post"],
            json!({ "userId": "u1", "commentOn": "p1", "tags": [], "texts": ["a bad one"] })
        );
    }
}
