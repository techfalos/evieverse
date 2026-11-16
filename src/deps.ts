import { loadConfig, type Config } from './config.js';
import { openDb } from './db/index.js';
import type { AppDeps, StoreDeps } from './deps.types.js';
import { AdStore, CommentStore, ContentStore, createHotStore, FollowStore, PublisherStore, RelatedTagStore, SummaryStore, type HotStore } from './storage/index.js';
import { TagFeedReader } from './tagfeed/reader.js';
import { HOUR } from './time.js';

/**
 * The stores of a process, built from its settings, with no database among them: the content
 * store, the hot store (Redis, or one in this process where `redis.url` is unset), and the stores
 * and readers built over those. Summaries are stored where `storage.summaries` says, or in the
 * content store if it names no scheme. `hot` is for processes sharing one in-memory store.
 */
export function createStores(config: Config, now: () => number = Date.now, hot: HotStore = createHotStore(config.redis, now)) {
  const { scheme, options } = config.storage.summaries;
  return {
    content: new ContentStore(config.storage.content),
    comments: new CommentStore(hot, config.storage.content, { hotMs: config.comments.hotHours * HOUR }),
    hot,
    summaries: new SummaryStore(
      hot,
      scheme ? { scheme, options: options ?? {} } : config.storage.content,
      {
        hotDays: config.feed.summaryHotDays,
        quality: config.feed.summaryBrotliQuality,
        cacheSize: config.feed.summaryCacheSize,
        cacheSeconds: config.feed.summaryCacheSeconds,
        publicBaseUrl: config.publicBaseUrl,
      },
      now,
    ),
    publishers: new PublisherStore(hot, { cacheMs: config.feed.headCacheMs }, now),
    follows: new FollowStore(hot),
    relatedTags: new RelatedTagStore(hot, { cacheMs: config.feed.headCacheMs }, now),
    ads: new AdStore(hot, { cacheMs: config.feed.headCacheMs }, now),
    feedReader: new TagFeedReader(hot, { headCacheMs: config.feed.headCacheMs, indexCacheSize: config.feed.indexCacheSize }, now),
    authorReader: new TagFeedReader(hot, { headCacheMs: config.feed.headCacheMs, indexCacheSize: config.feed.authorIndexCacheSize }, now),
  };
}

/**
 * What a process that only serves feeds starts with: its settings and the stores, and no database
 * connection. `close` ends its connections. `hot` is for processes sharing one in-memory store.
 */
export function bootstrapStores(config: Config = loadConfig(), now?: () => number, hot?: HotStore): StoreDeps & { close(): Promise<void> } {
  const stores = createStores(config, now, hot);
  return { config, ...stores, now, close: () => stores.hot.close() };
}

/**
 * What every other process that serves or compacts starts with: the same, and the database, at the
 * latest schema unless `db.migrateOnStart` is off.
 */
export async function bootstrap(config: Config = loadConfig(), now?: () => number, hot?: HotStore): Promise<AppDeps & { close(): Promise<void> }> {
  const db = await openDb(config.db);
  const stores = bootstrapStores(config, now, hot);
  return {
    ...stores,
    db,
    close: async () => {
      await stores.close();
      await db.destroy();
    },
  };
}
