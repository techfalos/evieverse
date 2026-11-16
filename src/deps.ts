import type { Challenges } from './challenge/challenges.js';
import { loadConfig, type Config } from './config.js';
import { openDb, type Db } from './db/index.js';
import type { TrustPlugin } from './moderation/trust.js';
import type { CliRelease } from './routes/cli.js';
import { AdStore, CommentStore, ContentStore, createHotStore, FollowStore, PublisherStore, RelatedTagStore, SummaryStore, type HotStore } from './storage/index.js';
import { TagFeedReader } from './tagfeed/reader.js';
import { HOUR } from './time.js';
import type { ContentWriter } from './write.js';

/** Everything but the database: all that feeds read. */
export interface StoreDeps {
  config: Config;
  content: ContentStore;
  /** The comments on posts: objects in the content store, with Redis as a cache over them. */
  comments: CommentStore;
  hot: HotStore;
  summaries: SummaryStore;
  publishers: PublisherStore;
  follows: FollowStore;
  /** Each hashtag's related hashtags, which feeds asked to add them read, in Redis. */
  relatedTags: RelatedTagStore;
  /** The ads feeds and posts show, where the server shows any (src/monetization.ts), in Redis. */
  ads: AdStore;
  feedReader: TagFeedReader;
  /** Reads publishers' own indexes for following feeds, with caches of its own so they don't push out hashtags'. */
  authorReader: TagFeedReader;
  /** Injectable clock (UTC epoch ms) so timestamps and feed windows are testable. */
  now?: () => number;
}

export interface AppDeps extends StoreDeps {
  db: Db;
}

/** What the routes that write posts share, built once per app; and the CLI the app ships, if any. */
export interface RouteDeps extends AppDeps {
  challenges: Challenges;
  writer: ContentWriter;
  cli: CliRelease | null;
  /** The algorithms that give each post its trust score, in the order they run (src/plugins/trust). */
  trustPlugins: TrustPlugin[];
}

export function createStores(config: Config, now: () => number = Date.now, hot: HotStore = createHotStore(config.redis, now)) {
  const content = new ContentStore(config.storage.content);
  const comments = new CommentStore(hot, config.storage.content, { hotMs: config.comments.hotHours * HOUR });
  const { scheme, options } = config.storage.summaries;
  const summaries = new SummaryStore(
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
  );
  const publishers = new PublisherStore(hot, { cacheMs: config.feed.headCacheMs }, now);
  const follows = new FollowStore(hot);
  const relatedTags = new RelatedTagStore(hot, { cacheMs: config.feed.headCacheMs }, now);
  const ads = new AdStore(hot, { cacheMs: config.feed.headCacheMs }, now);
  const feedReader = new TagFeedReader(hot, { headCacheMs: config.feed.headCacheMs, indexCacheSize: config.feed.indexCacheSize }, now);
  const authorReader = new TagFeedReader(hot, { headCacheMs: config.feed.headCacheMs, indexCacheSize: config.feed.authorIndexCacheSize }, now);
  return { content, comments, hot, summaries, publishers, follows, relatedTags, ads, feedReader, authorReader };
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
  const close = async () => {
    await stores.close();
    await db.destroy();
  };
  return { ...stores, db, close };
}
