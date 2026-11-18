import type { Mention } from '../mentions.types.js';

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
  /** The users `text` mentions, as a post's meta file has its own (see ContentMeta.mentions). Absent on one that mentions nobody. */
  mentions?: Mention[];
  /** Its author's declaration that it was created with AI, as a post's publisher makes one of a post: true on one declared so. Absent on one that wasn't. */
  aiGenerated?: boolean;
  /** The image or video it came with, whose bytes are an object of their own (see commentMediaKey). Absent on one that is only text. */
  media?: CommentMedia;
  /** When it was sent. UTC epoch milliseconds. */
  createdAt: number;
  /** When its author last edited it: changed its text, or what it declares of AI. Absent on one that was never edited. */
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
  /** An image's alternative text, which describes it to those who can't see it. Absent on an image sent with none, and on a video. */
  alt?: string;
}

/** What a mark in a user's index of comments names (see CommentStore): a comment the user wrote, or one they liked, and the post it is on. */
export interface CommentMark {
  commentId: string;
  postId: string;
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
