import type { Comment, ContentMeta } from './storage/index.js';

/**
 * What a `post` row of `pending_writes` holds: the post's meta file as the write made it, which
 * the compactor writes with the hashtags settled (see applyPending). A text post's text and a
 * link's URL are in it, and are what the compactor writes as the post's bytes; a file's bytes
 * wait under the row's `staged_key`.
 */
export interface PostPayload {
  meta: ContentMeta;
}

/**
 * What a `comment_put` row holds: the comment as it is from this write on, new, edited or
 * accepted, and whether it waits in the moderation queue (`held`) or is published.
 */
export interface CommentPutPayload {
  comment: Comment;
  held: boolean;
}

/**
 * What a `comment_remove` row holds: the comment that the removed one replied to, if it was a
 * reply. The compactor goes by it once the comment is gone, to take away the placeholder of a
 * deleted comment that this was the last reply to (see prune).
 */
export interface CommentRemovePayload {
  parentId?: string;
}

/** What a `comment_like` row holds: who likes the comment the row names. */
export interface CommentLikePayload {
  userId: string;
}

/** The newest write of a post that the compactor hasn't applied yet. */
export interface PendingPost {
  seq: number;
  meta: ContentMeta;
  /** Where the file it came with waits; null for a text or a link, and for a repost of a post on another server. */
  stagedKey: string | null;
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

/** A row to add to `pending_writes`, as insertPending takes it. */
export interface PendingWrite {
  contentId: string;
  /** The one nextSeq gave this write. */
  seq: number;
  kind: 'post' | 'comment_put' | 'comment_remove' | 'comment_like';
  commentId?: string;
  payload?: PostPayload | CommentPutPayload | CommentRemovePayload | CommentLikePayload;
  stagedKey?: string | null;
  at: number;
}
