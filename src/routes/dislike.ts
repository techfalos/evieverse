import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { authenticate } from '../auth/apiKey.js';
import { contentNotFound, withheld } from '../content.js';
import { isUniqueViolation } from '../db/index.js';
import type { AppDeps } from '../deps.types.js';
import { badRequest } from '../http/errors.js';
import { Credentials } from '../http/schemas.js';
import { msg } from '../language.js';
import { refuseBanned } from '../moderation/policy.js';

/**
 * The body of POST /dislike and of DELETE /dislike: who's asking, and the post to dislike or to
 * stop disliking. `commentId` is what POST /like takes for a comment on the post: it is read
 * only to be refused, so that a request that means a comment isn't taken for one of the post.
 */
const Body = Credentials.extend({
  contentId: z.string().uuid(),
  commentId: z.unknown().optional(),
});

/**
 * Dislikes of posts: POST /dislike gives one, and DELETE /dislike takes it back. A server has
 * them only if it says so (`dislikes` in the configuration, DISLIKES), and none does unless it
 * says so.
 *
 * A post's dislikes are a count of their own, from 0 (`content.dislike_count`), beside its likes:
 * a dislike takes no like off, a user may both like and dislike a post, and no feed is ordered or
 * trimmed by dislikes. The count comes with the post wherever it is read, as `dislikes`, on a
 * server that has them on; on one that has them off, `dislikes` is null there (see `countsOf`).
 * Only posts are disliked, not comments.
 */
export function dislikeRoutes(app: FastifyInstance, { db, config, now = Date.now }: AppDeps) {
  const { dialect } = config.db;

  /** How many dislikes the post has, as a response says it: the count where the server has dislikes on, and null where it has them off, as wherever a post is read. */
  async function dislikesOf(contentId: string): Promise<number | null> {
    const { dislike_count } = await db.selectFrom('content').select('dislike_count').where('id', '=', contentId).executeTakeFirstOrThrow();
    return config.dislikes ? dislike_count : null;
  }

  /**
   * Dislikes a post. A dislike is idempotent, as a like is: disliking twice succeeds without
   * double-counting (`alreadyDisliked`). It stays until the user takes it back (DELETE /dislike).
   *
   * It is a row of `dislikes`, whose primary key is what makes it once per user, and one more on
   * the post's count, in one transaction. The post is marked as having had its dislikes change
   * (`disliked_at`), which is how the compactor's next run finds it and writes its entries in the
   * feed indexes with the count as it now is: until then feeds show the count they had.
   *
   * 400 on a server that has dislikes off, before anything is looked up, and for a `commentId`:
   * comments aren't disliked. Only published content is: what is set for deletion, waits in the
   * moderation queue, or is hidden because its original is gone, is 404. A banned user is refused
   * (403), as they are a like.
   */
  app.post('/dislike', async (req, reply) => {
    const body = Body.parse(req.body ?? {});
    if (!config.dislikes) throw badRequest(msg('dislike.off'));
    if (body.commentId !== undefined) throw badRequest(msg('dislike.posts_only'));
    const user = await authenticate(db, req, body);
    refuseBanned(user);
    const { contentId } = body;

    let alreadyDisliked = false;
    try {
      await db.transaction().execute(async (trx) => {
        if (
          !(await trx
            .selectFrom('content')
            .leftJoin('moderation_queue', 'moderation_queue.content_id', 'content.id')
            .select('content.id')
            .where('content.id', '=', contentId)
            .where('content.delete_requested_at', 'is', null)
            .where('content.origin_gone_at', 'is', null)
            .where('moderation_queue.content_id', 'is', null)
            .executeTakeFirst())
        ) {
          throw contentNotFound();
        }
        if (await trx.selectFrom('dislikes').select('user_id').where('user_id', '=', user.id).where('content_id', '=', contentId).executeTakeFirst()) {
          alreadyDisliked = true;
          return;
        }
        await trx.insertInto('dislikes').values({ user_id: user.id, content_id: contentId, created_at: now() }).execute();
        await trx
          .updateTable('content')
          .set({ dislike_count: sql`dislike_count + 1`, disliked_at: now() })
          .where('id', '=', contentId)
          .execute();
      });
    } catch (err) {
      // A concurrent dislike from the same user won the race; the transaction rolled back cleanly.
      if (!isUniqueViolation(err)) throw err;
      alreadyDisliked = true;
    }
    return reply.status(alreadyDisliked ? 200 : 201).send({ contentId, dislikes: await dislikesOf(contentId), alreadyDisliked });
  });

  /**
   * Takes back the user's dislike of a post. Idempotent: taking back a dislike that isn't there
   * changes nothing, and says so (`wasDisliked`). The user can dislike the post again afterwards.
   *
   * It names the post as DELETE /like does: in a JSON body, or with `contentId` as a query
   * parameter, for a client that sends no body with a DELETE, whose credentials are then in the
   * headers.
   *
   * The dislike's row is deleted, with one off the post's count, never below 0. The post's row
   * is locked first, so the count is taken from once however many requests ask, and the post is
   * marked (`disliked_at`) for the compactor's next run, as a dislike marks it.
   *
   * It is answered on a server that has dislikes off, and to a banned user: either keeps a
   * user from adding a dislike, and this takes away one that is the user's own, given while they
   * could. `dislikes` is then null in the answer, as it is wherever a post is read. As with a
   * like, a dislike stays the user's to take back while the post is withheld from readers; to
   * anyone who has none there, withheld content is 404, and content set for deletion is 404 to
   * all.
   */
  app.delete('/dislike', async (req) => {
    const { contentId: queryContentId, commentId: queryCommentId } = (req.query ?? {}) as Record<string, unknown>;
    const body = Body.parse({ contentId: queryContentId, commentId: queryCommentId, ...(typeof req.body === 'object' && req.body !== null ? req.body : {}) });
    if (body.commentId !== undefined) throw badRequest(msg('dislike.posts_only'));
    const user = await authenticate(db, req, body);
    const { contentId } = body;

    const mine = (from: typeof db) => from.selectFrom('dislikes').select('created_at').where('user_id', '=', user.id).where('content_id', '=', contentId).executeTakeFirst();
    const post = await db
      .selectFrom('content')
      .leftJoin('moderation_queue', 'moderation_queue.content_id', 'content.id')
      .select(['content.id', 'content.origin_gone_at', 'moderation_queue.content_id as queued_id'])
      .where('content.id', '=', contentId)
      .where('content.delete_requested_at', 'is', null)
      .executeTakeFirst();
    const disliked = await mine(db);
    // Not there, or set for deletion; or withheld, which is 404 to whoever has no dislike of it to take back.
    if (!post || (withheld(post) && !disliked)) throw contentNotFound();

    let wasDisliked = false;
    // A dislike that isn't there takes no lock, and changes nothing.
    if (disliked) await db.transaction().execute(async (trx) => {
      // The lock on the post's row first, and nothing read before it, as an unlike does (see DELETE /like): the
      // user's requests take turns, and each takes one from a count no other is changing.
      const row = trx.selectFrom('content').select('id').where('id', '=', contentId).where('delete_requested_at', 'is', null);
      const locked = await (dialect === 'sqlite' ? row : dialect === 'postgres' ? row.forNoKeyUpdate() : row.forUpdate()).executeTakeFirst();
      if (!locked) throw contentNotFound();
      const { numDeletedRows } = await trx.deleteFrom('dislikes').where('user_id', '=', user.id).where('content_id', '=', contentId).executeTakeFirst();
      // Taken back by the user's other request after all: the count is taken from for a row that this one deleted, and no other.
      if (Number(numDeletedRows) !== 1) return;
      await trx
        .updateTable('content')
        .set({ dislike_count: sql`case when dislike_count > 0 then dislike_count - 1 else 0 end`, disliked_at: now() })
        .where('id', '=', contentId)
        .execute();
      wasDisliked = true;
    });

    return { contentId, dislikes: await dislikesOf(contentId), wasDisliked };
  });
}
