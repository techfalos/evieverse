import type { Config } from './config.js';
import type { Db } from './db/index.js';
import { ContentStore, createHotStore, PublisherStore, SummaryStore, type HotStore } from './storage/index.js';
import { TagAppender } from './tagfeed/appender.js';
import { TagFeedReader } from './tagfeed/reader.js';

export interface AppDeps {
  config: Config;
  db: Db;
  content: ContentStore;
  hot: HotStore;
  summaries: SummaryStore;
  publishers: PublisherStore;
  appender: TagAppender;
  feedReader: TagFeedReader;
  /** Injectable clock (UTC epoch ms) so timestamps, tail windows and feed windows are testable. */
  now?: () => number;
}

export function createStores(config: Config, now: () => number = Date.now, hot: HotStore = createHotStore(config.redis, now)) {
  const content = new ContentStore(config.storage.content);
  const { scheme, options } = config.storage.summaries;
  const summaries = new SummaryStore(
    hot,
    scheme ? { scheme, options: options ?? {} } : config.storage.content,
    {
      hotDays: config.feed.summaryHotDays,
      quality: config.feed.summaryBrotliQuality,
      cacheSize: config.feed.summaryCacheSize,
      publicBaseUrl: config.publicBaseUrl,
    },
    now,
  );
  const publishers = new PublisherStore(hot, { cacheMs: config.feed.headCacheMs }, now);
  const appender = new TagAppender(hot, { windowMs: config.feed.tailWindowSeconds * 1000 }, now);
  const feedReader = new TagFeedReader(hot, { headCacheMs: config.feed.headCacheMs, indexCacheSize: config.feed.indexCacheSize }, now);
  return { content, hot, summaries, publishers, appender, feedReader };
}
