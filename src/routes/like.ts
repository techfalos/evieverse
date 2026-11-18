import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { authenticate } from '../auth/apiKey.js';
import { contentNotFound, loadContent, loadPublished, requireMeta, takesComments, withheld } from '../content.js';
import { isUniqueViolation } from '../db/index.js';
import type { AppDeps } from '../deps.types.js';
import { notFound } from '../http/errors.js';
import { Credentials } from '../http/schemas.js';
import { msg } from '../language.js';
import { refuseBanned } from '../moderation/policy.js';
import { effectiveComment, flipLike, insertLike, pendingComment, pendingLike, pendingLikes, writeUnnumbered } from '../pending.js';

/** The body of POST /like and of DELETE /like: who's asking, and the post, or the post and the comment on it, to like or to stop liking. */
const Body = Credentials.extend({
  contentId: z.string().uuid(),
  /** For a comment on the post rather than the post. */
  commentId: z.string().uuid().optional(),
});

/**
 * How many times a like of a comment, or its taking back, is tried before the request fails. It
 * is tried again when the user's row for the comment changed under it: their other request
 * added one first, or the compactor applied the one that was there. Once is nearly always all.
 */
const LIKE_ATTEMPTS = 4;

/** Likes, of posts and of comments on them: POST /like gives one, and DELETE /like takes it back. */
export function likeRoutes(app: FastifyInstance, { db, config, content, comments, now = Date.now }: AppDeps) {
  const { dialect } = config.db;
  const commentGone = () => notFound(msg('comment.not_found'));

  /**
   * Makes a user's like of a comment what they ask for: there (`liked`), or taken back. Returns
   * whether that changed anything: false if the user liked the comment already, or didn't.
   *
   * What the user's like is, is what the row of it that waits for the compactor says, or with
   * no row, what the content store has (the row first, then the store: the compactor applies a
   * row there before it deletes it). To change it, a user with no row gets one, and one with a
   * row has it say the other thing (see insertLike, flipLike): a user has one row for a comment,
   * and the compactor applies what it last said.
   *
   * Neither takes a number or a lock on the post (see writeUnnumbered): the likes of one
   * comment, and of one post's comments, commit side by side. A like that commits as its
   * comment is deleted, or as an edit takes the comment back to the moderation queue, is
   * refused (404), and so is the taking back of a like of a comment that is deleted.
   */
  async function setCommentLike(contentId: string, commentId: string, userId: string, liked: boolean): Promise<boolean> {
    const of = { postId: contentId, commentId, userId, liked };
    for (let attempt = 1; ; attempt++) {
      const waiting = await pendingLike(db, contentId, commentId, userId);
      if ((waiting ? waiting.liked : await comments.liked(contentId, commentId, userId)) === liked) return false;
      try {
        const outcome = await writeUnnumbered(db, dialect, contentId, {}, async (trx) => {
          // Deleted, or for a like, taken back to the queue, by a write that committed while this was under way.
          const written = await pendingComment(trx, contentId, commentId);
          if (written && (liked ? written.put?.held !== false : written.put === null)) throw commentGone();
          if (waiting) return flipLike(trx, dialect, of);
          await insertLike(trx, { ...of, at: now() });
          return 'made' as const;
        });
        // The user's other request had the row say it first.
        if (outcome === 'same') return false;
        if (outcome !== 'gone') return true;
        // Gone: the compactor applied the row that was there, so the store now says what the like is.
      } catch (err) {
        // The user's other request added a row first, which has the key this one asked for.
        if (!isUniqueViolation(err)) throw err;
      }
      if (attempt === LIKE_ATTEMPTS) throw new Error(`the like of comment ${commentId} by user ${userId} kept changing while it was being set`);
    }
  }

  /**
   * How many likes the comment has: the ones the store has with what waits to be applied there,
   * likes and their taking back, each once, also when the compactor is applying them as they
   * are counted.
   */
  const commentLikes = (contentId: string, commentId: string) => comments.likesWith(contentId, commentId, () => pendingLikes(db, contentId, commentId));

  /**
   * Likes a post, or with `commentId`, a comment on it. A like is idempotent: liking twice
   * succeeds without double-counting. It stays until the user takes it back (DELETE /like).
   *
   * A post's likes are rows in the database, and its count a column of the post's. A comment's are
   * in the content store, as comments are, where the compactor makes them (see CommentStore.addLike):
   * the request commits the like as a write of the comment's post (`pending_writes`), with the
   * user and the comment as its key, so a user's like is there once (see setCommentLike). A like
   * of a comment that was deleted, or of one under a post that is set for deletion, is refused
   * (404), and one that commits as either happens is never made: the compactor applies a
   * comment's removal last of its writes, and nothing of a post that is set for deletion. The
   * count it answers with has the likes that wait to be made; a comment read before the
   * compactor's next run has only the ones that were.
   *
   * A banned user is refused (403) either like, before anything is looked up: one they made before
   * the ban stays, and is answered the same way. They can still take it back.
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
      if ((await effectiveComment(db, comments, contentId, commentId))?.held !== false) throw commentGone();
      const made = await setCommentLike(contentId, commentId, user.id, true);
      return reply.status(made ? 201 : 200).send({ contentId, commentId, likes: await commentLikes(contentId, commentId), alreadyLiked: !made });
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

  /**
   * Takes back the user's like of a post, or with `commentId`, of a comment on it. Idempotent:
   * taking back a like that isn't there changes nothing, and says so (`wasLiked`). The user can
   * like the same thing again afterwards.
   *
   * It names what POST /like names, in a JSON body, or with `contentId` and `commentId` as query
   * parameters, for a client that sends no body with a DELETE: the credentials are then in the
   * headers.
   *
   * A post's like is its row, which is deleted, with one off the post's count. The post's row is
   * locked first, so the count is taken from once however many requests ask. The post is marked
   * as having lost a like (`unliked_at`), which is how the compactor's next run finds it and
   * writes its entries in the feed indexes with the count as it now is: until then feeds show the
   * count they had. Where a repost placed the post as a new one, the entry counts the likes
   * since the repost, from the count the post had then (`reposts.likes_before`): a like from
   * before the repost that is taken back comes off that too, so the entry's count stays what it
   * was. (By the times of the two: a like made within the second of the repost may be taken for
   * one made after it, and the entry's count is then one off.)
   *
   * A comment's like is made in the content store by the compactor, and taken back there by it
   * too (see CommentStore.removeLike): the request commits what the user asked for as a write of
   * the comment's post, as a like does (see setCommentLike). The count it answers with is without
   * the like; a comment read before the compactor's next run still has it.
   *
   * What a like can be taken back from is what it could be given to, and more: a like stays the
   * user's to take back while the post is withheld from readers (it waits in the moderation
   * queue, or its original is gone from its own server), once the post takes no comments any
   * more, and while the comment waits in the moderation queue after an edit. To anyone who has
   * no like there, those are 404, as they are to POST /like, so the answer tells nobody what is
   * withheld. Content that is set for deletion is 404 to all: its likes go with it. So is a
   * comment that was deleted.
   *
   * A banned user isn't refused: the ban is on what adds to the server, and this takes away
   * what is the user's own.
   */
  app.delete('/like', async (req) => {
    const { contentId: queryContentId, commentId: queryCommentId } = (req.query ?? {}) as Record<string, unknown>;
    const body = Body.parse({ contentId: queryContentId, commentId: queryCommentId, ...(typeof req.body === 'object' && req.body !== null ? req.body : {}) });
    const user = await authenticate(db, req, body);
    const { contentId, commentId } = body;

    if (commentId !== undefined) {
      const post = await loadContent(db, contentId);
      const hidden = post.queued || post.gone;
      const off = !hidden && !takesComments(await requireMeta({ db, content }, contentId));
      const comment = await effectiveComment(db, comments, contentId, commentId);
      // What POST /like would refuse a like of this comment with, if it would.
      const refusal = hidden ? contentNotFound() : off ? notFound(msg('comment.off')) : comment?.held !== false ? commentGone() : null;
      if (refusal) {
        // Still the user's to take back, if they have a like there and the comment isn't deleted: to anyone else it isn't there.
        const mine = (await pendingLike(db, contentId, commentId, user.id))?.liked ?? (await comments.liked(contentId, commentId, user.id));
        if (!comment || !mine) throw refusal;
      }
      const wasLiked = await setCommentLike(contentId, commentId, user.id, false);
      return { contentId, commentId, likes: await commentLikes(contentId, commentId), wasLiked };
    }

    const mine = (from: typeof db) => from.selectFrom('likes').select('created_at').where('user_id', '=', user.id).where('content_id', '=', contentId).executeTakeFirst();
    const post = await db
      .selectFrom('content')
      .leftJoin('moderation_queue', 'moderation_queue.content_id', 'content.id')
      .select(['content.id', 'content.origin_gone_at', 'moderation_queue.content_id as queued_id'])
      .where('content.id', '=', contentId)
      .where('content.delete_requested_at', 'is', null)
      .executeTakeFirst();
    const liked = await mine(db);
    // Not there, or set for deletion; or withheld, which is 404 to whoever has no like of it to take back.
    if (!post || (withheld(post) && !liked)) throw contentNotFound();

    let wasLiked = false;
    // A like that isn't there takes no lock, and changes nothing.
    if (liked) await db.transaction().execute(async (trx) => {
      // The transaction starts with the lock on the post's row, as a repost locks it: the unlikes of a post take
      // turns, and each takes one from a count no other is changing. It reads nothing before it, so that what it
      // reads is what the request that had the lock before it left (MySQL reads as of a transaction's first read).
      // SQLite runs one transaction at a time, and has no rows to lock.
      const row = trx.selectFrom('content').select('id').where('id', '=', contentId).where('delete_requested_at', 'is', null);
      const locked = await (dialect === 'sqlite' ? row : dialect === 'postgres' ? row.forNoKeyUpdate() : row.forUpdate()).executeTakeFirst();
      if (!locked) throw contentNotFound();
      // Read again, now that no other request of the user's can take it back: it says when the like was made.
      const like = await mine(trx);
      if (!like) return;
      const { numDeletedRows } = await trx.deleteFrom('likes').where('user_id', '=', user.id).where('content_id', '=', contentId).executeTakeFirst();
      // Taken back by the user's other request after all: the count is taken from for a row that this one deleted, and no other.
      if (Number(numDeletedRows) !== 1) return;
      await trx
        .updateTable('content')
        .set({ like_count: sql`case when like_count > 0 then like_count - 1 else 0 end`, unliked_at: now() })
        .where('id', '=', contentId)
        .execute();
      // Where a repost placed the post since the like was made, the like is among those the entry doesn't count.
      await trx
        .updateTable('reposts')
        .set({ likes_before: sql`likes_before - 1` })
        .where('content_id', '=', contentId)
        .where('created_at', '>', like.created_at)
        .where('likes_before', '>', 0)
        .execute();
      wasLiked = true;
    });

    const { like_count } = await db
      .selectFrom('content')
      .select('like_count')
      .where('id', '=', contentId)
      .executeTakeFirstOrThrow();
    return { contentId, likes: like_count, wasLiked };
  });
}
