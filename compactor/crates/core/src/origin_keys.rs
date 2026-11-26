//! The keys other servers sign with, which is the one thing this server asks another for a
//! repost a client brings: an attestation names the address of a post (see `attestation`),
//! and the keys it is checked with are the ones the server at that address publishes.
//!
//! A server's keys are kept in Redis for a few hours, so a server is asked once for many
//! reposts from it. It is asked again, at most once a minute, when an attestation names a key
//! that isn't among them: that is how a new key is learnt. One that gave no keys isn't asked
//! again for a minute.
//!
//! The API keeps them the same way, under the same keys of Redis (src/originKeys.ts): what
//! one process learnt of a server, the other reads.

use std::sync::Arc;

use anyhow::{Result, bail};
use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::attestation::{PublishedKey, published_key};
use crate::hot::HotStore;
use crate::log::{self, Logger};
use crate::public_fetch::fetch_public_json;
use crate::time::{Clock, HOUR, MINUTE};

/// How long the keys a server gave are used before it is asked for them again. A key it took
/// out is taken for no longer than this.
const KEYS_TTL_MS: i64 = 3 * HOUR;

/// How long a server isn't asked again: after it gave no keys, and after it gave keys that an
/// attestation's isn't among.
const ASK_AGAIN_MS: i64 = MINUTE;

/// The most keys taken from one server: the first ones it lists.
const MAX_KEYS: usize = 16;

/// What gets a server's keys: the answer to a GET of an address, read as JSON. An error if
/// there is none.
pub type KeyFetcher = Arc<dyn Fn(String) -> BoxFuture<'static, Result<Value>> + Send + Sync>;

/// What `find` answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyFound {
    Key(PublishedKey),
    /// The server has no key of that id.
    Unknown,
    /// Its keys couldn't be had.
    Unavailable,
}

/// The keys of one server as Redis holds them: what it gave (none: nothing that reads as
/// keys), when it was asked, and until when that is used.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Kept {
    at: i64,
    until: i64,
    keys: Option<Vec<PublishedKey>>,
}

/// Where the server at `base` publishes its keys: GET /repost/keys there.
pub fn keys_address(base: &str) -> String {
    format!("{base}/repost/keys")
}

/// The Redis key of the keys of the server at `base`, which is a URL of any length: its hash.
fn kept_key(base: &str) -> String {
    format!("originkeys:{}", hex::encode(Sha256::digest(base.as_bytes())))
}

/// The keys of other servers, as this one knows them.
#[derive(Clone)]
pub struct OriginKeys {
    hot: HotStore,
    fetcher: KeyFetcher,
    now: Clock,
    log: Logger,
}

impl OriginKeys {
    /// The keys as `hot` holds them, asked for with `fetcher` where it holds none: over the
    /// public internet, unless another is given.
    pub fn new(hot: HotStore, fetcher: Option<KeyFetcher>, now: Clock, log: Logger) -> Self {
        let fetcher = fetcher.unwrap_or_else(|| Arc::new(|address| Box::pin(async move { fetch_public_json(&address).await })));
        Self { hot, fetcher, now, log }
    }

    /// The key with the id `kid` of the server at `base`, which is what a post's address there
    /// starts with (https://other.example). From Redis, if the server's keys are there and
    /// the key is among them; else the server is asked, unless it was within the last minute.
    pub async fn find(&self, base: &str, kid: &str) -> Result<KeyFound> {
        let kept = self.kept(base).await?;
        let among = |keys: &Option<Vec<PublishedKey>>| keys.as_ref().and_then(|keys| keys.iter().find(|key| key.id == kid).cloned());
        if let Some(known) = kept.as_ref().and_then(|kept| among(&kept.keys)) {
            return Ok(KeyFound::Key(known));
        }
        let at = (self.now)();
        if let Some(kept) = kept.as_ref().filter(|kept| at - kept.at < ASK_AGAIN_MS) {
            return Ok(if kept.keys.is_some() { KeyFound::Unknown } else { KeyFound::Unavailable });
        }

        let next = match (self.ask(base).await, kept) {
            (Some(keys), _) => Kept {
                at,
                until: at + KEYS_TTL_MS,
                keys: Some(keys),
            },
            // A server that doesn't answer now keeps the keys it gave before, for as long as they had left.
            (None, Some(kept)) if kept.keys.is_some() => Kept { at, ..kept },
            (None, _) => Kept {
                at,
                until: at + ASK_AGAIN_MS,
                keys: None,
            },
        };
        self.hot
            .set(&kept_key(base), serde_json::to_string(&next)?.as_bytes(), Some((next.until - at).max(1)))
            .await?;
        Ok(match (&next.keys, among(&next.keys)) {
            (_, Some(key)) => KeyFound::Key(key),
            (Some(_), None) => KeyFound::Unknown,
            (None, None) => KeyFound::Unavailable,
        })
    }

    /// What Redis holds of a server's keys, if it holds any that are still to be used.
    async fn kept(&self, base: &str) -> Result<Option<Kept>> {
        let Some(stored) = self.hot.get(&kept_key(base)).await? else {
            return Ok(None);
        };
        let kept: Kept = crate::json::from_slice(&stored)?;
        Ok(Some(kept).filter(|kept| kept.until > (self.now)()))
    }

    /// The keys the server at `base` publishes, or none if it gave none: it didn't answer, or
    /// not with a list of keys. Why is logged, and told to nobody: what this server can and
    /// can't reach is not a user's to learn. A server that signs nothing answers with an
    /// empty list.
    async fn ask(&self, base: &str) -> Option<Vec<PublishedKey>> {
        let asked = async {
            let answer = (self.fetcher)(keys_address(base)).await?;
            let Some(Value::Array(keys)) = answer.get("keys") else {
                bail!("it did not answer with a list of keys")
            };
            Ok(keys
                .iter()
                .take(MAX_KEYS)
                .filter_map(|key| published_key(key.get("publicKey")?.as_str()?))
                .collect())
        };
        match asked.await {
            Ok(keys) => Some(keys),
            Err(err) => {
                let fields = json!({ "err": log::err(&err), "server": base });
                self.log.warn(fields, "could not get another server's keys, so a repost from it was refused");
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_a_servers_keys_under_the_hash_of_its_address_as_the_api_does() {
        // sha256("https://other.example"), which is what src/originKeys.ts names the key by.
        assert_eq!(
            kept_key("https://other.example"),
            format!("originkeys:{}", hex::encode(Sha256::digest(b"https://other.example")))
        );
        assert_eq!(keys_address("https://other.example"), "https://other.example/repost/keys");
        let kept: Kept = serde_json::from_str(r#"{"at":1,"until":2,"keys":null}"#).unwrap();
        assert!(kept.keys.is_none());
        let key = PublishedKey {
            id: "k".into(),
            public_key: "p".into(),
        };
        let kept = Kept {
            at: 1,
            until: 2,
            keys: Some(vec![key]),
        };
        assert_eq!(
            serde_json::to_string(&kept).unwrap(),
            r#"{"at":1,"until":2,"keys":[{"id":"k","publicKey":"p"}]}"#
        );
    }
}
