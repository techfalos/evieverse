import { randomBytes } from 'node:crypto';
import type { AppDeps } from './deps.js';
import type { Comment, Publisher } from './storage/index.js';
import { iso } from './time.js';

/**
 * Comments on posts: flat, text only, written once and never edited. A post takes them if its
 * publisher said so (the `comments` flag of /store, in the post's meta file). They are objects in
 * the content store, with Redis as a cache over them (storage/commentStore.ts), and not in the
 * database, which holds only the ones that wait in the moderation queue or the report queue
 * (`comment_queue`, `comment_reports`). The routes are in routes/comments.ts, and the queues'
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

/** A comment as responses give it: its author's credit first, as a post's publisher's is. */
export interface CommentRecord {
  commentId: string;
  /** The post it is on. */
  contentId: string;
  author: Publisher;
  text: string;
  createdAt: string;
}

export const toCommentRecord = (comment: Comment, author: Publisher): CommentRecord => ({
  commentId: comment.commentId,
  contentId: comment.contentId,
  author,
  text: comment.text,
  createdAt: iso(comment.createdAt),
});

/** Comments as responses give them, each with its author's credit, read from Redis as feeds read publishers'. */
export async function toCommentRecords({ publishers }: Pick<AppDeps, 'publishers'>, comments: Comment[]): Promise<CommentRecord[]> {
  const authors = await publishers.getMany(comments.map((comment) => comment.userId));
  return comments.map((comment) => toCommentRecord(comment, authors.get(comment.userId) ?? { userId: comment.userId, username: '' }));
}

/**
 * Removes a comment for good, published or waiting in the moderation queue: its rows in the two
 * queues first, so neither lists a comment that is gone, then the comment itself. Removing one
 * that isn't there changes nothing.
 */
export async function removeComment({ db, comments }: Pick<AppDeps, 'db' | 'comments'>, postId: string, commentId: string): Promise<void> {
  await db.deleteFrom('comment_queue').where('comment_id', '=', commentId).where('content_id', '=', postId).execute();
  await db.deleteFrom('comment_reports').where('comment_id', '=', commentId).where('content_id', '=', postId).execute();
  await comments.remove(postId, commentId);
}
