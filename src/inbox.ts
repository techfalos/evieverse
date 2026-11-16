import { randomUUID } from 'node:crypto';
import type { AppDeps } from './deps.js';
import { plainText } from './format.js';
import type { MessageKey } from './language.js';
import type { ContentMeta } from './storage/index.js';

/**
 * A user's inbox (the table `inbox`) holds what they have been sent: the messages other users
 * wrote them, and the server's notices of what moderation did to their posts and of their mutes
 * on hashtags. This is what a notice is, and how one is left; the routes are in routes/inbox.ts.
 */

/** The longest message one user can send another, which is what `inbox.body` holds. */
export const MAX_MESSAGE_CHARS = 2000;

/** How much of a post a notice about it quotes, so its publisher can tell which it was once it is gone. */
const EXCERPT_CHARS = 200;

/**
 * The notices, each with the message that words it (the languages folder). A notice is stored as its kind
 * and what it is about, never as words: it is said in its reader's language when the inbox is read.
 *
 *   post_accepted      a server moderator or an admin accepted the post from the moderation queue
 *   post_rejected      ...or rejected it there, which deletes it
 *   post_deleted       an admin deleted the post
 *   tag_removed        a moderator of the hashtag removed it from the post
 *   last_tag_removed   ...and it was the post's last, so the post is in no hashtag's feed
 *   tag_muted          a moderator of the hashtag muted the user on it
 *   tag_unmuted        ...or ended the mute
 *   comment_accepted   a server moderator or an admin accepted the comment from the moderation queue
 *   comment_rejected   ...or rejected it there, which deletes it
 *   comment_deleted    someone other than its author deleted the comment: the post's publisher, an
 *                      admin, or a server moderator or an admin from the report queue
 *   user_banned        a server moderator or an admin banned the user
 *   user_unbanned      ...or ended the ban
 */
export const NOTICES = {
  post_accepted: 'notice.post_accepted',
  post_rejected: 'notice.post_rejected',
  post_deleted: 'notice.post_deleted',
  tag_removed: 'notice.tag_removed',
  last_tag_removed: 'notice.last_tag_removed',
  tag_muted: 'notice.tag_muted',
  tag_unmuted: 'notice.tag_unmuted',
  comment_accepted: 'notice.comment_accepted',
  comment_rejected: 'notice.comment_rejected',
  comment_deleted: 'notice.comment_deleted',
  user_banned: 'notice.user_banned',
  user_unbanned: 'notice.user_unbanned',
} as const satisfies Record<string, MessageKey>;

export type NoticeKind = keyof typeof NOTICES;

/** The `kind` of a message another user wrote; every other kind is a notice's. */
export const MESSAGE = 'message';

export const isNotice = (kind: string): kind is NoticeKind => Object.hasOwn(NOTICES, kind);

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

/**
 * The start of a text, as a notice quotes it. Null for no text at all. A `formatted` text (a post's,
 * a caption, a comment's) is quoted as it reads, without its formatting.
 */
function excerpt(text: string | null | undefined, formatted = true): string | null {
  if (!text) return null;
  // By code point, so the cut never splits a character in two.
  const chars = [...(formatted ? plainText(text) : text).replace(/\s+/g, ' ').trim()];
  if (!chars.length) return null;
  return chars.length > EXCERPT_CHARS ? `${chars.slice(0, EXCERPT_CHARS - 1).join('')}…` : chars.join('');
}

/** The start of a post, as a notice about it quotes it: its text or caption, or a link's URL. Null for a file without a caption. */
export function excerptOf(meta: Pick<ContentMeta, 'preview'> | null): string | null {
  if (!meta) return null;
  return meta.preview.kind === 'link' ? excerpt(meta.preview.url, false) : excerpt(meta.preview.text);
}

/**
 * Leaves a notice in a user's inbox. It reports what a moderation request has already done, so it
 * never fails that request: a notice that can't be left is logged, and lost.
 *
 * A notice about a post quotes its start, read from the post's meta file, which is still there
 * when the post has just been set for deletion: the compactor removes it later. A notice about a
 * comment quotes the comment's, which whoever leaves the notice passes on: by then it may be gone.
 */
export async function notify(
  { db, content, now = Date.now }: Pick<AppDeps, 'db' | 'content' | 'now'>,
  { userId, kind, by, contentId, tag, comment }: Notice,
  log: { warn: (o: object, msg?: string) => void },
): Promise<void> {
  if (by === userId) return;
  try {
    const body = comment !== undefined ? excerpt(comment) : contentId ? excerptOf(await content.getMeta(contentId)) : null;
    await db
      .insertInto('inbox')
      .values({ id: randomUUID(), user_id: userId, kind, sender_id: null, content_id: contentId ?? null, tag: tag ?? null, body, created_at: now(), read_at: null })
      .execute();
  } catch (err) {
    log.warn({ err, userId, kind, contentId, tag }, 'could not leave the notice in the inbox; the user is not told');
  }
}
