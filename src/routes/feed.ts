import { randomInt } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { AppDeps } from '../deps.types.js';
import { decodeCursor, decodeFollowingCursor, encodeCursor, encodeFollowingCursor } from '../feed/cursor.js';
import { planFollowing } from '../feed/following.js';
import { FEED_ALGORITHMS, FEED_HOURS, planFeed } from '../feed/plan.js';
import { relatedTo } from '../feed/related.js';
import { followingRecords, loadBodies, planned, renderFeed } from '../feed/render.js';
import { requireShownFollows } from '../follows.js';
import { badRequest } from '../http/errors.js';
import { say } from '../http/language.js';
import { invalidCursor } from '../http/listCursor.js';
import { HASHTAG } from '../http/schemas.js';
import { messageKey, msg } from '../language.js';
import { adRecord, eligibleAds, orderAds, placeAds } from '../monetization.js';
import type { FeedAd } from '../monetization.types.js';
import { normalizeTag } from '../tags.js';
import { authorIndex } from '../tagfeed/layout.js';
import { DAY } from '../time.js';
import type { FeedDeps } from './feed.types.js';

/** The most hashtags a feed reads: the ones asked for and, with addRelated, the ones related to them. */
const MAX_FEED_TAGS = 20;

/** Most posts in the page; FEED_PAGE_SIZE when omitted, at most FEED_MAX_PAGE_SIZE. */
const Limit = z.coerce.number().int().positive().optional();
/** true: only content its publisher declared created with AI. false: only content declared not. Omitted: both. */
const AiGenerated = z.stringbool().optional();

/**
 * The query of GET /feed: the hashtags to read, how far back, which posts come first and which are
 * left out, and the page asked for (`limit`, and the `cursor` the page before came with).
 */
const Query = z.object({
  /** Comma-separated hashtags, e.g. "news,mumbai". Also accepts repeated ?tags= params. */
  tags: z.union([z.string(), z.array(z.string())]),
  /** Posts of the past this many hours: 1, 2, 4, 8 or 12 hours, or 1, 2, 3, 7, 14, 21, 30, 60 or 90 days' worth. */
  hours: z.coerce
    .number()
    .refine((hours) => FEED_HOURS.includes(hours), { message: messageKey('feed.hours_invalid'), params: { hours: FEED_HOURS.join(', ') } })
    .default(24),
  limit: Limit,
  /** Which of the window's posts come first. popular: the most liked. chronological: the newest. */
  algorithm: z.enum(FEED_ALGORITHMS).default('popular'),
  /**
   * true: the feed also returns posts under the hashtags related to the ones asked for, which are those
   * that tend to be on the same posts. Omitted or false: only under the ones asked for.
   */
  addRelated: z.stringbool().optional(),
  aiGenerated: AiGenerated,
  /**
   * false: only posts no moderator of their hashtag has decided on yet, which is that hashtag's moderation
   * queue. true: only posts one has approved. Omitted: both.
   */
  moderated: z.stringbool().optional(),
  cursor: z.string().optional(),
});

/** The query of GET /feed/following: whose follows, which of their posts are left out, and the page asked for. */
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

/**
 * The hashtag feed: GET /feed, and nothing else. It never touches the database (see FeedDeps), so
 * it can be served by a function that opens none (see functions/groups.ts). The following feed
 * does, and is a route of its own (followingFeedRoutes).
 */
export function feedRoutes(app: FastifyInstance, { config, feedReader, summaries, publishers, relatedTags, ads, now = Date.now }: FeedDeps) {
  /**
   * retrieve_feed. Each record says whether a moderator of the hashtag it is listed under has approved
   * it there (`moderated`), and `moderated=false` leaves only those none has: the hashtag's
   * moderation queue, which is read like any feed, from the index alone.
   *
   * With `addRelated`, the feed is planned over the hashtags asked for and then the ones related to
   * them, as if all had been asked for: the related ones are read from Redis, where the compactor
   * keeps them (RelatedTagStore), and the response names them in `related`.
   *
   * Where the server shows ads in feeds (MONETIZATION_FEED_ADS), every page comes with `ads`: an
   * ad to show before the 3rd, the 10th and the 17th of the page's records, as far as the page has
   * them (see AD_POSITIONS). They are chosen from the ads the compactor published to Redis
   * (AdStore) that are being shown now and that appear all the time or are targeted at one of the
   * hashtags the feed reads, the related ones among them. The records are the same with or without.
   */
  app.get('/feed', async (req, reply) => {
    const q = Query.parse(req.query);
    const tags = [
      ...new Set(
        (Array.isArray(q.tags) ? q.tags : [q.tags])
          .flatMap((t) => t.split(','))
          .map((t) => t.trim())
          .filter(Boolean)
          .map((t) => (HASHTAG.test(t) ? normalizeTag(t) : null)),
      ),
    ];
    if (!tags.length || tags.includes(null)) throw badRequest(msg('feed.tags_invalid'));
    if (tags.length > MAX_FEED_TAGS) throw badRequest(msg('feed.too_many_tags', { max: MAX_FEED_TAGS }));
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
    if (cursor?.related && tagList.length + cursor.related.length > MAX_FEED_TAGS) throw invalidCursor();
    // The window ends where the first page's did, so a session never reaches posts newer than its first page.
    const anchor = cursor?.anchor ?? now();
    const seed = cursor?.seed ?? randomInt(2 ** 31);
    const { freshEvery, freshMaxLikes, freshPool } = config.feed;

    // Later pages read the related hashtags the first page did: what was counted since could name others.
    const related = !addRelated
      ? undefined
      : (cursor?.related ?? relatedTo(tagList, await Promise.all(tagList.map((tag) => relatedTags.get(tag))), MAX_FEED_TAGS));
    const feedTags = related ? [...tagList, ...related] : tagList;
    if (cursor && cursor.after.length !== feedTags.length) throw invalidCursor();

    // Every page reads the indexes as they are now. The cursor says where in each tag's list the page before stopped.
    const plan = planFeed(
      (await Promise.all(feedTags.map((tag) => feedReader.view(tag)))).map((v) => v.candidates),
      {
        algorithm: q.algorithm,
        aiGenerated: q.aiGenerated,
        moderated: q.moderated,
        hours: q.hours,
        anchor,
        limit,
        after: cursor?.after,
        fresh: { every: freshEvery, maxLikes: freshMaxLikes, pool: freshPool, seed, after: cursor?.freshAfter },
      },
    );
    const bodies = await loadBodies(planned(plan), summaries, publishers);

    // The ads this page chooses from, in the page's own order of them (see orderAds): the session's
    // seed and the cursor the page was asked with tell it from every other page.
    const pageAds = config.monetization.feedAds ? orderAds(eligibleAds(await ads.get(), feedTags, now()), `${seed} ${q.cursor ?? ''}`) : undefined;
    const label = say(req, msg('ad.sponsored'));

    reply.type('application/json; charset=utf-8');
    return reply.send(
      Readable.from(
        renderFeed(
          plan,
          feedTags,
          bodies,
          plan.truncated
            ? encodeCursor({
                anchor,
                hours: q.hours,
                tags: tagList,
                related,
                algorithm: q.algorithm,
                aiGenerated: q.aiGenerated,
                moderated: q.moderated,
                after: plan.after,
                seed,
                freshAfter: plan.freshAfter,
              })
            : null,
          related,
          pageAds && ((count: number): FeedAd[] => placeAds(pageAds, count).map(({ ad, position }) => ({ ...adRecord(ad, label, config.publicBaseUrl), position }))),
        ),
      ),
    );
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

    const plan = await planFollowing(authorReader, await Promise.all((await follows.get(q.userId)).map((id) => authorReader.open(authorIndex(id)))), {
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
