import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import { authenticate } from '../auth/apiKey.js';
import { blockedAmong, blocks, readerOf } from '../blocks.js';
import { hideBlocked, MAX_COMMENT_CHARS, newCommentId, removeComment, toCommentRecord, toCommentRecords } from '../comments.js';
import type { CommentRecord } from '../comments.types.js';
import { loadContent, loadPublished, loadReadable, PENDING_REVIEW, PROCESSING, readsHeld, requireMeta, takesComments, videoProcessing } from '../content.js';
import { updateOnConflict } from '../db/index.js';
import type { Database } from '../db/schema.js';
import type { AppDeps, RouteDeps } from '../deps.types.js';
import { badRequest, forbidden, notFound } from '../http/errors.js';
import { perMinute } from '../http/rateLimitStore.js';
import { Credentials, Flag } from '../http/schemas.js';
import { excerpt, notify } from '../inbox.js';
import { msg } from '../language.js';
import { notifyMentions, resolveMentions } from '../mentions.js';
import { moderateComment, moderatesServer, refuseBanned } from '../moderation/policy.js';
import { effectiveComment, insertPending, pendingComment, pendingCommentFile, UNNUMBERED, writePending, writeUnnumbered, type PendingReader } from '../pending.js';
import { MAX_ALT_CHARS } from '../posts.js';
import { admitting } from '../sendLimit.js';
import { commentPlaceholder, type Comment, type CommentMedia } from '../storage/index.js';
import { readCommentFile, readMultipart, readUploaded, trustImage } from '../upload.js';
import type { CommentFile, Upload } from '../upload.types.js';
import { addVideoJob, jobClient } from '../video/jobs.js';
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
 * who's asking, what the comment says and which comment it replies to, whether it was created
 * with AI, and the image or video it comes with.
 */
const CommentBody = Credentials.extend({
  /** What it says. A comment that comes with an image or a video needs none. */
  text: Text.optional(),
  /** Its author's declaration that the comment was created with AI, as /store takes a post's. Omitted: false. */
  aiGenerated: Flag.optional(),
  /** The comment, on the same post, that this one replies to. Left out: it is a comment on the post itself. */
  parentId: z.string().uuid().optional(),
  // The image or video it comes with, sent as a post's file is (routes/store.ts).
  contentType: z.string().max(255).optional(),
  filename: z.string().max(512).optional(),
  /** The file, inline for JSON requests (or a plain multipart text field). */
  content: z.string().optional(),
  /** The file, already sent to the link POST /uploads gave: the id it came with. */
  uploadId: z.string().uuid().optional(),
  /** The alternative text of the image it comes with: what describes it to those who can't see it. Only an image has one. */
  alt: z.string().trim().max(MAX_ALT_CHARS).optional(),
  contentEncoding: z.enum(['utf8', 'base64']).default('utf8'),
});
/**
 * An edit: the comment's text, which may be empty for a comment that has an image or a video, and
 * its author's declaration that it was created with AI. Omitted: what the comment declared.
 */
const EditBody = Credentials.extend({ text: Text, aiGenerated: Flag.optional() });

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
 *
 * The two lists leave out what a user the reader blocks wrote (src/blocks.ts), for a reader who
 * sends their credentials: such a comment is listed as a placeholder (see `listed`). A comment
 * read by its id is given as it is.
 */
export function commentReadRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, content, comments } = deps;
  /**
   * The limit on each of the two lists of comments, which need no key: one address gets
   * `comments.listRateLimitPerMinute` requests a minute to each, counted in Redis for every node
   * and function (see app.ts), and is refused past that (429) before anything is read for it. A
   * list of a post whose comments Redis doesn't hold is a listing of the content store.
   */
  const listLimit = { config: perMinute(deps.config.comments.listRateLimitPerMinute) };

  /** The post, for whoever may read it, if it takes comments. */
  async function commented(req: FastifyRequest, contentId: string) {
    const row = await loadReadable(db, req, contentId);
    if (!takesComments(await requireMeta({ db, content }, contentId))) throw notFound(msg('comment.off'));
    return row;
  }

  /**
   * A page of a list, as records, for whoever asks. To a reader who sends their credentials, a
   * comment by a user they block is a placeholder (`status: "blocked"`, see hideBlocked): it
   * keeps its place and its replies, and says nothing of the comment. A request with no
   * credentials, or wrong ones, is listed every comment, as before: it costs the database nothing
   * more. One with them costs the key's lookup, and one more for the blocks among the page's authors.
   */
  async function listed(req: FastifyRequest, page: Comment[]): Promise<CommentRecord[]> {
    const records = await toCommentRecords(deps, page);
    const reader = records.some((record) => record.author !== null) ? await readerOf(db, req) : null;
    if (!reader) return records;
    return hideBlocked(records, await blockedAmong(db, reader.id, records.flatMap((record) => (record.author ? [record.author.userId] : []))));
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
   * listed, and counted, as the comment it stands for, and so is the one a reader gets for a
   * comment by a user they block (see `listed`). Limited by address (see `listLimit`).
   */
  app.get('/content/:contentId/comments', listLimit, async (req) => {
    const { contentId } = Params.parse(req.params);
    const query = PageQuery.parse(req.query);
    await commented(req, contentId);
    const [page, count] = await Promise.all([comments.page(contentId, query), comments.count(contentId)]);
    return { contentId, count, comments: await listed(req, page.comments), nextCursor: page.nextCursor };
  });

  /**
   * The replies to a comment, a page at a time, as the comments on a post are read, with how many
   * replies the comment has: to it, not to its replies, each of which is asked for its own. The
   * replies to a comment that was deleted, or that an edit took back to the moderation queue, are
   * read as any others are. 404 for a comment that isn't there, or was never published. Limited
   * by address, apart from the comments on the post itself (see `listLimit`).
   */
  app.get('/content/:contentId/comments/:commentId/replies', listLimit, async (req) => {
    const { contentId, commentId } = CommentParams.parse(req.params);
    const query = PageQuery.parse(req.query);
    await commented(req, contentId);
    if (!(await comments.find(contentId, commentId))) throw commentNotFound();
    const [page, count] = await Promise.all([comments.page(contentId, { ...query, parentId: commentId }), comments.count(contentId, commentId)]);
    return { contentId, commentId, count, comments: await listed(req, page.comments), nextCursor: page.nextCursor };
  });

  /**
   * One comment. `status: "pending_review"` on one that waits in the moderation queue, which only
   * its author and those who decide on it there can read (see `readable`); anyone else gets the
   * placeholder of one that was published before, which has that status too, and nothing of the
   * comment. `status: "deleted"` on the placeholder of a deleted comment that has replies.
   * `processing: true` on one whose video the server is still processing (compactor/src/video): it is in
   * no list yet, and its video isn't there to play.
   */
  app.get('/content/:contentId/comments/:commentId', async (req) => {
    const { contentId, commentId } = CommentParams.parse(req.params);
    await commented(req, contentId);
    const { comment, held } = await readable(req, contentId, commentId);
    const [record] = await toCommentRecords(deps, [comment]);
    // Only a comment with a video can be waiting for one: no other is asked about.
    const processing = comment.media?.kind === 'video' && !comment.gone && (await pendingCommentFile(db, contentId, commentId))?.processing === true;
    return { ...record, ...(held && PENDING_REVIEW), ...(processing && PROCESSING) };
  });

  /**
   * The bytes of the image or video a comment came with, served as a post's are at
   * /content/:contentId/raw: a redirect to the store where it can sign links, else streamed from
   * here as something to show and nothing more (see rawHeaders). Whoever may read the comment may
   * read them. 404 for a comment that is only text, and for a placeholder, which has no file.
   *
   * The file of a comment the compactor has yet to write is where its request staged it, and is
   * served from there; once the compactor has it where comments' files are kept, from there.
   * 404 for a video the server is still processing (compactor/src/video), which says so.
   */
  app.get('/content/:contentId/comments/:commentId/raw', { compress: false }, async (req, reply) => {
    const { contentId, commentId } = CommentParams.parse(req.params);
    await commented(req, contentId);
    const { comment } = await readable(req, contentId, commentId);
    if (comment.gone) throw commentNotFound();
    if (!comment.media) throw notFound(msg('comment.no_media'));
    const { mimeType } = comment.media;

    const staged = await pendingCommentFile(db, contentId, commentId);
    // A video as it was sent is never served (see GET /content/:contentId/raw): it is there once it is processed.
    if (staged?.processing) throw videoProcessing();
    // Gone from there: the compactor applied the write meanwhile, and the file is the comment's own.
    if (staged !== null && (await sendBytes(reply, content, { staged: staged.stagedKey }, () => mimeType, { staged: true }))) return reply;
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
 * A comment's text mentions users as a post's does, by `@` and their name (src/mentions.ts): whom
 * it mentions is found as it is written, kept in the comment, and given with it as `mentions`,
 * which its text is read with. Each of them is told, by a notice in their inbox, once the comment
 * is published: as it is sent or edited, or when it is accepted from the moderation queue. An
 * edit tells those it newly mentions.
 *
 * None of them writes the comment store. Each is one commit to the database: a row of
 * `pending_writes` under the comment's post, and with it the comment's row in the moderation
 * queue where it is held (see src/pending.ts). The compactor's next run writes the comment store
 * from the rows. An edit and a deletion take the post's next write number, which locks the
 * post's row: the two of one comment commit one after the other, and are applied in that order,
 * so they never write over each other. A new comment takes no number and locks nothing: however
 * many are sent to one post at once, none waits for another. None is written under a post that
 * is set for deletion (404). Until the run, the comment is read by its id as it was written (see
 * commentReadRoutes), and is in no list.
 *
 * A comment, and an edit of one, is then limited as a post is, by the code that limits posts
 * (src/sendLimit.ts), with a setting of its own: one past `comments.perMinute` in any minute is
 * refused (429). It comes after the gate and before anything is stored, so a comment the gate
 * refuses counts for nothing, and neither does one whose write fails.
 */
export function commentWriteRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { db, config, content, comments, trust, now = Date.now } = deps;

  /**
   * The published post, if it takes comments: what is set for deletion, or waits in the moderation
   * queue, isn't there to comment on. Its row is read before anything of its comments is, which
   * is what its write number is good for to an edit (see writePending).
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
   * Refuses (403) a comment, or an edit of one, by a user the post's publisher blocks
   * (src/blocks.ts): they write nothing more under that publisher's posts. What they wrote there
   * before the block stays, theirs to delete, and the publisher's. A block made while a comment
   * is being sent may not stop it: it applies to the ones sent after it.
   */
  async function refuseBlocked(post: { user_id: string }, user: { id: string }): Promise<void> {
    if (post.user_id !== user.id && (await blocks(db, post.user_id, user.id))) throw forbidden(msg('comment.not_taken'));
  }

  /**
   * Refuses (403) a reply, or an edit of one, by a user whom the author of the comment it replies
   * to blocks: they write nothing more under that user's comments, on whoever's post, as they
   * write nothing under that user's posts (see refuseBlocked). It goes by the comment replied
   * to, and no further up: a reply to someone else's reply under the blocker's comment is taken.
   * What they replied before the block stays, theirs to delete. `parent` is that comment as it
   * is now, if it is still there: what is left of a deleted one is nobody's.
   */
  async function refuseBlockedReply(parent: Comment | undefined, user: { id: string }): Promise<void> {
    if (parent && parent.userId !== user.id && (await blocks(db, parent.userId, user.id))) throw forbidden(msg('comment.reply_not_taken'));
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
   * An image can come with its alternative text (`alt`), which describes it to those who can't
   * see it: it is kept with the comment, given wherever the comment's image is, and read by
   * moderation as the comment's text is. It is said of an image only (400).
   *
   * `aiGenerated` is its author's declaration that the comment was created with AI, as a post's
   * publisher makes one of a post: false unless they say so. Nothing detects or checks it. It is
   * kept in the comment and given wherever the comment is, and its author can change it with an
   * edit.
   *
   * A video is not published as it was sent, where the server processes videos
   * (`video.processing`, compactor/src/video): the answer says `processing: true`, and the comment is
   * listed, with a video that plays anywhere and says nothing of where it was filmed, once the
   * video worker has made it one. Until then it is read by its id, and its video isn't served.
   * One that can't be processed is told to its author by a notice, and the comment is
   * published with its text alone, or not at all if the video was all of it.
   *
   * A banned user is refused (403), and so is one the post's publisher blocks (see refuseBlocked),
   * and a reply to a comment whose author blocks them (see refuseBlockedReply).
   *
   * 429 for a comment past the most a user sends in a minute (see commentWriteRoutes). Only the
   * comments that are stored count. One that was refused is sent again with the same `uploadId`
   * if it has one: the upload is kept for it.
   */
  // The body limit is the largest JSON body a comment is sent in, which holds its file when the file is inline: what /store takes.
  app.post('/content/:contentId/comments', { bodyLimit: 32 * 1024 * 1024 }, async (req, reply) => {
    let raw: Record<string, unknown>;
    let upload: Upload | undefined;
    let file: CommentFile | undefined;
    if (req.isMultipart()) {
      ({
        fields: raw,
        uploads: [upload],
      } = await readMultipart(req, config.storage));
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
      await refuseBlocked(await commentable(contentId), user);
      // A reply is to a comment anyone can read: not to one that waits in the moderation queue, or was deleted.
      const answered = async (reader: PendingReader, id: string) => {
        const parent = await current(reader, contentId, id);
        return parent?.held === false ? parent.comment : undefined;
      };
      if (parentId !== undefined) {
        const parent = await answered(db, parentId);
        if (!parent) throw commentNotFound();
        await refuseBlockedReply(parent, user);
      }
      // An upload is kept under its user's id, so it is only looked for once the request is known to be theirs.
      if (uploadId) upload = await readUploaded(content, user.id, uploadId, config.storage);
      file = await readCommentFile(body, upload, config.storage, config.postTypes);

      // Before the limit, so a refused one doesn't count.
      const { route, trustScore } = await moderateComment(
        { trust, now, log: req.log, client: { ip: req.ip, userAgent: req.headers['user-agent'] ?? null } },
        // Its image is given to the trust plugins that look at pictures, as a post's are (see trustImage). A video isn't.
        { userId: user.id, contentId, text, filename: file?.filename, alt: file?.alt, ...(file?.kind === 'image' && { image: trustImage(file) }) },
      );
      const held = route === 'queue';
      const attached = file;
      const mentions = await resolveMentions(db, text);

      const record = await admitting(deps, 'comment', user.id, async () => {
        const createdAt = now();
        const commentId = newCommentId(createdAt);
        // The file first, where only this write knows of it: the commit below is what makes it the comment's.
        const staged = attached && (await attached.file.stage(content, randomUUID(), attached.mimeType));
        const media: CommentMedia | undefined = attached && staged && { kind: attached.kind, mimeType: attached.mimeType, size: staged.size, ...(attached.alt && { alt: attached.alt }) };
        const comment: Comment = {
          commentId,
          contentId,
          ...(parentId !== undefined && { parentId }),
          userId: user.id,
          text,
          ...(mentions.length > 0 && { mentions }),
          ...(body.aiGenerated === true && { aiGenerated: true }),
          ...(media && { media }),
          createdAt,
        };
        // A video the server processes waits as it was sent: the row says so, and the job is what the video worker finds it by (see write).
        const process = staged !== undefined && media?.kind === 'video' && config.video.processing;
        try {
          // It takes no number, and no lock on its post: the comments of one post commit side by side.
          await writeUnnumbered(db, config.db.dialect, contentId, { reply: parentId !== undefined }, async (trx) => {
            // The comment it replies to was deleted, or taken back to the queue, while this was under way. Read again
            // here, where the compactor waits for this reply before it decides what a removal of that comment leaves.
            if (parentId !== undefined && !(await answered(trx, parentId))) throw commentNotFound();
            if (held) await queue(trx, comment, trustScore, createdAt);
            await insertPending(trx, { contentId, key: commentId, kind: 'comment_put', commentId, payload: { comment, held, ...(process && { process: true }) }, stagedKey: staged?.key, at: createdAt });
            if (process) await addVideoJob(trx, { contentId, seq: UNNUMBERED, key: commentId, commentId, at: createdAt, client: jobClient(config, { ip: req.ip, userAgent: req.headers['user-agent'] ?? null }) });
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
        return { ...toCommentRecord(comment, { userId: user.id, username: user.username }, config.publicBaseUrl), ...(process && PROCESSING) };
      });
      stored = true;
      // Whom it mentions is told once it is published: one that is held tells nobody until it is accepted (routes/moderation.ts).
      if (!held) await notifyMentions(deps, { by: user.id, contentId, commentId: record.commentId, mentions, excerpt: excerpt(text) }, req.log);
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
   * An edit can also say whether the comment was created with AI (`aiGenerated`), as an update of
   * a post does: one that leaves it out keeps what the comment declared, and changing only that
   * is an edit too, with the text the comment has. `unchanged` is for an edit that changes
   * neither.
   *
   * Nothing else is edited. The image or video a comment came with stays as it is: an edit
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
   * comment. So is the comment's author once the post's publisher blocks them (403, see
   * refuseBlocked): an edit would be a new text under the post. And so is the author of a reply
   * once the author of the comment it replies to blocks them (403, see refuseBlockedReply): it
   * would be a new text under that comment. An edit is limited as a new comment is, and counted
   * with them: 429 where a new comment would get one (see commentWriteRoutes).
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
    await refuseBlocked(post, user);
    const { comment } = seen;
    if (comment.parentId !== undefined) await refuseBlockedReply((await current(db, contentId, comment.parentId))?.comment, user);
    // The text it has, with the declaration it has, or with none said: nothing to write.
    const declares = body.aiGenerated !== undefined && body.aiGenerated !== (comment.aiGenerated === true);
    if (body.text === comment.text && !declares) return { contentId, commentId, unchanged: true, ...(seen.held && PENDING_REVIEW) };
    if (!body.text && !comment.media) throw badRequest(msg('comment.text_required'));

    const { route, trustScore } = await moderateComment(
      { trust, now, log: req.log, client: { ip: req.ip, userAgent: req.headers['user-agent'] ?? null } },
      { userId: user.id, contentId, text: body.text },
    );
    const held = route === 'queue';
    // Whom the new text mentions: it goes on mentioning whom the text it replaces did (see resolveMentions).
    const mentions = await resolveMentions(db, body.text, comment.mentions);

    const edited = await admitting(deps, 'comment', user.id, () => {
      const editedAt = now();
      return writePending(
        db,
        contentId,
        { seq: post.seq, state: seen },
        (reader) => current(reader, contentId, commentId),
        async (trx, seq, state) => {
          // Deleted while this was under way. Otherwise the edit is of the comment as it is by now, whatever was written to it meanwhile.
          if (!state) throw commentNotFound();
          // The mentions it had were of the text it had. What it declares of AI is what the edit says, or what it declared by now.
          const { mentions: mentioned, aiGenerated: declared, ...was } = state.comment;
          const aiGenerated = body.aiGenerated ?? (declared === true);
          const edited: Comment = { ...was, text: body.text, ...(mentions.length > 0 && { mentions }), ...(aiGenerated && { aiGenerated }), editedAt };
          // Where the edit leaves it is where it is: in the queue, with a row there, or published, with none.
          if (held) await queue(trx, edited, trustScore, editedAt);
          else await trx.deleteFrom('comment_queue').where('comment_id', '=', commentId).where('content_id', '=', contentId).execute();
          await insertPending(trx, { contentId, seq, kind: 'comment_put', commentId, payload: { comment: edited, held }, at: editedAt });
          return edited;
        },
      );
    });
    req.log.info({ contentId, commentId, by: user.id, held }, 'edited a comment');
    // Those the edit newly mentions are told, once it is published: not those the comment mentioned as it was read here, if it was published.
    if (!held) await notifyMentions(deps, { by: user.id, contentId, commentId, mentions, before: seen.held ? undefined : comment.mentions, excerpt: excerpt(body.text) }, req.log);
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
