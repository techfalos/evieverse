import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { authenticate } from '../auth/apiKey.js';
import { contentNotFound, loadPublished, requireMeta, takesComments } from '../content.js';
import { isUniqueViolation } from '../db/index.js';
import type { AppDeps } from '../deps.js';
import { notFound } from '../http/errors.js';
import { Credentials } from '../http/schemas.js';
import { msg } from '../language.js';

const Body = Credentials.extend({
  contentId: z.string().uuid(),
  /** To like a comment on the post rather than the post. */
  commentId: z.string().uuid().optional(),
});

export function likeRoutes(app: FastifyInstance, { db, content, comments, now = Date.now }: AppDeps) {
  /**
   * Likes a post, or with `commentId`, a comment on it. Likes are permanent and idempotent: liking
   * twice succeeds without double-counting.
   *
   * A post's likes are rows in the database, and its count a column of the post's. A comment's are
   * in the content store, as comments are (see CommentStore.like), and the database has none.
   */
  app.post('/like', async (req, reply) => {
    const body = Body.parse(req.body ?? {});
    const user = await authenticate(db, req, body);
    const { contentId, commentId } = body;

    if (commentId !== undefined) {
      // A comment anyone can read: one of a published post that takes comments, and not one that waits in the moderation queue.
      await loadPublished(db, contentId);
      if (!takesComments(await requireMeta(content, contentId))) throw notFound(msg('comment.off'));
      if (!(await comments.get(contentId, commentId))) throw notFound(msg('comment.not_found'));
      const { likes, already } = await comments.like(contentId, commentId, user.id);
      return reply.status(already ? 200 : 201).send({ contentId, commentId, likes, alreadyLiked: already });
    }

    let alreadyLiked = false;
    try {
      await db.transaction().execute(async (trx) => {
        // Published content only: what is set for deletion, or waits in the moderation queue, isn't there to like.
        const content = await trx
          .selectFrom('content')
          .leftJoin('moderation_queue', 'moderation_queue.content_id', 'content.id')
          .select('content.id')
          .where('content.id', '=', contentId)
          .where('content.delete_requested_at', 'is', null)
          .where('moderation_queue.content_id', 'is', null)
          .executeTakeFirst();
        if (!content) throw contentNotFound();
        const existing = await trx
          .selectFrom('likes')
          .select('user_id')
          .where('user_id', '=', user.id)
          .where('content_id', '=', contentId)
          .executeTakeFirst();
        if (existing) {
          alreadyLiked = true;
          return;
        }
        await trx.insertInto('likes').values({ user_id: user.id, content_id: contentId, created_at: now() }).execute();
        await trx
          .updateTable('content')
          .set({ like_count: sql`like_count + 1` })
          .where('id', '=', contentId)
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
      .where('id', '=', contentId)
      .executeTakeFirstOrThrow();
    return reply.status(alreadyLiked ? 200 : 201).send({ contentId, likes: like_count, alreadyLiked });
  });
}
