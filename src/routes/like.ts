import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { authenticate } from '../auth/apiKey.js';
import { isUniqueViolation } from '../db/index.js';
import type { AppDeps } from '../deps.js';
import { notFound } from '../http/errors.js';

const Body = z.object({
  userId: z.string().optional(),
  apiKey: z.string().optional(),
  contentId: z.string().uuid(),
});

export function likeRoutes(app: FastifyInstance, { db, now = Date.now }: AppDeps) {
  /** Likes are permanent and idempotent: liking twice succeeds without double-counting. */
  app.post('/like', async (req, reply) => {
    const body = Body.parse(req.body ?? {});
    const user = await authenticate(db, req, body);

    let alreadyLiked = false;
    try {
      await db.transaction().execute(async (trx) => {
        const content = await trx
          .selectFrom('content')
          .select('id')
          .where('id', '=', body.contentId)
          .where('delete_requested_at', 'is', null)
          .executeTakeFirst();
        if (!content) throw notFound('content not found');
        const existing = await trx
          .selectFrom('likes')
          .select('user_id')
          .where('user_id', '=', user.id)
          .where('content_id', '=', body.contentId)
          .executeTakeFirst();
        if (existing) {
          alreadyLiked = true;
          return;
        }
        await trx.insertInto('likes').values({ user_id: user.id, content_id: body.contentId, created_at: now() }).execute();
        await trx
          .updateTable('content')
          .set({ like_count: sql`like_count + 1` })
          .where('id', '=', body.contentId)
          .execute();
      });
    } catch (err) {
      // A concurrent like from the same user won the race; the transaction rolled back cleanly.
      if (!isUniqueViolation(err)) throw err;
      alreadyLiked = true;
    }

    const { like_count } = await db
      .selectFrom('content')
      .select('like_count')
      .where('id', '=', body.contentId)
      .executeTakeFirstOrThrow();
    return reply.status(alreadyLiked ? 200 : 201).send({ contentId: body.contentId, likes: like_count, alreadyLiked });
  });
}
