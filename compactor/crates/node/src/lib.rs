//! The addon the API loads: the Rust code it shares with the compactor, as functions Node
//! calls. There is one implementation of each thing on both sides: the trust plugins, the
//! moderation policy, the blocked words of the server and of its hashtags, the attestations
//! servers sign of their posts, the one way a server asks an address somebody else chose, and
//! how a search reads the words it is asked with.
//!
//! Everything crosses as JSON, in a string: what the API's side (src/native.ts) writes and
//! reads is what these functions read and write, and nothing more of either side shows.
//!
//! A server is opened with its settings (`open`), and is then called by the number it was
//! given. It keeps its own few connections to the database, made when first needed, the trust
//! plugins the settings turn on, and what those keep between posts (a list they download).
//! A call says what time it is, as the API counts it: the clock is the API's.
//!
//! What is said for the log while a call runs is given back with its answer, for the API to
//! say in the log of the request. What is said afterwards (a download that ends once the
//! request is answered) is kept, and given back with the next call's answer.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use evieverse_core::attestation;
use evieverse_core::config::{Config, DbConfig};
use evieverse_core::db::Db;
use evieverse_core::log::{Collected, Entry, Logger};
use evieverse_core::public_fetch;
use evieverse_core::search;
use evieverse_core::time::fixed_clock;
use evieverse_trust::policy::{self, CommentSent, Moderation, PostSent, ProfileSent, RepostSent, Unmoderated};
use evieverse_trust::trust::{Plugins, TrustClient, TrustImage, load_trust_plugins};
use evieverse_trust::words;
use napi::{Error, Result};
use napi_derive::napi;
use serde::Deserialize;
use serde_json::{Value, json};

/// The most connections a server's addon keeps to the database: it reads a few rows for a
/// post, and writes only what a plugin reports.
const POOL_SIZE: i64 = 4;

/// A server, as opened.
struct Server {
    config: Config,
    plugins: Plugins,
    /// Connected when a call first needs it: a server that never moderates never connects.
    db: tokio::sync::OnceCell<Db>,
    /// The log of what goes on between calls, and what it holds.
    process_log: Logger,
    background: Arc<Collected>,
    #[cfg(feature = "test-plugin")]
    seen: evieverse_trust::testing::Seen,
}

static SERVERS: LazyLock<Mutex<HashMap<u32, Arc<Server>>>> = LazyLock::new(Mutex::default);
static NEXT: AtomicU32 = AtomicU32::new(1);

fn failed(err: impl std::fmt::Display) -> Error {
    Error::from_reason(err.to_string())
}

fn read<T: serde::de::DeserializeOwned>(what: &str, json: &str) -> Result<T> {
    serde_json::from_str(json).map_err(|err| failed(format!("the addon was given {what} it cannot read: {err}")))
}

fn server(handle: u32) -> Result<Arc<Server>> {
    SERVERS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&handle)
        .cloned()
        .ok_or_else(|| failed("the addon was called for a server that is not open"))
}

/// What `open` is given beside the settings.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Options {
    /// Plugins a test describes (see crates/trust/src/testing.rs), which run after the
    /// server's own.
    #[serde(default)]
    test_plugins: Vec<Value>,
    /// Whether they run in place of the server's own.
    #[serde(default)]
    only_test_plugins: bool,
}

/// Whether this addon was built with the plugin a test configures.
#[napi]
pub fn has_test_plugin() -> bool {
    cfg!(feature = "test-plugin")
}

/// Opens a server: `config` is the API's settings as it resolved them, as JSON. Answers the
/// number the server is then called by. Fails where the settings name a trust plugin this
/// addon was built without, so a server never starts without an algorithm it was meant to
/// have.
#[napi]
pub fn open(config: String, options: String) -> Result<u32> {
    let config: Config = read("settings", &config)?;
    let options: Options = read("options", &options)?;
    let own = if options.only_test_plugins {
        Plugins::of(vec![])
    } else {
        load_trust_plugins(&config.trust.optional_plugins).map_err(failed)?
    };
    #[cfg(feature = "test-plugin")]
    let seen = evieverse_trust::testing::Seen::default();
    #[cfg(feature = "test-plugin")]
    let plugins = {
        let described = options
            .test_plugins
            .into_iter()
            .map(serde_json::from_value)
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|err| failed(format!("a test plugin is described wrongly: {err}")))?;
        own.and(evieverse_trust::testing::plugins(described, &seen))
    };
    #[cfg(not(feature = "test-plugin"))]
    let plugins = {
        if !options.test_plugins.is_empty() || options.only_test_plugins {
            return Err(failed(
                "this addon was built without the plugin tests configure: build it with the feature test-plugin",
            ));
        }
        own
    };
    let (process_log, background) = Logger::collecting();
    let opened = Server {
        config,
        plugins,
        db: tokio::sync::OnceCell::new(),
        process_log,
        background,
        #[cfg(feature = "test-plugin")]
        seen,
    };
    let handle = NEXT.fetch_add(1, Ordering::Relaxed);
    SERVERS.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(handle, Arc::new(opened));
    Ok(handle)
}

/// The trust plugins a server runs, by name, in the order they run in.
#[napi]
pub fn plugin_names(handle: u32) -> Result<Vec<String>> {
    Ok(server(handle)?.plugins.names().into_iter().map(str::to_owned).collect())
}

/// Whether one of a server's plugins reads a post's images. Where none does, the API reads
/// nothing of an image for them.
#[napi]
pub fn reads_images(handle: u32) -> Result<bool> {
    Ok(server(handle)?.plugins.read_images())
}

/// Closes a server: its connections to the database are closed, and it is called no more.
#[napi]
pub async fn close(handle: u32) -> Result<()> {
    let closed = SERVERS.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&handle);
    if let Some(closed) = closed
        && let Some(db) = closed.db.get()
    {
        db.close().await;
    }
    Ok(())
}

/// What a call is given, whichever it is: what it moderates, and who sent it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Asked {
    #[serde(default)]
    client: Option<TrustClient>,
    #[serde(default)]
    sent: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Post {
    user_id: String,
    #[serde(default)]
    content_id: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    texts: Vec<String>,
    #[serde(default)]
    images: Vec<TrustImage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Comment {
    user_id: String,
    content_id: String,
    #[serde(default)]
    texts: Vec<String>,
    #[serde(default)]
    image: Option<TrustImage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
    user_id: String,
    #[serde(default)]
    texts: Vec<String>,
    #[serde(default)]
    image: Option<TrustImage>,
    #[serde(default)]
    splash: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Repost {
    user_id: String,
    publisher_id: String,
    content_id: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    texts: Vec<String>,
}

fn said(entries: Vec<Entry>) -> Value {
    Value::Array(
        entries
            .into_iter()
            .map(|entry| json!({ "level": entry.level.name(), "fields": entry.fields, "msg": entry.msg }))
            .collect(),
    )
}

/// What a call came to: `{ ok }` with its answer, `{ refused }` with what the sender is told,
/// or `{ failed }` with why it could not be done at all.
fn outcome<T: serde::Serialize>(result: std::result::Result<T, Unmoderated>) -> Value {
    match result {
        Ok(answer) => json!({ "ok": answer }),
        Err(Unmoderated::Refused(refusal)) => json!({ "refused": refusal }),
        Err(Unmoderated::Failed(err)) => json!({ "failed": format!("{err:#}") }),
    }
}

/// Calls a server: `method` is what to do, `now` the time as the API counts it (in
/// milliseconds), and `asked` what to do it with, as JSON. Answers JSON: what it came to (see
/// `outcome`), with `logs`, what was said for the log of the request, and `background`, what
/// was said since the last call by what goes on between them.
#[napi]
pub async fn call(handle: u32, method: String, now: f64, asked: String) -> Result<String> {
    let server = server(handle)?;
    let asked: Asked = read("a call", &asked)?;
    let (log, logs) = Logger::collecting();
    let came_to = run(&server, &method, now, asked, &log).await?;
    let mut answer = came_to;
    answer["logs"] = said(logs.take());
    answer["background"] = said(server.background.take());
    Ok(answer.to_string())
}

async fn run(server: &Server, method: &str, now: f64, asked: Asked, log: &Logger) -> Result<Value> {
    // Nothing of these needs the database.
    match method {
        "background" => return Ok(json!({ "ok": null })),
        #[cfg(feature = "test-plugin")]
        "seen" => {
            let seen = std::mem::take(&mut *server.seen.lock().unwrap_or_else(|poisoned| poisoned.into_inner()));
            return Ok(json!({ "ok": seen }));
        }
        _ => {}
    }
    let db = match server
        .db
        .get_or_try_init(|| async {
            let settings = DbConfig {
                pool_size: server.config.db.pool_size.clamp(1, POOL_SIZE),
                ..server.config.db.clone()
            };
            Db::connect(&settings).await
        })
        .await
    {
        Ok(db) => db,
        Err(err) => return Ok(json!({ "failed": format!("{err:#}") })),
    };
    // Whole milliseconds, as the API's clock gives them.
    #[allow(clippy::cast_possible_truncation)]
    let clock = fixed_clock(now as i64);
    let deps = Moderation {
        db,
        config: &server.config,
        plugins: &server.plugins,
        now: &clock,
        log,
        process_log: &server.process_log,
        client: asked.client.as_ref(),
    };
    let sent = asked.sent;
    let given = |err: serde_json::Error| failed(format!("the addon was asked to {method} what it cannot read: {err}"));
    Ok(match method {
        "moderatePost" => {
            let post: Post = serde_json::from_value(sent).map_err(given)?;
            outcome(
                policy::moderate_post(
                    &deps,
                    PostSent {
                        user_id: post.user_id,
                        content_id: post.content_id,
                        tags: post.tags,
                        texts: post.texts,
                        images: post.images,
                    },
                )
                .await,
            )
        }
        "moderateComment" => {
            let comment: Comment = serde_json::from_value(sent).map_err(given)?;
            let result = policy::moderate_comment(
                &deps,
                CommentSent {
                    user_id: comment.user_id,
                    content_id: comment.content_id,
                    texts: comment.texts,
                    image: comment.image,
                },
            )
            .await;
            outcome(result.map(|(score, route)| json!({ "trustScore": score, "route": route })))
        }
        "moderateProfile" => {
            let profile: Profile = serde_json::from_value(sent).map_err(given)?;
            outcome(
                policy::moderate_profile(
                    &deps,
                    ProfileSent {
                        user_id: profile.user_id,
                        texts: profile.texts,
                        image: profile.image,
                        splash: profile.splash,
                    },
                )
                .await,
            )
        }
        "moderateRepost" => {
            let repost: Repost = serde_json::from_value(sent).map_err(given)?;
            let sent = RepostSent {
                user_id: repost.user_id,
                publisher_id: repost.publisher_id,
                content_id: repost.content_id,
                tags: repost.tags,
                texts: repost.texts,
            };
            outcome(
                policy::moderate_repost(db, log, sent)
                    .await
                    .map(|(tags, removed)| json!({ "tags": tags, "removedTags": removed }))
                    .map_err(Unmoderated::Failed),
            )
        }
        _ => return Err(failed(format!("the addon has nothing called {method}"))),
    })
}

/// The limits of a list of blocked words, and the name the server's own list is kept under.
#[napi]
pub fn word_limits() -> String {
    json!({
        "serverList": words::SERVER_LIST,
        "maxListWords": words::MAX_LIST_WORDS,
        "maxListPatterns": words::MAX_LIST_PATTERNS,
        "maxWordChars": words::MAX_WORD_CHARS,
        "maxPhraseWords": words::MAX_PHRASE_WORDS,
        "patternBudgetMs": words::PATTERN_BUDGET_MS,
    })
    .to_string()
}

/// Lowercase, without the accents of Latin letters, as hashtags are normalised.
#[napi]
pub fn fold(text: String) -> String {
    words::fold(&text)
}

/// Whether an entry of a list of blocked words is a pattern, and not a word or a phrase.
#[napi]
pub fn is_pattern(entry: String) -> bool {
    words::is_pattern(&entry)
}

/// An entry of a list of blocked words as it is stored; null for one that can't be.
#[napi]
pub fn normalize_word(input: String) -> Option<String> {
    words::normalize_word(&input)
}

/// What `scan_texts` is given.
#[derive(Deserialize)]
struct Scan {
    /// Each list by its name, with its entries as stored.
    lists: Vec<(String, Vec<String>)>,
    texts: Vec<String>,
}

/// The lists that have one of their entries in one of the texts, each of which is read on
/// its own: `{ matched, logs }`, as JSON.
#[napi]
pub async fn scan_texts(asked: String) -> Result<String> {
    let scan: Scan = read("lists and texts", &asked)?;
    let (log, logs) = Logger::collecting();
    let matched = words::scan_texts(&scan.lists, &scan.texts, &log);
    Ok(json!({ "matched": matched, "logs": said(logs.take()) }).to_string())
}

/// The limits of an attestation: how long one is taken for after it was issued, how far
/// ahead the clock that issued it may be, and the longest one a request can carry.
#[napi]
pub fn attestation_limits() -> String {
    json!({
        "maxAgeMs": attestation::ATTESTATION_MAX_AGE_MS,
        "skewMs": attestation::ATTESTATION_SKEW_MS,
        "maxChars": attestation::MAX_ATTESTATION_CHARS,
    })
    .to_string()
}

/// The keys a server signs with, as it publishes them, from the seeds its setting holds (a
/// JSON list): `[{ id, publicKey }]`, as JSON. Fails for a seed that isn't one, which it
/// names by its place and never by what it is.
#[napi]
pub fn signing_keys(seeds: String) -> Result<String> {
    // Not what the reader says of them, which may quote one.
    let seeds: Vec<String> = serde_json::from_str(&seeds).map_err(|_| failed("the addon was given signing keys it cannot read"))?;
    let keys = seeds
        .iter()
        .enumerate()
        .map(|(at, seed)| {
            attestation::signing_key(seed)
                .map(|key| key.published())
                .map_err(|_| failed(format!("signing key {} is not 32 random bytes, in base64 or hex", at + 1)))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(json!(keys).to_string())
}

/// A key as another server published it, with the id an attestation names it by:
/// `{ id, publicKey }`, as JSON. Null for what isn't an Ed25519 public key.
#[napi]
pub fn published_key(public_key: String) -> Option<String> {
    attestation::published_key(&public_key).map(|key| json!(key).to_string())
}

/// The attestation of what a server says of a post (`said`, the JSON of an object), signed
/// with the key `seed` makes as of `issued_at`.
#[napi]
pub fn attest(seed: String, said: String, issued_at: f64) -> Result<String> {
    // Not the error's own words, which are of the setting: nothing of a key is said.
    let key = attestation::signing_key(&seed).map_err(|_| failed("the signing key is not 32 random bytes, in base64 or hex"))?;
    if issued_at.fract() != 0.0 || !(0.0..=9_007_199_254_740_991.0).contains(&issued_at) {
        return Err(failed("an attestation is issued at a time in whole milliseconds"));
    }
    #[allow(clippy::cast_possible_truncation)]
    attestation::attest(&key, &said, issued_at as i64).map_err(failed)
}

/// An attestation taken apart, as JSON: `payload`, what it says as the JSON it is, and
/// either `said`, what that comes to once it is found to say what an attestation says, or
/// `issues`, what it says that one doesn't. Null for a text that isn't written as an
/// attestation. Whose signature it carries is not looked at (see `signed_by`).
#[napi]
pub fn read_attestation(text: String) -> Option<String> {
    let read = attestation::read_attestation(&text)?;
    let checked = match attestation::said(&read.payload) {
        Ok(said) => json!({ "payload": read.payload, "said": said }),
        Err(issues) => json!({ "payload": read.payload, "issues": issues }),
    };
    Some(checked.to_string())
}

/// Whether the key a server published as `public_key` signed the attestation. A text that
/// isn't an attestation was signed by nobody.
#[napi]
pub fn signed_by(public_key: String, text: String) -> bool {
    attestation::read_attestation(&text).is_some_and(|read| attestation::signed_by(&public_key, &read))
}

/// What the address of a post says of where it is, as JSON: the post's `id`, the `server`
/// it is on (the address without what names the post), and whether that server is one that
/// is `asked` for its keys: over https, on the port https has. Null for an address that
/// doesn't end as a post's does.
#[napi]
pub fn post_of(address: String) -> Option<String> {
    let (at, id) = attestation::post_of(&address)?;
    Some(json!({ "id": id, "server": &address[..at], "asked": attestation::asked_server(&address).is_some() }).to_string())
}

/// Whether `address` is an IP address on the public internet.
#[napi]
pub fn is_public_address(address: String) -> bool {
    public_fetch::is_public_address(&address)
}

/// What the server at `address` answers a GET with, which is JSON, as it is. Asked only over
/// https, on its own port, at an address on the public internet, once, for a short time and
/// a small answer (see core's `public_fetch`). Fails for anything else, and for an answer
/// that isn't 200.
#[napi]
pub async fn fetch_public_json(address: String) -> Result<String> {
    Ok(public_fetch::fetch_public_json(&address).await.map_err(failed)?.to_string())
}

/// The terms a search for `q` looks for: its words, as a post's keywords are read from its
/// text, and its hashtags.
#[napi]
pub fn query_terms(q: String) -> Vec<String> {
    search::query_terms(&q)
}

/// A username as a search compares it, and as `users.username_folded` keeps it.
#[napi]
pub fn fold_username(username: String) -> String {
    search::fold_username(&username)
}
