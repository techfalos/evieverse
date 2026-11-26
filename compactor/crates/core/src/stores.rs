//! What the compactor keeps in Redis beside the feed index, so that feeds read no database
//! for it: each user's name, whom each user follows, each hashtag's related hashtags, and the
//! ads. The same keys and values as the API's stores of them (src/storage/publisherStore.ts,
//! followStore.ts, relatedTagStore.ts and adStore.ts), which read them and write the first two
//! as requests change them.

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::db::Row;
use crate::hot::HotStore;

/// The one Redis key every published ad is under.
const ADS_KEY: &str = "ads";
/// The version of what the ads' key holds: readers take another for no ads.
const ADS_VERSION: u32 = 1;

/// Publisher credits: each user's username, one key per user and no expiry, so feeds show a
/// changed name at once. The compactor writes those of the users who changed, and with
/// `--rebuild` every user's.
#[derive(Clone)]
pub struct PublisherStore {
    hot: HotStore,
}

impl PublisherStore {
    pub fn new(hot: HotStore) -> Self {
        Self { hot }
    }

    /// Has Redis hold the user's name.
    pub async fn put(&self, user_id: &str, username: &str) -> Result<()> {
        self.hot.set(&format!("pub:{user_id}"), username.as_bytes(), None).await
    }
}

/// Whom each user follows: their ids, one to a line, one key per user who follows anyone and
/// no expiry. The compactor writes those of the users who followed someone since its last
/// run, and with `--rebuild` every user's.
#[derive(Clone)]
pub struct FollowStore {
    hot: HotStore,
}

impl FollowStore {
    pub fn new(hot: HotStore) -> Self {
        Self { hot }
    }

    /// Has Redis hold whom the user follows: no key for one who follows nobody.
    pub async fn put(&self, user_id: &str, followees: &[String]) -> Result<()> {
        let key = format!("fol:{user_id}");
        if followees.is_empty() {
            self.hot.del(&[key]).await
        } else {
            self.hot.set(&key, followees.join("\n").as_bytes(), None).await
        }
    }
}

/// Each hashtag's related hashtags, most related first, with a space between them: one key
/// per hashtag that has any, and no expiry. The compactor works them out from the counts in
/// `tag_pairs` and writes them.
#[derive(Clone)]
pub struct RelatedTagStore {
    hot: HotStore,
}

impl RelatedTagStore {
    pub fn new(hot: HotStore) -> Self {
        Self { hot }
    }

    /// Has Redis hold the hashtag's related hashtags: no key for one that has none.
    pub async fn put(&self, tag: &str, related: &[String]) -> Result<()> {
        let key = format!("rel:{tag}");
        if related.is_empty() {
            self.hot.del(&[key]).await
        } else {
            self.hot.set(&key, related.join(" ").as_bytes(), None).await
        }
    }
}

/// An ad as it is published: what feeds and posts show of it, with its schedule, which
/// whoever reads it holds it to (see `PublishedAd` in src/monetization.types.ts).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedAd {
    pub ad_id: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Of an image ad: what describes its image.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_alt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// The hashtags the ad is targeted at; none for one that appears everywhere.
    pub tags: Option<Vec<String>>,
    pub starts_at: i64,
    /// None for an ad that runs until it is ended.
    pub ends_at: Option<i64>,
}

impl PublishedAd {
    /// An ad's row of `monetization` as it is published.
    pub fn of(row: &Row) -> Result<Self> {
        let kind = row.string("kind")?;
        Ok(Self {
            ad_id: row.string("id")?,
            text: row.opt_string("text")?,
            image_alt: row.opt_string("image_alt")?.filter(|_| kind == "image"),
            url: row.opt_string("url")?,
            tags: row
                .opt_str("tags")?
                .map(|tags| tags.split(' ').filter(|tag| !tag.is_empty()).map(str::to_owned).collect()),
            starts_at: row.i64("starts_at")?,
            ends_at: row.opt_i64("ends_at")?,
            kind,
        })
    }
}

/// What the ads' key holds.
#[derive(Serialize)]
struct Published<'a> {
    v: u32,
    ads: &'a [PublishedAd],
}

/// The ads feeds and posts show: one key with every ad that hasn't ended, with no expiry. The
/// compactor writes it from the `monetization` table, on every run.
#[derive(Clone)]
pub struct AdStore {
    hot: HotStore,
}

impl AdStore {
    pub fn new(hot: HotStore) -> Self {
        Self { hot }
    }

    /// Publishes `ads` in place of the ones there, and returns whether that changed anything:
    /// the key is written only if it would hold something else, and deleted where there are
    /// no ads.
    pub async fn sync(&self, ads: &[PublishedAd]) -> Result<bool> {
        let next = if ads.is_empty() {
            None
        } else {
            Some(serde_json::to_vec(&Published { v: ADS_VERSION, ads })?)
        };
        if self.hot.get(ADS_KEY).await? == next {
            return Ok(false);
        }
        match next {
            None => self.hot.del(&[ADS_KEY.to_owned()]).await?,
            Some(next) => self.hot.set(ADS_KEY, &next, None).await?,
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_an_ad_as_the_api_reads_it() {
        let ad = PublishedAd {
            ad_id: "a1".into(),
            kind: "text".into(),
            text: Some("hello".into()),
            image_alt: None,
            url: None,
            tags: None,
            starts_at: 5,
            ends_at: None,
        };
        let written = serde_json::to_string(&Published { v: ADS_VERSION, ads: &[ad] }).unwrap();
        assert_eq!(
            written,
            r#"{"v":1,"ads":[{"adId":"a1","kind":"text","text":"hello","tags":null,"startsAt":5,"endsAt":null}]}"#
        );
    }
}
