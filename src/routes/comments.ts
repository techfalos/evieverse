import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import { authenticate } from '../auth/apiKey.js';
import { ChallengeFields } from '../challenge/challenges.js';
import { MAX_COMMENT_CHARS, newCommentId, removeComment, toCommentRecord, toCommentRecords } from '../comments.js';
import { loadContent, loadPublished, loadReadable, PENDING_REVIEW, readsHeld, requireMeta, takesComments } from '../content.js';
import { updateOnConflict } from '../db/index.js';
import type { Database } from '../db/schema.js';
import type { AppDeps, RouteDeps } from '../deps.types.js';
import { badRequest, forbidden, notFound } from '../http/errors.js';
import { Credentials } from '../http/schemas.js';
import { notify } from '../inbox.js';
import { msg } from '../language.js';
import { moderateComment, moderatesServer, refuseBanned } from '../moderation/policy.js';
import { effectiveComment, insertPending, pendingComment, pendingCommentFile, writePending, type PendingReader } from '../pending.js';
import { commentPlaceholder, type Comment, type CommentMedia } from '../storage/index.js';
import { readCommentFile, readMultipart, readUploaded } from '../upload.js';
import type { CommentFile, Upload } from '../upload.types.js';
import { sendBytes } from './content.js';

/** The path of a post's comments: the post's id. */
const Params = z.object({ contentId: z.string().uuid() });
/** The path of one comment: the id of the post it is on, and its own. */
const CommentParams = z.object({ contentId: z.string().uuid(), commentId: z.string().uuid() });
/** A page of a post's comments, or of the replies to one: from the first sent or from the last, after the comment the page before ended on. */
const PageQuery = z.object({
  order: z.enum(['oldest', 'newest']).default('oldest'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** The `nextCursor` of the page before, which is the id of its last comment. */
  cursor: z.string().uuid().optional(),
});
/**
 * A comment's text, without the spaces around it: MAX_COMMENT_CHARS characters at most, and none
 * at least, as a comment that has an image or a video needs no text. The routes refuse an empty one
 * where there is no file.
 */
const Text = z.string().trim().max(MAX_COMMENT_CHARS);
/**
 * The body of POST /content/:contentId/comments, as JSON or as the fields of a multipart form:
 * who's asking, what the comment says and which comment it replies to, the image or video it comes
 * with, and the solution of a challenge.
 */
const CommentBody = Credentials.extend({
  /** What it says. A comment that comes with an image or a video needs none. */
  text: Text.optional(),
  /** The comment, on the same post, that this one replies to. Left out: it is a comment on the post itself. */
  parentId: z.string().uuid().optional(),
  // The image or video it comes with, sent as a post's file is (routes/store.ts).
  contentType: z.string().max(255).optional(),
  filename: z.string().max(512).optional(),
  /** The file, inline for JSON requests (or a plain multipart text field). */
  content: z.string().optional(),
  /** The file, already sent to the link POST /uploads gave: the id it came with. */
  uploadId: z.string().uuid().optional(),
  contentEncoding: z.enum(['utf8', 'base64']).default('utf8'),
  ...ChallengeFields,
});
/** An edit's text, which may be empty for a comment that has an image or a video. */
const EditBody = Credentials.extend({ text: Text, ...ChallengeFields });

/** The 404 for a comment that isn't there, which a comment its reader may not read is answered with too. It is returned, not thrown. */
const commentNotFound = () => notFound(msg('comment.not_found'));

/**
 * Reading a post's comments (see comments.ts for what they are). Whoever may read the post may read
 * them: anyone, for a published post. They are read from Redis and the content store, and the
 * database says that the post is there, as it does for GET /content/:contentId, and what was
 * written to a comment that the compactor has yet to write there (`pending_writes`).
 *
 * A comment read by its id is read as its newest write left it, applied or not: one just sent is
 * there for its author to read, and one just deleted is gone. The lists and the counts are the
 * store's: they show a comment, an edit, a like and a deletion once the compactor has run.
 *
 * A post's comments are a tree: the comments on the post itself, and under each the comments that
 * reply to it. It is read a level at a time, each a list of its own with its own pages: the
 * comments on the post, then the replies to whichever of them the reader opens. Each comment says
 * how many replies it has (`replies`), so a reader knows which have any.
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
    if (!takesComments(await requireMeta({ db, content }, contentId))) throw notFound(msg('comment.off'));
    return row;
  }

  /**
   * One comment of the post, for whoever may read it, and whether it waits in the moderation
   * queue (`held`). One that does is read only by its author and by those who decide on it there
   * (server moderators and admins), by the credentials in the request's headers. Anyone else gets
   * what is in its place: the placeholder of a comment that was published before an edit took it
   * back to the queue, or 404, like a comment that isn't there, for one that never was published.
   * A deleted comment that has replies is its placeholder to everyone.
   *
   * A write of the comment that the compactor hasn't applied yet says what it is (see
   * effectiveComment), and the store what is in its place for those who may not read it. The
   * rows first, then the store: the compactor writes the store before it deletes a row.
   */
  async function readable(req: FastifyRequest, contentId: string, commentId: string): Promise<{ comment: Comment; held: boolean }> {
    const pending = await pendingComment(db, contentId, commentId);
    const found = await comments.find(contentId, commentId);
    if (pending) {
      const { put } = pending;
      // Deleted: what the compactor will leave of it, which is a placeholder if anything replies to it.
      if (!put) {
        if (!found || (await comments.count(contentId, commentId)) === 0) throw commentNotFound();
        return { comment: found.gone === 'deleted' ? found : commentPlaceholder(found, 'deleted'), held: false };
      }
      if (!put.held) return { comment: put.comment, held: false };
      if (await readsHeld(db, req, put.comment.userId)) return { comment: put.comment, held: true };
      // An edit that is held: the comment that was published is a placeholder to everyone else.
      if (!found) throw commentNotFound();
      return { comment: found.gone ? found : commentPlaceholder(found, 'held'), held: false };
    }
    if (found && !found.gone) return { comment: found, held: false };
    const held = await comments.getHeld(contentId, commentId);
    if (held && (await readsHeld(db, req, held.userId))) return { comment: held, held: true };
    if (!found) throw commentNotFound();
    return { comment: found, held: false };
  }

  /**
   * The comments on a post itself, a page at a time, oldest first unless `order=newest`, with how
   * many comments the post has in all, replies included. A comment that waits in the moderation
   * queue is in neither, unless it was published before: an edit that is held leaves a placeholder
   * in its place, as deleting a comment that has replies does (see comments.ts). A placeholder is
   * listed, and counted, as the comment it stands for.
   */
  app.get('/content/:contentId/comments', async (req) => {
    const { contentId } = Params.parse(req.params);
    const query = PageQuery.parse(req.query);
    await commented(req, contentId);
    const [page, count] = await Promise.all([comments.page(contentId, query), comments.count(contentId)]);
    return { contentId, count, comments: await toCommentRecords(deps, page.comments), nextCursor: page.nextCursor };
  });

  /**
   * The replies to a comment, a page at a time, as the comments on a post are read, with how many
   * replies the comment has: to it, not to its replies, each of which is asked for its own. The
   * replies to a comment that was deleted, or that an edit took back to the moderation queue, are
   * read as any others are. 404 for a comment that isn't there, or was never published.
   */
  app.get('/content/:contentId/comments/:commentId/replies', async (req) => {
    const { contentId, commentId } = CommentParams.parse(req.params);
    const query = PageQuery.parse(req.query);
    await commented(req, contentId);
    if (!(await comments.find(contentId, commentId))) throw commentNotFound();
    const [page, count] = await Promise.all([comments.page(contentId, { ...query, parentId: commentId }), comments.count(contentId, commentId)]);
    return { contentId, commentId, count, comments: await toCommentRecords(deps, page.comments), nextCursor: page.nextCursor };
  });

  /**
   * One comment. `status: "pending_review"` on one that waits in the moderation queue, which only
   * its author and those who decide on it there can read (see `readable`); anyone else gets the
   * placeholder of one that was published before, which has that status too, and nothing of the
   * comment. `status: "deleted"` on the placeholder of a deleted comment that has replies.
   */
  app.get('/content/:contentId/comments/:commentId', async (req) => {
    const { contentId, commentId } = CommentParams.parse(req.params);
    await commented(req, contentId);
    const { comment, held } = await readable(req, contentId, commentId);
    const [record] = await toCommentRecords(deps, [comment]);
    return held ? { ...record, ...PENDING_REVIEW } : record;
  });

  /**
   * The bytes of the image or video a comment came with, served as a post's are at
   * /content/:contentId/raw: a redirect to the store where it can sign links, else streamed from
   * here as something to show and nothing more (see rawHeaders). Whoever may read the comment may
   * read them. 404 for a comment that is only text, and for a placeholder, which has no file.
   *
   * The file of a comment the compactor has yet to write is where its request staged it, and is
   * served from there; once the compactor has it where comments' files are kept, from there.
   */
  app.get('/content/:contentId/comments/:commentId/raw', { compress: false }, async (req, reply) => {
    const { contentId, commentId } = CommentParams.parse(req.params);
    await commented(req, contentId);
    const { comment } = await readable(req, contentId, commentId);
    if (comment.gone) throw commentNotFound();
    if (!comment.media) throw notFound(msg('comment.no_media'));
    const { mimeType } = comment.media;

    const staged = await pendingCommentFile(db, contentId, commentId);
    // Gone from there: the compactor applied the write meanwhile, and the file is the comment's own.
    if (staged !== null && (await sendBytes(reply, content, { staged }, () => mimeType, { staged: true }))) return reply;
    await sendBytes(reply, content, { postId: contentId, commentId }, () => mimeType);
    return reply;
  });
}

/**
 * Writing comments: any user comments on a published post that takes comments, or replies to a
 * comment on it; a comment's author edits it; and a comment is deleted by its author, by the
 * post's publisher, or by an admin. The comments that reply to it stay (see comments.ts).
 *
 * A comment goes through the gate a post does (see moderateComment), and so does an edit of one,
 * as an update of a post does: its trust score has it refused, held in the moderation queue for a
 * server moderator or an admin, or published.
 *
 * None of them writes the comment store. Each is one commit to the database: a row of
 * `pending_writes` under the comment's post, with the post's next write number, and with it the
 * comment's row in the moderation queue where it is held (see src/pending.ts). The compactor's
 * next run writes the comment store from the rows, a post's in the order they committed. So a
 * comment, an edit and a deletion of one never write over each other, and none is written under a
 * post that is set for deletion, which gives no number (404). Until the run, the comment is read
 * by its id as it was written (see commentReadRoutes), and is in no list.
 *
 * A comment, and an edit of one, is then limited as a post is, by the code that limits posts
 * (Challenges.admitting), with settings of its own. A user's first `challenge.commentsPerMinute`
 * in any minute go through as they are. Each one past them is answered with a challenge (428), or
 * two from the third such comment in a row, to be sent again with the solution. One past
 * `comments.perMinute` in any minute is refused outright (429), before any challenge. All of it
 * comes after the gate and before anything is stored, so a comment the gate refuses costs no
 * challenge and counts for nothing, and neither does one whose write fails.
 */
export function commentWriteRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { db, config, content, comments, challenges, trustPlugins, now = Date.now } = deps;

  /**
   * The published post, if it takes comments: what is set for deletion, or waits in the moderation
   * queue, isn't there to comment on. Its row is read before anything of its comments is, which
   * is what its write number is good for (see writePending).
   */
  async function commentable(contentId: string) {
    const post = await loadPublished(db, contentId);
    if (!takesComments(await requireMeta({ db, content }, contentId))) throw notFound(msg('comment.off'));
    return post;
  }

  /**
   * Puts a comment in the moderation queue with its trust score, or gives the row it has there the
   * score: a comment that was waiting keeps its place in the queue, as a post does. In the
   * transaction of the write that holds the comment, so the queue lists it if and only if it is held.
   */
  const queue = (trx: Transaction<Database>, { commentId, contentId }: Comment, trustScore: number, at: number) =>
    updateOnConflict(
      trx.insertInto('comment_queue').values({ comment_id: commentId, content_id: contentId, trust_score: trustScore, created_at: at }),
      config.db.dialect,
      'comment_id',
      { trust_score: trustScore },
    ).execute();

  /** The comment as it is with every write that has committed (see effectiveComment). */
  const current = (reader: PendingReader, contentId: string, commentId: string) => effectiveComment(reader, comments, contentId, commentId);

  /**
   * Comments on a post, or with `parentId`, replies to a comment on it, which must be published:
   * 201 with the comment, or 202 with `status: "pending_review"` for one that waits in the
   * moderation queue, which nobody but its author and the queue's moderators reads until it is
   * accepted. 422 for one the server doesn't trust enough to keep.
   *
   * A comment is a text, an image or a video, or a text with one of the two: it needs a text or a
   * file, and takes one file at most. The file comes as a post's does to /store: as a multipart
   * part, inline in `content`, or as an `uploadId` (see POST /uploads), and it is held to what an
   * image or a video post's file is (see readCommentFile). It is as large as a post's may be. A
   * server that has turned image or video posts off (POST_TYPE_IMAGE, POST_TYPE_VIDEO) takes no
   * file of that type with a comment either (400).
   *
   * A banned user is refused (403).
   *
   * 428 with a challenge for a comment past the ones a user sends in a minute without one, and 429
   * past the most they send in a minute (see commentWriteRoutes). Only the comments that are
   * stored count. One answered with a challenge is sent again with its solution, and with the same
   * `uploadId` if it has one: the upload is kept for it.
   */
  // The body limit is the largest JSON body a comment is sent in, which holds its file when the file is inline: what /store takes.
  app.post('/content/:contentId/comments', { bodyLimit: 32 * 1024 * 1024 }, async (req, reply) => {
    let raw: Record<string, unknown>;
    let upload: Upload | undefined;
    let file: CommentFile | undefined;
    if (req.isMultipart()) {
      ({ fields: raw, upload } = await readMultipart(req, config.storage));
    } else {
      raw = (req.body as Record<string, unknown>) ?? {};
    }

    // Whether the server holds the comment once the request is over.
    let stored = false;
    try {
      const { contentId } = Params.parse(req.params);
      const body = CommentBody.parse(raw);
      const { parentId, uploadId } = body;
      const text = body.text ?? '';
      if (upload && body.content !== undefined) throw badRequest(msg('post.file_or_field'));
      if (uploadId && (upload || body.content !== undefined)) throw badRequest(msg('post.one_source'));
      if (!text && !upload && body.content === undefined && !uploadId) throw badRequest(msg('comment.text_or_file'));

      const user = await authenticate(db, req, body);
      refuseBanned(user);
      const post = await commentable(contentId);
      // A reply is to a comment anyone can read: not to one that waits in the moderation queue, or was deleted.
      const answerable = async (reader: PendingReader) => parentId === undefined || (await current(reader, contentId, parentId))?.held === false;
      if (!(await answerable(db))) throw commentNotFound();
      // An upload is kept under its user's id, so it is only looked for once the request is known to be theirs.
      if (uploadId) upload = await readUploaded(content, user.id, uploadId, config.storage);
      file = await readCommentFile(body, upload, config.storage, config.postTypes);

      // Before the limit and any challenge, so nobody solves one for a comment that isn't stored, and a refused one doesn't count.
      const { route, trustScore } = await moderateComment({ db, config, trustPlugins, now, log: req.log }, { userId: user.id, contentId, text, filename: file?.filename });
      const held = route === 'queue';
      const attached = file;

      const record = await challenges.admitting('comment', user.id, body, req.language, async () => {
        const createdAt = now();
        const commentId = newCommentId(createdAt);
        // The file first, where only this write knows of it: the commit below is what makes it the comment's.
        const staged = attached && (await attached.file.stage(content, randomUUID(), attached.mimeType));
        const media: CommentMedia | undefined = attached && staged && { kind: attached.kind, mimeType: attached.mimeType, size: staged.size };
        const comment: Comment = { commentId, contentId, ...(parentId !== undefined && { parentId }), userId: user.id, text, ...(media && { media }), createdAt };
        try {
          await writePending(db, contentId, { seq: post.seq, state: true }, answerable, async (trx, seq, there) => {
            // The comment it replies to was deleted, or taken back to the queue, while this was under way.
            if (!there) throw commentNotFound();
            if (held) await queue(trx, comment, trustScore, createdAt);
            await insertPending(trx, { contentId, seq, kind: 'comment_put', commentId, payload: { comment, held }, stagedKey: staged?.key, at: createdAt });
          });
        } catch (err) {
          // A COMMIT can fail yet still be applied, e.g. if the connection dropped mid-commit: the comment is then there, with its file.
          const committed = await pendingComment(db, contentId, commentId).then(
            (row) => row !== null,
            () => null,
          );
          // What was staged is nobody's, unless the write may be there after all: then the file is its own, and stays.
          if (committed === false && staged) {
            await content.removeStaged(staged.key).catch((cause) => req.log.warn({ err: cause, contentId, commentId, staged: staged.key }, 'could not delete the staged file of a comment that was not stored'));
          }
          if (committed !== true) throw err;
        }
        return toCommentRecord(comment, { userId: user.id, username: user.username }, config.publicBaseUrl);
      });
      stored = true;
      reply.status(held ? 202 : 201);
      return held ? { ...record, ...PENDING_REVIEW } : record;
    } finally {
      // Before the response goes out (it is what this returns): a function may be frozen straight after it.
      // An upload in the content store is kept unless the comment was stored, for the request to be sent again.
      await upload?.file.release(stored);
      await file?.file.release(stored);
    }
  });

  /**
   * Edits a comment: its author gives it another text, and nobody else does, not an admin either.
   * The comment keeps its id, its place, its replies and its likes, and says when it was edited
   * (`editedAt`). 200 with the comment; with `unchanged` and nothing written for the text it has.
   *
   * Only the text is edited. The image or video a comment came with stays as it is: an edit
   * neither replaces it nor takes it away, and gives none to a comment that came without. A
   * comment that has one can be left with no text; one that hasn't needs a text (400).
   *
   * The new text goes through the gate a new comment does, and what an update of a post does to
   * the post, an edit does to the comment:
   *
   * - refused (422): nothing changes, and the comment stays as it was;
   * - held: 202 with `status: "pending_review"`. A published comment is taken back to the
   *   moderation queue, where it waits as a new one does: nobody but its author and the queue's
   *   moderators reads it until it is accepted. Nothing else changes: a placeholder is left in
   *   its place, which says that it waits and nothing of it, and its replies and its likes stay
   *   where they are. Rejected, it is deleted as any comment is: that comment, and no reply to it;
   * - published: a comment that was waiting in the queue leaves it, published.
   *
   * A banned user is refused (403), and a post that doesn't take comments (404), as for a new
   * comment. An edit is limited as a new comment is, and counted with them: 428 with a challenge,
   * or 429, where a new comment would get one (see commentWriteRoutes).
   */
  app.patch('/content/:contentId/comments/:commentId', async (req, reply) => {
    const { contentId, commentId } = CommentParams.parse(req.params);
    const body = EditBody.parse(req.body ?? {});
    const user = await authenticate(db, req, body);
    refuseBanned(user);
    const post = await commentable(contentId);
    const seen = await current(db, contentId, commentId);
    const own = seen?.comment.userId === user.id;
    // A held comment is there only for those who can read it.
    if (!seen || (seen.held && !own && !moderatesServer(user))) throw commentNotFound();
    if (!own) throw forbidden(msg('comment.edit_own_only'));
    const { comment } = seen;
    if (body.text === comment.text) return { contentId, commentId, unchanged: true, ...(seen.held && PENDING_REVIEW) };
    if (!body.text && !comment.media) throw badRequest(msg('comment.text_required'));

    const { route, trustScore } = await moderateComment({ db, config, trustPlugins, now, log: req.log }, { userId: user.id, contentId, text: body.text });
    const held = route === 'queue';

    const edited = await challenges.admitting('comment', user.id, body, req.language, () => {
      const editedAt = now();
      return writePending(
        db,
        contentId,
        { seq: post.seq, state: seen },
        (reader) => current(reader, contentId, commentId),
        async (trx, seq, state) => {
          // Deleted while this was under way. Otherwise the edit is of the comment as it is by now, whatever was written to it meanwhile.
          if (!state) throw commentNotFound();
          const edited: Comment = { ...state.comment, text: body.text, editedAt };
          // Where the edit leaves it is where it is: in the queue, with a row there, or published, with none.
          if (held) await queue(trx, edited, trustScore, editedAt);
          else await trx.deleteFrom('comment_queue').where('comment_id', '=', commentId).where('content_id', '=', contentId).execute();
          await insertPending(trx, { contentId, seq, kind: 'comment_put', commentId, payload: { comment: edited, held }, at: editedAt });
          return edited;
        },
      );
    });
    req.log.info({ contentId, commentId, by: user.id, held }, 'edited a comment');
    const [record] = await toCommentRecords(deps, [edited]);
    return reply.status(held ? 202 : 200).send({ ...record, ...(held && PENDING_REVIEW) });
  });

  /**
   * Deletes a comment, for good, and nothing else: its author, the publisher of the post it is
   * on, or an admin. The comments that reply to it stay, under a placeholder left in its place
   * (`status: "deleted"`: no author, no text, no image or video, no likes); a comment nothing
   * replies to leaves none. One that waits in the moderation queue is 404 to those who can't read
   * it, the post's publisher among them, and is its author's or an admin's to delete: a server
   * moderator rejects it there. Its author is told, unless they deleted it themselves.
   *
   * It works whether or not the post takes comments now: what was written while it did is still
   * its author's, and the publisher's, to delete.
   */
  app.delete('/content/:contentId/comments/:commentId', async (req) => {
    const { contentId, commentId } = CommentParams.parse(req.params);
    const user = await authenticate(db, req, Credentials.parse(req.body ?? {}));
    const post = await loadContent(db, contentId);
    const seen = await current(db, contentId, commentId);
    const own = seen?.comment.userId === user.id;
    // A held comment is there only for those who can read it.
    if (!seen || (seen.held && !own && !moderatesServer(user))) throw commentNotFound();
    if (!own && !user.admin && !(!seen.held && post.user_id === user.id)) throw forbidden(msg('comment.delete_not_allowed'));
    const removed = await removeComment(deps, post, commentId, seen);
    // Deleted by someone else while this was under way.
    if (!removed) throw commentNotFound();
    req.log.info({ contentId, commentId, by: user.id }, 'deleted a comment');
    await notify(deps, { userId: removed.userId, kind: 'comment_deleted', contentId, comment: removed.text, by: user.id }, req.log);
    return { contentId, commentId, status: 'deleted' };
  });
}
