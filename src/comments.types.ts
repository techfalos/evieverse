import type { Mention } from './mentions.types.js';
import type { CommentMedia, Publisher } from './storage/index.js';

/**
 * A comment as responses give it: its author's credit first, as a post's publisher's is.
 *
 * A placeholder (see comments.ts) is given as a comment too, in the place its comment had:
 * with `status`, no author, no text, no declaration of AI, no image or video and no likes, and
 * with the replies it has.
 * So is a comment by a user its reader blocks, in the lists that reader is given.
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
  /**
   * The users `text` mentions, each with the name it has them by: what the text is read with, to
   * show each `@name` of theirs as a link to their profile (src/format.ts). Absent on a comment
   * that mentions nobody, and on a placeholder.
   */
  mentions?: Mention[];
  /**
   * Its author's declaration of whether it was created with AI, as a post's publisher makes one
   * of a post: nothing detects or checks it. False on a placeholder, which says nothing of the
   * comment.
   */
  aiGenerated: boolean;
  /** The image or video it came with, and where its bytes are read; null for one that is only text. */
  media: (CommentMedia & { url: string }) | null;
  /** How many users liked it. */
  likes: number;
  /** How many comments reply to it: to it, not to its replies. */
  replies: number;
  createdAt: string;
  /** When its author last edited it: changed its text, or what it declares of AI. Null for one that was never edited. */
  editedAt: string | null;
  /**
   * Absent on a published comment. On a placeholder, why the comment isn't there: `deleted`, or
   * `pending_review` for one an edit took back to the moderation queue. Also `pending_review` on
   * a comment that waits there, as its author and the queue's moderators read it: whole. And
   * `blocked`, in a list read by a user who blocks the comment's author: a placeholder made for
   * that reader alone (see hideBlocked).
   */
  status?: 'deleted' | 'pending_review' | 'blocked';
}

/** What a comment's record says that the comment itself doesn't hold; a comment just sent has none of either. */
export interface CommentCounts {
  likes: number;
  replies: number;
}
