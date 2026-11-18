/**
 * A user a text mentions, as the text names them: `@` and then `username`, which is the name the
 * user had when the text was written. `userId` is who that was, and where the mention leads
 * (GET /users/:userId), whatever they are called by now, and whoever has the name since.
 */
export interface Mention {
  userId: string;
  username: string;
}

/** A text that was published, with the users it mentions, as the route that published it gives it to `notifyMentions`. */
export interface Mentioning {
  /** Who wrote the text: the post's publisher, or the comment's author. Nobody is told of a mention they made of themselves. */
  by: string;
  /** The post the text is, or the post the comment is on. */
  contentId: string;
  /** The comment the text is. Absent: the text is the post's own, or its caption. */
  commentId?: string;
  /** The text's mentions, as they are kept beside it (see resolveMentions). */
  mentions: readonly Mention[] | undefined;
  /**
   * The mentions of the text this one replaces, if that was published: an update of a post, or
   * an edit of a comment. Those users were told then, and aren't told again.
   */
  before?: readonly Mention[];
  /** The start of the text, as the notice quotes it (see excerpt in src/inbox.ts). */
  excerpt: string | null;
}
