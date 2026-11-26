//! A post's trust score: how far the server trusts it, from 0 (not at all) to 100. It serves
//! one purpose, which is to say where the post goes (see `route_of`), and is kept nowhere but
//! in the moderation queue, beside a post that waits there.
//!
//! The score is worked out by plugins. Every folder of src/plugins is one: an algorithm that
//! looks at a post and may lower its score. Every post and update starts at 100 and goes
//! through each of the ones the server runs (see `trust_of`): all of them, but for the
//! optional ones it didn't turn on (see `load_trust_plugins`).
//!
//! A comment on a post is scored the same way, by the same plugins, and its score sends it
//! where a post's would. A plugin tells one from a post by `comment_on`. So is what a user
//! puts on their profile (`profile`).

use std::path::PathBuf;

use anyhow::{Result, bail};
use async_trait::async_trait;
use evieverse_core::config::{Config, TrustConfig};
use evieverse_core::db::Db;
use evieverse_core::log::Logger;
use evieverse_core::time::Clock;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// The lowest score there is: no trust at all. No change takes a score below it, and a plugin
/// sets it for what the server shouldn't keep (a blocked word, a malware link).
pub const MIN_TRUST_SCORE: i64 = 0;
/// The score every post and comment starts at, and keeps unless a plugin lowers it: the
/// server trusts it wholly.
pub const MAX_TRUST_SCORE: i64 = 100;

/// What a sender is told: a message of the API's language files, by its key and what fills it
/// in, which they are told in their language, or words as written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Reason {
    Message {
        key: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        params: Option<Map<String, Value>>,
    },
    Words(String),
}

/// A message of the language files by its key, as `msg` of src/language.ts makes one.
pub fn msg(key: &str) -> Reason {
    Reason::Message {
        key: key.to_owned(),
        params: None,
    }
}

/// An image of a post or of a comment, for a plugin that looks at pictures.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustImage {
    /// Which image its bytes are (image/jpeg, image/png, image/gif or image/webp), read from
    /// the bytes themselves.
    pub mime_type: String,
    /// The name it was sent with, if it had one.
    #[serde(default)]
    pub filename: Option<String>,
    /// The path of a file on this machine that holds the image as it would be stored: without
    /// its metadata. It is the request's, which deletes it when it is over: a plugin reads it,
    /// and neither changes nor keeps it.
    pub file: PathBuf,
    /// The SHA-256 of that file, in hex: what the post's meta file would keep of it.
    pub sha256: String,
}

/// Who sent a request, as far as the server can tell.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustClient {
    /// The address the request came from, as the server counts it (see TRUST_PROXY).
    pub ip: String,
    /// Its User-Agent header, if it sent one.
    #[serde(default)]
    pub user_agent: Option<String>,
}

/// What a plugin is told of a new post, of an update, of a comment, or of what a user puts on
/// their profile.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustPost {
    /// Its publisher, a comment's author, or the user whose profile it is.
    pub user_id: String,
    /// The content an update writes over; none for a new post, for a comment, and for a profile.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_id: Option<String>,
    /// For a comment: the post it is on. None for a post, and for a profile.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment_on: Option<String>,
    /// True for what a user puts on their profile: a bio, links, or an avatar, whichever the
    /// request sets. It is neither a post nor a comment, and has no moderation queue to wait
    /// in: a score that doesn't publish it refuses it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub profile: bool,
    /// The hashtags it was sent with, normalised, before moderation drops any. A comment has
    /// none, and neither has a profile.
    #[serde(default)]
    pub tags: Vec<String>,
    /// What there is of it to read: its text or caption or link, and its filename. A comment's
    /// text, and the name of its image or video. A profile's bio and links, and the name of
    /// its avatar. A text, a caption, a comment's text and a bio are as their readers read
    /// them: without their formatting, and with each link's address after its label.
    #[serde(default)]
    pub texts: Vec<String>,
    /// Its images: those of an image post, in their order, the one a comment comes with, and a
    /// profile's avatar. None for anything else.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<TrustImage>,
}

/// What a plugin works with.
#[derive(Clone, Copy)]
pub struct TrustContext<'a> {
    pub db: &'a Db,
    pub config: &'a Config,
    pub now: &'a Clock,
    /// The log of the request that sent the post, or of the process that scores it.
    pub log: &'a Logger,
    /// The log of the process, for what goes on after the request is answered: a list that
    /// is downloaded while posts go on being scored.
    pub process_log: &'a Logger,
    /// Who sent the request the post came in. None where a post is scored outside a request.
    pub client: Option<&'a TrustClient>,
    /// The post's score as the plugins before this one left it.
    pub score: i64,
}

/// What a plugin does to a post's score: sets it, or reduces it by so much. Either way the
/// score only goes down: a plugin that sets it higher than it is changes nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    Set(i64),
    /// By this much, which is 0 or more.
    Reduce(i64),
}

/// A plugin's answer: the change, and what the sender is told if this change is what has the
/// post refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustChange {
    pub change: Change,
    pub reason: Option<Reason>,
}

impl TrustChange {
    pub fn set(score: i64) -> Self {
        Self {
            change: Change::Set(score),
            reason: None,
        }
    }

    pub fn reduce(by: i64) -> Self {
        Self {
            change: Change::Reduce(by),
            reason: None,
        }
    }

    pub fn because(mut self, reason: Reason) -> Self {
        self.reason = Some(reason);
        self
    }
}

/// A trust plugin: what a folder of src/plugins gives from its `plugin()`.
#[async_trait]
pub trait TrustPlugin: Send + Sync {
    /// Whether the plugin is optional: one that runs only on a server that turns it on, by
    /// naming it in `trust.optionalPlugins` (TRUST_OPTIONAL_PLUGINS). A plugin that doesn't
    /// say runs on every server.
    fn optional(&self) -> bool {
        false
    }

    /// Whether the plugin reads a post's images. Where none of the plugins a server runs
    /// does, nothing of an image is read for them: one sent with an upload link stays in the
    /// content store, and is never fetched.
    fn reads_images(&self) -> bool {
        false
    }

    /// Looks at a post, and says what to do to its score. None leaves it as it is.
    async fn assess(&self, post: &TrustPost, ctx: &TrustContext<'_>) -> Result<Option<TrustChange>>;
}

/// The plugins a server runs, each named after its folder, in the order they run in.
pub struct Plugins(Vec<(String, Box<dyn TrustPlugin>)>);

impl Plugins {
    /// These plugins, in this order: for a caller that names its own, as a test does.
    pub fn of(plugins: Vec<(String, Box<dyn TrustPlugin>)>) -> Self {
        Self(plugins)
    }

    pub fn names(&self) -> Vec<&str> {
        self.0.iter().map(|(name, _)| name.as_str()).collect()
    }

    /// Whether one of them is named so.
    pub fn runs(&self, name: &str) -> bool {
        self.0.iter().any(|(named, _)| named == name)
    }

    /// Whether one of them reads a post's images.
    pub fn read_images(&self) -> bool {
        self.0.iter().any(|(_, plugin)| plugin.reads_images())
    }

    /// The same, with these after them.
    pub fn and(mut self, more: Vec<(String, Box<dyn TrustPlugin>)>) -> Self {
        self.0.extend(more);
        self
    }

    /// The same, with this in place of the one named so, if one is: for a process that
    /// gives a plugin what it shares with it (see `pdq::sharing`).
    pub fn replace(mut self, name: &str, plugin: Box<dyn TrustPlugin>) -> Self {
        if let Some(named) = self.0.iter_mut().find(|(named, _)| named == name) {
            named.1 = plugin;
        }
        self
    }
}

/// The trust score of a post or a comment as `trust_of` works it out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Trust {
    pub score: i64,
    /// The reason given with the change that brought the score to what it is, if it gave one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<Reason>,
}

/// The score once a plugin's change is applied to it: never higher than it was, never under 0.
/// A change that reduces by less than nothing is the plugin's mistake, and an error.
fn lowered(score: i64, change: Change, plugin: &str) -> Result<i64> {
    let next = match change {
        Change::Set(to) => to,
        Change::Reduce(by) if by >= 0 => score.saturating_sub(by),
        Change::Reduce(by) => bail!("the trust plugin {plugin} must set a score or reduce it by 0 or more, not by {by}"),
    };
    Ok(next.min(score).max(MIN_TRUST_SCORE))
}

/// A post's trust score: 100, as each plugin in turn leaves it. The plugins run one after
/// another, in the order given (that of their folders' names), each told the score so far.
/// Where they disagree the lower score wins: none can raise what another lowered.
///
/// A plugin that fails, fails the post: nothing is published that a plugin didn't get to
/// look at.
pub async fn trust_of(plugins: &Plugins, post: &TrustPost, ctx: &TrustContext<'_>) -> Result<Trust> {
    let mut trust = Trust {
        score: MAX_TRUST_SCORE,
        reason: None,
    };
    for (name, plugin) in &plugins.0 {
        let Some(answer) = plugin.assess(post, &TrustContext { score: trust.score, ..*ctx }).await? else {
            continue;
        };
        let next = lowered(trust.score, answer.change, name)?;
        if next == trust.score {
            continue;
        }
        trust.score = next;
        trust.reason = answer.reason;
    }
    Ok(trust)
}

/// The trust plugins the server runs: one per folder of src/plugins, in the order of the
/// folders' names. A plugin that says it is optional is one of them only if `optional` names
/// it, which is the server's `trust.optionalPlugins`; any other runs whatever that says.
///
/// A name that no folder has is an error, so the server doesn't start without an algorithm it
/// was meant to have.
pub fn load_trust_plugins(optional: &[String]) -> Result<Plugins> {
    let registered = crate::plugins::REGISTERED;
    let unknown: Vec<&str> = optional
        .iter()
        .map(String::as_str)
        .filter(|name| !registered.iter().any(|(known, _)| known == name))
        .collect();
    if !unknown.is_empty() {
        let known: Vec<&str> = registered.iter().map(|(name, _)| *name).collect();
        bail!(
            "TRUST_OPTIONAL_PLUGINS names {}, which {} of the trust plugins this server was built with: it has {}",
            unknown.join(", "),
            if unknown.len() == 1 { "isn't one" } else { "aren't any" },
            if known.is_empty() { "none".to_owned() } else { known.join(", ") }
        );
    }
    let mut plugins = vec![];
    for (name, make) in registered {
        let plugin = make();
        // The gate: an optional plugin the server didn't turn on is left out, and never sees a post.
        if plugin.optional() && !optional.iter().any(|named| named == name) {
            continue;
        }
        plugins.push(((*name).to_owned(), plugin));
    }
    Ok(Plugins(plugins))
}

/// Where a score sends a post. Delete: it is refused, and nothing of it is kept. Queue: it is
/// stored but not published until an admin accepts it. Allow: it is published.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrustRoute {
    Delete,
    Queue,
    Allow,
}

/// Where `score` sends a post or a comment, by the server's `trust` settings: `Delete` if it
/// is less than `deleteBelow`, `Queue` if it is less than `allowFrom`, and `Allow` otherwise.
pub fn route_of(score: i64, trust: &TrustConfig) -> TrustRoute {
    if score < trust.delete_below {
        TrustRoute::Delete
    } else if score < trust.allow_from {
        TrustRoute::Queue
    } else {
        TrustRoute::Allow
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::Mutex;

    use evieverse_core::testing;
    use evieverse_core::time::fixed_clock;
    use serde_json::json;

    use super::*;

    /// What a test scores a post in: a server's database, settings and clock, and what the
    /// plugins said.
    pub(crate) struct World {
        /// Its folder, which is there for as long as it is.
        _dir: tempfile::TempDir,
        pub db: Db,
        pub config: Config,
        pub now: Clock,
        pub log: Logger,
        pub said: std::sync::Arc<evieverse_core::log::Collected>,
        pub client: Option<TrustClient>,
    }

    impl World {
        /// A server that sets `settings` (as a configuration file has them) and nothing else.
        pub(crate) async fn new(settings: Value) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let db = testing::database(dir.path()).await;
            let config = testing::config(dir.path(), settings);
            let (log, said) = Logger::collecting();
            Self {
                _dir: dir,
                db,
                config,
                now: fixed_clock(1_793_966_400_000),
                log,
                said,
                client: None,
            }
        }

        pub(crate) fn ctx(&self) -> TrustContext<'_> {
            TrustContext {
                db: &self.db,
                config: &self.config,
                now: &self.now,
                log: &self.log,
                process_log: &self.log,
                client: self.client.as_ref(),
                score: MAX_TRUST_SCORE,
            }
        }

        /// What was said since this was last asked, as (level, message, fields).
        pub(crate) fn said(&self) -> Vec<(evieverse_core::log::Level, String, Value)> {
            self.said
                .take()
                .into_iter()
                .map(|entry| (entry.level, entry.msg, Value::Object(entry.fields)))
                .collect()
        }
    }

    /// A server of this machine that answers every request with the same thing, for the
    /// lists a plugin downloads.
    pub(crate) struct Served {
        pub url: String,
        answer: std::sync::Arc<Mutex<(u16, Vec<u8>)>>,
        requests: std::sync::Arc<Mutex<Vec<String>>>,
    }

    impl Served {
        pub(crate) async fn start(status: u16, body: &str) -> Self {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let answer = std::sync::Arc::new(Mutex::new((status, body.as_bytes().to_vec())));
            let requests = std::sync::Arc::new(Mutex::new(vec![]));
            let (answers, asked) = (answer.clone(), requests.clone());
            tokio::spawn(async move {
                while let Ok((mut socket, _)) = listener.accept().await {
                    let (answers, asked) = (answers.clone(), asked.clone());
                    tokio::spawn(async move {
                        let mut request = vec![];
                        let mut chunk = [0_u8; 4096];
                        while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                            match socket.read(&mut chunk).await {
                                Ok(read) if read > 0 => request.extend_from_slice(&chunk[..read]),
                                _ => return,
                            }
                        }
                        let (status, body) = answers.lock().unwrap().clone();
                        let head = format!(
                            "HTTP/1.1 {status} Said\r\ncontent-type: text/plain\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                            body.len()
                        );
                        let _ = socket.write_all(head.as_bytes()).await;
                        let _ = socket.write_all(&body).await;
                        let _ = socket.shutdown().await;
                        asked.lock().unwrap().push(String::from_utf8_lossy(&request).into_owned());
                    });
                }
            });
            Self { url, answer, requests }
        }

        /// What it answers from now on.
        pub(crate) fn answer(&self, status: u16, body: &str) {
            *self.answer.lock().unwrap() = (status, body.as_bytes().to_vec());
        }

        /// The requests it answered so far, each as it was sent: its first line and headers.
        pub(crate) fn requests(&self) -> Vec<String> {
            self.requests.lock().unwrap().clone()
        }
    }

    /// A plugin that answers what it is made with, and keeps the scores it was told.
    struct Answers {
        answer: Option<TrustChange>,
        told: Mutex<Vec<i64>>,
        fails: bool,
    }

    #[async_trait]
    impl TrustPlugin for Answers {
        async fn assess(&self, _post: &TrustPost, ctx: &TrustContext<'_>) -> Result<Option<TrustChange>> {
            self.told.lock().unwrap().push(ctx.score);
            if self.fails {
                bail!("the plugin failed");
            }
            Ok(self.answer.clone())
        }
    }

    fn answering(name: &str, answer: Option<TrustChange>) -> (String, Box<dyn TrustPlugin>) {
        (
            name.to_owned(),
            Box::new(Answers {
                answer,
                told: Mutex::new(vec![]),
                fails: false,
            }),
        )
    }

    async fn scored(plugins: Vec<(String, Box<dyn TrustPlugin>)>) -> Result<Trust> {
        let world = World::new(json!({})).await;
        trust_of(&Plugins::of(plugins), &TrustPost::default(), &world.ctx()).await
    }

    #[tokio::test]
    async fn a_post_no_plugin_lowers_is_trusted_wholly() {
        assert_eq!(scored(vec![]).await.unwrap(), Trust { score: 100, reason: None });
        assert_eq!(scored(vec![answering("quiet", None)]).await.unwrap(), Trust { score: 100, reason: None });
    }

    #[tokio::test]
    async fn the_lower_score_wins_and_gives_its_reason() {
        let trust = scored(vec![
            answering("a", Some(TrustChange::reduce(30).because(msg("a.reason")))),
            // Higher than it is: changes nothing, and its reason is nobody's.
            answering("b", Some(TrustChange::set(90).because(msg("b.reason")))),
            answering("c", Some(TrustChange::reduce(0).because(msg("c.reason")))),
        ])
        .await
        .unwrap();
        assert_eq!(
            trust,
            Trust {
                score: 70,
                reason: Some(msg("a.reason"))
            }
        );

        let trust = scored(vec![
            answering("a", Some(TrustChange::reduce(30).because(msg("a.reason")))),
            answering("b", Some(TrustChange::set(10))),
        ])
        .await
        .unwrap();
        // The change that brought it to what it is gave no reason, so it has none.
        assert_eq!(trust, Trust { score: 10, reason: None });

        let trust = scored(vec![
            answering("a", Some(TrustChange::reduce(70))),
            answering("b", Some(TrustChange::reduce(70).because(Reason::Words("in its own words".to_owned())))),
        ])
        .await
        .unwrap();
        assert_eq!(
            trust,
            Trust {
                score: 0,
                reason: Some(Reason::Words("in its own words".to_owned()))
            }
        );
        assert_eq!(scored(vec![answering("a", Some(TrustChange::set(-5)))]).await.unwrap().score, 0);
    }

    #[tokio::test]
    async fn a_plugin_that_fails_or_answers_what_is_no_change_fails_the_post() {
        let failing: (String, Box<dyn TrustPlugin>) = (
            "failing".to_owned(),
            Box::new(Answers {
                answer: None,
                told: Mutex::new(vec![]),
                fails: true,
            }),
        );
        assert!(scored(vec![failing]).await.is_err());
        let err = scored(vec![answering("raises", Some(TrustChange::reduce(-1)))]).await.unwrap_err();
        assert!(err.to_string().contains("the trust plugin raises"), "{err}");
    }

    #[test]
    fn loads_every_plugin_but_the_optional_ones_that_are_not_named() {
        let own = load_trust_plugins(&[]).unwrap();
        assert_eq!(own.names(), ["blocked_words"]);
        assert!(!own.read_images());
        let all = load_trust_plugins(&["urlhaus".to_owned(), "pdq".to_owned()]).unwrap();
        // In the order of their folders' names, whatever order they were named in.
        assert_eq!(all.names(), ["blocked_words", "pdq", "urlhaus"]);
        assert!(all.read_images());
        let err = load_trust_plugins(&["nope".to_owned()]).err().unwrap();
        assert!(err.to_string().contains("TRUST_OPTIONAL_PLUGINS names nope"), "{err}");
    }

    #[test]
    fn a_score_sends_a_post_by_the_thresholds() {
        let trust = TrustConfig {
            delete_below: 25,
            allow_from: 75,
            optional_plugins: vec![],
        };
        assert_eq!(route_of(0, &trust), TrustRoute::Delete);
        assert_eq!(route_of(24, &trust), TrustRoute::Delete);
        assert_eq!(route_of(25, &trust), TrustRoute::Queue);
        assert_eq!(route_of(74, &trust), TrustRoute::Queue);
        assert_eq!(route_of(75, &trust), TrustRoute::Allow);
        // Nothing is deleted on arrival, and everything waits.
        let held = TrustConfig {
            delete_below: 0,
            allow_from: 101,
            optional_plugins: vec![],
        };
        assert_eq!(route_of(0, &held), TrustRoute::Queue);
        assert_eq!(route_of(100, &held), TrustRoute::Queue);
    }

    #[test]
    fn a_reason_is_written_as_the_api_reads_one() {
        assert_eq!(
            serde_json::to_value(msg("moderation.blocked_word")).unwrap(),
            json!({ "key": "moderation.blocked_word" })
        );
        assert_eq!(serde_json::to_value(Reason::Words("as written".to_owned())).unwrap(), json!("as written"));
    }
}
