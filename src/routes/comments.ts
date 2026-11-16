import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/apiKey.js';
import { ChallengeFields } from '../challenge/challenges.js';
import { MAX_COMMENT_CHARS, newCommentId, publishComment, removeComment, toCommentRecord, toCommentRecords } from '../comments.js';
import { loadContent, loadPublished, loadReadable, PENDING_REVIEW, readsHeld, requireMeta, takesComments } from '../content.js';
import { updateOnConflict } from '../db/index.js';
import type { AppDeps, RouteDeps } from '../deps.types.js';
import { badRequest, forbidden, notFound } from '../http/errors.js';
import { Credentials } from '../http/schemas.js';
import { notify } from '../inbox.js';
import { msg } from '../language.js';
import { moderateComment, moderatesServer, refuseBanned } from '../moderation/policy.js';
import type { Comment, CommentMedia } from '../storage/index.js';
import { readCommentFile, readMultipart, readUploaded } from '../upload.js';
import type { CommentFile, Upload } from '../upload.types.js';
import { rawHeaders } from './content.js';

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
 * database only says that the post is there, as it does for GET /content/:contentId.
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
    if (!takesComments(await requireMeta(content, contentId))) throw notFound(msg('comment.off'));
    return row;
  }

  /**
   * One comment of the post, for whoever may read it, and whether it waits in the moderation
   * queue (`held`). One that does is read only by its author and by those who decide on it there
   * (server moderators and admins), by the credentials in the request's headers. Anyone else gets
   * what is in its place: the placeholder of a comment that was published before an edit took it
   * back to the queue, or 404, like a comment that isn't there, for one that never was published.
   * A deleted comment that has replies is its placeholder to everyone.
   */
  async function readable(req: FastifyRequest, contentId: string, commentId: string): Promise<{ comment: Comment; held: boolean }> {
    const found = await comments.find(contentId, commentId);
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
   */
  app.get('/content/:contentId/comments/:commentId/raw', { compress: false }, async (req, reply) => {
    const { contentId, commentId } = CommentParams.parse(req.params);
    await commented(req, contentId);
    const { comment } = await readable(req, contentId, commentId);
    if (comment.gone) throw commentNotFound();
    if (!comment.media) throw notFound(msg('comment.no_media'));

    const bytes = { postId: contentId, commentId };
    const signed = await content.signedUrl(bytes);
    if (signed) return reply.redirect(signed, 302);
    const { size, contentType } = await content.stat(bytes);
    const type = contentType ?? comment.media.mimeType;
    reply.headers(rawHeaders(type));
    reply.header('content-type', type);
    reply.header('content-length', String(size));
    return reply.send(await content.stream(bytes));
  });
}

/**
 * Writing comments: any user comments on a published post that takes comments, or replies to a
 * comment on it; a comment's author edits it; and a comment is deleted by its author, by the
 * post's publisher, or by an admin. The comments that reply to it stay (see comments.ts).
 *
 * A comment goes through the gate a post does (see moderateComment), and so does an edit of one,
 * as an update of a post does: its trust score has it refused, held in the moderation queue for a
 * server moderator or an admin, or published. Only a held comment touches the database, for its
 * row in the queue; a published one is an object in the content store and a member in Redis.
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

  /** The published post, if it takes comments: what is set for deletion, or waits in the moderation queue, isn't there to comment on. */
  async function commentable(contentId: string): Promise<void> {
    await loadPublished(db, contentId);
    if (!takesComments(await requireMeta(content, contentId))) throw notFound(msg('comment.off'));
  }

  /**
   * Puts a comment in the moderation queue with its trust score, or gives the row it has there the
   * score: a comment that was waiting keeps its place in the queue, as a post does.
   */
  const queue = ({ commentId, contentId }: Comment, trustScore: number, at: number) =>
    updateOnConflict(
      db.insertInto('comment_queue').values({ comment_id: commentId, content_id: contentId, trust_score: trustScore, created_at: at }),
      config.db.dialect,
      'comment_id',
      { trust_score: trustScore },
    ).execute();

  /**
   * Stores the image or video a new comment comes with, and returns what the comment says of it.
   * It is stored before the comment, where it stays whether the comment is published or waits in
   * the moderation queue: a comment that is there to read never lacks its file.
   */
  async function place(req: FastifyRequest, { kind, file, mimeType }: CommentFile, postId: string, commentId: string): Promise<CommentMedia> {
    try {
      return { kind, mimeType, size: (await file.place(content, { postId, commentId }, mimeType)).size };
    } catch (err) {
      await discard(req, postId, commentId);
      throw err;
    }
  }

  /** Deletes the file of a comment that wasn't stored: nothing of it is left. */
  const discard = (req: FastifyRequest, postId: string, commentId: string) =>
    comments.discardMedia(postId, commentId).catch((cause) => req.log.warn({ err: cause, contentId: postId, commentId }, 'could not delete the file of a comment that was not stored'));

  /**
   * Looks again for the comment a reply that was just stored replies to. It was there when the
   * reply was sent; deleted meanwhile, before the reply was there to be seen, nothing is left of
   * it, not a placeholder to list the reply under: the reply is removed, and 404, as for a reply
   * to a comment that isn't there.
   */
  async function answered({ contentId, commentId, parentId }: Comment): Promise<void> {
    if (parentId === undefined || (await comments.find(contentId, parentId))) return;
    await removeComment(deps, contentId, commentId);
    throw commentNotFound();
  }

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
      await commentable(contentId);
      // A reply is to a comment anyone can read: not to one that waits in the moderation queue, or was deleted.
      if (parentId !== undefined && !(await comments.get(contentId, parentId))) throw commentNotFound();
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
        const media = attached && (await place(req, attached, contentId, commentId));
        const comment: Comment = { commentId, contentId, ...(parentId !== undefined && { parentId }), userId: user.id, text, ...(media && { media }), createdAt };
        try {
          await comments.put(comment, { held });
        } catch (err) {
          if (media) await discard(req, contentId, commentId);
          throw err;
        }
        if (held) {
          // The comment first, then its row: the queue never lists a comment the store doesn't have.
          try {
            await queue(comment, trustScore, createdAt);
          } catch (err) {
            await comments.remove(contentId, commentId).catch((cause) => req.log.warn({ err: cause, contentId, commentId }, 'could not remove a held comment that has no row in the queue'));
            // The post was deleted meanwhile, which is why it takes no row: 404, as for a post that isn't there.
            await loadPublished(db, contentId);
            throw err;
          }
        }
        await answered(comment);
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
    await commentable(contentId);
    const published = await comments.get(contentId, commentId);
    const comment = published ?? (await comments.getHeld(contentId, commentId));
    const own = comment?.userId === user.id;
    // A held comment is there only for those who can read it.
    if (!comment || (!published && !own && !moderatesServer(user))) throw commentNotFound();
    if (!own) throw forbidden(msg('comment.edit_own_only'));
    const waiting = published === null;
    if (body.text === comment.text) return { contentId, commentId, unchanged: true, ...(waiting && PENDING_REVIEW) };
    if (!body.text && !comment.media) throw badRequest(msg('comment.text_required'));

    const { route, trustScore } = await moderateComment({ db, config, trustPlugins, now, log: req.log }, { userId: user.id, contentId, text: body.text });
    const held = route === 'queue';

    const edited = await challenges.admitting('comment', user.id, body, req.language, async () => {
      const editedAt = now();
      const edited: Comment = { ...comment, text: body.text, editedAt };
      if (!waiting && !held) {
        // Deleted while this was under way, or taken back to the queue by another edit.
        if (!(await comments.update(edited))) throw commentNotFound();
      } else if (!waiting) {
        // Its row first: the queue reads a comment whose row is there from wherever it is, and one held with no row would wait for nobody.
        await queue(edited, trustScore, editedAt);
        try {
          await comments.hold(edited);
        } catch (err) {
          await db.deleteFrom('comment_queue').where('comment_id', '=', commentId).where('content_id', '=', contentId).execute().catch((cause) => req.log.warn({ err: cause, contentId, commentId }, 'could not take a comment that is still published out of the moderation queue'));
          throw err;
        }
        // Again, for a moderator who decided on it between the two, and took the row out: it waits, so it has one.
        await queue(edited, trustScore, editedAt);
      } else if (held) {
        await comments.put(edited, { held: true });
        await queue(edited, trustScore, editedAt);
      } else {
        // Out of the queue as an accepted comment goes: its row first, in the transaction the store's work is done inside.
        if (
          !(await db.transaction().execute(async (trx) => {
            // Decided on while this was under way: it is published as it was, or gone.
            if (
              Number((await trx.deleteFrom('comment_queue').where('comment_id', '=', commentId).where('content_id', '=', contentId).executeTakeFirst()).numDeletedRows) === 0
            ) {
              return false;
            }
            return publishComment(deps, edited);
          }))
        ) {
          throw commentNotFound();
        }
      }
      return edited;
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
    const published = await comments.get(contentId, commentId);
    const comment = published ?? (await comments.getHeld(contentId, commentId));
    const own = comment?.userId === user.id;
    // A held comment is there only for those who can read it.
    if (!comment || (!published && !own && !moderatesServer(user))) throw commentNotFound();
    if (!own && !user.admin && !(published !== null && post.user_id === user.id)) throw forbidden(msg('comment.delete_not_allowed'));
    await removeComment(deps, contentId, commentId);
    req.log.info({ contentId, commentId, by: user.id }, 'deleted a comment');
    await notify(deps, { userId: comment.userId, kind: 'comment_deleted', contentId, comment: comment.text, by: user.id }, req.log);
    return { contentId, commentId, status: 'deleted' };
  });
}
