import type { NoticeKind } from './inbox.js';

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
