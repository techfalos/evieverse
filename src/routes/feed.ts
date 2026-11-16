import { randomInt } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { decodeCursor, decodeFollowingCursor, encodeCursor, encodeFollowingCursor } from '../feed/cursor.js';
import { planFollowing } from '../feed/following.js';
import { DAY, FEED_MODES, planFeed } from '../feed/plan.js';
import { followingRecords, loadBodies, planned, renderFeed } from '../feed/render.js';
import { badRequest } from '../http/errors.js';
import type { FollowStore, PublisherStore, SummaryStore } from '../storage/index.js';
import { normalizeTag } from '../tags.js';
import { authorIndex } from '../tagfeed/layout.js';
import { cursorExpired, type TagFeedReader } from '../tagfeed/reader.js';

const MAX_TAGS = 20;
const QUERY_TAG = /^#?[A-Za-z0-9_]{1,64}$/;

/** Most posts in the page; FEED_PAGE_SIZE when omitted, at most FEED_MAX_PAGE_SIZE. */
const Limit = z.coerce.number().int().positive().optional();
/** true: only content its publisher declared created with AI. false: only content declared not. Omitted: both. */
const AiGenerated = z.stringbool().optional();

const Query = z.object({
  /** Comma-separated hashtags, e.g. "news,mumbai". Also accepts repeated ?tags= params. */
  tags: z.union([z.string(), z.array(z.string())]),
  hours: z.coerce.number().int().min(1).max(168).default(24),
  limit: Limit,
  /** popular: most liked first. balanced: equal turns for the most liked, middle and least liked thirds. */
  mode: z.enum(FEED_MODES).default('popular'),
  aiGenerated: AiGenerated,
  cursor: z.string().optional(),
});

const FollowingQuery = z.object({
  /** Whose follows: they're public, so reading the feed needs no key. */
  userId: z.string().uuid(),
  limit: Limit,
  aiGenerated: AiGenerated,
  cursor: z.string().optional(),
});

/** Only the feed index, summaries, publisher credits and follows are passed in: feeds never touch the database. */
export interface FeedDeps {
  config: Config;
  feedReader: TagFeedReader;
  authorReader: TagFeedReader;
  summaries: SummaryStore;
  publishers: PublisherStore;
  follows: FollowStore;
  now?: () => number;
}

export function feedRoutes(app: FastifyInstance, { config, feedReader, authorReader, summaries, publishers, follows, now = Date.now }: FeedDeps) {
  const pageLimit = (requested: number | undefined) => {
    const limit = requested ?? config.feed.pageSize;
    if (limit > config.feed.maxPageSize) throw badRequest(`limit can be at most ${config.feed.maxPageSize}`);
    return limit;
  };

  /** retrieve_feed */
  app.get('/feed', async (req, reply) => {
    const q = Query.parse(req.query);
    const raw = (Array.isArray(q.tags) ? q.tags : [q.tags]).flatMap((t) => t.split(',')).map((t) => t.trim()).filter(Boolean);
    const tags = [...new Set(raw.map((t) => (QUERY_TAG.test(t) ? normalizeTag(t) : null)))];
    if (!tags.length || tags.includes(null)) throw badRequest('tags must be one or more hashtags (letters, digits, _)');
    if (tags.length > MAX_TAGS) throw badRequest(`at most ${MAX_TAGS} tags are allowed`);
    const tagList = tags as string[];
    const limit = pageLimit(q.limit);

    const cursor = q.cursor ? decodeCursor(q.cursor) : undefined;
    if (
      cursor &&
      (cursor.hours !== q.hours || cursor.mode !== q.mode || cursor.aiGenerated !== q.aiGenerated || cursor.tags.join(',') !== tagList.join(','))
    ) {
      throw badRequest('cursor does not match the requested tags/hours/mode/aiGenerated');
    }
    const t = now();
    if (cursor && t - cursor.anchor > config.feed.genRetentionMinutes * 60_000) throw cursorExpired();
    const anchor = cursor?.anchor ?? t;
    const seed = cursor?.seed ?? randomInt(2 ** 31);
    const { freshEvery, freshMaxLikes, freshPool } = config.feed;

    const views = await Promise.all(tagList.map((tag) => feedReader.view(tag, anchor, cursor?.pins[tag])));
    const plan = planFeed(
      views.map((v) => v.candidates),
      {
        mode: q.mode,
        aiGenerated: q.aiGenerated,
        hours: q.hours,
        anchor,
        limit,
        maxLookbackDays: config.feed.maxLookbackDays,
        positions: cursor?.positions,
        fresh: { every: freshEvery, maxLikes: freshMaxLikes, pool: freshPool, seed, positions: cursor?.freshPositions },
      },
    );
    const pins = Object.fromEntries(views.map((v) => [v.tag, v.pin]));
    const nextCursor = plan.truncated
      ? encodeCursor({
          anchor,
          hours: q.hours,
          tags: tagList,
          mode: q.mode,
          aiGenerated: q.aiGenerated,
          pins,
          positions: plan.positions,
          seed,
          freshPositions: plan.freshPositions,
        })
      : null;
    const bodies = await loadBodies(planned(plan), summaries, publishers);

    reply.type('application/json; charset=utf-8');
    return reply.send(Readable.from(renderFeed(plan, tagList, bodies, nextCursor)));
  });

  /**
   * The posts of the users `userId` follows, newest first, reaching back up to maxLookbackDays. Read
   * from each followed publisher's own index; a user who follows nobody (or doesn't exist) gets none.
   */
  app.get('/feed/following', async (req) => {
    const q = FollowingQuery.parse(req.query);
    const limit = pageLimit(q.limit);
    const after = q.cursor ? decodeFollowingCursor(q.cursor) : undefined;
    const t = now();

    const followees = await follows.get(q.userId);
    const indexes = await Promise.all(followees.map((id) => authorReader.open(authorIndex(id), t)));
    const plan = await planFollowing(authorReader, indexes, {
      limit,
      after,
      aiGenerated: q.aiGenerated,
      oldest: t - config.feed.maxLookbackDays * DAY,
    });
    const last = plan.picks.at(-1);
    const records = followingRecords(plan.picks, await loadBodies(plan.picks, summaries, publishers));
    return { count: records.length, truncated: plan.truncated, nextCursor: plan.truncated && last ? encodeFollowingCursor(last) : null, records };
  });
}
