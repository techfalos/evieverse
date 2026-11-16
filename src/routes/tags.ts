import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import { allowedTags, MAX_TAGS } from '../tags.js';
import { iso } from '../time.js';

const Query = z.object({
  prefix: z
    .string()
    .regex(/^#?[a-z0-9_]*$/i)
    .optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

export function tagRoutes(app: FastifyInstance, { db, config }: AppDeps) {
  /**
   * How posts are tagged on this server, for anyone to read: what a client needs to know to offer
   * people hashtags a post will be accepted with. `allowedTags` is every hashtag a post can have in
   * server tagging mode, as the configuration lists them, used yet or not, and null in user mode,
   * where a post can have any. `maxTags` is the most one post can have, in either mode.
   */
  app.get('/tagging', async () => ({ mode: config.tagging.mode, allowedTags: allowedTags(config.tagging), maxTags: MAX_TAGS }));

  /** Lists the hashtags posts have used, most recently active first. ?prefix=mum matches "mumbai", "mumbaifloods", ... */
  app.get('/tags', async (req) => {
    const q = Query.parse(req.query);
    let query = db
      .selectFrom('tags')
      .select(['name', 'last_appended_at'])
      // Publishers' own indexes ("@<userId>") are compacted like hashtags, but aren't hashtags.
      .where('name', 'not like', '@%')
      .orderBy('last_appended_at', 'desc')
      .limit(q.limit);
    const prefix = q.prefix?.replace(/^#/, '').toLowerCase();
    if (prefix) query = query.where('name', 'like', `${prefix}%`);
    const rows = await query.execute();
    return { tags: rows.map((r) => ({ tag: r.name, lastActiveAt: iso(r.last_appended_at) })) };
  });
}
