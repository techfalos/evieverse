import type { Comment, ContentMeta } from './storage/index.js';

/**
 * What a `post` row of `pending_writes` holds: the post's meta file as the write made it, which
 * the compactor writes with the hashtags settled (see applyPending). A text post's text and a
 * link's URL are in it, and are what the compactor writes as the post's bytes; a file's bytes
 * wait under the row's `staged_key`. An image post of several images has a file for each: the
 * first waits under the post's row, and each of the others under a `post_file` row of its own,
 * which has the write's number and holds nothing else.
 */
export interface PostPayload {
  meta: ContentMeta;
  /**
   * The write's file is a video that is yet to be processed (src/video): the staged file is the
   * one that was sent, and `meta` describes that. The compactor leaves the write, and readers
   * are given nothing of the file, until the video worker has put the processed file in the
   * row and taken this off, in one commit. It is in the row, not beside it, so that whoever
   * reads the row reads with it whether it is ready.
   */
  process?: true;
  /**
   * The write has no file of its own, and the post keeps the bytes it has: what the video
   * worker makes of an update whose new video couldn't be processed. `meta` then describes the
   * video the post had, with whatever else the update said, and the compactor writes no bytes.
   */
  keepBytes?: true;
}

/**
 * What a `comment_put` row holds: the comment as it is from this write on, new, edited or
 * accepted, and whether it waits in the moderation queue (`held`) or is published.
 */
export interface CommentPutPayload {
  comment: Comment;
  held: boolean;
  /**
   * On the write that made a comment with a video that is yet to be processed, as on a post's
   * (see PostPayload.process): the compactor leaves every write of the comment, and of its
   * replies, until the video worker has taken this off.
   */
  process?: true;
}

/**
 * What a `comment_remove` row holds: the comment that the removed one replied to, if it was a
 * reply. The compactor goes by it once the comment is gone, to take away the placeholder of a
 * deleted comment that this was the last reply to (see prune).
 */
export interface CommentRemovePayload {
  parentId?: string;
}

/**
 * What a `comment_like` row holds: whose like of the comment the row names it is about, and
 * whether it makes the like or takes it back. A user has one such row for a comment at most,
 * which says what they last asked for.
 */
export interface CommentLikePayload {
  userId: string;
  /** The row takes the user's like back. Left out of a like, which is what a row from before likes could be taken back is. */
  unlike?: true;
}

/**
 * A user's like of a comment as a row of `pending_writes` has it: what the user last asked for,
 * which the compactor hasn't applied yet.
 */
export interface PendingLike {
  /** Whether the user likes the comment by it: false for a row that takes the like back. */
  liked: boolean;
}

/** The newest write of a post that the compactor hasn't applied yet. */
export interface PendingPost {
  seq: number;
  meta: ContentMeta;
  /** Where the file it came with waits, the first of an image post's images; null for a text or a link, and for a repost of a post on another server. */
  stagedKey: string | null;
  /** Its file is a video that is yet to be processed (see PostPayload.process): the staged file is as it was sent, and isn't served. */
  processing: boolean;
}

/** Where the image or video of a comment waits, for a comment whose first write the compactor hasn't applied yet. */
export interface PendingCommentFile {
  stagedKey: string;
  /** It is a video that is yet to be processed (see CommentPutPayload.process), and isn't served. */
  processing: boolean;
}

/**
 * The newest write of a comment that the compactor hasn't applied yet, likes aside: what puts it
 * as it is from then on, or what removes it.
 */
export interface PendingComment {
  seq: number;
  /** What the comment is from this write on; null for a removal. */
  put: CommentPutPayload | null;
}

/**
 * A comment as it is with every write of it that has committed, applied or not: published, or
 * waiting in the moderation queue (`held`).
 */
export interface EffectiveComment {
  comment: Comment;
  held: boolean;
}

/** A numbered row to add to `pending_writes`, as insertPending takes it. */
export interface PendingWrite {
  contentId: string;
  /** The one nextSeq gave this write. */
  seq: number;
  kind: 'post' | 'post_file' | 'comment_put' | 'comment_remove' | 'comment_like';
  /**
   * On a `post_file` row, which has the number of the post's write it belongs to: the place of
   * its image among the post's images, counted from 1. It is what tells the row from the
   * write's others (see `pending_writes.write_key`).
   */
  image?: number;
  commentId?: string;
  payload?: PostPayload | CommentPutPayload | CommentRemovePayload | CommentLikePayload;
  stagedKey?: string | null;
  at: number;
}

/**
 * A row to add to `pending_writes` that takes no number (see writeUnnumbered): a new comment, or
 * a like of a comment, made or taken back.
 */
export interface UnnumberedWrite extends Omit<PendingWrite, 'seq' | 'kind' | 'image' | 'commentId'> {
  /** What tells it apart from its post's other unnumbered writes: the comment's id for a new comment, likeKey for a like. */
  key: string;
  kind: 'comment_put' | 'comment_like';
  commentId: string;
  /** On a like: what the row adds to the number of likes the store has of the comment (see `pending_writes.net`). */
  net?: number;
}
