//! The RAM tier: the feed index (heads, manifests, day indexes), hot summaries, publisher
//! credits, comments with their likes, and the compactor's state, in a Redis-protocol server
//! (Redis, Valkey). Keys are relative to REDIS_KEY_PREFIX. It is where the API, the functions
//! and the compactor meet, so every command here is the one src/storage/hotStore.ts sends.
//! Keys expire by that server's clock, whatever clock a process was given.

use std::sync::Arc;

use anyhow::{Context, Result};
use redis::aio::{ConnectionManager, ConnectionManagerConfig};
use redis::{AsyncCommands, Value};
use serde_json::json;

use crate::probe::Probes;

/// Members a `lex_add` sends in one command.
const LEX_BATCH: usize = 1000;

/// Commands the connection retries after it is lost, as the API's own does.
const RETRIES: usize = 2;

/// ZADD of every member at score 0, which is what orders a sorted set by its members, giving
/// the set its expiry if it has none.
const LEX_ADD: &str = "
for i = 2, #ARGV do
  redis.call('ZADD', KEYS[1], 0, ARGV[i])
end
if redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return 1";

/// INCR, giving the counter its expiry when it is new (or somehow has none). Returns the count
/// and the time left.
const COUNT: &str = "
local count = redis.call('INCR', KEYS[1])
local left = redis.call('PTTL', KEYS[1])
if left < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  left = tonumber(ARGV[1])
end
return {count, left}";

/// INCRBY of a key that is there, which keeps its expiry. ARGV: what to add. A missing key is
/// left missing: false, which a client reads as nil.
const BUMP: &str = "
if redis.call('EXISTS', KEYS[1]) == 0 then
  return false
end
return redis.call('INCRBY', KEYS[1], ARGV[1])";

/// Compare-and-set. ARGV: whether a value is expected ('1') and the value; whether one is set
/// ('1') and the value; its expiry in ms, or ''. GET gives false for a missing key.
const SWAP: &str = "
local current = redis.call('GET', KEYS[1])
if ARGV[1] == '1' then
  if current ~= ARGV[2] then return 0 end
elseif current then
  return 0
end
if ARGV[3] ~= '1' then
  redis.call('DEL', KEYS[1])
elseif ARGV[5] == '' then
  redis.call('SET', KEYS[1], ARGV[4])
else
  redis.call('SET', KEYS[1], ARGV[4], 'PX', ARGV[5])
end
return 1";

/// An expiry as the store sets it: a whole number of ms, 1 at the least, so nothing is set to
/// expire at once or in the past.
fn ttl(ms: i64) -> i64 {
    ms.max(1)
}

/// A key to set (see `HotStore::set_many`).
#[derive(Debug, Clone)]
pub struct HotEntry {
    pub key: String,
    pub value: Vec<u8>,
    /// Without it the key never expires.
    pub ttl_ms: Option<i64>,
}

/// The bounds of a range of an ordered set (see `HotStore::lex_range`): neither is part of
/// the range, and one left out is no bound.
#[derive(Debug, Clone, Default)]
pub struct LexRange {
    pub after: Option<String>,
    pub before: Option<String>,
}

impl LexRange {
    /// The lower bound as ZRANGEBYLEX takes it: `after`, which is not part of the range, or `-`.
    fn min(&self) -> String {
        self.after.as_ref().map_or_else(|| "-".to_owned(), |after| format!("({after}"))
    }

    /// The upper bound as ZRANGEBYLEX takes it: `before`, which is not part of the range, or `+`.
    fn max(&self) -> String {
        self.before.as_ref().map_or_else(|| "+".to_owned(), |before| format!("({before}"))
    }
}

/// The hot store: the Redis-protocol server at a URL, every key under a prefix. A copy of it
/// shares the one connection, which carries the commands of concurrent callers together.
#[derive(Clone)]
pub struct HotStore {
    redis: ConnectionManager,
    prefix: Arc<str>,
    /// What a test watches this store's calls with; nothing, in a process that serves.
    probes: Probes,
}

impl HotStore {
    /// Connects to the server at `url` (redis:// or rediss://), to keep every key under
    /// `key_prefix` there.
    pub async fn connect(url: &str, key_prefix: &str) -> Result<Self> {
        let client = redis::Client::open(url).context("REDIS_URL is not the URL of a Redis or Valkey server")?;
        let config = ConnectionManagerConfig::new().set_number_of_retries(RETRIES);
        let redis = ConnectionManager::new_with_config(client, config).await.context("could not connect to Redis")?;
        Ok(Self {
            redis,
            prefix: Arc::from(key_prefix),
            probes: Probes::default(),
        })
    }

    /// This store, with its calls shown to a test's probe (see `crate::probe`).
    pub fn probed(mut self, probes: Probes) -> Self {
        self.probes = probes;
        self
    }

    /// The key as the server has it: under the store's prefix.
    fn k(&self, key: &str) -> String {
        format!("{}{key}", self.prefix)
    }

    /// A connection to send commands on: a handle to the one all copies share.
    fn con(&self) -> ConnectionManager {
        self.redis.clone()
    }

    pub async fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        Ok(self.con().get(self.k(key)).await?)
    }

    pub async fn mget(&self, keys: &[String]) -> Result<Vec<Option<Vec<u8>>>> {
        if keys.is_empty() {
            return Ok(vec![]);
        }
        let mut cmd = redis::cmd("MGET");
        for key in keys {
            cmd.arg(self.k(key));
        }
        self.probes
            .call("hot.mget", || json!({ "keys": keys }), async { Ok(cmd.query_async(&mut self.con()).await?) })
            .await
    }

    /// Without `ttl_ms` the key never expires (and is never evicted under a volatile-* policy).
    pub async fn set(&self, key: &str, value: &[u8], ttl_ms: Option<i64>) -> Result<()> {
        let mut cmd = redis::cmd("SET");
        cmd.arg(self.k(key)).arg(value);
        if let Some(ms) = ttl_ms {
            cmd.arg("PX").arg(ttl(ms));
        }
        self.probes
            .call("hot.set", || json!({ "key": key }), async {
                cmd.query_async::<()>(&mut self.con()).await?;
                Ok(())
            })
            .await
    }

    /// Sets several keys in one round trip, each as `set` does. Not atomic: if it fails, some
    /// may be set.
    pub async fn set_many(&self, entries: &[HotEntry]) -> Result<()> {
        if entries.is_empty() {
            return Ok(());
        }
        let mut pipe = redis::pipe();
        for entry in entries {
            let cmd = pipe.cmd("SET").arg(self.k(&entry.key)).arg(&entry.value[..]);
            if let Some(ms) = entry.ttl_ms {
                cmd.arg("PX").arg(ttl(ms));
            }
            cmd.ignore();
        }
        let keys = || json!({ "keys": entries.iter().map(|entry| &entry.key).collect::<Vec<_>>() });
        self.probes
            .call("hot.setMany", keys, async {
                pipe.query_async::<()>(&mut self.con()).await?;
                Ok(())
            })
            .await
    }

    /// Sets a key that isn't there, to expire in `ttl_ms`; one that is there is left as it is.
    pub async fn set_if_absent(&self, key: &str, value: &[u8], ttl_ms: i64) -> Result<()> {
        redis::cmd("SET")
            .arg(self.k(key))
            .arg(value)
            .arg("PX")
            .arg(ttl(ttl_ms))
            .arg("NX")
            .query_async::<Value>(&mut self.con())
            .await?;
        Ok(())
    }

    /// Gets and deletes a key in one step, so of concurrent callers only one gets its value.
    pub async fn take(&self, key: &str) -> Result<Option<Vec<u8>>> {
        Ok(redis::cmd("GETDEL").arg(self.k(key)).query_async(&mut self.con()).await?)
    }

    pub async fn del(&self, keys: &[String]) -> Result<()> {
        if keys.is_empty() {
            return Ok(());
        }
        let mut cmd = redis::cmd("UNLINK");
        for key in keys {
            cmd.arg(self.k(key));
        }
        self.probes
            .call("hot.del", || json!({ "keys": keys }), async {
                cmd.query_async::<()>(&mut self.con()).await?;
                Ok(())
            })
            .await
    }

    /// Makes existing keys expire `ttl_ms` from now; missing keys are ignored.
    pub async fn expire(&self, keys: &[String], ttl_ms: i64) -> Result<()> {
        if keys.is_empty() {
            return Ok(());
        }
        let mut pipe = redis::pipe();
        for key in keys {
            pipe.cmd("PEXPIRE").arg(self.k(key)).arg(ttl(ttl_ms)).ignore();
        }
        self.probes
            .call("hot.expire", || json!({ "keys": keys }), async {
                pipe.query_async::<()>(&mut self.con()).await?;
                Ok(())
            })
            .await
    }

    /// Makes keys never expire. For each, whether it is still there: false if it expired or
    /// was evicted first.
    pub async fn persist(&self, keys: &[String]) -> Result<Vec<bool>> {
        if keys.is_empty() {
            return Ok(vec![]);
        }
        let mut pipe = redis::pipe();
        // PERSIST alone can't tell a missing key from one that never had an expiry.
        for key in keys {
            pipe.cmd("PERSIST").arg(self.k(key)).ignore();
            pipe.cmd("EXISTS").arg(self.k(key));
        }
        self.probes
            .call_masked("hot.persist", || json!({ "keys": keys }), async {
                let there: Vec<i64> = pipe.query_async(&mut self.con()).await?;
                Ok(there.into_iter().map(|n| n == 1).collect())
            })
            .await
    }

    pub async fn exists(&self, keys: &[String]) -> Result<Vec<bool>> {
        if keys.is_empty() {
            return Ok(vec![]);
        }
        let mut pipe = redis::pipe();
        for key in keys {
            pipe.cmd("EXISTS").arg(self.k(key));
        }
        self.probes
            .call_masked("hot.exists", || json!({ "keys": keys }), async {
                let there: Vec<i64> = pipe.query_async(&mut self.con()).await?;
                Ok(there.into_iter().map(|n| n == 1).collect())
            })
            .await
    }

    /// Adds one to a counter that starts at zero and is deleted `ttl_ms` after its first
    /// count. Returns the count and how long the counter has left. Atomic.
    pub async fn incr(&self, key: &str, ttl_ms: i64) -> Result<(i64, i64)> {
        // One key, so the script runs wherever the key lives, behind a proxy or in a cluster.
        Ok(redis::cmd("EVAL")
            .arg(COUNT)
            .arg(1)
            .arg(self.k(key))
            .arg(ttl(ttl_ms))
            .query_async(&mut self.con())
            .await?)
    }

    /// Adds `by` to a counter that is there, which takes from it if it is negative. The
    /// counter keeps its expiry, and the count is returned. A counter that isn't there is
    /// left missing, and none returned. Atomic.
    pub async fn bump(&self, key: &str, by: i64) -> Result<Option<i64>> {
        Ok(redis::cmd("EVAL")
            .arg(BUMP)
            .arg(1)
            .arg(self.k(key))
            .arg(by)
            .query_async(&mut self.con())
            .await?)
    }

    /// Sets a key to `next` (or deletes it, if none), but only if it holds `expected` (none:
    /// if it is missing), and returns whether it did. Atomic, so of concurrent callers that
    /// read the same value only one changes it. `ttl_ms` is as for `set`.
    pub async fn swap(&self, key: &str, expected: Option<&str>, next: Option<&str>, ttl_ms: Option<i64>) -> Result<bool> {
        let swapped: i64 = redis::cmd("EVAL")
            .arg(SWAP)
            .arg(1)
            .arg(self.k(key))
            .arg(if expected.is_some() { "1" } else { "0" })
            .arg(expected.unwrap_or_default())
            .arg(if next.is_some() { "1" } else { "0" })
            .arg(next.unwrap_or_default())
            .arg(ttl_ms.map(|ms| ttl(ms).to_string()).unwrap_or_default())
            .query_async(&mut self.con())
            .await?;
        Ok(swapped == 1)
    }

    /// Adds members to a set that is kept in the order of its members, which must be ASCII. A
    /// set that is new, or somehow has no expiry, expires `ttl_ms` from now; one that has an
    /// expiry keeps it, so the set lasts `ttl_ms` from when it was begun.
    pub async fn lex_add(&self, key: &str, members: &[String], ttl_ms: i64) -> Result<()> {
        // One key, so the script runs wherever the key lives, as for incr.
        for batch in members.chunks(LEX_BATCH) {
            let mut cmd = redis::cmd("EVAL");
            cmd.arg(LEX_ADD).arg(1).arg(self.k(key)).arg(ttl(ttl_ms));
            for member in batch {
                cmd.arg(member);
            }
            cmd.query_async::<()>(&mut self.con()).await?;
        }
        Ok(())
    }

    /// Up to `limit` of an ordered set's members within the bounds, in order, or with
    /// `reverse` from the last back. A missing set is empty.
    pub async fn lex_range(&self, key: &str, range: &LexRange, limit: usize, reverse: bool) -> Result<Vec<String>> {
        let mut cmd = redis::cmd(if reverse { "ZREVRANGEBYLEX" } else { "ZRANGEBYLEX" });
        cmd.arg(self.k(key));
        if reverse {
            cmd.arg(range.max()).arg(range.min());
        } else {
            cmd.arg(range.min()).arg(range.max());
        }
        Ok(cmd.arg("LIMIT").arg(0).arg(limit).query_async(&mut self.con()).await?)
    }

    /// How many of an ordered set's members are within the bounds.
    pub async fn lex_count(&self, key: &str, range: &LexRange) -> Result<i64> {
        Ok(redis::cmd("ZLEXCOUNT")
            .arg(self.k(key))
            .arg(range.min())
            .arg(range.max())
            .query_async(&mut self.con())
            .await?)
    }

    /// Whether an ordered set has the member.
    pub async fn lex_has(&self, key: &str, member: &str) -> Result<bool> {
        let score: Option<f64> = redis::cmd("ZSCORE").arg(self.k(key)).arg(member).query_async(&mut self.con()).await?;
        Ok(score.is_some())
    }

    pub async fn lex_rem(&self, key: &str, members: &[String]) -> Result<()> {
        if members.is_empty() {
            return Ok(());
        }
        let mut cmd = redis::cmd("ZREM");
        cmd.arg(self.k(key));
        for member in members {
            cmd.arg(member);
        }
        cmd.query_async::<()>(&mut self.con()).await?;
        Ok(())
    }

    /// The keys under the store's prefix that match `pattern`, a glob as SCAN takes one,
    /// without the prefix: what a test looks at the store by.
    pub async fn keys(&self, pattern: &str) -> Result<Vec<String>> {
        let mut found = vec![];
        let mut cursor = 0u64;
        loop {
            let (next, keys): (u64, Vec<String>) = redis::cmd("SCAN")
                .arg(cursor)
                .arg("MATCH")
                .arg(format!("{}{pattern}", self.prefix))
                .arg("COUNT")
                .arg(500)
                .query_async(&mut self.con())
                .await?;
            found.extend(keys.into_iter().filter_map(|key| key.strip_prefix(&*self.prefix).map(str::to_owned)));
            if next == 0 {
                break;
            }
            cursor = next;
        }
        found.sort();
        found.dedup();
        Ok(found)
    }

    /// Deletes every key under this store's prefix.
    pub async fn clear(&self) -> Result<()> {
        let keys = self.keys("*").await?;
        for batch in keys.chunks(500) {
            self.del(batch).await?;
        }
        Ok(())
    }
}
