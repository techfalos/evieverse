import { randomInt } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { decodeCursor, encodeCursor } from '../feed/cursor.js';
import { FEED_MODES, planFeed } from '../feed/plan.js';
import { loadBodies, renderFeed } from '../feed/render.js';
import { badRequest } from '../http/errors.js';
import type { PublisherStore, SummaryStore } from '../storage/index.js';
import { normalizeTag } from '../tags.js';
import { cursorExpired, type Pin, type TagFeedReader } from '../tagfeed/reader.js';

const MAX_TAGS = 20;
const QUERY_TAG = /^#?[A-Za-z0-9_]{1,64}$/;

const Query = z.object({
  /** Comma-separated hashtags, e.g. "news,mumbai". Also accepts repeated ?tags= params. */
  tags: z.union([z.string(), z.array(z.string())]),
  hours: z.coerce.number().int().min(1).max(168).default(24),
  /** popular: most liked first. balanced: equal turns for the most liked, middle and least liked thirds. */
  mode: z.enum(FEED_MODES).default('popular'),
  /** true: only content its publisher declared created with AI. false: only content declared not. Omitted: both. */
  aiGenerated: z.stringbool().optional(),
  cursor: z.string().optional(),
});

/** Only the feed index, summaries and publisher credits are passed in: the feed never touches the database. */
export interface FeedDeps {
  config: Config;
  feedReader: TagFeedReader;
  summaries: SummaryStore;
  publishers: PublisherStore;
  now?: () => number;
}

export function feedRoutes(app: FastifyInstance, { config, feedReader, summaries, publishers, now = Date.now }: FeedDeps) {
  /** retrieve_feed */
  app.get('/feed', async (req, reply) => {
    const q = Query.parse(req.query);
    const raw = (Array.isArray(q.tags) ? q.tags : [q.tags]).flatMap((t) => t.split(',')).map((t) => t.trim()).filter(Boolean);
    const tags = [...new Set(raw.map((t) => (QUERY_TAG.test(t) ? normalizeTag(t) : null)))];
    if (!tags.length || tags.includes(null)) throw badRequest('tags must be one or more hashtags (letters, digits, _)');
    if (tags.length > MAX_TAGS) throw badRequest(`at most ${MAX_TAGS} tags are allowed`);
    const tagList = tags as string[];

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
        maxTokens: config.feed.maxTokens,
        charsPerToken: config.feed.charsPerToken,
        maxLookbackDays: config.feed.maxLookbackDays,
        positions: cursor?.positions,
        fresh: { every: freshEvery, maxLikes: freshMaxLikes, pool: freshPool, seed, positions: cursor?.freshPositions },
      },
    );
    const pins: Record<string, Pin> = Object.fromEntries(views.map((v) => [v.tag, { manifest: v.manifest, mergedThrough: v.mergedThrough }]));
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
    const bodies = await loadBodies(plan, summaries, publishers);

    reply.type('application/json; charset=utf-8');
    return reply.send(Readable.from(renderFeed(plan, tagList, bodies, nextCursor)));
  });
}
