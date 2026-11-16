import { randomInt } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { AppDeps } from '../deps.js';
import { decodeCursor, decodeFollowingCursor, encodeCursor, encodeFollowingCursor } from '../feed/cursor.js';
import { planFollowing } from '../feed/following.js';
import { FEED_ALGORITHMS, FEED_HOURS, planFeed } from '../feed/plan.js';
import { relatedTo } from '../feed/related.js';
import { followingRecords, loadBodies, planned, renderFeed } from '../feed/render.js';
import { requireShownFollows } from '../follows.js';
import { badRequest } from '../http/errors.js';
import { invalidCursor } from '../http/listCursor.js';
import { HASHTAG } from '../http/schemas.js';
import { messageKey, msg } from '../language.js';
import type { PublisherStore, RelatedTagStore, SummaryStore } from '../storage/index.js';
import { normalizeTag } from '../tags.js';
import { authorIndex } from '../tagfeed/layout.js';
import { cursorExpired, type TagFeedReader } from '../tagfeed/reader.js';
import { DAY } from '../time.js';

/** The most hashtags a feed reads: the ones asked for and, with addRelated, the ones related to them. */
const MAX_TAGS = 20;

/** Most posts in the page; FEED_PAGE_SIZE when omitted, at most FEED_MAX_PAGE_SIZE. */
const Limit = z.coerce.number().int().positive().optional();
/** true: only content its publisher declared created with AI. false: only content declared not. Omitted: both. */
const AiGenerated = z.stringbool().optional();
/**
 * false: only posts no moderator of their hashtag has decided on yet, which is that hashtag's moderation
 * queue. true: only posts one has approved. Omitted: both.
 */
const Moderated = z.stringbool().optional();

/** Posts of the past this many hours: 1, 2, 4, 8 or 12 hours, or 1, 2, 3, 7, 14, 21, 30, 60 or 90 days' worth. */
const Hours = z.coerce
  .number()
  .refine((hours) => FEED_HOURS.includes(hours), { message: messageKey('feed.hours_invalid'), params: { hours: FEED_HOURS.join(', ') } })
  .default(24);
/**
 * true: the feed also returns posts under the hashtags related to the ones asked for, which are those
 * that tend to be on the same posts. Omitted or false: only under the ones asked for.
 */
const AddRelated = z.stringbool().optional();

const Query = z.object({
  /** Comma-separated hashtags, e.g. "news,mumbai". Also accepts repeated ?tags= params. */
  tags: z.union([z.string(), z.array(z.string())]),
  hours: Hours,
  limit: Limit,
  /** Which of the window's posts come first. popular: the most liked. chronological: the newest. */
  algorithm: z.enum(FEED_ALGORITHMS).default('popular'),
  addRelated: AddRelated,
  aiGenerated: AiGenerated,
  moderated: Moderated,
  cursor: z.string().optional(),
});

const FollowingQuery = z.object({
  /** Whose follows. Theirs to read by their key; anyone's, with no key, if they show whom they follow. */
  userId: z.string().uuid(),
  limit: Limit,
  aiGenerated: AiGenerated,
  cursor: z.string().optional(),
});

/** The size of the page a feed request asks for; 400 if it is more than a page can hold. */
function pageLimit(config: Config, requested: number | undefined): number {
  const limit = requested ?? config.feed.pageSize;
  if (limit > config.feed.maxPageSize) throw badRequest(msg('feed.limit_too_large', { max: config.feed.maxPageSize }));
  return limit;
}

/** Only the feed index, summaries, publisher credits and related hashtags are passed in: hashtag feeds never touch the database. */
export interface FeedDeps {
  config: Config;
  feedReader: TagFeedReader;
  summaries: SummaryStore;
  publishers: PublisherStore;
  relatedTags: RelatedTagStore;
  now?: () => number;
}

export function feedRoutes(app: FastifyInstance, { config, feedReader, summaries, publishers, relatedTags, now = Date.now }: FeedDeps) {
  /**
   * retrieve_feed. Each record says whether a moderator of the hashtag it is listed under has approved
   * it there (`moderated`), and `moderated=false` leaves only those none has: the hashtag's
   * moderation queue, which is read like any feed, from the index alone.
   *
   * With `addRelated`, the feed is planned over the hashtags asked for and then the ones related to
   * them, as if all had been asked for: the related ones are read from Redis, where the compactor
   * keeps them (RelatedTagStore), and the response names them in `related`.
   */
  app.get('/feed', async (req, reply) => {
    const q = Query.parse(req.query);
    const raw = (Array.isArray(q.tags) ? q.tags : [q.tags]).flatMap((t) => t.split(',')).map((t) => t.trim()).filter(Boolean);
    const tags = [...new Set(raw.map((t) => (HASHTAG.test(t) ? normalizeTag(t) : null)))];
    if (!tags.length || tags.includes(null)) throw badRequest(msg('feed.tags_invalid'));
    if (tags.length > MAX_TAGS) throw badRequest(msg('feed.too_many_tags', { max: MAX_TAGS }));
    const tagList = tags as string[];
    const limit = pageLimit(config, q.limit);

    const addRelated = q.addRelated ?? false;

    const cursor = q.cursor ? decodeCursor(q.cursor) : undefined;
    if (
      cursor &&
      (cursor.hours !== q.hours ||
        cursor.algorithm !== q.algorithm ||
        (cursor.related !== undefined) !== addRelated ||
        cursor.aiGenerated !== q.aiGenerated ||
        cursor.moderated !== q.moderated ||
        cursor.tags.join(',') !== tagList.join(','))
    ) {
      throw badRequest(msg('feed.cursor_mismatch'));
    }
    // A cursor is the client's to hold, so what it names is held to what a first page could have read.
    if (cursor?.related && tagList.length + cursor.related.length > MAX_TAGS) throw invalidCursor();
    const t = now();
    if (cursor && t - cursor.anchor > config.feed.genRetentionMinutes * 60_000) throw cursorExpired();
    const anchor = cursor?.anchor ?? t;
    const seed = cursor?.seed ?? randomInt(2 ** 31);
    const { freshEvery, freshMaxLikes, freshPool } = config.feed;

    // Later pages read the related hashtags the first page did: what was counted since could name others.
    const related = !addRelated
      ? undefined
      : (cursor?.related ?? relatedTo(tagList, await Promise.all(tagList.map((tag) => relatedTags.get(tag))), MAX_TAGS));
    const feedTags = related ? [...tagList, ...related] : tagList;

    // A tag the cursor has no pin for is read as it is now: only a cursor that was tampered with lacks one.
    const views = await Promise.all(feedTags.map((tag) => feedReader.view(tag, cursor?.pins[tag])));
    const plan = planFeed(
      views.map((v) => v.candidates),
      {
        algorithm: q.algorithm,
        aiGenerated: q.aiGenerated,
        moderated: q.moderated,
        hours: q.hours,
        anchor,
        limit,
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
          related,
          algorithm: q.algorithm,
          aiGenerated: q.aiGenerated,
          moderated: q.moderated,
          pins,
          positions: plan.positions,
          seed,
          freshPositions: plan.freshPositions,
        })
      : null;
    const bodies = await loadBodies(planned(plan), summaries, publishers);

    reply.type('application/json; charset=utf-8');
    return reply.send(Readable.from(renderFeed(plan, feedTags, bodies, nextCursor, related)));
  });
}

/**
 * The following feed, which is served apart from the hashtag feeds (see functions/groups.ts): its
 * records say whose posts a user follows, so it reads the database to learn who may read it.
 */
export function followingFeedRoutes(app: FastifyInstance, { db, config, authorReader, summaries, publishers, follows, now = Date.now }: AppDeps) {
  /**
   * The posts of the users `userId` follows, newest first, reaching back up to maxLookbackDays. Read
   * from each followed publisher's own index; a user who follows nobody gets none.
   *
   * It is the user's own to read, by their key, and anyone's if the user shows whom they follow:
   * the same rule as the list of them, which the feed would otherwise give away (see
   * requireShownFollows). That is all it asks the database: whom they follow, and the posts, come
   * from Redis and the summary store, as a hashtag feed's do.
   */
  app.get('/feed/following', async (req) => {
    const q = FollowingQuery.parse(req.query);
    const limit = pageLimit(config, q.limit);
    const after = q.cursor ? decodeFollowingCursor(q.cursor) : undefined;
    await requireShownFollows(db, req, q.userId, 'following');
    const t = now();

    const followees = await follows.get(q.userId);
    const indexes = await Promise.all(followees.map((id) => authorReader.open(authorIndex(id))));
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
