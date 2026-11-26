import type { Challenges } from './challenge/challenges.js';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import type { TrustEngine } from './moderation/trust.js';
import type { OriginKeys } from './originKeys.js';
import type { CliRelease } from './routes/cli.types.js';
import type { AdStore, CommentStore, ContentStore, FollowStore, HotStore, PublisherStore, RelatedTagStore, SummaryStore } from './storage/index.js';
import type { TagFeedReader } from './tagfeed/reader.js';
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

/** The stores and the database: what `bootstrap` makes, for the routes that use the database and for the compactor. */
export interface AppDeps extends StoreDeps {
  db: Db;
}

/** What the routes that write posts share, built once per app; and the CLI the app ships, if any. */
export interface RouteDeps extends AppDeps {
  challenges: Challenges;
  writer: ContentWriter;
  cli: CliRelease | null;
  /** The algorithms that give each post its trust score, and the policy that says where the score sends it (moderation/trust.ts). */
  trust: TrustEngine;
  /** The keys other servers sign their posts' attestations with, which a repost of a post on another server is checked by. */
  originKeys: OriginKeys;
}
