import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/apiKey.js';
import { MAX_COMMENT_CHARS, newCommentId, removeComment, toCommentRecord, toCommentRecords } from '../comments.js';
import { loadContent, loadPublished, loadReadable, readsHeld, requireMeta, takesComments } from '../content.js';
import type { AppDeps, RouteDeps } from '../deps.js';
import { forbidden, notFound, tooManyRequests } from '../http/errors.js';
import { Credentials } from '../http/schemas.js';
import { notify } from '../inbox.js';
import { msg } from '../language.js';
import { moderateComment, moderatesServer } from '../moderation/policy.js';
import type { Comment } from '../storage/index.js';

const Params = z.object({ contentId: z.string().uuid() });
const CommentParams = z.object({ contentId: z.string().uuid(), commentId: z.string().uuid() });
/** A page of a post's comments: from the first sent or from the last, after the comment the page before ended on. */
const PageQuery = z.object({
  order: z.enum(['oldest', 'newest']).default('oldest'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** The `nextCursor` of the page before, which is the id of its last comment. */
  cursor: z.string().uuid().optional(),
});
const CommentBody = Credentials.extend({ text: z.string().trim().min(1).max(MAX_COMMENT_CHARS) });

/** What a comment that waits in the moderation queue carries, as a post that waits there does. */
const PENDING_REVIEW = { status: 'pending_review' } as const;

export const commentNotFound = () => notFound(msg('comment.not_found'));

/**
 * Reading a post's comments (see comments.ts for what they are). Whoever may read the post may read
 * them: anyone, for a published post. They are read from Redis and the content store, and the
 * database only says that the post is there, as it does for GET /content/:contentId.
 *
 * A post whose publisher didn't turn comments on, or turned them off, has none to read: 404, as for
 * a post that isn't there, though in other words. The comments it had are kept, and are back when
 * comments are turned on again.
 */
export function commentReadRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, content, comments } = deps;

  /** The post, for whoever may read it, if it takes comments. */
  async function commented(req: FastifyRequest, contentId: string) {
    const row = await loadReadable(db, req, contentId);
    if (!takesComments(await requireMeta(content, contentId))) throw notFound(msg('comment.off'));
    return row;
  }

  /**
   * A post's comments, a page at a time, oldest first unless `order=newest`, with how many it has
   * in all. A comment that waits in the moderation queue is in neither.
   */
  app.get('/content/:contentId/comments', async (req) => {
    const { contentId } = Params.parse(req.params);
    const query = PageQuery.parse(req.query);
    await commented(req, contentId);
    const [page, count] = await Promise.all([comments.page(contentId, query), comments.count(contentId)]);
    return { contentId, count, comments: await toCommentRecords(deps, page.comments), nextCursor: page.nextCursor };
  });

  /**
   * One comment. `status: "pending_review"` on one that waits in the moderation queue, which only
   * its author and those who decide on it there (server moderators and admins) can read, by the
   * credentials in the request's headers: to anyone else it is 404, like a comment that isn't there.
   */
  app.get('/content/:contentId/comments/:commentId', async (req) => {
    const { contentId, commentId } = CommentParams.parse(req.params);
    await commented(req, contentId);
    const published = await comments.get(contentId, commentId);
    if (published) return (await toCommentRecords(deps, [published]))[0];
    const held = await comments.getHeld(contentId, commentId);
    if (!held || !(await readsHeld(db, req, held.userId))) throw commentNotFound();
    return { ...(await toCommentRecords(deps, [held]))[0], ...PENDING_REVIEW };
  });
}

/**
 * Writing comments: any user comments on a published post that takes comments, and a comment is
 * deleted by its author, by the post's publisher, or by an admin. A comment is never edited.
 *
 * A comment goes through the gate a post does (see moderateComment): its trust score has it
 * refused, held in the moderation queue for a server moderator or an admin, or published. Only a
 * held comment touches the database, for its row in the queue; a published one is an object in the
 * content store and an id in Redis.
 */
export function commentWriteRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { db, config, content, comments, hot, trustPlugins, now = Date.now } = deps;

  /** Counts a comment a user sends, and refuses it past the comments a user can send in a minute. */
  async function count(userId: string): Promise<void> {
    const { perMinute } = config.comments;
    if (perMinute <= 0) return;
    const { count, ttlMs } = await hot.incr(`comments:${userId}`, 60_000);
    const seconds = Math.max(1, Math.ceil(ttlMs / 1000));
    if (count > perMinute) throw tooManyRequests(msg('comment.rate_limited', { count: seconds }), seconds);
  }

  /**
   * Comments on a post: 201 with the comment, or 202 with `status: "pending_review"` for one that
   * waits in the moderation queue, which nobody but its author and the queue's moderators reads
   * until it is accepted. 422 for one the server doesn't trust enough to keep.
   *
   * A user sends at most `comments.perMinute` a minute, counted in Redis as messages are, and only
   * the comments that got through the gate count.
   */
  app.post('/content/:contentId/comments', async (req, reply) => {
    const { contentId } = Params.parse(req.params);
    const body = CommentBody.parse(req.body ?? {});
    const user = await authenticate(db, req, body);
    // Published content only: what is set for deletion, or waits in the moderation queue, isn't there to comment on.
    await loadPublished(db, contentId);
    if (!takesComments(await requireMeta(content, contentId))) throw notFound(msg('comment.off'));

    const { route, trustScore } = await moderateComment({ db, config, trustPlugins, now }, { userId: user.id, contentId, text: body.text });
    await count(user.id);

    const createdAt = now();
    const comment: Comment = { commentId: newCommentId(createdAt), contentId, userId: user.id, text: body.text, createdAt };
    const record = toCommentRecord(comment, { userId: user.id, username: user.username });
    if (route === 'allow') {
      await comments.put(comment);
      return reply.status(201).send(record);
    }
    // The comment first, then its row: the queue never lists a comment the store doesn't have.
    await comments.put(comment, { held: true });
    try {
      await db.insertInto('comment_queue').values({ comment_id: comment.commentId, content_id: contentId, trust_score: trustScore, created_at: createdAt }).execute();
    } catch (err) {
      await comments.remove(contentId, comment.commentId).catch((cause) => req.log.warn({ err: cause, contentId, commentId: comment.commentId }, 'could not remove a held comment that has no row in the queue'));
      // The post was deleted meanwhile, which is why it takes no row: 404, as for a post that isn't there.
      await loadPublished(db, contentId);
      throw err;
    }
    return reply.status(202).send({ ...record, ...PENDING_REVIEW });
  });

  /**
   * Deletes a comment, for good: its author, the publisher of the post it is on, or an admin. One
   * that waits in the moderation queue is 404 to those who can't read it, the post's publisher
   * among them, and is its author's or an admin's to delete: a server moderator rejects it there.
   * Its author is told, unless they deleted it themselves.
   *
   * It works whether or not the post takes comments now: what was written while it did is still
   * its author's, and the publisher's, to delete.
   */
  app.delete('/content/:contentId/comments/:commentId', async (req) => {
    const { contentId, commentId } = CommentParams.parse(req.params);
    const user = await authenticate(db, req, Credentials.parse(req.body ?? {}));
    const post = await loadContent(db, contentId);
    const published = await comments.get(contentId, commentId);
    const comment = published ?? (await comments.getHeld(contentId, commentId));
    const own = comment?.userId === user.id;
    // A held comment is there only for those who can read it.
    if (!comment || (!published && !own && !moderatesServer(user))) throw commentNotFound();
    const onOwnPost = published !== null && post.user_id === user.id;
    if (!own && !user.admin && !onOwnPost) throw forbidden(msg('comment.delete_not_allowed'));
    await removeComment(deps, contentId, commentId);
    req.log.info({ contentId, commentId, by: user.id }, 'deleted a comment');
    await notify(deps, { userId: comment.userId, kind: 'comment_deleted', contentId, comment: comment.text, by: user.id }, req.log);
    return { contentId, commentId, status: 'deleted' };
  });
}
