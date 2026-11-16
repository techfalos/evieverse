/** A comment on a post, as it is stored. */
export interface Comment {
  /** A UUIDv7 (see newCommentId): the order of a post's comment ids is the order they were sent in. */
  commentId: string;
  /** The post it is on. */
  contentId: string;
  /** The comment it replies to, which is on the same post. Absent on a comment on the post itself. */
  parentId?: string;
  /** Who wrote it. */
  userId: string;
  /** What it says. Empty for one that is only its image or video. */
  text: string;
  /** The image or video it came with, whose bytes are an object of their own (see commentMediaKey). Absent on one that is only text. */
  media?: CommentMedia;
  /** When it was sent. UTC epoch milliseconds. */
  createdAt: number;
  /** When its author last changed its text. Absent on one that was never edited. */
  editedAt?: number;
  /**
   * Set on what stands in a comment's place among the post's published comments once the comment
   * is gone from there (see placeholder): `deleted`, for good, or `held`, taken back to the
   * moderation queue by an edit. Absent on a comment.
   */
  gone?: 'deleted' | 'held';
}

/** What a comment says of the image or video it came with. */
export interface CommentMedia {
  kind: 'image' | 'video';
  mimeType: string;
  /** Of the bytes, as stored. */
  size: number;
}

/**
 * Which comments a page holds: so many of the comments on the post itself, or of the replies to
 * one comment, from the first or from the last, after the one the page before ended on.
 */
export interface CommentPageQuery {
  order: 'oldest' | 'newest';
  limit: number;
  /** The id of the last comment of the page before. */
  cursor?: string;
  /** The comment whose replies the page is of. Absent: the comments on the post itself. */
  parentId?: string;
}
