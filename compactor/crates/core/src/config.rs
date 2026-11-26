//! The server's configuration, as this side of it reads it: the settings the compactor, its
//! workers and the trust plugins use, from the same places the API reads them (src/config.ts),
//! in the same order: defaults, a JSON file (EVIEVERSE_CONFIG or ./evieverse.config.json),
//! environment variables, and overrides. Each setting has the type, the default and the bounds
//! the API's schema gives it, and is read the way the schema reads it: a number given as the
//! string the environment has it in, "yes" for on.
//!
//! A setting only requests use (a rate limit, the size of a page) is not read here, and so is
//! not checked here either: what the API refuses of those, this takes.
//!
//! test/config.test.ts holds the two together: it has the binary print what it resolved
//! (`compactor config`) and compares that with what `loadConfig` makes of the same file and
//! environment.

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

/// The options of an OpenDAL store, by name.
pub type Options = BTreeMap<String, String>;

/// Which setting each environment variable sets, as the path of the setting's keys in the
/// configuration (`db.poolSize`): those of `ENV_MAP` in src/config.ts that name a setting read
/// here. A variable that is unset or empty sets nothing.
const ENV_MAP: &[(&str, &str)] = &[
    ("LOG_LEVEL", "logLevel"),
    ("DB_DIALECT", "db.dialect"),
    ("DATABASE_URL", "db.url"),
    ("DB_POOL_SIZE", "db.poolSize"),
    ("DB_IDLE_TIMEOUT_MS", "db.idleTimeoutMs"),
    ("DB_MIGRATE_ON_START", "db.migrateOnStart"),
    ("PUBLIC_BASE_URL", "publicBaseUrl"),
    ("REDIS_URL", "redis.url"),
    ("REDIS_KEY_PREFIX", "redis.keyPrefix"),
    ("CONTENT_SCHEME", "storage.content.scheme"),
    ("CONTENT_OPTIONS", "storage.content.options"),
    ("CONTENT_SIGNED_URL_SECONDS", "storage.content.signedUrlSeconds"),
    ("SUMMARY_SCHEME", "storage.summaries.scheme"),
    ("SUMMARY_OPTIONS", "storage.summaries.options"),
    ("STORAGE_TMP_PATH", "storage.tmpPath"),
    ("TAGGING_MODE", "tagging.mode"),
    ("TAG_MODERATOR_INACTIVE_DAYS", "tagging.moderatorInactiveDays"),
    ("POST_TYPE_TEXT", "postTypes.text"),
    ("POST_TYPE_IMAGE", "postTypes.image"),
    ("POST_TYPE_VIDEO", "postTypes.video"),
    ("POST_TYPE_AUDIO", "postTypes.audio"),
    ("POST_TYPE_LINK", "postTypes.link"),
    ("VIDEO_PROCESSING", "video.processing"),
    ("VIDEO_HEIGHTS", "video.heights"),
    ("VIDEO_COMMENT_HEIGHT", "video.commentHeight"),
    ("VIDEO_TIMEOUT_SECONDS", "video.timeoutSeconds"),
    ("VIDEO_FFMPEG_PATH", "video.ffmpegPath"),
    ("VIDEO_FFPROBE_PATH", "video.ffprobePath"),
    ("REPOSTS", "reposts.enabled"),
    ("REPOSTS_REMOTE", "reposts.remote"),
    ("REPOSTS_SIGNING_KEYS", "reposts.signingKeys"),
    ("REPOSTS_REFRESH_HOURS", "reposts.refreshHours"),
    ("REPOSTS_GONE_DAYS", "reposts.goneDays"),
    ("FEED_HEAD_CACHE_MS", "feed.headCacheMs"),
    ("FEED_TAG_DAY_MAX_POSTS", "feed.tagDayMaxPosts"),
    ("FEED_TAG_DAY_MIN_POSTS", "feed.tagDayMinPosts"),
    ("FEED_TAG_RETENTION_DAYS", "feed.tagRetentionDays"),
    ("FEED_AUTHOR_DAY_MAX_POSTS", "feed.authorDayMaxPosts"),
    ("FEED_MAX_LOOKBACK_DAYS", "feed.maxLookbackDays"),
    ("FEED_PREVIEW_WORDS", "feed.previewWords"),
    ("FEED_PREVIEW_CHARS", "feed.previewChars"),
    ("FEED_RELATED_TAGS", "feed.relatedTags"),
    ("FEED_RELATED_MIN_POSTS", "feed.relatedMinPosts"),
    ("FEED_RELATED_MIN_PERCENT", "feed.relatedMinPercent"),
    ("SUMMARY_HOT_DAYS", "feed.summaryHotDays"),
    ("SUMMARY_BROTLI_QUALITY", "feed.summaryBrotliQuality"),
    ("COMPACT_INTERVAL_SECONDS", "compact.intervalSeconds"),
    ("COMPACT_GRACE_SECONDS", "compact.graceSeconds"),
    ("COMPACT_CONCURRENCY", "compact.concurrency"),
    ("COMPACT_COMMENT_WRITES", "compact.commentWrites"),
    ("COMPACT_LEASE_SECONDS", "compact.leaseSeconds"),
    ("TRUST_SCORE_DELETE_BELOW", "trust.deleteBelow"),
    ("TRUST_SCORE_ALLOW_FROM", "trust.allowFrom"),
    ("TRUST_OPTIONAL_PLUGINS", "trust.optionalPlugins"),
    ("URLHAUS_AUTH_KEY", "urlhaus.authKey"),
    ("URLHAUS_LIST_URL", "urlhaus.listUrl"),
    ("URLHAUS_REFRESH_MINUTES", "urlhaus.refreshMinutes"),
    ("PDQ_HASH_LIST", "pdq.hashList"),
    ("PDQ_HASH_LIST_AUTHORIZATION", "pdq.authorization"),
    ("PDQ_MAX_DISTANCE", "pdq.maxDistance"),
    ("PDQ_MIN_QUALITY", "pdq.minQuality"),
    ("PDQ_REFRESH_MINUTES", "pdq.refreshMinutes"),
    ("QUARANTINE_SCHEME", "quarantine.scheme"),
    ("QUARANTINE_OPTIONS", "quarantine.options"),
    ("QUARANTINE_RETENTION_DAYS", "quarantine.retentionDays"),
    ("AUDIT_SCHEME", "audit.scheme"),
    ("AUDIT_OPTIONS", "audit.options"),
    ("COMMENTS_HOT_HOURS", "comments.hotHours"),
    ("INBOX_RETENTION_DAYS", "inbox.retentionDays"),
    ("SEARCH_MAX_KEYWORDS", "search.maxKeywords"),
    ("MONETIZATION_FEED_ADS", "monetization.feedAds"),
    ("MONETIZATION_POST_ADS", "monetization.postAds"),
];

/// What a server that is given no Redis says, rather than start.
const REDIS_URL_NEEDED: &str = "REDIS_URL is not set: the server needs the redis:// or rediss:// URL of a Redis or Valkey server, which holds the feed index";

/// The largest whole number JavaScript counts exactly, which is the largest a setting can be.
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// The database the server keeps its rows in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Dialect {
    Postgres,
    Sqlite,
    Mysql,
}

/// Where the database is, and how it is connected to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbConfig {
    pub dialect: Dialect,
    /// Connection URL for postgres/mysql, or a file path (or ":memory:") for sqlite.
    pub url: String,
    pub pool_size: i64,
    /// Connections idle this long are closed (postgres, mysql). Unset: the driver's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idle_timeout_ms: Option<i64>,
    /// Whether a process of the API brings the schema up to date when it opens the database.
    /// This side never does: it waits for the schema (see `db`).
    pub migrate_on_start: bool,
}

/// The RAM tier: feed index, summaries of the last few days, publisher credits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisConfig {
    pub url: String,
    /// Put in front of every key, so instances can share a Redis.
    pub key_prefix: String,
}

/// A store as the settings name one: an OpenDAL scheme and its options.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoreConfig {
    pub scheme: String,
    pub options: Options,
}

/// The content store: uploaded bytes and each post's meta file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentStoreConfig {
    pub scheme: String,
    pub options: Options,
    /// Lifetime of the presigned links to stored bytes.
    pub signed_url_seconds: i64,
}

/// A store that is used only where its scheme is set.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OptionalStoreConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scheme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Options>,
}

impl OptionalStoreConfig {
    /// The store, where one is named.
    pub fn store(&self) -> Option<StoreConfig> {
        self.scheme.as_ref().map(|scheme| StoreConfig {
            scheme: scheme.clone(),
            options: self.options.clone().unwrap_or_default(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageConfig {
    pub content: ContentStoreConfig,
    /// Brotli-compressed summaries for the whole retention period; unset uses the content store.
    pub summaries: OptionalStoreConfig,
    /// Where files are kept while they are worked on. Unset: the system's own place for them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tmp_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaggingConfig {
    /// `user`: any hashtags. `server`: only the server's own.
    pub mode: String,
    /// Days a hashtag's moderator can go without doing anything as one before they are its
    /// moderator no more. 0: never.
    pub moderator_inactive_days: i64,
}

/// Which types of post the server takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PostTypesConfig {
    pub text: bool,
    pub image: bool,
    pub video: bool,
    pub audio: bool,
    pub link: bool,
}

/// What the server makes of the videos it is sent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoConfig {
    pub processing: bool,
    /// The heights a post's video is made at, in pixels, tallest first.
    pub heights: Vec<i64>,
    /// The most a comment's video measures in height, in pixels.
    pub comment_height: i64,
    /// How long ffmpeg is given for one video, all of its renditions together.
    pub timeout_seconds: i64,
    pub ffmpeg_path: String,
    pub ffprobe_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepostsConfig {
    pub enabled: bool,
    /// Whether the server takes reposts of posts on other servers.
    pub remote: bool,
    /// The keys this server signs the attestations of its posts with. They are secrets.
    pub signing_keys: Vec<String>,
    /// How often, in hours, the server asks the server of each post it holds a repost of for
    /// the post's attestation again. 0: never.
    pub refresh_hours: i64,
    /// Days a repost of a post on another server stays hidden after that server said it
    /// published no post there, before the compactor deletes it.
    pub gone_days: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedConfig {
    /// How long each API node goes on reading the index a head named after the head is
    /// swapped, in milliseconds: what the compactor keeps a replaced index for.
    pub head_cache_ms: i64,
    /// Posts a tag's index keeps for today; each older UTC day keeps half the previous day's...
    pub tag_day_max_posts: i64,
    /// ...but never fewer than this.
    pub tag_day_min_posts: i64,
    /// UTC days a tag's index keeps, and summaries are stored (capped at `max_lookback_days`).
    pub tag_retention_days: i64,
    /// Posts a publisher's own index keeps per UTC day: the newest, whatever their likes.
    pub author_day_max_posts: i64,
    /// How far back a following feed reaches, and the longest a tag's index is kept.
    pub max_lookback_days: i64,
    /// Words of a text post or caption copied into each record's preview...
    pub preview_words: i64,
    /// ...and at most this many characters of them.
    pub preview_chars: i64,
    /// The most related hashtags kept for each hashtag (0: none).
    pub related_tags: i64,
    /// A hashtag is related to another once at least this many posts carry both...
    pub related_min_posts: i64,
    /// ...and those are at least this share, in percent, of the posts that carry the other.
    pub related_min_percent: i64,
    /// Summaries of posts younger than this are also kept in Redis.
    pub summary_hot_days: i64,
    /// Brotli quality (0-11) of stored summaries.
    pub summary_brotli_quality: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactConfig {
    /// A run starts this long after the previous one started, or as soon as that one ends.
    pub interval_seconds: i64,
    /// What a run leaves for a later one until it is this old.
    pub grace_seconds: i64,
    /// Batches of indexes compacted at a time.
    pub concurrency: i64,
    /// Writes to comments a run has under way at once.
    pub comment_writes: i64,
    /// Lifetime of the database lease that keeps the runs of two processes from overlapping.
    pub lease_seconds: i64,
}

/// Where a post's trust score sends it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustConfig {
    /// A post that scores less than this is deleted on arrival. 0: no post is.
    pub delete_below: i64,
    /// A post that scores at least this is published. 101: every post waits.
    pub allow_from: i64,
    /// The optional trust plugins the server runs, by the names of their folders.
    pub optional_plugins: Vec<String>,
}

/// The settings of the urlhaus trust plugin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UrlhausConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_key: Option<String>,
    /// Where the list is downloaded from, with {key} where the Auth-Key goes.
    pub list_url: String,
    pub refresh_minutes: i64,
}

/// The settings of the pdq trust plugin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdqConfig {
    /// Where the list of hashes is: the path of a file, or an http or https address.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hash_list: Option<String>,
    /// The Authorization header a list at an address is asked for with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authorization: Option<String>,
    pub max_distance: i64,
    pub min_quality: i64,
    pub refresh_minutes: i64,
}

/// Where the files that matched the pdq plugin's list are kept.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuarantineConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scheme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Options>,
    /// Days a file is kept after an admin recorded that it was reported.
    pub retention_days: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentsConfig {
    /// How long Redis keeps a post's index of its comments, each comment, and each number of likes.
    pub hot_hours: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxConfig {
    /// Days a message or a notice stays in an inbox.
    pub retention_days: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchConfig {
    /// The most words of its text or caption a post is found by.
    pub max_keywords: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonetizationConfig {
    pub feed_ads: bool,
    pub post_ads: bool,
}

/// The settings this side reads: `Config` in src/config.ts, less what only requests use. It
/// is read from what `load` resolves, and from the API's own resolved configuration, as JSON,
/// which holds every field here under the same name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub log_level: String,
    pub db: DbConfig,
    /// Absolute base URL used for media links in feed records. Empty: relative links.
    pub public_base_url: String,
    pub redis: RedisConfig,
    pub storage: StorageConfig,
    pub tagging: TaggingConfig,
    pub post_types: PostTypesConfig,
    pub video: VideoConfig,
    pub reposts: RepostsConfig,
    pub feed: FeedConfig,
    pub compact: CompactConfig,
    pub trust: TrustConfig,
    pub urlhaus: UrlhausConfig,
    pub pdq: PdqConfig,
    pub quarantine: QuarantineConfig,
    pub comments: CommentsConfig,
    pub inbox: InboxConfig,
    pub search: SearchConfig,
    pub monetization: MonetizationConfig,
}

impl Config {
    /// The store summaries are kept in: their own, or the content store where none is named.
    pub fn summary_store(&self) -> StoreConfig {
        self.storage.summaries.store().unwrap_or_else(|| StoreConfig {
            scheme: self.storage.content.scheme.clone(),
            options: self.storage.content.options.clone(),
        })
    }

    /// The quarantine's store, where the server keeps one.
    pub fn quarantine_store(&self) -> Option<StoreConfig> {
        self.quarantine.scheme.as_ref().map(|scheme| StoreConfig {
            scheme: scheme.clone(),
            options: self.quarantine.options.clone().unwrap_or_default(),
        })
    }

    /// Whether the server runs an optional trust plugin.
    pub fn runs_plugin(&self, name: &str) -> bool {
        self.trust.optional_plugins.iter().any(|plugin| plugin == name)
    }
}

/// What JavaScript's `Number()` makes of a string, for the strings that are numbers; none for
/// one that is not (NaN).
fn js_number(text: &str) -> Option<f64> {
    let text = text.trim();
    if text.is_empty() {
        return Some(0.0);
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(digits) = text.strip_prefix(prefix) {
            return u64::from_str_radix(digits, radix).ok().filter(|_| !digits.starts_with('+')).map(|n| n as f64);
        }
    }
    match text {
        "Infinity" | "+Infinity" => return Some(f64::INFINITY),
        "-Infinity" => return Some(f64::NEG_INFINITY),
        _ => {}
    }
    // Digits, a sign, a point and an exponent alone: Rust would take "inf" and "nan" too.
    if !text.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'+' | b'-' | b'.' | b'e' | b'E')) {
        return None;
    }
    text.parse::<f64>().ok()
}

/// What JavaScript's `String()` makes of a value of JSON: what an option given as a number or
/// as true is read as.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "null".to_owned(),
        Value::Bool(on) => on.to_string(),
        Value::Number(number) => number.to_string(),
        Value::Array(items) => items
            .iter()
            .map(|item| if item.is_null() { String::new() } else { js_string(item) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// The words of a setting given as a string of them, separated by commas or spaces.
fn split_words(text: &str) -> impl Iterator<Item = &str> {
    text.split(|c: char| c == ',' || c.is_whitespace()).filter(|word| !word.is_empty())
}

/// Whether `text` is the 32 bytes a signing key is made from, as a setting writes them: in
/// base64 (either alphabet, padded or not) or in hex. As `seedOf` in src/attestation.ts.
pub fn is_signing_seed(text: &str) -> bool {
    let hex = text.len() == 64 && text.bytes().all(|b| b.is_ascii_hexdigit());
    let unpadded = text.strip_suffix('=').unwrap_or(text);
    let base64 = unpadded.len() == 43 && unpadded.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'_' | b'-'));
    hex || base64
}

/// Where a store's options say it is, in one form: the options in the order of their names,
/// with a path's trailing slashes left out.
fn place_of(scheme: Option<&str>, options: Option<&Options>) -> (Option<String>, Vec<(String, String)>) {
    let entries = options
        .map(|options| {
            options
                .iter()
                .map(|(name, value)| (name.clone(), value.trim_end_matches('/').to_owned()))
                .collect()
        })
        .unwrap_or_default();
    (scheme.map(str::to_owned), entries)
}

/// Reads the settings out of what the file, the environment and the overrides said, and keeps
/// what it refuses of them: every setting is read, and all that is wrong is said at once.
struct Reader<'a> {
    root: &'a Value,
    issues: Vec<String>,
}

impl<'a> Reader<'a> {
    /// What is at a path of keys; none where nothing was said (a key that is not there).
    fn at(&self, path: &str) -> Option<&'a Value> {
        let root: &'a Value = self.root;
        path.split('.').try_fold(root, |node, key| node.get(key))
    }

    fn refuse(&mut self, path: &str, why: impl std::fmt::Display) {
        self.issues.push(format!("{path}: {why}"));
    }

    /// A setting that is text; `default` where it isn't set.
    fn string(&mut self, path: &str, default: &str) -> String {
        match self.at(path) {
            None => default.to_owned(),
            Some(Value::String(text)) => text.clone(),
            Some(_) => {
                self.refuse(path, "expected a string");
                default.to_owned()
            }
        }
    }

    /// A setting that is text of at least one character, where it is set at all.
    fn optional(&mut self, path: &str, trim: bool) -> Option<String> {
        match self.at(path) {
            None => None,
            Some(Value::String(text)) => {
                let text = if trim { text.trim() } else { text.as_str() }.to_owned();
                if text.is_empty() {
                    self.refuse(path, "expected at least one character");
                    return None;
                }
                Some(text)
            }
            Some(_) => {
                self.refuse(path, "expected a string");
                None
            }
        }
    }

    /// A setting that is text of at least one character; `default` where it isn't set.
    fn named(&mut self, path: &str, default: &str) -> String {
        self.optional(path, false).unwrap_or_else(|| default.to_owned())
    }

    /// A whole number within bounds, given as a number or as the string the environment has it
    /// in, where it is set at all.
    fn optional_int(&mut self, path: &str, min: i64, max: i64) -> Option<i64> {
        let number = match self.at(path)? {
            Value::Number(number) => number.as_f64(),
            Value::String(text) => js_number(text),
            Value::Bool(on) => Some(f64::from(u8::from(*on))),
            Value::Null => Some(0.0),
            _ => None,
        };
        let whole = number
            .filter(|n| n.is_finite() && n.fract() == 0.0 && n.abs() <= MAX_SAFE_INTEGER as f64)
            .map(|n| n as i64);
        match whole {
            Some(n) if n < min => self.refuse(path, format_args!("expected a number of at least {min}")),
            Some(n) if n > max => self.refuse(path, format_args!("expected a number of at most {max}")),
            Some(n) => return Some(n),
            None => self.refuse(path, "expected a whole number"),
        }
        None
    }

    /// A whole number within bounds; `default` where it isn't set.
    fn int(&mut self, path: &str, default: i64, min: i64, max: i64) -> i64 {
        self.optional_int(path, min, max).unwrap_or(default)
    }

    /// A whole number above zero; `default` where it isn't set.
    fn positive(&mut self, path: &str, default: i64) -> i64 {
        self.int(path, default, 1, MAX_SAFE_INTEGER)
    }

    /// A whole number from zero; `default` where it isn't set.
    fn count(&mut self, path: &str, default: i64) -> i64 {
        self.int(path, default, 0, MAX_SAFE_INTEGER)
    }

    /// A setting that is on or off; `default` where it isn't set. Of a string, as the
    /// environment has it, "1", "true" and "yes" are on, in any case, and anything else is off.
    fn boolean(&mut self, path: &str, default: bool) -> bool {
        match self.at(path) {
            None => default,
            Some(Value::Bool(on)) => *on,
            Some(Value::String(text)) => ["1", "true", "yes"].contains(&text.to_lowercase().as_str()),
            Some(_) => {
                self.refuse(path, "expected true or false");
                default
            }
        }
    }

    /// A setting that is one of a few words; `default` where it isn't set.
    fn one_of(&mut self, path: &str, words: &[&str], default: &str) -> String {
        match self.at(path) {
            None => default.to_owned(),
            Some(Value::String(text)) if words.contains(&text.as_str()) => text.clone(),
            Some(_) => {
                self.refuse(path, format_args!("expected one of {}", words.join(", ")));
                default.to_owned()
            }
        }
    }

    /// The options of a store, given as an object or as the JSON of one, where they are set.
    fn options(&mut self, path: &str) -> Option<Options> {
        let parsed;
        let value = match self.at(path)? {
            Value::String(text) => match serde_json::from_str::<Value>(text) {
                Ok(value) => {
                    parsed = value;
                    &parsed
                }
                Err(err) => {
                    self.refuse(path, format_args!("is not JSON: {err}"));
                    return None;
                }
            },
            value => value,
        };
        match value {
            Value::Object(entries) => Some(entries.iter().map(|(name, value)| (name.clone(), js_string(value))).collect()),
            _ => {
                self.refuse(path, "expected an object of options, such as {\"root\":\"./data/content\"}");
                None
            }
        }
    }

    /// A list of words, given as a list or as a string of them separated by commas or spaces:
    /// each without the space around it, and none that is empty. None where it isn't set.
    fn words(&mut self, path: &str) -> Vec<String> {
        match self.at(path) {
            None => vec![],
            Some(Value::String(text)) => split_words(text).map(str::to_owned).collect(),
            Some(Value::Array(items)) if items.iter().all(Value::is_string) => items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|word| !word.is_empty())
                .map(str::to_owned)
                .collect(),
            Some(_) => {
                self.refuse(path, "expected a list of words, or a string of them separated by commas or spaces");
                vec![]
            }
        }
    }

    /// The heights a post's video is made at: from one to eight of them, each from 144 to
    /// 2160, given as a list or as a string of them. Each once, tallest first.
    fn heights(&mut self, path: &str) -> Vec<i64> {
        let default = vec![1080, 720, 480, 240];
        let given: Vec<Option<f64>> = match self.at(path) {
            None => return default,
            Some(Value::String(text)) => split_words(text).map(js_number).collect(),
            Some(Value::Array(items)) => items
                .iter()
                .map(|item| match item {
                    Value::Number(number) => number.as_f64(),
                    Value::String(text) => js_number(text),
                    _ => None,
                })
                .collect(),
            Some(_) => vec![],
        };
        let mut heights: Vec<i64> = given
            .iter()
            .flatten()
            .filter(|n| n.fract() == 0.0 && (144.0..=2160.0).contains(*n))
            .map(|n| *n as i64)
            .collect();
        if heights.len() != given.len() || heights.is_empty() || heights.len() > 8 {
            self.refuse(path, "expected from one to eight heights in pixels, each from 144 to 2160");
            return default;
        }
        heights.sort_unstable_by(|a, b| b.cmp(a));
        heights.dedup();
        heights
    }
}

/// Sets what an environment variable says at the path of its setting.
fn set_path(target: &mut Value, path: &str, value: String) {
    let mut node = target;
    let mut keys = path.split('.').peekable();
    while let Some(key) = keys.next() {
        if !node.is_object() {
            *node = Value::Object(Map::new());
        }
        let Value::Object(entries) = node else { unreachable!("made an object above") };
        if keys.peek().is_none() {
            entries.insert(key.to_owned(), Value::String(value));
            return;
        }
        node = entries.entry(key.to_owned()).or_insert(Value::Null);
    }
}

/// `base` with what `over` says laid over it: an object over an object key by key, and
/// anything else in the other's place.
fn deep_merge(base: &mut Value, over: &Value) {
    match (base, over) {
        (Value::Object(base), Value::Object(over)) => {
            for (key, value) in over {
                match base.get_mut(key) {
                    Some(slot) if value.is_object() && slot.is_object() => deep_merge(slot, value),
                    _ => {
                        base.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        (base, over) => *base = over.clone(),
    }
}

/// Reads the settings out of what was said of them, all sources merged.
fn resolve(merged: &Value) -> Result<Config> {
    let mut r = Reader { root: merged, issues: vec![] };

    let redis_url = match r.at("redis.url") {
        Some(Value::String(url)) if !url.trim().is_empty() => url.trim().to_owned(),
        _ => {
            r.issues.push(REDIS_URL_NEEDED.to_owned());
            String::new()
        }
    };
    let dialect = match r.one_of("db.dialect", &["postgres", "sqlite", "mysql"], "sqlite").as_str() {
        "postgres" => Dialect::Postgres,
        "mysql" => Dialect::Mysql,
        _ => Dialect::Sqlite,
    };
    let mut optional_plugins = r.words("trust.optionalPlugins");
    let mut seen = std::collections::HashSet::new();
    optional_plugins.retain(|name| seen.insert(name.clone()));
    let signing_keys = r.words("reposts.signingKeys");
    if let Some(wrong) = signing_keys.iter().position(|key| !is_signing_seed(key)) {
        // Which one, by its place: a key is never put in an error.
        r.refuse(
            "reposts.signingKeys",
            format_args!(
                "key {} of REPOSTS_SIGNING_KEYS is not 32 random bytes in base64 or hex, such as `openssl rand -base64 32` makes",
                wrong + 1
            ),
        );
    }
    let list_url = match r.at("urlhaus.listUrl") {
        None => "https://urlhaus-api.abuse.ch/v2/files/exports/{key}/recent.csv".to_owned(),
        Some(Value::String(url)) => {
            let url = url.trim().to_owned();
            let scheme = url.get(..8).unwrap_or(&url).to_ascii_lowercase();
            if !(scheme.starts_with("http://") || scheme.starts_with("https://")) || url::Url::parse(&url.replace("{key}", "key")).is_err() {
                r.refuse(
                    "urlhaus.listUrl",
                    "URLHAUS_LIST_URL is an http or https URL, with {key} where the Auth-Key goes",
                );
            }
            url
        }
        Some(_) => {
            r.refuse("urlhaus.listUrl", "expected a string");
            String::new()
        }
    };

    // The audit log's store is not this side's to write, and is read for one thing: the quarantine may not share it.
    let audit = OptionalStoreConfig {
        scheme: r.optional("audit.scheme", false),
        options: r.options("audit.options"),
    };

    let config = Config {
        log_level: r.string("logLevel", "info"),
        db: DbConfig {
            dialect,
            url: r.string("db.url", "./data/evieverse.sqlite"),
            pool_size: r.positive("db.poolSize", 10),
            idle_timeout_ms: r.optional_int("db.idleTimeoutMs", 1, MAX_SAFE_INTEGER),
            migrate_on_start: r.boolean("db.migrateOnStart", true),
        },
        public_base_url: r.string("publicBaseUrl", ""),
        redis: RedisConfig {
            url: redis_url,
            key_prefix: r.string("redis.keyPrefix", "ev:"),
        },
        storage: StorageConfig {
            content: ContentStoreConfig {
                scheme: r.named("storage.content.scheme", "fs"),
                options: r
                    .options("storage.content.options")
                    .unwrap_or_else(|| Options::from([("root".to_owned(), "./data/content".to_owned())])),
                signed_url_seconds: r.positive("storage.content.signedUrlSeconds", 900),
            },
            summaries: OptionalStoreConfig {
                scheme: r.optional("storage.summaries.scheme", false),
                options: r.options("storage.summaries.options"),
            },
            tmp_path: if r.at("storage.tmpPath").is_some() {
                Some(r.string("storage.tmpPath", ""))
            } else {
                None
            },
        },
        tagging: TaggingConfig {
            mode: r.one_of("tagging.mode", &["server", "user"], "user"),
            moderator_inactive_days: r.count("tagging.moderatorInactiveDays", 365),
        },
        post_types: PostTypesConfig {
            text: r.boolean("postTypes.text", true),
            image: r.boolean("postTypes.image", true),
            video: r.boolean("postTypes.video", true),
            audio: r.boolean("postTypes.audio", true),
            link: r.boolean("postTypes.link", true),
        },
        video: VideoConfig {
            processing: r.boolean("video.processing", true),
            heights: r.heights("video.heights"),
            comment_height: r.int("video.commentHeight", 720, 144, 2160),
            timeout_seconds: r.positive("video.timeoutSeconds", 3600),
            ffmpeg_path: r.named("video.ffmpegPath", "ffmpeg"),
            ffprobe_path: r.named("video.ffprobePath", "ffprobe"),
        },
        reposts: RepostsConfig {
            enabled: r.boolean("reposts.enabled", true),
            remote: r.boolean("reposts.remote", true),
            signing_keys,
            refresh_hours: r.count("reposts.refreshHours", 24),
            gone_days: r.positive("reposts.goneDays", 7),
        },
        feed: FeedConfig {
            head_cache_ms: r.count("feed.headCacheMs", 1000),
            tag_day_max_posts: r.positive("feed.tagDayMaxPosts", 400),
            tag_day_min_posts: r.positive("feed.tagDayMinPosts", 40),
            tag_retention_days: r.positive("feed.tagRetentionDays", 90),
            author_day_max_posts: r.positive("feed.authorDayMaxPosts", 1000),
            max_lookback_days: r.int("feed.maxLookbackDays", 90, 7, MAX_SAFE_INTEGER),
            preview_words: r.positive("feed.previewWords", 100),
            preview_chars: r.positive("feed.previewChars", 1000),
            related_tags: r.count("feed.relatedTags", 3),
            related_min_posts: r.positive("feed.relatedMinPosts", 5),
            related_min_percent: r.int("feed.relatedMinPercent", 20, 0, 100),
            summary_hot_days: r.positive("feed.summaryHotDays", 8),
            summary_brotli_quality: r.int("feed.summaryBrotliQuality", 11, 0, 11),
        },
        compact: CompactConfig {
            interval_seconds: r.positive("compact.intervalSeconds", 5),
            grace_seconds: r.count("compact.graceSeconds", 30),
            concurrency: r.positive("compact.concurrency", 4),
            comment_writes: r.positive("compact.commentWrites", 16),
            lease_seconds: r.int("compact.leaseSeconds", 60, 30, MAX_SAFE_INTEGER),
        },
        trust: TrustConfig {
            delete_below: r.int("trust.deleteBelow", 25, 0, 100),
            allow_from: r.int("trust.allowFrom", 75, 0, 101),
            optional_plugins,
        },
        urlhaus: UrlhausConfig {
            auth_key: r.optional("urlhaus.authKey", true),
            list_url,
            refresh_minutes: r.int("urlhaus.refreshMinutes", 15, 5, MAX_SAFE_INTEGER),
        },
        pdq: PdqConfig {
            hash_list: r.optional("pdq.hashList", true),
            authorization: r.optional("pdq.authorization", true),
            max_distance: r.int("pdq.maxDistance", 31, 0, 63),
            min_quality: r.int("pdq.minQuality", 50, 0, 100),
            refresh_minutes: r.int("pdq.refreshMinutes", 60, 1, MAX_SAFE_INTEGER),
        },
        quarantine: QuarantineConfig {
            scheme: r.optional("quarantine.scheme", false),
            options: r.options("quarantine.options"),
            retention_days: r.positive("quarantine.retentionDays", 365),
        },
        comments: CommentsConfig {
            hot_hours: r.positive("comments.hotHours", 24),
        },
        inbox: InboxConfig {
            retention_days: r.positive("inbox.retentionDays", 90),
        },
        search: SearchConfig {
            max_keywords: r.positive("search.maxKeywords", 100),
        },
        monetization: MonetizationConfig {
            feed_ads: r.boolean("monetization.feedAds", false),
            post_ads: r.boolean("monetization.postAds", false),
        },
    };

    let types = config.post_types;
    if !(types.text || types.image || types.video || types.audio || types.link) {
        r.refuse(
            "postTypes",
            "the server needs a type of post to take: POST_TYPE_TEXT, POST_TYPE_IMAGE, POST_TYPE_VIDEO, POST_TYPE_AUDIO and POST_TYPE_LINK are all off",
        );
    }
    if config.trust.delete_below > config.trust.allow_from {
        r.refuse("trust.deleteBelow", "TRUST_SCORE_DELETE_BELOW can be at most TRUST_SCORE_ALLOW_FROM");
    }
    if config.runs_plugin("urlhaus") && config.urlhaus.auth_key.is_none() {
        r.refuse(
            "urlhaus.authKey",
            "TRUST_OPTIONAL_PLUGINS turns on urlhaus, which needs URLHAUS_AUTH_KEY: the Auth-Key of an abuse.ch account, which is free (https://auth.abuse.ch)",
        );
    }
    if config.runs_plugin("pdq") && config.pdq.hash_list.is_none() {
        r.refuse(
            "pdq.hashList",
            "TRUST_OPTIONAL_PLUGINS turns on pdq, which needs PDQ_HASH_LIST: the file or the address of the list of PDQ hashes it matches images against",
        );
    }
    if config.runs_plugin("pdq") && config.trust.allow_from <= 0 {
        r.refuse(
            "trust.allowFrom",
            "TRUST_OPTIONAL_PLUGINS turns on pdq, which needs TRUST_SCORE_ALLOW_FROM above 0: at 0 every post is published whatever its score, an image that matches the list too",
        );
    }
    if config.quarantine.scheme.is_some() {
        let place = place_of(config.quarantine.scheme.as_deref(), config.quarantine.options.as_ref());
        let summaries = &config.storage.summaries;
        let shared = place == place_of(Some(&config.storage.content.scheme), Some(&config.storage.content.options))
            || (summaries.scheme.is_some() && place == place_of(summaries.scheme.as_deref(), summaries.options.as_ref()))
            || (audit.scheme.is_some() && place == place_of(audit.scheme.as_deref(), audit.options.as_ref()));
        if shared {
            r.refuse(
                "quarantine.scheme",
                "QUARANTINE_SCHEME and QUARANTINE_OPTIONS name a store that another setting names too (CONTENT_SCHEME, SUMMARY_SCHEME or AUDIT_SCHEME, with the same options): the quarantine needs a store of its own, which nothing else is read from or written to",
            );
        }
    }

    if !r.issues.is_empty() {
        bail!("the configuration is not one the server runs with:\n  {}", r.issues.join("\n  "));
    }
    Ok(config)
}

/// Loads the configuration from (lowest to highest precedence): defaults, a JSON file
/// (EVIEVERSE_CONFIG or ./evieverse.config.json, looked for from `cwd`), the environment as
/// `env` gives it, and `overrides`.
pub fn load_with(overrides: &Value, env: &dyn Fn(&str) -> Option<String>, cwd: &Path) -> Result<Config> {
    let mut merged = json!({});
    let file = cwd.join(env("EVIEVERSE_CONFIG").unwrap_or_else(|| "evieverse.config.json".to_owned()));
    if file.exists() {
        let text = std::fs::read_to_string(&file).with_context(|| format!("could not read {}", file.display()))?;
        let said: Value = serde_json::from_str(&text).with_context(|| format!("{} is not JSON", file.display()))?;
        deep_merge(&mut merged, &said);
    }
    let mut from_env = json!({});
    for (name, path) in ENV_MAP {
        if let Some(value) = env(name).filter(|value| !value.is_empty()) {
            set_path(&mut from_env, path, value);
        }
    }
    deep_merge(&mut merged, &from_env);
    deep_merge(&mut merged, overrides);
    resolve(&merged)
}

/// Loads the configuration of this process: from its environment and the folder it runs in.
pub fn load() -> Result<Config> {
    let cwd = std::env::current_dir().context("the process has no folder it runs in")?;
    load_with(&json!({}), &|name| std::env::var(name).ok(), &cwd)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn load_env(vars: &[(&str, &str)]) -> Result<Config> {
        let dir = tempfile::tempdir().unwrap();
        let vars: Vec<(String, String)> = vars.iter().map(|(name, value)| ((*name).to_owned(), (*value).to_owned())).collect();
        load_with(
            &json!({}),
            &|name| vars.iter().find(|(n, _)| n == name).map(|(_, value)| value.clone()),
            dir.path(),
        )
    }

    #[test]
    fn fills_what_is_not_set_with_the_defaults_of_the_api() {
        let config = load_env(&[("REDIS_URL", "redis://127.0.0.1:6379")]).unwrap();
        assert_eq!(config.db.dialect, Dialect::Sqlite);
        assert_eq!(config.db.url, "./data/evieverse.sqlite");
        assert_eq!(config.redis.key_prefix, "ev:");
        assert_eq!(config.storage.content.options["root"], "./data/content");
        assert_eq!(config.video.heights, [1080, 720, 480, 240]);
        assert_eq!(config.compact.interval_seconds, 5);
        assert_eq!(config.summary_store().scheme, "fs");
        assert!(config.quarantine_store().is_none());
    }

    #[test]
    fn reads_the_environment_as_the_api_reads_it() {
        let config = load_env(&[
            ("REDIS_URL", " redis://r:6379 "),
            ("DB_DIALECT", "postgres"),
            ("DB_POOL_SIZE", " 0x10 "),
            ("COMPACT_GRACE_SECONDS", "0"),
            ("VIDEO_PROCESSING", "YES"),
            ("POST_TYPE_AUDIO", "off"),
            ("VIDEO_HEIGHTS", "480, 720 480"),
            ("CONTENT_OPTIONS", r#"{"bucket":"b","port":9000,"tls":true}"#),
            ("TRUST_OPTIONAL_PLUGINS", "urlhaus, urlhaus"),
            ("URLHAUS_AUTH_KEY", "k"),
            ("SUMMARY_SCHEME", ""),
        ])
        .unwrap();
        assert_eq!(config.redis.url, "redis://r:6379");
        assert_eq!(config.db.dialect, Dialect::Postgres);
        assert_eq!(config.db.pool_size, 16);
        assert_eq!(config.compact.grace_seconds, 0);
        assert!(config.video.processing && !config.post_types.audio);
        assert_eq!(config.video.heights, [720, 480]);
        assert_eq!(
            config.storage.content.options,
            Options::from([("bucket".into(), "b".into()), ("port".into(), "9000".into()), ("tls".into(), "true".into())])
        );
        assert_eq!(config.trust.optional_plugins, ["urlhaus"]);
        assert_eq!(config.storage.summaries.scheme, None);
    }

    #[test]
    fn refuses_what_the_api_refuses() {
        let refused = |vars: &[(&str, &str)]| load_env(vars).unwrap_err().to_string();
        assert!(refused(&[]).contains("REDIS_URL is not set"));
        let redis = ("REDIS_URL", "redis://r");
        assert!(refused(&[redis, ("DB_POOL_SIZE", "0")]).contains("db.poolSize"));
        assert!(refused(&[redis, ("DB_POOL_SIZE", "ten")]).contains("db.poolSize"));
        assert!(refused(&[redis, ("COMPACT_LEASE_SECONDS", "29")]).contains("compact.leaseSeconds"));
        assert!(refused(&[redis, ("DB_DIALECT", "oracle")]).contains("db.dialect"));
        assert!(refused(&[redis, ("TRUST_OPTIONAL_PLUGINS", "pdq")]).contains("PDQ_HASH_LIST"));
        assert!(refused(&[redis, ("QUARANTINE_SCHEME", "fs"), ("QUARANTINE_OPTIONS", r#"{"root":"./data/content/"}"#)]).contains("QUARANTINE_SCHEME"));
        assert!(refused(&[redis, ("REPOSTS_SIGNING_KEYS", "abc")]).contains("key 1 of REPOSTS_SIGNING_KEYS"));
        assert!(refused(&[redis, ("VIDEO_HEIGHTS", "100")]).contains("video.heights"));
    }

    #[test]
    fn lays_the_environment_over_the_file_and_overrides_over_both() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("evieverse.config.json"),
            r#"{"redis":{"url":"redis://file","keyPrefix":"f:"},"compact":{"intervalSeconds":9,"concurrency":2},"apiOnly":{"x":1}}"#,
        )
        .unwrap();
        let env = |name: &str| (name == "COMPACT_INTERVAL_SECONDS").then(|| "7".to_owned());
        let config = load_with(&json!({ "redis": { "keyPrefix": "o:" } }), &env, dir.path()).unwrap();
        assert_eq!(config.redis.url, "redis://file");
        assert_eq!(config.redis.key_prefix, "o:");
        assert_eq!(config.compact.interval_seconds, 7);
        assert_eq!(config.compact.concurrency, 2);
    }

    #[test]
    fn reads_numbers_as_javascript_does() {
        assert_eq!(js_number(" 12 "), Some(12.0));
        assert_eq!(js_number(""), Some(0.0));
        assert_eq!(js_number("1e3"), Some(1000.0));
        assert_eq!(js_number("0b101"), Some(5.0));
        assert_eq!(js_number("nan"), None);
        assert_eq!(js_number("inf"), None);
        assert_eq!(js_number("12px"), None);
        assert!(is_signing_seed(&"ab".repeat(32)) && is_signing_seed(&"A".repeat(43)) && is_signing_seed(&format!("{}=", "A".repeat(43))));
        assert!(!is_signing_seed(&"A".repeat(44)) && !is_signing_seed(""));
    }
}
