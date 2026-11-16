import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import { iso } from '../time.js';

const Query = z.object({
  prefix: z
    .string()
    .regex(/^#?[a-z0-9_]*$/i)
    .optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

export function tagRoutes(app: FastifyInstance, { db }: AppDeps) {
  /** Lists hashtags, most recently active first. ?prefix=mum matches "mumbai", "mumbaifloods", ... */
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
