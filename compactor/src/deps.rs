//! What a compactor works with: the settings, the database, the stores, the clock and the log.

use std::sync::Arc;

use anyhow::{Context, Result};
use evieverse_core::comments::CommentStore;
use evieverse_core::config::Config;
use evieverse_core::content::ContentStore;
use evieverse_core::db::Db;
use evieverse_core::hot::HotStore;
use evieverse_core::log::Logger;
use evieverse_core::object::ObjectStore;
use evieverse_core::probe::Probes;
use evieverse_core::stores::{AdStore, FollowStore, PublisherStore, RelatedTagStore};
use evieverse_core::summary::{SummaryOptions, SummaryStore};
use evieverse_core::time::{Clock, HOUR};

/// What a compactor works with, as the API's own `AppDeps` is what its requests work with:
/// the same database, Redis and stores, opened by the same settings. A copy shares them all.
#[derive(Clone)]
pub struct Deps {
    pub config: Arc<Config>,
    pub db: Db,
    pub hot: HotStore,
    pub content: ContentStore,
    pub comments: CommentStore,
    pub summaries: SummaryStore,
    pub publishers: PublisherStore,
    pub follows: FollowStore,
    pub related_tags: RelatedTagStore,
    pub ads: AdStore,
    /// The clock every time is told by: the system's, or the one a test gives.
    pub now: Clock,
    pub log: Logger,
}

impl Deps {
    /// Opens what the settings name: the database, Redis and the stores.
    pub async fn open(config: Config, now: Clock, log: Logger) -> Result<Self> {
        Self::open_probed(config, now, log, Probes::default()).await
    }

    /// Opens what the settings name, with the calls made to Redis, the content store and the
    /// comment store shown to a test's probe (see `evieverse_core::probe`).
    pub async fn open_probed(config: Config, now: Clock, log: Logger, probes: Probes) -> Result<Self> {
        let db = Db::connect(&config.db).await.context("could not open the database")?;
        let hot = HotStore::connect(&config.redis.url, &config.redis.key_prefix)
            .await
            .context("could not reach Redis")?
            .probed(probes.clone());
        let stored = &config.storage.content;
        let content = ContentStore::open(&stored.scheme, &stored.options, stored.signed_url_seconds)
            .context("could not open the content store")?
            .probed(probes.clone());
        let summaries = config.summary_store();
        let summary_objects = ObjectStore::open(&summaries.scheme, &summaries.options).context("could not open the summary store")?;
        Ok(Self {
            comments: CommentStore::new(hot.clone(), content.objects().clone(), config.comments.hot_hours * HOUR).probed(probes),
            summaries: SummaryStore::new(
                hot.clone(),
                summary_objects,
                SummaryOptions {
                    hot_days: config.feed.summary_hot_days,
                    quality: u32::try_from(config.feed.summary_brotli_quality).unwrap_or(11),
                    public_base_url: config.public_base_url.clone(),
                },
                now.clone(),
            ),
            publishers: PublisherStore::new(hot.clone()),
            follows: FollowStore::new(hot.clone()),
            related_tags: RelatedTagStore::new(hot.clone()),
            ads: AdStore::new(hot.clone()),
            config: Arc::new(config),
            db,
            hot,
            content,
            now,
            log,
        })
    }

    /// The time now, by the clock this works with.
    pub fn now(&self) -> i64 {
        (self.now)()
    }

    /// How many of something a setting says to run at once: one at least.
    pub fn concurrency(&self) -> usize {
        usize::try_from(self.config.compact.concurrency).unwrap_or(1).max(1)
    }
}
