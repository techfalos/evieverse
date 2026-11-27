import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import type { AppDeps } from '../deps.types.js';
import { decodeCursorJson, encodeCursorJson, invalidCursor } from '../http/listCursor.js';
import { allowedTags, MAX_TAGS } from '../tags.js';
import { iso } from '../time.js';

/**
 * The orders GET /tags lists hashtags in: `recent`, the one a post was last published or updated
 * under first, and `popular`, the one the most posts carry first.
 */
const SORTS = ['recent', 'popular'] as const;

/**
 * What GET /tags is asked: with `prefix` (letters, digits and _, with or without #, in any case),
 * only the hashtags that start with it; `sort`, the order to list them in (see SORTS), `recent`
 * unless the request says; `limit`, the most hashtags of one page, 200 unless the request says,
 * and 1000 at most; and `cursor`, the one the page before came with, for the page after it.
 */
const Query = z.object({
  prefix: z
    .string()
    .regex(/^#?[a-z0-9_]*$/i)
    .optional(),
  sort: z.enum(SORTS).default('recent'),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  cursor: z.string().optional(),
});

/**
 * Where a page of hashtags ended, as its cursor says: what the last hashtag was listed by (when
 * it was last active, or how many posts it had) and its name. 400 for a cursor that isn't a page
 * of hashtags', or is one of a list in another order than `sort`.
 */
function decodeTagCursor(cursor: string, sort: (typeof SORTS)[number]): { by: number; name: string } {
  const raw = decodeCursorJson(cursor);
  if (Array.isArray(raw) && raw.length === 3 && raw[0] === sort && Number.isSafeInteger(raw[1]) && typeof raw[2] === 'string' && !raw[2].includes('\0')) {
    return { by: raw[1], name: raw[2] };
  }
  throw invalidCursor();
}

/** What the server tells anyone about hashtags, with no credentials: how posts are tagged here (GET /tagging), and the hashtags posts have used (GET /tags). */
export function tagRoutes(app: FastifyInstance, { db, config }: AppDeps) {
  /**
   * How posts are tagged on this server, for anyone to read: what a client needs to know to offer
   * people hashtags a post will be accepted with. `allowedTags` is every hashtag a post can have in
   * server tagging mode, as the configuration lists them, used yet or not, and null in user mode,
   * where a post can have any. `maxTags` is the most one post can have, in either mode.
   */
  app.get('/tagging', async () => ({ mode: config.tagging.mode, allowedTags: allowedTags(config.tagging), maxTags: MAX_TAGS }));

  /**
   * Lists the hashtags posts have used, a page at a time: `tags`, each with how many posts carry
   * it (`postCount`) and when a post was last published or updated under it (`lastActiveAt`), and
   * `nextCursor`, which asks for the page after this one, or null if there is none.
   * ?prefix=mum matches "mumbai", "mumbaifloods", ...
   *
   * The most recently active first, or with ?sort=popular, the one with the most posts first.
   * Either way two hashtags that are level are in the reverse order of their names, so the list
   * has one order, which is the order its index has them in, read from its end
   * (`tags_last_appended_idx`, `tags_post_count_idx`).
   *
   * `postCount` is the compactor's count (`tags.post_count`): the posts that carry the hashtag
   * and that anyone can read, as of its last run. So a post counts once it is in feeds, and a
   * hashtag whose posts were all deleted is listed with 0. A page is read as the counts and the
   * times are when it is asked for: a hashtag that moves in the list between two pages may be
   * in both, or in neither.
   */
  app.get('/tags', async (req) => {
    const q = Query.parse(req.query);
    const after = q.cursor === undefined ? undefined : decodeTagCursor(q.cursor, q.sort);
    const by = sql.ref<number>(q.sort === 'popular' ? 'tags.post_count' : 'tags.last_appended_at');
    const name = sql.ref<string>('tags.name');
    let query = db
      .selectFrom('tags')
      .select(['name', 'last_appended_at', 'post_count'])
      // Publishers' own indexes ("@<userId>") are compacted like hashtags, but aren't hashtags.
      .where('name', 'not like', '@%')
      // Both the same way, which is the order the index has them in, read from its end.
      .orderBy(by, 'desc')
      .orderBy('name', 'desc')
      .limit(q.limit + 1);
    const prefix = q.prefix?.replace(/^#/, '').toLowerCase();
    if (prefix) query = query.where('name', 'like', `${prefix}%`);
    if (after) query = query.where(sql<boolean>`(${by} < ${after.by} or (${by} = ${after.by} and ${name} < ${after.name}))`);
    const found = await query.execute();
    const rows = found.slice(0, q.limit);
    const last = rows.at(-1);
    return {
      tags: rows.map((r) => ({ tag: r.name, postCount: Number(r.post_count), lastActiveAt: iso(r.last_appended_at) })),
      nextCursor: found.length > q.limit && last ? encodeCursorJson([q.sort, Number(q.sort === 'popular' ? last.post_count : last.last_appended_at), last.name]) : null,
    };
  });
}
