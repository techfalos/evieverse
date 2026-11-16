import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import type { TrustRoute } from './trust.js';
import type { TrustPlugin } from './trust.types.js';

/**
 * Why a post didn't get a hashtag: the publisher is muted on it (or, for a repost, the reposter is),
 * a moderator removed it from this content, or its blocked words. And, for a repost alone: the
 * post has the hashtag already.
 */
type RemovalReason = 'muted' | 'removed' | 'blocked_word' | 'already_tagged';

/**
 * A hashtag a post or a repost was sent with and didn't get, with why. Moderation makes them (see
 * `moderatePost`), the repost routes add the ones the post has already, and the response to the
 * request lists them as `removedTags`.
 */
export interface RemovedTag {
  tag: string;
  reason: RemovalReason;
}

/** What moderation of a post or a comment works with: the database, the settings, and the trust plugins. */
export interface ModerationDeps {
  db: Db;
  config: Config;
  trustPlugins: TrustPlugin[];
  now?: () => number;
  /** The request's log, which is told of a blocked pattern that took too long to read the post (see scanTexts). */
  log?: FastifyBaseLogger;
}

/**
 * What `moderatePost` makes of a post it doesn't refuse, for the route that writes the post: which
 * of its hashtags it gets, and where its trust score sends it. `moderateRepost` returns the
 * hashtags alone.
 */
export interface Moderated {
  /** The hashtags the post gets. */
  tags: string[];
  /** Those it doesn't, with why. */
  removedTags: RemovedTag[];
  /** How far the server trusts the post (see trustOf). Kept only with a post that waits in the moderation queue. */
  trustScore: number;
  /** Where the score sends the post: to the moderation queue, or straight to the feeds. */
  route: Exclude<TrustRoute, 'delete'>;
}
