//! The feed index as it is laid out in Redis, per hashtag (keys are relative to
//! REDIS_KEY_PREFIX). The same layout as src/tagfeed/layout.ts, which the API reads it by:
//!
//! ```text
//!   head:<tag>        { v: 5, manifest, compactedAt } - the only overwritten index key
//!   man:<tag>:<id>    immutable: every UTC day's index key and quota
//!   day:<tag>:<gen>   immutable: one UTC day's packed index, DAY_ENTRY_BYTES per post, best first
//! ```
//!
//! Only the compactor writes them. Each publisher's own posts have an index of the same layout,
//! named `author_index(user_id)`, which following feeds read.

use std::cmp::Ordering;

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

use crate::time::whole_seconds;

/// contentId (16 bytes) | likes u32 | createdAt seconds u32 | flags u8, big-endian.
pub const DAY_ENTRY_BYTES: usize = 25;
/// The most a u32 field of a day index entry holds: likes and creation seconds above it are
/// stored as this.
const U32_MAX: i64 = 0xffff_ffff;

/// Flag bit of a day index entry: its publisher declared the content as created with AI.
const AI_GENERATED: u8 = 1;
/// Flag bit of a day index entry: a moderator of the hashtag approved the content under it.
const MODERATED: u8 = 2;
/// Flag bit of a day index entry: a repost put the content in the index.
const REPOST: u8 = 4;

/// The version of the index's layout that heads and manifests say they are of.
pub const LAYOUT_VERSION: u32 = 5;

/// The key the compactor keeps its progress under from one run to the next, as JSON.
pub const COMPACTOR_STATE_KEY: &str = "compactor:state";

/// One post in a day index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexEntry {
    pub content_id: String,
    /// When the content was placed in this index, which is where feeds order it: its creation,
    /// or for a repost's entry, the repost. UTC epoch ms; day indexes keep whole seconds.
    pub created_at: i64,
    /// The content's likes; for a repost's entry, those since the repost.
    pub likes: i64,
    /// Declared by the publisher at /store.
    pub ai_generated: bool,
    /// A moderator of this hashtag approved the content under it.
    pub moderated: bool,
    /// A repost put the content here.
    pub repost: bool,
}

/// The start of a tag's index, under `head_key(tag)`: the one key of it that is overwritten.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Head {
    pub v: u32,
    /// The manifest readers should use; none until the tag's first compaction.
    pub manifest: Option<String>,
    pub compacted_at: i64,
}

impl Head {
    /// What a tag that was never compacted has for a head: no manifest, so no day index.
    pub fn empty() -> Self {
        Self {
            v: LAYOUT_VERSION,
            manifest: None,
            compacted_at: 0,
        }
    }
}

/// One UTC day's index, as a manifest names it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayRef {
    /// UTC day number (ms / DAY).
    pub day: i64,
    /// What the key of the day's index ends with (see `new_gen_id`): `gen`, as it is stored.
    #[serde(rename = "gen")]
    pub generation: String,
    /// The most posts the index was trimmed to.
    pub quota: i64,
    pub count: i64,
}

/// The list of a tag's day indexes, under `manifest_key(tag, id)`, never changed once written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub v: u32,
    pub tag: String,
    pub id: String,
    pub created_at: i64,
    /// Newest day first.
    pub days: Vec<DayRef>,
}

/// A publisher's own index, named so no hashtag (letters, digits and _) can be the same.
pub fn author_index(user_id: &str) -> String {
    format!("@{user_id}")
}

/// The publisher whose own index this is; none for a hashtag.
pub fn index_author(name: &str) -> Option<&str> {
    name.strip_prefix('@')
}

/// The key of a tag's head. `tag` is a hashtag or the name of a publisher's own index, here
/// and in the keys below.
pub fn head_key(tag: &str) -> String {
    format!("head:{tag}")
}

/// The key of the manifest `id` of a tag's index.
pub fn manifest_key(tag: &str, id: &str) -> String {
    format!("man:{tag}:{id}")
}

/// The key of one of a tag's day indexes: `generation` is the one its `DayRef` in the manifest names.
pub fn day_key(tag: &str, generation: &str) -> String {
    format!("day:{tag}:{generation}")
}

/// Eight random hex digits, which end a new id so that two made for the same instant differ.
fn rand_hex() -> String {
    hex::encode(rand::random::<[u8; 4]>())
}

/// The id of a new manifest: when it was made (`created_at`, epoch ms, which is the compactor
/// run's start), then random digits.
pub fn new_manifest_id(created_at: i64) -> String {
    format!("{created_at:013}-{}", rand_hex())
}

/// The `gen` of a new day index, which its key carries: the UTC day number, when it was built
/// (`created_at`, epoch ms), then random digits. A day that is rebuilt gets a new one.
pub fn new_gen_id(day: i64, created_at: i64) -> String {
    format!("{day:05}-{created_at:013}-{}", rand_hex())
}

/// Post quota of a UTC day at `age_days` old: halves each day from `max`, never below `min`.
pub fn day_quota(age_days: i64, max: i64, min: i64) -> i64 {
    let age = age_days.max(0);
    // Past 62 days the divisor is more than any count of posts: nothing is left of `max`.
    let halved = if age >= 63 { 0 } else { max.max(0) >> age };
    min.max(halved)
}

/// `n` as a whole number from 0 to `max`.
fn clamp(n: i64, max: i64) -> u32 {
    u32::try_from(n.clamp(0, max)).unwrap_or(u32::MAX)
}

/// A day index as it is stored: DAY_ENTRY_BYTES per entry, in the order given. An entry's
/// time is cut to whole seconds. Fails if a content id isn't a UUID.
pub fn pack_day(entries: &[IndexEntry]) -> Result<Vec<u8>> {
    let mut buf = Vec::with_capacity(entries.len() * DAY_ENTRY_BYTES);
    for e in entries {
        let id = hex::decode(e.content_id.replace('-', "")).unwrap_or_default();
        if id.len() != 16 {
            bail!("content id {} is not a UUID", e.content_id);
        }
        buf.extend_from_slice(&id);
        buf.extend_from_slice(&clamp(e.likes, U32_MAX).to_be_bytes());
        buf.extend_from_slice(&clamp(e.created_at.div_euclid(1000), U32_MAX).to_be_bytes());
        buf.push(if e.ai_generated { AI_GENERATED } else { 0 } | if e.moderated { MODERATED } else { 0 } | if e.repost { REPOST } else { 0 });
    }
    Ok(buf)
}

/// The entries `pack_day` packed, in the same order, their times in ms again (of whole
/// seconds). Bytes at the end that don't make a whole entry are ignored.
pub fn unpack_day(buf: &[u8]) -> Vec<IndexEntry> {
    buf.as_chunks::<DAY_ENTRY_BYTES>()
        .0
        .iter()
        .map(|e| {
            let h = hex::encode(&e[..16]);
            let flags = e[24];
            IndexEntry {
                content_id: format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..]),
                likes: i64::from(u32::from_be_bytes([e[16], e[17], e[18], e[19]])),
                created_at: i64::from(u32::from_be_bytes([e[20], e[21], e[22], e[23]])) * 1000,
                ai_generated: flags & AI_GENERATED != 0,
                moderated: flags & MODERATED != 0,
                repost: flags & REPOST != 0,
            }
        })
        .collect()
}

/// Order of a hashtag's day indexes and of the popular feed: likes desc, newest, id.
pub fn compare_records(a: &IndexEntry, b: &IndexEntry) -> Ordering {
    b.likes
        .cmp(&a.likes)
        .then(b.created_at.cmp(&a.created_at))
        .then_with(|| a.content_id.cmp(&b.content_id))
}

/// Order of a publisher's day indexes and of the following feed: newest first, then id. In the
/// whole seconds day indexes keep, so an entry built from the database, which has
/// milliseconds, is ordered as it will be read.
pub fn compare_recent(a: &IndexEntry, b: &IndexEntry) -> Ordering {
    whole_seconds(b.created_at)
        .cmp(&whole_seconds(a.created_at))
        .then_with(|| a.content_id.cmp(&b.content_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_new_manifests_and_days_by_when_they_were_made() {
        let id = new_manifest_id(1_700_000_000_000);
        assert_eq!(id.len(), 13 + 1 + 8);
        assert!(id.starts_with("1700000000000-"));
        let generation = new_gen_id(19_675, 1_700_000_000_000);
        assert!(generation.starts_with("19675-1700000000000-"));
        assert_eq!(new_gen_id(7, 5).len(), 5 + 1 + 13 + 1 + 8);
        assert_ne!(new_manifest_id(1), new_manifest_id(1));
    }

    #[test]
    fn refuses_to_pack_an_id_that_is_no_uuid() {
        let entry = IndexEntry {
            content_id: "not-a-uuid".into(),
            created_at: 0,
            likes: 0,
            ai_generated: false,
            moderated: false,
            repost: false,
        };
        assert!(pack_day(&[entry]).is_err());
    }

    #[test]
    fn ignores_bytes_that_make_no_whole_entry() {
        assert_eq!(unpack_day(&[0; DAY_ENTRY_BYTES + 3]).len(), 1);
    }
}
