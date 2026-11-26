//! Attestations: what a server says of one of its own posts, signed, so that another server
//! can tell it is the post's own server that said it. A repost of a post on another server is
//! made from one (POST /repost), and from nothing else: what a client says of a post
//! elsewhere is believed only as far as that post's server signed it.
//!
//! A server signs with an Ed25519 key of its own (REPOSTS_SIGNING_KEYS), and publishes the
//! public half (GET /repost/keys). It gives the attestation of a post to anyone who asks (GET
//! /content/:id/attestation): the post's address there, its publisher, and its summary, with
//! when that was said and which key signed it. Whoever is given one reads the address in it,
//! asks the server at that address for its keys (see `origin_keys`), and checks the
//! signature. So the keys a post is checked with are the ones served where the post is:
//! nobody signs for an address they don't serve.
//!
//! An attestation is two parts with a dot between them, each in base64url: the payload, which
//! is JSON, and the signature. What is signed is the payload's part as it is written, after a
//! prefix that says what the signature is for. So it is checked against the bytes that
//! arrived, and JSON is read only to learn what they say.
//!
//! What it doesn't say: that the post's server tells the truth about its own posts, which it
//! is free not to; who the person behind a publisher's name is, which is a name on that
//! server and nothing more; and that the post is still what it was, once the attestation is
//! used.
//!
//! So a server that holds a repost is told what the post became by a later attestation of it,
//! which it asks the post's server for now and then (the compactor's origin sweep) and which
//! anyone can bring sooner (POST /repost/refresh): a newer one replaces the summary, and one
//! that says the post is gone (`AttestedGone`), which a server signs in place of whatever it
//! doesn't publish, has the repost hidden. An older one changes nothing.
//!
//! This is the one implementation of it: the compactor's process reads attestations with it,
//! and the API does through its addon.

use anyhow::{Context, Result, bail};
use base64::Engine;
use base64::alphabet;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use ed25519_dalek::{Signature, Signer, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::json::js_number;
use crate::posts::{MAX_TEXT_CHARS, OriginPublisher, Preview, PreviewKind, Video, link_url};
use crate::text::{trim, units};
use crate::time::MINUTE;

/// How long an attestation is taken for after it was issued. A client asks for one and sends
/// it on at once, so this is time enough, and a post that was changed or deleted since is
/// reposted as it was for no longer than this.
pub const ATTESTATION_MAX_AGE_MS: i64 = 10 * MINUTE;

/// How far ahead of this server's clock the clock of the server that issued an attestation
/// may be.
pub const ATTESTATION_SKEW_MS: i64 = MINUTE;

/// The longest attestation a request can carry, in characters. A payload is little beside its
/// preview's text, which is at most MAX_TEXT_CHARS UTF-16 units: up to six bytes each as JSON
/// writes the ones it escapes, and a third more in base64. The alternative texts of an
/// album's images, of a server that takes what this one does, come to less than half as much
/// again.
pub const MAX_ATTESTATION_CHARS: usize = 600_000;

/// The most images an attestation can say an image post has. More than this server's own
/// posts take: how many a post has is its own server's to decide, within reason.
const MAX_ATTESTED_IMAGES: usize = 100;

/// The longest alternative text an attestation can give one image, in UTF-16 units. More than
/// this server's own images take, as with how many images a post has.
const MAX_ATTESTED_ALT_CHARS: usize = 5000;

/// The most an attestation can say a video measures along one side, in pixels.
const MAX_ATTESTED_PIXELS: i64 = 16_384;

/// The longest an attestation can say a video is, in seconds: a week.
const MAX_ATTESTED_SECONDS: f64 = 7.0 * 24.0 * 3600.0;

/// The longest name of a publisher, and the longest content type, in UTF-16 units.
const MAX_USERNAME_CHARS: usize = 64;
const MAX_MIME_TYPE_CHARS: usize = 255;

/// The largest whole number the API's language counts with exactly.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// What is signed starts with this: a signature made with the same key for anything else is
/// no attestation's.
const CONTEXT: &str = "evieverse-repost-attestation-v1.";

/// What comes before a post's id at the end of its address on its own server, as GET
/// /content/:id reads it.
const POST_PATH: &str = "/content/";

/// How long an id is, as it is written: 32 hex digits in five groups.
const ID_CHARS: usize = 36;

/// How long a signature is as it is written, in base64url: its 64 bytes.
const SIGNATURE_CHARS: usize = 86;

/// How long a public key is as a server publishes it, in base64url: its 32 bytes.
const PUBLIC_KEY_CHARS: usize = 43;

/// Base64 as the API's language reads it: padded or not, and whatever the last character's
/// spare bits are.
const LENIENT: GeneralPurposeConfig = GeneralPurposeConfig::new()
    .with_decode_padding_mode(DecodePaddingMode::Indifferent)
    .with_decode_allow_trailing_bits(true);
const BASE64: GeneralPurpose = GeneralPurpose::new(&alphabet::STANDARD, LENIENT);
const BASE64_URL: GeneralPurpose = GeneralPurpose::new(&alphabet::URL_SAFE, LENIENT.with_encode_padding(false));

/// Whether a text is written in base64url's characters, and has some.
fn is_base64_url(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

/// The bytes a text in base64url's characters holds. A last character that completes no byte
/// holds nothing, and is left out.
fn from_base64_url(text: &str) -> Option<Vec<u8>> {
    let whole = if text.len() % 4 == 1 { &text[..text.len() - 1] } else { text };
    BASE64_URL.decode(whole).ok()
}

/// Whether a text is an id as it is written: 32 hex digits, in groups of 8, 4, 4, 4 and 12.
fn is_id(text: &str) -> bool {
    text.len() == ID_CHARS
        && text.bytes().enumerate().all(|(at, b)| match at {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

/// Whether a text is a UUID of any version, or the one of all zeros or of all ones, as the
/// API takes one for.
fn is_uuid(text: &str) -> bool {
    if !is_id(text) {
        return false;
    }
    let lower = text.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    (matches!(bytes[14], b'1'..=b'8') && matches!(bytes[19], b'8' | b'9' | b'a' | b'b'))
        || text == "00000000-0000-0000-0000-000000000000"
        || text == "ffffffff-ffff-ffff-ffff-ffffffffffff"
}

/// Where the address of a post starts to name the post, and the post's id, if `address` (or
/// a path) ends as a post's does: with `/content/` and an id.
pub fn post_of(address: &str) -> Option<(usize, &str)> {
    let at = address.len().checked_sub(POST_PATH.len() + ID_CHARS)?;
    let (before, id) = (address.get(at..at + POST_PATH.len())?, address.get(at + POST_PATH.len()..)?);
    (before.eq_ignore_ascii_case(POST_PATH) && is_id(id)).then_some((at, id))
}

/// The server a post's address is on: the address without what names the post.
pub fn server_of(address: &str) -> &str {
    post_of(address).map_or(address, |(at, _)| &address[..at])
}

/// The server a post's address is on, if it is one that is asked for its keys: over https
/// only, on the port https has. The URL parser leaves out the port that is https's own, so
/// one that is there is another.
pub fn asked_server(address: &str) -> Option<&str> {
    let server = server_of(address);
    let own_port = url::Url::parse(address).is_ok_and(|url| url.port().is_none());
    (server.starts_with("https://") && own_port).then_some(server)
}

/// The host an address is on, with its port if it names one: what tells one server from
/// another.
pub fn host_of(address: &str) -> Option<String> {
    let url = url::Url::parse(address).ok()?;
    let host = url.host_str()?;
    Some(url.port().map_or_else(|| host.to_owned(), |port| format!("{host}:{port}")))
}

/// What the server knows an original on another server by: the SHA-256, in hex, of its
/// address (see `content.origin_hash`).
pub fn origin_hash(address: &str) -> String {
    hex::encode(Sha256::digest(address.as_bytes()))
}

/// The id of a public key, given its bytes: the first 8 bytes of its SHA-256, in hex.
fn key_id(public_key: &[u8]) -> String {
    hex::encode(&Sha256::digest(public_key).as_slice()[..8])
}

/// The 32 bytes a signing key is made from, as a setting writes them: in base64 (either
/// alphabet, padded or not) or in hex. None for anything else.
pub fn seed_of(text: &str) -> Option<[u8; 32]> {
    if !crate::config::is_signing_seed(text) {
        return None;
    }
    let bytes = if text.len() == 64 {
        hex::decode(text).ok()?
    } else {
        BASE64.decode(text.replace('-', "+").replace('_', "/")).ok()?
    };
    bytes.try_into().ok()
}

/// A key a server signs with.
#[derive(Clone)]
pub struct SigningKey {
    /// What an attestation names the key by.
    pub id: String,
    /// The public half as the server publishes it: its 32 bytes in base64url.
    pub public_key: String,
    key: ed25519_dalek::SigningKey,
}

/// A key as a server publishes it, with the id an attestation names it by.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedKey {
    pub id: String,
    pub public_key: String,
}

impl SigningKey {
    /// The key as the server publishes it.
    pub fn published(&self) -> PublishedKey {
        PublishedKey {
            id: self.id.clone(),
            public_key: self.public_key.clone(),
        }
    }
}

/// The key a seed makes, as a setting writes the seed.
pub fn signing_key(seed: &str) -> Result<SigningKey> {
    let seed = seed_of(seed).context("a signing key is 32 random bytes, in base64 or hex")?;
    let key = ed25519_dalek::SigningKey::from_bytes(&seed);
    let public = key.verifying_key().to_bytes();
    Ok(SigningKey {
        id: key_id(&public),
        public_key: BASE64_URL.encode(public),
        key,
    })
}

/// The keys a server signs with, from its setting (`reposts.signingKeys`, which the
/// configuration has checked): the first signs, and all are published, so that what an
/// earlier key signed is still taken while a new one comes in.
pub fn signing_keys(seeds: &[String]) -> Result<Vec<SigningKey>> {
    seeds.iter().map(|seed| signing_key(seed)).collect()
}

/// A key as another server published it, or none if what it published isn't an Ed25519
/// public key. Its id is worked out here, from the key: the one it was published with is not
/// read.
pub fn published_key(public_key: &str) -> Option<PublishedKey> {
    if public_key.len() != PUBLIC_KEY_CHARS || !is_base64_url(public_key) {
        return None;
    }
    Some(PublishedKey {
        id: key_id(&from_base64_url(public_key)?),
        public_key: public_key.to_owned(),
    })
}

/// The attestation of a post, or of there being none at an address, signed with `key` as of
/// `issued_at`. `said` is what the server says of it, as the JSON of an object: all of an
/// attestation but what signing adds, which is put before it.
pub fn attest(key: &SigningKey, said: &str, issued_at: i64) -> Result<String> {
    let rest = trim(said).strip_prefix('{').context("what a server attests is an object")?;
    let between = if trim(rest) == "}" { "" } else { "," };
    let json = format!("{{\"v\":1,\"kid\":\"{}\",\"issuedAt\":{issued_at}{between}{rest}", key.id);
    if !serde_json::from_str::<Value>(&json).is_ok_and(|payload| payload.is_object()) {
        bail!("what a server attests is an object");
    }
    let payload = BASE64_URL.encode(json);
    let signature = key.key.sign(format!("{CONTEXT}{payload}").as_bytes());
    Ok(format!("{payload}.{}", BASE64_URL.encode(signature.to_bytes())))
}

/// An attestation taken apart. Nothing of it is checked yet.
#[derive(Debug, Clone)]
pub struct ReadAttestation {
    /// What it says, as the JSON it is.
    pub payload: Value,
    /// What its signature is of.
    signed: Vec<u8>,
    signature: Vec<u8>,
}

/// An attestation taken apart, or none if `text` isn't written as one.
pub fn read_attestation(text: &str) -> Option<ReadAttestation> {
    let (payload, signature) = text.split_once('.')?;
    if !is_base64_url(payload) || signature.len() != SIGNATURE_CHARS || !is_base64_url(signature) {
        return None;
    }
    let json = from_base64_url(payload)?;
    Some(ReadAttestation {
        payload: crate::json::from_str(&String::from_utf8_lossy(&json)).ok()?,
        signed: format!("{CONTEXT}{payload}").into_bytes(),
        signature: from_base64_url(signature)?,
    })
}

/// Whether the key a server published as `public_key` signed the attestation: its signature
/// is that key's, of the bytes that arrived. A key that isn't one signed nothing.
pub fn signed_by(public_key: &str, read: &ReadAttestation) -> bool {
    let key = is_base64_url(public_key)
        .then(|| from_base64_url(public_key))
        .flatten()
        .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
        .and_then(|bytes| VerifyingKey::from_bytes(&bytes).ok());
    let signature = Signature::from_slice(&read.signature).ok();
    match (key, signature) {
        (Some(key), Some(signature)) => key.verify(&read.signed, &signature).is_ok(),
        _ => false,
    }
}

/// Whether a payload says its post is gone: it is then read as an `AttestedGone`, and as a
/// post otherwise.
pub fn says_gone(payload: &Value) -> bool {
    payload.get("gone") == Some(&Value::Bool(true)) && payload.is_object()
}

/// What an attestation says of a post that is there: the post, as its own server gives it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttestedPost {
    /// The version of the format.
    pub v: u8,
    /// The id of the key that signed.
    pub kid: String,
    /// When, in UTC epoch milliseconds, by the clock of the server that signed.
    pub issued_at: i64,
    /// The post's address on its own server: https://other.example/content/<id>, with nothing
    /// after the id and nobody's credentials in it. Its id is in lower case, so that a post
    /// has one address however it was written.
    pub url: String,
    /// Who published it there. The name is one line.
    pub publisher: OriginPublisher,
    /// Its content type, in lower case. Needed of an image, video or audio; a text's and a
    /// link's are their own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    pub ai_generated: bool,
    /// Its summary, as feeds show it there. An image's, video's or audio's has no `url`: the
    /// bytes are read at the post's address.
    pub preview: Preview,
}

/// What an attestation says of an address at which the server publishes no post: `gone`, and
/// nothing of a post. It is what a server signs for a post it deleted, and for anything else
/// that isn't published there, which it doesn't tell apart for anyone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttestedGone {
    pub v: u8,
    pub kid: String,
    pub issued_at: i64,
    pub url: String,
    pub gone: bool,
}

/// What an attestation says: a post, or that there is none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum Attested {
    Post(Box<AttestedPost>),
    Gone(AttestedGone),
}

impl Attested {
    /// The address it is of.
    pub fn url(&self) -> &str {
        match self {
            Self::Post(post) => &post.url,
            Self::Gone(gone) => &gone.url,
        }
    }

    /// The id of the key that signed it.
    pub fn kid(&self) -> &str {
        match self {
            Self::Post(post) => &post.kid,
            Self::Gone(gone) => &gone.kid,
        }
    }

    /// When it was issued.
    pub fn issued_at(&self) -> i64 {
        match self {
            Self::Post(post) => post.issued_at,
            Self::Gone(gone) => gone.issued_at,
        }
    }
}

/// Something a payload says that an attestation doesn't, or doesn't say that one must: where
/// in the payload, and what is wrong there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Issue {
    pub path: Vec<String>,
    pub message: String,
}

/// What is wrong with a payload, as it is found.
#[derive(Default)]
struct Issues(Vec<Issue>);

impl Issues {
    fn add(&mut self, path: &[&str], message: &str) {
        self.0.push(Issue {
            path: path.iter().map(|part| (*part).to_owned()).collect(),
            message: message.to_owned(),
        });
    }

    /// A text at `path`, without the white space around it, of `min` to `max` UTF-16 units.
    fn text(&mut self, value: Option<&Value>, path: &[&str], min: usize, max: usize) -> Option<String> {
        let Some(Value::String(text)) = value else {
            self.add(path, "expected a string");
            return None;
        };
        let text = trim(text);
        let length = units(text);
        if length < min {
            self.add(path, &format!("expected at least {min} characters"));
            return None;
        }
        if length > max {
            self.add(path, &format!("expected at most {max} characters"));
            return None;
        }
        Some(text.to_owned())
    }

    /// A text at `path` that may be left out.
    fn optional_text(&mut self, value: Option<&Value>, path: &[&str], max: usize) -> Option<String> {
        value.and_then(|value| self.text(Some(value), path, 0, max))
    }

    /// A whole number at `path`, from `min` to `max`.
    fn whole(&mut self, value: Option<&Value>, path: &[&str], min: i64, max: i64) -> Option<i64> {
        let n = value.and_then(Value::as_f64).filter(|n| n.fract() == 0.0 && n.abs() <= MAX_SAFE_INTEGER);
        // Whole, and within what is counted with exactly: the cast loses nothing.
        match n.map(|n| n as i64) {
            Some(n) if n >= min && n <= max => Some(n),
            Some(n) => {
                let bound = if n < min { format!("at least {min}") } else { format!("at most {max}") };
                self.add(path, &format!("expected a number of {bound}"));
                None
            }
            None => {
                self.add(path, "expected a whole number");
                None
            }
        }
    }

    /// An id at `path`.
    fn uuid(&mut self, value: Option<&Value>, path: &[&str]) -> Option<String> {
        match value {
            Some(Value::String(id)) if is_uuid(id) => Some(id.clone()),
            _ => {
                self.add(path, "expected a UUID");
                None
            }
        }
    }

    /// An http or https address at `path`, as the URL parser writes it.
    fn link(&mut self, value: Option<&Value>, path: &[&str]) -> Option<String> {
        let link = value.and_then(Value::as_str).and_then(link_url);
        if link.is_none() {
            self.add(path, "expected an http or https address");
        }
        link
    }
}

/// What every attestation says: the version of the format, the key that signed, when, and the
/// address of the post it is of.
struct Signed {
    v: u8,
    kid: String,
    issued_at: i64,
    url: String,
}

/// An address as an attestation gives a post's: one post's on its own server, with nothing
/// after the id and nobody's credentials in it, and the id in lower case.
fn post_address(href: &str) -> Option<String> {
    let url = url::Url::parse(href).ok()?;
    let nothing = |part: Option<&str>| part.is_none_or(str::is_empty);
    if post_of(url.path()).is_none() || !nothing(url.query()) || !nothing(url.fragment()) || !url.username().is_empty() || !nothing(url.password()) {
        return None;
    }
    Some(match post_of(href) {
        Some((at, _)) => format!("{}{}", &href[..at], href[at..].to_ascii_lowercase()),
        None => href.to_owned(),
    })
}

fn signed(said: &Map<String, Value>, issues: &mut Issues) -> Option<Signed> {
    let v = said.get("v").and_then(Value::as_f64).filter(|v| *v == 1.0);
    if v.is_none() {
        issues.add(&["v"], "expected 1");
    }
    let kid = said
        .get("kid")
        .and_then(Value::as_str)
        .filter(|kid| kid.len() == 16 && kid.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')));
    if kid.is_none() {
        issues.add(&["kid"], "expected the id of a key: 16 hex digits");
    }
    let issued_at = issues.whole(said.get("issuedAt"), &["issuedAt"], 0, i64::MAX);
    let url = issues.link(said.get("url"), &["url"]).and_then(|href| {
        let address = post_address(&href);
        if address.is_none() {
            issues.add(&["url"], "expected the address of a post on its own server");
        }
        address
    });
    let signed = Signed {
        v: 1,
        kid: kid?.to_owned(),
        issued_at: issued_at?,
        url: url?,
    };
    v.is_some().then_some(signed)
}

fn publisher(value: Option<&Value>, issues: &mut Issues) -> Option<OriginPublisher> {
    let Some(Value::Object(said)) = value else {
        issues.add(&["publisher"], "expected an object");
        return None;
    };
    let user_id = issues.uuid(said.get("userId"), &["publisher", "userId"]);
    let path = ["publisher", "username"];
    let username = issues.text(said.get("username"), &path, 1, MAX_USERNAME_CHARS).and_then(|name| {
        // The name is kept on a line of the summary.
        if name
            .chars()
            .any(|c| matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}' | '\u{85}' | '\u{2028}' | '\u{2029}'))
        {
            issues.add(&path, "expected a name of one line");
            return None;
        }
        Some(name)
    });
    Some(OriginPublisher {
        user_id: user_id?,
        username: username?,
    })
}

/// Whether a character is one a content type is written with, beside its slash.
fn in_mime_type(c: char) -> bool {
    c.is_ascii_alphanumeric() || "!#$&^_.+-".contains(c)
}

fn mime_type(value: Option<&Value>, issues: &mut Issues) -> Option<String> {
    let path = ["mimeType"];
    let written = issues.text(Some(value?), &path, 0, MAX_MIME_TYPE_CHARS)?;
    let is_one = written
        .split_once('/')
        .is_some_and(|(kind, of)| !kind.is_empty() && !of.is_empty() && kind.chars().all(in_mime_type) && of.chars().all(in_mime_type));
    if !is_one {
        issues.add(&path, "expected a content type");
        return None;
    }
    Some(written.to_ascii_lowercase())
}

fn video(value: Option<&Value>, issues: &mut Issues) -> Option<Video> {
    let path = ["preview", "video"];
    let Some(Value::Object(said)) = value else {
        issues.add(&path, "expected an object");
        return None;
    };
    let id = issues.uuid(said.get("id"), &["preview", "video", "id"]);
    let width = issues.whole(said.get("width"), &["preview", "video", "width"], 1, MAX_ATTESTED_PIXELS);
    let height = issues.whole(said.get("height"), &["preview", "video", "height"], 1, MAX_ATTESTED_PIXELS);
    let duration = said
        .get("duration")
        .and_then(Value::as_f64)
        .filter(|seconds| (0.0..=MAX_ATTESTED_SECONDS).contains(seconds));
    if duration.is_none() {
        issues.add(&["preview", "video", "duration"], "expected a number of seconds, of a week at most");
    }
    Some(Video {
        id: id?,
        width: width?.into(),
        height: height?.into(),
        duration: js_number(duration?)?,
        poster: None,
        hls: None,
    })
}

fn alts(value: &Value, issues: &mut Issues) -> Option<Vec<String>> {
    let path = ["preview", "alt"];
    let Value::Array(said) = value else {
        issues.add(&path, "expected a list");
        return None;
    };
    if said.is_empty() || said.len() > MAX_ATTESTED_IMAGES {
        issues.add(&path, &format!("expected 1 to {MAX_ATTESTED_IMAGES} texts"));
        return None;
    }
    let mut texts = Vec::with_capacity(said.len());
    for (at, alt) in said.iter().enumerate() {
        match alt {
            Value::String(text) if units(text) <= MAX_ATTESTED_ALT_CHARS => texts.push(text.clone()),
            _ => {
                issues.add(
                    &["preview", "alt", &at.to_string()],
                    &format!("expected a text of at most {MAX_ATTESTED_ALT_CHARS} characters"),
                );
                return None;
            }
        }
    }
    Some(texts)
}

fn preview(value: Option<&Value>, issues: &mut Issues) -> Option<Preview> {
    let Some(Value::Object(said)) = value else {
        issues.add(&["preview"], "expected an object");
        return None;
    };
    let Some(kind) = said.get("kind").and_then(Value::as_str).and_then(PreviewKind::parse) else {
        issues.add(&["preview", "kind"], "expected text, image, video, audio or link");
        return None;
    };
    let before = issues.0.len();
    let mut read = Preview::of(kind);
    let text = ["preview", "text"];
    match kind {
        PreviewKind::Text => read.text = issues.text(said.get("text"), &text, 1, MAX_TEXT_CHARS),
        PreviewKind::Link => read.url = issues.link(said.get("url"), &["preview", "url"]),
        PreviewKind::Image => {
            read.text = issues.optional_text(said.get("text"), &text, MAX_TEXT_CHARS);
            read.image_count = said
                .get("imageCount")
                .and_then(|count| issues.whole(Some(count), &["preview", "imageCount"], 2, MAX_ATTESTED_IMAGES as i64));
            read.alt = said.get("alt").and_then(|alt| alts(alt, issues));
        }
        PreviewKind::Video => {
            read.text = issues.optional_text(said.get("text"), &text, MAX_TEXT_CHARS);
            read.video = said.get("video").and_then(|made| video(Some(made), issues));
        }
        PreviewKind::Audio => read.text = issues.optional_text(said.get("text"), &text, MAX_TEXT_CHARS),
    }
    (issues.0.len() == before).then_some(read)
}

/// What a payload says, once it is found to say what an attestation says: the post, or that
/// there is none at its address. Otherwise what is wrong with it, the first thing first.
pub fn said(payload: &Value) -> Result<Attested, Vec<Issue>> {
    let mut issues = Issues::default();
    let Value::Object(said) = payload else {
        issues.add(&[], "expected an object");
        return Err(issues.0);
    };
    let signed = signed(said, &mut issues);
    if says_gone(payload) {
        return match signed {
            Some(Signed { v, kid, issued_at, url }) if issues.0.is_empty() => Ok(Attested::Gone(AttestedGone {
                v,
                kid,
                issued_at,
                url,
                gone: true,
            })),
            _ => Err(issues.0),
        };
    }
    let publisher = publisher(said.get("publisher"), &mut issues);
    let mime_type = mime_type(said.get("mimeType"), &mut issues);
    let ai_generated = said.get("aiGenerated").and_then(Value::as_bool);
    if ai_generated.is_none() {
        issues.add(&["aiGenerated"], "expected true or false");
    }
    let preview = preview(said.get("preview"), &mut issues);
    match (signed, publisher, ai_generated, preview) {
        (Some(Signed { v, kid, issued_at, url }), Some(publisher), Some(ai_generated), Some(preview)) if issues.0.is_empty() => {
            Ok(Attested::Post(Box::new(AttestedPost {
                v,
                kid,
                issued_at,
                url,
                publisher,
                mime_type,
                ai_generated,
                preview,
            })))
        }
        _ => Err(issues.0),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const ID: &str = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";

    fn seed(byte: u8) -> [u8; 32] {
        [byte; 32]
    }

    fn post() -> Value {
        json!({
            "url": format!("https://other.example/content/{ID}"),
            "publisher": { "userId": "11111111-1111-4111-8111-111111111111", "username": "Dana of the North" },
            "mimeType": "text/plain",
            "aiGenerated": false,
            "preview": { "kind": "text", "text": "Flooding closes the coast road. \u{1F30A}" },
        })
    }

    fn keys() -> (SigningKey, SigningKey) {
        (signing_key(&BASE64.encode(seed(1))).unwrap(), signing_key(&hex::encode(seed(2))).unwrap())
    }

    /// A payload: the post with what signing adds, and with `changes` in place of what it says.
    fn payload(changes: Value) -> Value {
        let mut said = json!({ "v": 1, "kid": keys().0.id, "issuedAt": 0 });
        for part in [post(), changes] {
            for (name, value) in part.as_object().unwrap() {
                said[name] = value.clone();
            }
        }
        said
    }

    /// Where the first thing wrong with a payload is.
    fn wrong(changes: Value) -> String {
        said(&payload(changes)).unwrap_err()[0].path.join(".")
    }

    #[test]
    fn reads_a_signing_key_from_32_bytes_in_base64_or_hex_and_nothing_else() {
        let one = seed(1);
        let padded = BASE64.encode(one);
        let written = [
            padded.clone(),
            padded.replace('+', "-").replace('/', "_"),
            hex::encode(one),
            hex::encode(one).to_uppercase(),
            padded.trim_end_matches('=').to_owned(),
        ];
        for text in &written {
            assert_eq!(seed_of(text), Some(one), "{text}");
        }
        let not = [
            String::new(),
            "secret".to_owned(),
            BASE64.encode(&one[1..]),
            BASE64.encode([1; 33]),
            hex::encode(one)[2..].to_owned(),
            format!("{padded} "),
        ];
        for text in &not {
            assert_eq!(seed_of(text), None, "{text}");
        }
        // The same bytes make the same key, however they were written, and other bytes another.
        let (key, other) = keys();
        let again = signing_key(&hex::encode(one)).unwrap();
        assert_eq!((&again.id, &again.public_key), (&key.id, &key.public_key));
        assert_ne!(other.id, key.id);
        assert!(key.id.len() == 16 && key.id.bytes().all(|b| b.is_ascii_hexdigit()));
        assert!(key.public_key.len() == 43 && is_base64_url(&key.public_key));
        assert!(signing_keys(&["not a key".to_owned()]).is_err());
    }

    #[test]
    fn signs_what_a_server_says_of_a_post_which_only_that_key_is_found_to_have_signed() {
        let (key, other) = keys();
        let attestation = attest(&key, &post().to_string(), 1_700_000_000_000).unwrap();
        let (written, signature) = attestation.split_once('.').unwrap();
        assert!(is_base64_url(written) && signature.len() == 86 && is_base64_url(signature));
        let read = read_attestation(&attestation).unwrap();
        let mut expected = json!({ "v": 1, "kid": key.id, "issuedAt": 1_700_000_000_000_i64 });
        expected.as_object_mut().unwrap().extend(post().as_object().unwrap().clone());
        assert_eq!(read.payload, expected);
        // In the order it was said in, after what signing adds.
        assert!(
            read.payload
                .to_string()
                .starts_with(&format!("{{\"v\":1,\"kid\":\"{}\",\"issuedAt\":1700000000000,\"url\":", key.id))
        );
        assert!(signed_by(&key.public_key, &read) && !signed_by(&other.public_key, &read));
        // The key a server publishes is enough to check with, and its id is the key's own.
        assert_eq!(published_key(&key.public_key), Some(key.published()));
        for not in ["", "short", &format!("{}A", key.public_key), &format!("{}+", &key.public_key[..42])] {
            assert_eq!(published_key(not), None, "{not}");
        }

        // A payload that was changed, a signature that was, and one moved from another attestation: none is the key's.
        let mut changed = read.payload.clone();
        changed["aiGenerated"] = json!(true);
        let changed = BASE64_URL.encode(changed.to_string());
        assert!(!signed_by(&key.public_key, &read_attestation(&format!("{changed}.{signature}")).unwrap()));
        let mut ai = post();
        ai["aiGenerated"] = json!(true);
        let moved = attest(&key, &ai.to_string(), 1_700_000_000_000).unwrap();
        let moved = moved.split_once('.').unwrap().1;
        assert!(!signed_by(&key.public_key, &read_attestation(&format!("{written}.{moved}")).unwrap()));
        assert!(!signed_by(
            &key.public_key,
            &read_attestation(&format!("{written}.{}", "A".repeat(86))).unwrap()
        ));
        // What the key signed for something else is no attestation: the payload's bytes alone.
        let bare = BASE64_URL.encode(key.key.sign(written.as_bytes()).to_bytes());
        assert!(!signed_by(&key.public_key, &read_attestation(&format!("{written}.{bare}")).unwrap()));
        // A key that isn't one signed nothing.
        assert!(!signed_by("not a key", &read) && !signed_by(&"A".repeat(342), &read));
    }

    #[test]
    fn reads_only_what_is_written_as_an_attestation() {
        let (key, _) = keys();
        let attestation = attest(&key, &post().to_string(), 0).unwrap();
        let (written, signature) = attestation.split_once('.').unwrap();
        let not = [
            String::new(),
            ".".to_owned(),
            written.to_owned(),
            format!("{written}."),
            format!(".{signature}"),
            format!("{written}.{signature}."),
            format!("{written}.{}", &signature[1..]),
            format!("{written}=.{signature}"),
            format!(" {attestation}"),
            format!("{attestation}\n"),
            format!("{}.{signature}", BASE64_URL.encode("{\"v\":1")),
        ];
        for text in &not {
            assert!(read_attestation(text).is_none(), "{text}");
        }
        // What is JSON is read, whatever it says: that is checked once it is known who signed it.
        let list = read_attestation(&format!("{}.{signature}", BASE64_URL.encode("[1]"))).unwrap();
        assert_eq!(list.payload, json!([1]));
        assert!(attest(&key, "[1]", 0).is_err() && attest(&key, "{", 0).is_err());
        assert_eq!(
            read_attestation(&attest(&key, "{}", 5).unwrap()).unwrap().payload,
            json!({ "v": 1, "kid": key.id, "issuedAt": 5 })
        );
    }

    #[test]
    fn says_a_post_only_by_an_address_that_is_one_post_on_its_own_server() {
        let address = format!("https://other.example/content/{ID}");
        let Ok(Attested::Post(read)) = said(&payload(json!({}))) else {
            panic!("the post is one")
        };
        assert_eq!(
            (read.url.as_str(), read.mime_type.as_deref(), read.publisher.username.as_str()),
            (address.as_str(), Some("text/plain"), "Dana of the North")
        );
        // One address for a post, however it was written.
        let shouted = said(&payload(json!({ "url": format!("HTTPS://Other.Example/content/{}", ID.to_uppercase()) }))).unwrap();
        assert_eq!(shouted.url(), address);
        assert!(said(&payload(json!({ "url": format!("https://other.example/sub/content/{ID}") }))).is_ok());
        let not = [
            format!("{address}/raw"),
            format!("{address}/"),
            format!("{address}?a=b"),
            format!("{address}#top"),
            format!("https://dana:pw@other.example/content/{ID}"),
            format!("ftp://other.example/content/{ID}"),
            format!("https://other.example/posts/{ID}"),
            "nowhere".to_owned(),
            format!("javascript:alert(1)//content/{ID}"),
        ];
        for url in &not {
            assert_eq!(wrong(json!({ "url": url })), "url", "{url}");
        }
        assert_eq!(wrong(json!({ "v": 2 })), "v");
        assert_eq!(wrong(json!({ "kid": "KEY" })), "kid");
        assert_eq!(wrong(json!({ "kid": null })), "kid");
        for issued in [json!(-1), json!(1.5), json!("0")] {
            assert_eq!(wrong(json!({ "issuedAt": issued })), "issuedAt");
        }
        assert_eq!(wrong(json!({ "aiGenerated": "false" })), "aiGenerated");
        assert_eq!(wrong(json!({ "aiGenerated": null })), "aiGenerated");
        assert_eq!(wrong(json!({ "publisher": null })), "publisher");
        assert_eq!(wrong(json!({ "preview": null })), "preview");
        assert_eq!(said(&json!([1])).unwrap_err()[0].path, Vec::<String>::new());
    }

    #[test]
    fn takes_nothing_that_is_not_the_summary_of_a_post() {
        let dana = "11111111-1111-4111-8111-111111111111";
        assert_eq!(
            wrong(json!({ "publisher": { "userId": dana, "username": "Dana\nof the North" } })),
            "publisher.username"
        );
        assert_eq!(wrong(json!({ "publisher": { "userId": "dana", "username": "Dana" } })), "publisher.userId");
        assert_eq!(wrong(json!({ "publisher": { "userId": dana, "username": "" } })), "publisher.username");
        assert_eq!(
            wrong(json!({ "publisher": { "userId": dana, "username": "x".repeat(65) } })),
            "publisher.username"
        );
        assert_eq!(wrong(json!({ "preview": { "kind": "text", "text": "  " } })), "preview.text");
        assert_eq!(wrong(json!({ "preview": { "kind": "link", "url": "javascript:alert(1)" } })), "preview.url");
        assert_eq!(wrong(json!({ "preview": { "kind": "poll", "text": "Yes or no?" } })), "preview.kind");
        assert_eq!(wrong(json!({ "mimeType": "image/png\nx", "preview": { "kind": "image" } })), "mimeType");
        assert_eq!(wrong(json!({ "preview": { "kind": "image", "imageCount": 1 } })), "preview.imageCount");
        assert_eq!(wrong(json!({ "preview": { "kind": "image", "alt": [] } })), "preview.alt");
        assert_eq!(wrong(json!({ "preview": { "kind": "image", "alt": ["a", 7] } })), "preview.alt.1");
        assert_eq!(
            wrong(json!({ "preview": { "kind": "video", "video": { "id": dana, "width": 0, "height": 2, "duration": 1 } } })),
            "preview.video.width"
        );
        assert_eq!(
            wrong(json!({ "preview": { "kind": "video", "video": { "id": dana, "width": 2, "height": 2, "duration": -1 } } })),
            "preview.video.duration"
        );

        // What it is read as: trimmed, in lower case where case says nothing, and with nothing it doesn't know.
        let image = json!({
            "mimeType": " IMAGE/PNG ",
            "publisher": { "userId": dana, "username": " Dana ", "admin": true },
            "preview": { "kind": "image", "text": " A view ", "imageCount": 3, "alt": [" the sea ", ""], "url": "https://elsewhere.example/x" },
        });
        let Ok(Attested::Post(read)) = said(&payload(image)) else {
            panic!("the post is one")
        };
        assert_eq!(
            serde_json::to_value(&read).unwrap(),
            json!({
                "v": 1,
                "kid": keys().0.id,
                "issuedAt": 0,
                "url": format!("https://other.example/content/{ID}"),
                "publisher": { "userId": dana, "username": "Dana" },
                "mimeType": "image/png",
                "aiGenerated": false,
                "preview": { "kind": "image", "text": "A view", "imageCount": 3, "alt": [" the sea ", ""] },
            })
        );
        let video = json!({ "mimeType": "video/mp4", "preview": { "kind": "video", "video": { "id": dana, "width": 320, "height": 240.0, "duration": 2.0 } } });
        let Ok(Attested::Post(read)) = said(&payload(video)) else {
            panic!("the post is one")
        };
        assert_eq!(
            serde_json::to_string(&read.preview).unwrap(),
            format!(r#"{{"kind":"video","video":{{"id":"{dana}","width":320,"height":240,"duration":2}}}}"#)
        );
        let link = said(&payload(json!({ "preview": { "kind": "link", "url": " HTTPS://News.example/a?b=c " } }))).unwrap();
        let Attested::Post(link) = link else { panic!("the post is one") };
        assert_eq!(link.preview.url.as_deref(), Some("https://news.example/a?b=c"));
    }

    #[test]
    fn signs_that_there_is_no_post_at_an_address_which_reads_as_that_and_not_as_a_post() {
        let (key, other) = keys();
        let address = format!("https://other.example/content/{ID}");
        let read = read_attestation(&attest(&key, &json!({ "url": address, "gone": true }).to_string(), 1_700_000_000_000).unwrap()).unwrap();
        assert_eq!(
            read.payload,
            json!({ "v": 1, "kid": key.id, "issuedAt": 1_700_000_000_000_i64, "url": address, "gone": true })
        );
        assert!(signed_by(&key.public_key, &read) && !signed_by(&other.public_key, &read));
        assert!(says_gone(&read.payload));
        let Ok(Attested::Gone(gone)) = said(&read.payload) else {
            panic!("it says the post is gone")
        };
        assert_eq!((gone.url.as_str(), gone.issued_at, gone.gone), (address.as_str(), 1_700_000_000_000, true));
        assert_eq!(serde_json::to_value(Attested::Gone(gone)).unwrap(), read.payload);
        // A post's attestation doesn't say so, and nothing else does: it is said with `true`, of an address that is one post's.
        assert!(!says_gone(&payload(json!({}))));
        for not in [
            json!(null),
            json!("gone"),
            json!([true]),
            json!({ "gone": "true" }),
            json!({ "gone": 1 }),
            json!({ "gone": false }),
        ] {
            assert!(!says_gone(&not), "{not}");
        }
        let elsewhere = json!({ "v": 1, "kid": key.id, "issuedAt": 0, "url": format!("{address}/raw"), "gone": true });
        assert_eq!(said(&elsewhere).unwrap_err()[0].path, ["url"]);
    }

    #[test]
    fn tells_the_server_a_post_is_on_from_its_address() {
        let address = format!("https://other.example/sub/content/{ID}");
        assert_eq!(post_of(&address), Some(("https://other.example/sub".len(), ID)));
        assert_eq!(server_of(&address), "https://other.example/sub");
        assert_eq!(post_of("https://other.example/content/x"), None);
        assert_eq!(server_of("https://other.example/"), "https://other.example/");
        assert_eq!(asked_server(&address), Some("https://other.example/sub"));
        assert_eq!(asked_server(&format!("http://other.example/content/{ID}")), None);
        assert_eq!(asked_server(&format!("https://other.example:8443/content/{ID}")), None);
        assert_eq!(host_of(&address).as_deref(), Some("other.example"));
        assert_eq!(
            host_of(&format!("https://other.example:8443/content/{ID}")).as_deref(),
            Some("other.example:8443")
        );
        // As src/origins.ts hashes it.
        assert_eq!(
            origin_hash("https://other.example/content/1"),
            hex::encode(Sha256::digest(b"https://other.example/content/1"))
        );
    }
}
