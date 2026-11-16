import type { Config } from './config.js';
import type { Db } from './db/index.js';
import { ContentStore, createHotStore, FollowStore, PublisherStore, SummaryStore, type HotStore } from './storage/index.js';
import { TagAppender } from './tagfeed/appender.js';
import { TagFeedReader } from './tagfeed/reader.js';

export interface AppDeps {
  config: Config;
  db: Db;
  content: ContentStore;
  hot: HotStore;
  summaries: SummaryStore;
  publishers: PublisherStore;
  follows: FollowStore;
  appender: TagAppender;
  feedReader: TagFeedReader;
  /** Reads publishers' own indexes for following feeds, with caches of its own so they don't push out hashtags'. */
  authorReader: TagFeedReader;
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
  const follows = new FollowStore(hot);
  const appender = new TagAppender(hot, { windowMs: config.feed.tailWindowSeconds * 1000 }, now);
  const feedReader = new TagFeedReader(hot, { headCacheMs: config.feed.headCacheMs, indexCacheSize: config.feed.indexCacheSize }, now);
  const authorReader = new TagFeedReader(hot, { headCacheMs: config.feed.headCacheMs, indexCacheSize: config.feed.authorIndexCacheSize }, now);
  return { content, hot, summaries, publishers, follows, appender, feedReader, authorReader };
}
