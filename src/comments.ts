import { randomBytes } from 'node:crypto';
import type { AppDeps } from './deps.js';
import type { Comment, CommentMedia, Publisher } from './storage/index.js';
import { iso } from './time.js';

/**
 * Comments on posts: a text, an image or a video, or a text with one of the two. A post takes them
 * if its publisher said so (the `comments` flag of /store, in the post's meta file). A comment is
 * on the post or replies to another comment on it, so a post's comments are a tree, of any depth.
 * Its author can edit its text, and any user can like it, once.
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
 */

/** The longest a comment can be. */
export const MAX_COMMENT_CHARS = 2000;

/** The most `seq` holds: the 12 bits a UUIDv7 has between its time and its random part. */
const MAX_SEQ = 0xfff;

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
  if (seq > MAX_SEQ) {
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

/**
 * A comment as responses give it: its author's credit first, as a post's publisher's is.
 *
 * A placeholder (see above) is given as a comment too, in the place its comment had:
 * with `status`, no author, no text, no image or video and no likes, and with the replies it has.
 */
export interface CommentRecord {
  commentId: string;
  /** The post it is on. */
  contentId: string;
  /** The comment it replies to; null for a comment on the post itself. */
  parentId: string | null;
  /** Who wrote it; null on a placeholder. */
  author: Publisher | null;
  /** What it says; empty for one that is only its image or video. */
  text: string;
  /** The image or video it came with, and where its bytes are read; null for one that is only text. */
  media: (CommentMedia & { url: string }) | null;
  /** How many users liked it. */
  likes: number;
  /** How many comments reply to it: to it, not to its replies. */
  replies: number;
  createdAt: string;
  /** When its author last changed its text; null for one that was never edited. */
  editedAt: string | null;
  /**
   * Absent on a published comment. On a placeholder, why the comment isn't there: `deleted`, or
   * `pending_review` for one an edit took back to the moderation queue. Also `pending_review` on
   * a comment that waits there, as its author and the queue's moderators read it: whole.
   */
  status?: 'deleted' | 'pending_review';
}

/** What a comment's record says that the comment itself doesn't hold; a comment just sent has none of either. */
export interface CommentCounts {
  likes: number;
  replies: number;
}

/** Where the bytes of a comment's image or video are read, as a post's are at /content/:contentId/raw. */
export const commentMediaUrl = (publicBaseUrl: string, postId: string, commentId: string) => `${publicBaseUrl}/content/${postId}/comments/${commentId}/raw`;

export function toCommentRecord(comment: Comment, author: Publisher, publicBaseUrl: string, { likes, replies }: CommentCounts = { likes: 0, replies: 0 }): CommentRecord {
  const place = { commentId: comment.commentId, contentId: comment.contentId, parentId: comment.parentId ?? null };
  const createdAt = iso(comment.createdAt);
  // A placeholder: where the comment was, how many reply to it, and why it isn't there.
  if (comment.gone) {
    return { ...place, author: null, text: '', media: null, likes: 0, replies, createdAt, editedAt: null, status: comment.gone === 'deleted' ? 'deleted' : 'pending_review' };
  }
  return {
    ...place,
    author,
    text: comment.text,
    // The link isn't stored: it is built when read, as a post's is.
    media: comment.media ? { kind: comment.media.kind, url: commentMediaUrl(publicBaseUrl, comment.contentId, comment.commentId), mimeType: comment.media.mimeType, size: comment.media.size } : null,
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
 * Publishes a comment that waits in the moderation queue, as it is given: one that was accepted
 * there, or that its author edited into something the server publishes. Returns whether it was
 * published.
 *
 * A reply is published under the comment it replies to, or under the placeholder that stands in
 * its place: one that was deleted while the reply waited, or that itself waits in the queue by
 * now, taken back there by an edit. Only where nothing is left of that comment, not a placeholder
 * either, is there nowhere to list the reply, and it is removed. Nothing leaves a reply so but a
 * reply sent in the very moment its comment was being deleted, each before the other could see
 * it (see removeComment).
 */
export async function publishComment({ comments }: Pick<AppDeps, 'comments'>, comment: Comment): Promise<boolean> {
  const { contentId: postId, commentId, parentId } = comment;
  if (parentId !== undefined && !(await comments.find(postId, parentId))) {
    await comments.remove(postId, commentId, { comment });
    return false;
  }
  await comments.publish(comment);
  return true;
}

type RemovalDeps = Pick<AppDeps, 'db' | 'comments'>;

/**
 * Whether anything replies to a comment: a published comment, or the placeholder of one, or a
 * reply that waits in the moderation queue. One that waits is in no index, so those are found by
 * the post's rows in the queue, which are few. Not to be called inside a transaction: it reads
 * the database on its own.
 */
export async function hasReplies({ db, comments }: RemovalDeps, postId: string, commentId: string): Promise<boolean> {
  if ((await comments.count(postId, commentId)) > 0) return true;
  const waiting = await db.selectFrom('comment_queue').select('comment_id').where('content_id', '=', postId).where('comment_id', '!=', commentId).execute();
  for (const { comment_id: id } of waiting) {
    if ((await comments.getHeld(postId, id))?.parentId === commentId) return true;
  }
  return false;
}

/**
 * The removal of one comment, in the two steps a caller may have work to do between (see
 * removeComment, which is both).
 */
export interface CommentRemoval {
  /** Removes the comment from the store, leaving a placeholder if something replies to it. It touches no database. */
  remove(): Promise<void>;
  /** What follows: see commentRemoval. Not to be called inside a transaction. */
  finish(): Promise<void>;
}

/**
 * Plans the removal of a comment, published or waiting in the moderation queue: that comment, its
 * likes and its image or video, and none of the comments that reply to it. If something replies
 * to it (see hasReplies), a placeholder is left in its place, which keeps its replies where they
 * are; if nothing does, nothing of it is left. Not to be called inside a transaction.
 *
 * `finish` then looks again, since the store has no transactions:
 * - a comment removed altogether that got a reply meanwhile is given a placeholder after all;
 * - a comment removed altogether may have been the last reply to a deleted comment, whose
 *   placeholder then stands for nothing: it is removed too, and so on up.
 */
export async function commentRemoval(deps: RemovalDeps, postId: string, commentId: string): Promise<CommentRemoval> {
  const { comments } = deps;
  const comment = (await comments.find(postId, commentId)) ?? (await comments.getHeld(postId, commentId));
  const keepPlace = await hasReplies(deps, postId, commentId);
  return {
    remove: () => comments.remove(postId, commentId, { keepPlace, comment }),
    async finish() {
      if (keepPlace) return;
      if (comment && (await hasReplies(deps, postId, commentId))) await comments.remove(postId, commentId, { keepPlace: true, comment });
      else await prune(deps, postId, comment?.parentId);
    },
  };
}

/** Removes the placeholder of a deleted comment that nothing replies to any more, and then that of the comment it replied to, and so on up. */
async function prune(deps: RemovalDeps, postId: string, parentId: string | undefined): Promise<void> {
  const { comments } = deps;
  while (parentId !== undefined) {
    const parent: Comment | null = await comments.find(postId, parentId);
    if (parent?.gone !== 'deleted' || (await hasReplies(deps, postId, parentId))) return;
    await comments.remove(postId, parentId, { comment: parent });
    parentId = parent.parentId;
  }
}

/**
 * Removes a comment for good, published or waiting in the moderation queue, and nothing that
 * replies to it (see commentRemoval): its rows in the two queues first, so neither lists a comment
 * that is gone, then the comment. Removing one that isn't there changes nothing. Not to be called
 * inside a transaction.
 */
export async function removeComment(deps: RemovalDeps, postId: string, commentId: string): Promise<void> {
  const removal = await commentRemoval(deps, postId, commentId);
  await removeCommentRows(deps.db, postId, commentId);
  await removal.remove();
  await removal.finish();
}

/** Takes a comment out of the two queues: the row that says it waits in one, and the reports of it. */
export async function removeCommentRows(db: AppDeps['db'], postId: string, commentId: string): Promise<void> {
  await db.deleteFrom('comment_queue').where('comment_id', '=', commentId).where('content_id', '=', postId).execute();
  await db.deleteFrom('comment_reports').where('comment_id', '=', commentId).where('content_id', '=', postId).execute();
}
