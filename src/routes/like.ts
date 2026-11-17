import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { authenticate } from '../auth/apiKey.js';
import { contentNotFound, loadPublished, requireMeta, takesComments } from '../content.js';
import { isUniqueViolation } from '../db/index.js';
import type { AppDeps } from '../deps.types.js';
import { notFound } from '../http/errors.js';
import { Credentials } from '../http/schemas.js';
import { msg } from '../language.js';
import { refuseBanned } from '../moderation/policy.js';
import { effectiveComment, insertPending, likeKey, pendingComment, pendingLike, pendingLikes, writeUnnumbered } from '../pending.js';

/** The body of POST /like: who's asking, and the post to like, or the post and the comment on it to like. */
const Body = Credentials.extend({
  contentId: z.string().uuid(),
  /** To like a comment on the post rather than the post. */
  commentId: z.string().uuid().optional(),
});

/** Likes, of posts and of comments on them: POST /like, and nothing else. No route takes a like back. */
export function likeRoutes(app: FastifyInstance, { db, config, content, comments, now = Date.now }: AppDeps) {
  const { dialect } = config.db;
  /**
   * Likes a post, or with `commentId`, a comment on it. Likes are permanent and idempotent: liking
   * twice succeeds without double-counting.
   *
   * A post's likes are rows in the database, and its count a column of the post's. A comment's are
   * in the content store, as comments are, where the compactor makes them (see CommentStore.addLike):
   * the request commits the like as a write of the comment's post (`pending_writes`), with the
   * user and the comment as its key, so a user's like is there once. It takes no number and
   * locks nothing (see writeUnnumbered): the likes of one comment, and of one post's comments,
   * don't wait for each other. A like of a comment that was deleted, or of one under a post that
   * is set for deletion, is refused (404), and one that commits as either happens is never made:
   * the compactor applies a comment's removal last of its writes, and nothing of a post that is
   * set for deletion. The count it answers with has the likes that wait to be made; a comment
   * read before the compactor's next run has only the ones that were.
   *
   * A banned user is refused (403) either like, before anything is looked up: one they made before
   * the ban stays, and is answered the same way.
   */
  app.post('/like', async (req, reply) => {
    const body = Body.parse(req.body ?? {});
    const user = await authenticate(db, req, body);
    refuseBanned(user);
    const { contentId, commentId } = body;

    if (commentId !== undefined) {
      // A comment anyone can read: one of a published post that takes comments, and not one that waits in the moderation queue.
      await loadPublished(db, contentId);
      if (!takesComments(await requireMeta({ db, content }, contentId))) throw notFound(msg('comment.off'));
      const gone = () => notFound(msg('comment.not_found'));
      if ((await effectiveComment(db, comments, contentId, commentId))?.held !== false) throw gone();
      // Whether the user likes the comment already, by a like that waits to be made or one that was.
      // The rows first, then the store: the compactor makes a like there before it deletes the like's row.
      let already = (await pendingLike(db, contentId, commentId, user.id)) || (await comments.liked(contentId, commentId, user.id));
      if (!already) {
        try {
          // It takes no number, and no lock on the post: the likes of one comment commit side by side.
          await writeUnnumbered(db, dialect, contentId, {}, async (trx) => {
            // Deleted, or taken back to the queue, by a write that committed while this was under way.
            const written = await pendingComment(trx, contentId, commentId);
            if (written && written.put?.held !== false) throw gone();
            await insertPending(trx, { contentId, key: likeKey(commentId, user.id), kind: 'comment_like', commentId, payload: { userId: user.id }, at: now() });
          });
        } catch (err) {
          // The same user's other request committed the like first: its row has the key this one asked for.
          if (!isUniqueViolation(err)) throw err;
          already = true;
        }
      }
      // The likes the store has and the ones that wait to be made there, this one among them: each
      // once, also when the compactor is making them as they are counted.
      const likes = await comments.likesWith(contentId, commentId, () => pendingLikes(db, contentId, commentId));
      return reply.status(already ? 200 : 201).send({ contentId, commentId, likes, alreadyLiked: already });
    }

    let alreadyLiked = false;
    try {
      await db.transaction().execute(async (trx) => {
        // Published content only: what is set for deletion, waits in the moderation queue, or is hidden because its original is gone, isn't there to like.
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
        if (
          await trx
            .selectFrom('likes')
            .select('user_id')
            .where('user_id', '=', user.id)
            .where('content_id', '=', contentId)
            .executeTakeFirst()
        ) {
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
