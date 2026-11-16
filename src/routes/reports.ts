import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, type AuthUser } from '../auth/apiKey.js';
import { removeComment } from '../comments.js';
import { loadContent, loadPublished, requireMeta, takesComments } from '../content.js';
import { addOnce } from '../db/index.js';
import { setForDeletion } from '../deletion.js';
import type { AppDeps } from '../deps.js';
import { forbidden, notFound, tooManyRequests } from '../http/errors.js';
import { listPage, listQuery } from '../http/listCursor.js';
import { Credentials, ListQuery } from '../http/schemas.js';
import { notify } from '../inbox.js';
import { msg } from '../language.js';
import { moderatesServer } from '../moderation/policy.js';
import { kindColumn, queueItems } from '../moderation/queues.js';
import { HOUR, iso } from '../time.js';

/** The longest reason a report can give, which is what `reports.reason` holds. */
export const MAX_REASON_CHARS = 500;

const ReportBody = Credentials.extend({
  contentId: z.string().uuid(),
  /** To report a comment on the post rather than the post. */
  commentId: z.string().uuid().optional(),
  reason: z.string().trim().max(MAX_REASON_CHARS).optional(),
});
const ContentParams = z.object({ contentId: z.string().uuid() });
const CommentParams = z.object({ contentId: z.string().uuid(), commentId: z.string().uuid() });
/** A page of the report queue: smaller than other lists', as each post's meta file, or each comment, is read for it. */
const QueueQuery = ListQuery.extend({ limit: z.coerce.number().int().min(1).max(100).default(50) });

const notReported = () => notFound(msg('report.not_reported'));
const commentNotReported = () => notFound(msg('comment.not_reported'));

/**
 * Reports: any user reports a published post to the server's moderators, once, with a reason if
 * they have one, and a comment on one likewise. A post or a comment with a report nobody has
 * decided on is in the report queue, which server moderators and admins work through: they accept
 * it, which settles its reports and leaves it as it is, or delete it. What is reported stays
 * published while it waits, and whoever wrote it isn't told of the reports.
 *
 * The queue is the `reports` rows with no `accepted_at`, by content, and the `comment_reports` rows
 * with none, by comment: nothing else records that a post or a comment is in it, so a report made
 * while one is being accepted puts it back in the queue, and is never lost.
 */
export function reportRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, config, content, comments, hot, now = Date.now } = deps;

  /** For the report queue: a server moderator, or an admin. */
  async function asServerModerator(req: FastifyRequest): Promise<AuthUser> {
    const user = await authenticate(db, req, Credentials.parse(req.body ?? {}));
    if (!moderatesServer(user)) throw forbidden(msg('moderation.server_moderator_only'));
    return user;
  }

  /** Counts a report a user makes, of a post or of a comment, and refuses it past the reports a user can make in an hour. */
  async function count(userId: string): Promise<void> {
    if (config.reportsPerHour <= 0) return;
    const { count, ttlMs } = await hot.incr(`reports:${userId}`, HOUR);
    if (count > config.reportsPerHour) {
      throw tooManyRequests(msg('report.rate_limited', { count: Math.max(1, Math.ceil(ttlMs / 60_000)) }), Math.max(1, Math.ceil(ttlMs / 1000)));
    }
  }

  /** The content's reports that nobody has decided on. */
  const waiting = (contentId: string) => db.selectFrom('reports').where('content_id', '=', contentId).where('accepted_at', 'is', null);

  /** The comment's reports that nobody has decided on. */
  const waitingOnComment = (contentId: string, commentId: string) =>
    db.selectFrom('comment_reports').where('comment_id', '=', commentId).where('content_id', '=', contentId).where('accepted_at', 'is', null);

  /**
   * Reports a post, or with `commentId`, a comment on it. Each user reports a post once, and a
   * comment once: reporting it again changes nothing, whatever the reason given then, and whether
   * or not it was accepted since.
   */
  app.post('/report', async (req, reply) => {
    const body = ReportBody.parse(req.body ?? {});
    const user = await authenticate(db, req, body);
    const { contentId, commentId } = body;
    // Published content only: what is set for deletion, or waits in the moderation queue, isn't there to report.
    await loadPublished(db, contentId);
    if (commentId === undefined) {
      const { at, already } = await addOnce(
        now,
        () => db.selectFrom('reports').select('created_at').where('content_id', '=', contentId).where('user_id', '=', user.id).executeTakeFirst(),
        async (createdAt) => {
          // Only a report that is made counts towards the limit: one sent again costs nothing.
          await count(user.id);
          await db
            .insertInto('reports')
            .values({ content_id: contentId, user_id: user.id, reason: body.reason || null, created_at: createdAt, accepted_at: null })
            .execute();
        },
      );
      return reply.status(already ? 200 : 201).send({ contentId, reportedAt: iso(at), alreadyReported: already });
    }
    // A comment anyone can read: one of a post that takes comments, and not one that waits in the moderation queue.
    if (!takesComments(await requireMeta(content, contentId))) throw notFound(msg('comment.off'));
    if (!(await comments.get(contentId, commentId))) throw notFound(msg('comment.not_found'));
    const { at, already } = await addOnce(
      now,
      () => db.selectFrom('comment_reports').select('created_at').where('comment_id', '=', commentId).where('user_id', '=', user.id).executeTakeFirst(),
      async (createdAt) => {
        await count(user.id);
        await db
          .insertInto('comment_reports')
          .values({ comment_id: commentId, user_id: user.id, content_id: contentId, reason: body.reason || null, created_at: createdAt, accepted_at: null })
          .execute();
      },
    );
    return reply.status(already ? 200 : 201).send({ contentId, commentId, reportedAt: iso(at), alreadyReported: already });
  });

  /**
   * The report queue: the posts and the comments with reports nobody has decided on, in one list,
   * longest reported first, a page at a time. `kind` says which each is: a post is a feed record
   * with its whole text or caption, a comment is as GET /content/:contentId/comments gives it. Each
   * has how many such reports it has and since when. Server moderators and admins.
   */
  app.get('/moderation/reports', async (req) => {
    const page = listQuery(req.query, QueueQuery);
    await asServerModerator(req);
    const posts = db
      .selectFrom('reports')
      .select((eb) => [kindColumn('post'), 'content_id as id', 'content_id', eb.fn.countAll<number>().as('reports'), eb.fn.min('created_at').as('created_at')])
      .where('accepted_at', 'is', null)
      .groupBy('content_id');
    const commented = db
      .selectFrom('comment_reports')
      .select((eb) => [kindColumn('comment'), 'comment_id as id', 'content_id', eb.fn.countAll<number>().as('reports'), eb.fn.min('created_at').as('created_at')])
      .where('accepted_at', 'is', null)
      .groupBy(['comment_id', 'content_id']);
    const query = db
      .selectFrom(posts.unionAll(commented).as('reported'))
      .innerJoin('content', 'content.id', 'reported.content_id')
      .select(['reported.kind', 'reported.id', 'reported.content_id', 'reported.reports', 'reported.created_at'])
      // Content set for deletion (here, or by its publisher) is gone, though its row and its reports are still there. So are its comments.
      .where('content.delete_requested_at', 'is', null);
    const { rows, nextCursor } = await listPage(query, { createdAt: 'reported.created_at', userId: 'reported.id' }, page, 'oldest');
    const items = await queueItems(deps, rows, { held: false });
    const queue = rows.flatMap((r, i) => {
      const item = items[i];
      return item ? [{ ...item, reports: Number(r.reports), reportedAt: iso(r.created_at) }] : [];
    });
    return { queue, nextCursor };
  });

  /**
   * A post's reports that nobody has decided on, most recent first, a page at a time: who made each,
   * when, and the reason they gave. Server moderators and admins.
   */
  app.get('/moderation/reports/:contentId', async (req) => {
    const { contentId } = ContentParams.parse(req.params);
    const page = listQuery(req.query);
    await asServerModerator(req);
    await loadContent(db, contentId);
    const query = waiting(contentId)
      .innerJoin('users', 'users.id', 'reports.user_id')
      .select(['users.id', 'users.username', 'reports.reason', 'reports.created_at']);
    const { rows, nextCursor } = await listPage(query, { createdAt: 'reports.created_at', userId: 'reports.user_id' }, page);
    return {
      contentId,
      reports: rows.map((r) => ({ userId: r.id, username: r.username, ...(r.reason !== null && { reason: r.reason }), reportedAt: iso(r.created_at) })),
      nextCursor,
    };
  });

  /**
   * Accepts a reported post: it stays as it is, and the reports it had are settled, which takes it
   * out of the report queue. The users who made them can't report it again; a report by anyone else
   * puts it back. Server moderators and admins.
   */
  app.post('/moderation/reports/:contentId/accept', async (req) => {
    const { contentId } = ContentParams.parse(req.params);
    const moderator = await asServerModerator(req);
    await loadContent(db, contentId);
    const res = await db.updateTable('reports').set({ accepted_at: now() }).where('content_id', '=', contentId).where('accepted_at', 'is', null).executeTakeFirst();
    const reports = Number(res.numUpdatedRows);
    if (reports === 0) throw notReported();
    req.log.info({ contentId, moderator: moderator.id, reports }, 'accepted from the report queue');
    return { contentId, status: 'accepted', reports };
  });

  /**
   * Deletes a reported post: it is set for deletion (see setForDeletion), and its reports go with
   * it. Server moderators and admins. Only what is in the report queue: any other published content
   * is its publisher's or an admin's to delete.
   */
  app.post('/moderation/reports/:contentId/delete', async (req, reply) => {
    const { contentId } = ContentParams.parse(req.params);
    const moderator = await asServerModerator(req);
    const row = await loadContent(db, contentId);
    if (!(await waiting(contentId).select('user_id').limit(1).executeTakeFirst())) throw notReported();
    const requestedAt = await setForDeletion(deps, row);
    req.log.info({ contentId, moderator: moderator.id }, 'deleted from the report queue');
    return reply.status(202).send({ contentId, status: 'pending_deletion', requestedAt: iso(requestedAt) });
  });

  // The same three for a reported comment.

  /**
   * A comment's reports that nobody has decided on, most recent first, a page at a time: who made
   * each, when, and the reason they gave. Server moderators and admins.
   */
  app.get('/moderation/reports/:contentId/comments/:commentId', async (req) => {
    const { contentId, commentId } = CommentParams.parse(req.params);
    const page = listQuery(req.query);
    await asServerModerator(req);
    await loadContent(db, contentId);
    const query = waitingOnComment(contentId, commentId)
      .innerJoin('users', 'users.id', 'comment_reports.user_id')
      .select(['users.id', 'users.username', 'comment_reports.reason', 'comment_reports.created_at']);
    const { rows, nextCursor } = await listPage(query, { createdAt: 'comment_reports.created_at', userId: 'comment_reports.user_id' }, page);
    return {
      contentId,
      commentId,
      reports: rows.map((r) => ({ userId: r.id, username: r.username, ...(r.reason !== null && { reason: r.reason }), reportedAt: iso(r.created_at) })),
      nextCursor,
    };
  });

  /**
   * Accepts a reported comment: it stays as it is, and the reports it had are settled, which takes
   * it out of the report queue. The users who made them can't report it again; a report by anyone
   * else puts it back. Server moderators and admins.
   */
  app.post('/moderation/reports/:contentId/comments/:commentId/accept', async (req) => {
    const { contentId, commentId } = CommentParams.parse(req.params);
    const moderator = await asServerModerator(req);
    await loadContent(db, contentId);
    const res = await db
      .updateTable('comment_reports')
      .set({ accepted_at: now() })
      .where('comment_id', '=', commentId)
      .where('content_id', '=', contentId)
      .where('accepted_at', 'is', null)
      .executeTakeFirst();
    const reports = Number(res.numUpdatedRows);
    if (reports === 0) throw commentNotReported();
    req.log.info({ contentId, commentId, moderator: moderator.id, reports }, 'accepted a comment from the report queue');
    return { contentId, commentId, status: 'accepted', reports };
  });

  /**
   * Deletes a reported comment, at once and for good, and its reports with it. Server moderators
   * and admins. Only what is in the report queue: any other comment is its author's, the post's
   * publisher's or an admin's to delete. Its author is told.
   */
  app.post('/moderation/reports/:contentId/comments/:commentId/delete', async (req) => {
    const { contentId, commentId } = CommentParams.parse(req.params);
    const moderator = await asServerModerator(req);
    await loadContent(db, contentId);
    if (!(await waitingOnComment(contentId, commentId).select('user_id').limit(1).executeTakeFirst())) throw commentNotReported();
    // Read before it is removed, for the notice that quotes it.
    const comment = await comments.get(contentId, commentId);
    await removeComment(deps, contentId, commentId);
    req.log.info({ contentId, commentId, moderator: moderator.id }, 'deleted a comment from the report queue');
    if (comment) await notify(deps, { userId: comment.userId, kind: 'comment_deleted', contentId, comment: comment.text, by: moderator.id }, req.log);
    return { contentId, commentId, status: 'deleted' };
  });
}
