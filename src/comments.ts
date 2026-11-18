import { randomBytes } from 'node:crypto';
import type { Transaction } from 'kysely';
import type { CommentCounts, CommentRecord } from './comments.types.js';
import type { Database } from './db/schema.js';
import type { AppDeps } from './deps.types.js';
import { effectiveComment, insertPending, payloadOf, writePending } from './pending.js';
import type { CommentPutPayload, EffectiveComment } from './pending.types.js';
import type { Comment, Publisher } from './storage/index.js';
import { iso } from './time.js';

/**
 * Comments on posts: a text, an image or a video, or a text with one of the two. A post takes them
 * if its publisher said so (the `comments` flag of /store, in the post's meta file). A comment is
 * on the post or replies to another comment on it, so a post's comments are a tree, of any depth.
 * Its author can edit its text, and any user can like it, once. Its author says whether it was
 * created with AI (`aiGenerated`), as a post's publisher says of a post: nothing detects or
 * checks it.
 *
 * A comment goes alone. Deleting one deletes that comment and none of the comments that reply to
 * it, and so does rejecting it in the moderation queue, or deleting it from the report queue; and
 * an edit that the server holds takes that comment off the post, and none of its replies. What
 * keeps the replies where they are is a placeholder, left in the comment's place: it says the
 * comment was deleted, or waits for a moderator, and nothing else of it. A deleted comment that
 * nothing replies to leaves none: it is gone altogether.
 *
 * They are objects in the content store, and so are their likes and their images and videos, with
 * Redis as a cache over them (storage/commentStore.ts), and not in the database, which holds only
 * the ones that wait in the moderation queue or the report queue (`comment_queue`,
 * `comment_reports`). The routes are in routes/comments.ts (and routes/like.ts), and the queues'
 * in routes/moderation.ts and routes/reports.ts.
 *
 * No request writes those objects. A comment, an edit, a like, a removal, an accept from the
 * moderation queue: each commits a row of `pending_writes` under its post (src/pending.ts), and
 * the compactor's next run writes the store from the rows: a comment's as what they come to, with
 * its removal last. So a write to a comment never races another, nor the deletion of the comment
 * or of its post. A new comment and a like lock nothing as they commit, so a post that many
 * answer at once takes them side by side; an edit, a removal and a moderator's decision take
 * turns on the post's row, as each has to know what the one before it left.
 * Until then the comment's own routes answer by the rows (see effectiveComment), and the lists
 * and counts by the store: a comment is in its post's list once the compactor has run.
 */

/** The longest a comment can be. */
export const MAX_COMMENT_CHARS = 2000;

/** The time and sequence of the last id this process made, so its ids only go up. */
let last = { ms: 0, seq: 0 };

/**
 * A new comment's id: a UUIDv7, which starts with the time it was made at (`now`, UTC epoch
 * milliseconds), so that a post's comment ids are in the order the comments were sent in. That
 * order is what the comment store lists and pages them by, with no index to keep but the ids.
 *
 * After the time come 12 bits that count the ids this process made in the same millisecond, so
 * that those are in order too, then 62 random bits. A process that makes more than 4,096 in one
 * millisecond, or whose clock went back, goes on from the time of its last id.
 */
export function newCommentId(now: number): string {
  let ms = Math.max(now, last.ms);
  let seq = ms === last.ms ? last.seq + 1 : 0;
  // The most `seq` holds: the 12 bits a UUIDv7 has between its time and its random part.
  if (seq > 0xfff) {
    ms += 1;
    seq = 0;
  }
  last = { ms, seq };
  const bytes = randomBytes(16);
  bytes.writeUIntBE(ms, 0, 6);
  // Version 7, then the sequence.
  bytes.writeUInt16BE(0x7000 | seq, 6);
  // The variant: 10, then random bits.
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Where the bytes of a comment's image or video are read, as a post's are at /content/:contentId/raw. */
const commentMediaUrl = (publicBaseUrl: string, postId: string, commentId: string) => `${publicBaseUrl}/content/${postId}/comments/${commentId}/raw`;

/**
 * A comment as responses give it: with `author` as its credit, and the link to its image or video
 * built from `publicBaseUrl`. A placeholder is given without author, text, media or likes, with
 * no declaration of AI, and with the `status` that says why the comment isn't there. Without counts, it has no likes and no
 * replies, as a comment just sent has.
 */
export function toCommentRecord(comment: Comment, author: Publisher, publicBaseUrl: string, { likes, replies }: CommentCounts = { likes: 0, replies: 0 }): CommentRecord {
  const place = { commentId: comment.commentId, contentId: comment.contentId, parentId: comment.parentId ?? null };
  const createdAt = iso(comment.createdAt);
  // A placeholder: where the comment was, how many reply to it, and why it isn't there.
  if (comment.gone) {
    return { ...place, author: null, text: '', aiGenerated: false, media: null, likes: 0, replies, createdAt, editedAt: null, status: comment.gone === 'deleted' ? 'deleted' : 'pending_review' };
  }
  return {
    ...place,
    author,
    text: comment.text,
    ...(comment.mentions?.length && { mentions: comment.mentions }),
    // Kept only where it was declared: a comment without it wasn't.
    aiGenerated: comment.aiGenerated === true,
    // The link isn't stored: it is built when read, as a post's is.
    media: comment.media
      ? {
          kind: comment.media.kind,
          url: commentMediaUrl(publicBaseUrl, comment.contentId, comment.commentId),
          mimeType: comment.media.mimeType,
          size: comment.media.size,
          ...(comment.media.alt && { alt: comment.media.alt }),
        }
      : null,
    likes,
    replies,
    createdAt,
    editedAt: comment.editedAt === undefined ? null : iso(comment.editedAt),
  };
}

/**
 * Comments as responses give them, each with its author's credit, read from Redis as feeds read
 * publishers', and with how many likes and replies it has, read from the comment store, a post's
 * comments at a time.
 */
export async function toCommentRecords({ config, publishers, comments: store }: Pick<AppDeps, 'config' | 'publishers' | 'comments'>, comments: Comment[]): Promise<CommentRecord[]> {
  const byPost = new Map<string, { ids: string[]; liked: string[] }>();
  for (const { contentId, commentId, gone } of comments) {
    let of = byPost.get(contentId);
    if (!of) byPost.set(contentId, (of = { ids: [], liked: [] }));
    of.ids.push(commentId);
    // A placeholder has no likes to read, and no author.
    if (!gone) of.liked.push(commentId);
  }
  const counts = new Map<string, CommentCounts>();
  const [authors] = await Promise.all([
    publishers.getMany(comments.filter((comment) => !comment.gone).map((comment) => comment.userId)),
    ...[...byPost].map(async ([postId, { ids, liked }]) => {
      const [likes, replies] = await Promise.all([store.likes(postId, liked), store.replyCounts(postId, ids)]);
      const likesOf = new Map(liked.map((id, i) => [id, likes[i]!]));
      ids.forEach((id, i) => counts.set(id, { likes: likesOf.get(id) ?? 0, replies: replies[i]! }));
    }),
  ]);
  return comments.map((comment) => toCommentRecord(comment, authors.get(comment.userId) ?? { userId: comment.userId, username: '' }, config.publicBaseUrl, counts.get(comment.commentId)));
}

/**
 * The records of a list as a reader who blocks `blocked` gets them (src/blocks.ts): a comment by
 * one of those users is a placeholder, with `status: "blocked"`. Like the placeholder of a
 * deleted comment it has no author, text, media, likes or declaration of AI, and keeps the
 * comment's place, its time and how many reply to it, so the tree is the one everyone else reads.
 * Nothing is stored for it: it is made as the list is answered, for that reader alone.
 */
export function hideBlocked(records: CommentRecord[], blocked: ReadonlySet<string>): CommentRecord[] {
  if (blocked.size === 0) return records;
  return records.map((record): CommentRecord => {
    if (record.author === null || !blocked.has(record.author.userId)) return record;
    // Nor whom it mentions, which is of its text.
    const { mentions, ...place } = record;
    return { ...place, author: null, text: '', aiGenerated: false, media: null, likes: 0, editedAt: null, status: 'blocked' };
  });
}

type RemovalDeps = Pick<AppDeps, 'db' | 'comments'>;

/**
 * Whether anything replies to a comment: a published comment, or the placeholder of one, or a
 * reply that waits in the moderation queue. One that waits is in no index, so those are found by
 * the post's rows in the queue, which are few. Not to be called inside a transaction: it reads
 * the database on its own.
 *
 * It reads the comment store, so it is the compactor's to ask, as it applies a removal: the
 * post's comments that were written before the removal are in the store by then, or still among
 * the post's pending writes, if one of theirs couldn't be applied or committed since the run
 * read them. A new reply takes no lock on its post, so one that read the comment before its
 * removal committed may commit after it: the run has waited for those (see awaitReplies), and
 * they are among the pending writes too. None begins later, as a comment takes no reply once its
 * removal has committed. A write that committed after the removal may also be of a reply the
 * comment had: an edit of one, or a held one that a moderator accepted, which is then out of the
 * queue and not published yet. So the post's pending writes are looked at as well.
 *
 * `without` is a comment whose own pending writes don't count: one that is being removed, and so
 * replies to nothing any more, though its rows are still there.
 */
export async function hasReplies({ db, comments }: RemovalDeps, postId: string, commentId: string, without?: string): Promise<boolean> {
  if ((await comments.count(postId, commentId)) > 0) return true;
  // The queue's rows before the pending writes: accepting a reply, or an edit of one, moves it from the one to the other in one commit, and so it is found in one of the two.
  const queued = await db.selectFrom('comment_queue').select('comment_id').where('content_id', '=', postId).where('comment_id', '!=', commentId).execute();
  const writes = await db.selectFrom('pending_writes').select('payload').where('content_id', '=', postId).where('kind', '=', 'comment_put').execute();
  const replies = (write: (typeof writes)[number]) => {
    const { comment } = payloadOf<CommentPutPayload>(write.payload);
    return comment.parentId === commentId && comment.commentId !== without;
  };
  if (writes.some(replies)) return true;
  for (const { comment_id: id } of queued) {
    if (id !== without && (await comments.getHeld(postId, id))?.parentId === commentId) return true;
  }
  return false;
}

/**
 * Removes the placeholder of a deleted comment that nothing replies to any more, and then that of
 * the comment it replied to, and so on up. The compactor's, after it removed a comment altogether:
 * that may have been the last reply to a deleted comment, whose placeholder then stands for nothing.
 * `without` is the comment that was removed (see hasReplies).
 */
export async function prune(deps: RemovalDeps, postId: string, parentId: string | undefined, without?: string): Promise<void> {
  const { comments } = deps;
  while (parentId !== undefined) {
    const parent: Comment | null = await comments.find(postId, parentId);
    if (parent?.gone !== 'deleted' || (await hasReplies(deps, postId, parentId, without))) return;
    await comments.remove(postId, parentId, { comment: parent });
    parentId = parent.parentId;
  }
}

/**
 * Removes a comment for good, published or waiting in the moderation queue, and nothing that
 * replies to it. All of it is one commit, and nothing is written to the comment store: the
 * removal is a row of `pending_writes`, with a number among the post's writes, and with it go the
 * comment's rows in the two queues, so neither lists a comment that is gone. The compactor's next
 * run removes the comment, its likes and its image or video; if something replies to it then, a
 * placeholder is left in its place, which keeps its replies where they are, and if nothing does,
 * nothing of it is left (see applyPending). From the commit on, the comment is gone to whoever
 * asks for it, takes no reply, no like and no edit, and no later write brings it back.
 *
 * `post` is the post's row and `seen` the comment as the request read them, in that order (see
 * writePending). `first`, if given, runs in the transaction before anything is written, and
 * refuses the removal by throwing. Returns the comment that was removed, as it was when the
 * removal committed, or null for one that was gone by then, which changes nothing. 404 for a
 * post that is set for deletion: its comments go with it.
 */
export async function removeComment(
  { db, comments, now = Date.now }: Pick<AppDeps, 'db' | 'comments' | 'now'>,
  post: { id: string; seq: number },
  commentId: string,
  seen: EffectiveComment | null,
  first?: (trx: Transaction<Database>) => Promise<void>,
): Promise<Comment | null> {
  return writePending(
    db,
    post.id,
    { seq: post.seq, state: seen },
    (reader) => effectiveComment(reader, comments, post.id, commentId),
    async (trx, seq, state) => {
      await first?.(trx);
      await removeCommentRows(trx, post.id, commentId);
      if (!state) return null;
      const { parentId } = state.comment;
      await insertPending(trx, { contentId: post.id, seq, kind: 'comment_remove', commentId, payload: { ...(parentId !== undefined && { parentId }) }, at: now() });
      return state.comment;
    },
  );
}

/** Takes a comment out of the two queues: the row that says it waits in one, and the reports of it. */
export async function removeCommentRows(db: Pick<AppDeps['db'], 'deleteFrom'>, postId: string, commentId: string): Promise<void> {
  await db.deleteFrom('comment_queue').where('comment_id', '=', commentId).where('content_id', '=', postId).execute();
  await db.deleteFrom('comment_reports').where('comment_id', '=', commentId).where('content_id', '=', postId).execute();
}
