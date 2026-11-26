import { loadConfig, type Config } from './config.js';
import { openDb } from './db/index.js';
import type { AppDeps, StoreDeps } from './deps.types.js';
import { AdStore, CommentStore, ContentStore, createHotStore, FollowStore, PublisherStore, RelatedTagStore, SummaryStore, type HotStore } from './storage/index.js';
import { TagFeedReader } from './tagfeed/reader.js';
import { HOUR } from './time.js';

/**
 * The summary store the settings ask for, over `hot`: summaries are stored where
 * `storage.summaries` says, or in the content store if it names no scheme. `now` decides which
 * of them Redis keeps, by how old their posts are: what seeds a server on clocks set back in time
 * (testbed/seed/seed.ts, bench/server.ts) gives the real one.
 */
export function createSummaryStore(config: Config, hot: HotStore, now: () => number = Date.now): SummaryStore {
  const { scheme, options } = config.storage.summaries;
  return new SummaryStore(
    hot,
    scheme ? { scheme, options: options ?? {} } : config.storage.content,
    {
      hotDays: config.feed.summaryHotDays,
      quality: config.feed.summaryBrotliQuality,
      cacheSize: config.feed.summaryCacheSize,
      cacheSeconds: config.feed.summaryCacheSeconds,
      publicBaseUrl: config.publicBaseUrl,
      titles: config.postTitles !== 'off',
    },
    now,
  );
}

/**
 * The stores of a process, built from its settings, with no database among them: the content
 * store, the hot store (the Redis-protocol server at `redis.url`, over a connection of this
 * process's own), and the stores and readers built over those.
 */
export function createStores(config: Config, now: () => number = Date.now) {
  const hot = createHotStore(config.redis);
  return {
    content: new ContentStore(config.storage.content, now),
    comments: new CommentStore(hot, config.storage.content, { hotMs: config.comments.hotHours * HOUR }),
    hot,
    summaries: createSummaryStore(config, hot, now),
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
 * connection. `close` ends its connections.
 */
export function bootstrapStores(config: Config = loadConfig(), now?: () => number): StoreDeps & { close(): Promise<void> } {
  const stores = createStores(config, now);
  return { config, ...stores, now, close: () => stores.hot.close() };
}

/**
 * What every other process that serves or compacts starts with: the same, and the database, at the
 * latest schema unless `db.migrateOnStart` is off.
 */
export async function bootstrap(config: Config = loadConfig(), now?: () => number): Promise<AppDeps & { close(): Promise<void> }> {
  const db = await openDb(config.db);
  const stores = bootstrapStores(config, now);
  return {
    ...stores,
    db,
    close: async () => {
      await stores.close();
      await db.destroy();
    },
  };
}
