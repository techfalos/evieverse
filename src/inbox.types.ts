import type { NoticeKind } from './inbox.js';

/** A row of `inbox` with its sender's username, as the inbox's list and a user's export read it (see inboxItem). */
export interface InboxRow {
  id: string;
  kind: string;
  sender_id: string | null;
  /** The sender's username; null on a notice that has no sender (any but a mention's), and for a sender whose account is gone. */
  username: string | null;
  content_id: string | null;
  comment_id: string | null;
  tag: string | null;
  body: string | null;
  created_at: number;
  read_at: number | null;
}

/** A notice to leave in a user's inbox, as the route that did what it reports gives it to `notify`. */
export interface Notice {
  /** Whose inbox it goes to: the publisher of the post, the author of the comment, or the user who was muted or banned. */
  userId: string;
  kind: NoticeKind;
  /** Who did what the notice reports. The notice doesn't name them; nobody is told of what they did themselves. */
  by: string;
  /** The post it is about, or the post the comment it is about is on. */
  contentId?: string;
  /** The hashtag it is about. */
  tag?: string;
  /** The comment it is about, which the notice quotes the start of in place of the post's. */
  comment?: string;
}
