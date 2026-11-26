import { randomUUID } from 'node:crypto';
import type { AppDeps } from './deps.types.js';
import { plainText } from './format.js';
import type { InboxRow, Notice } from './inbox.types.js';
import { msg, type MessageKey } from './language.js';
import type { Message } from './language.types.js';
import { effectiveMeta } from './pending.js';
import type { ContentMeta } from './storage/index.js';
import { iso } from './time.js';

/**
 * A user's inbox (the table `inbox`) holds what they have been sent: the messages other users
 * wrote them, and the server's notices of what moderation did to their posts, of their mutes
 * on hashtags, of the claims to moderate a hashtag (src/moderation/claims.ts), of being made a
 * hashtag's moderator or no longer being one (src/moderation/activity.ts), and of the posts
 * and comments that mention them (src/mentions.ts). This is what a
 * notice is, and how one is left; the routes are in routes/inbox.ts.
 */

/** The longest message one user can send another, which is what `inbox.body` holds. */
export const MAX_MESSAGE_CHARS = 2000;

/** How much of a post a notice about it quotes, so its publisher can tell which it was once it is gone. */
const EXCERPT_CHARS = 200;

/**
 * The notices, each with the message that words it (the languages folder). A notice is stored as its kind
 * and what it is about, never as words: it is said in its reader's language when the inbox is read.
 *
 *   post_held          the post's trust score sent it to the moderation queue, where it waits for a
 *                      server moderator or an admin: a new post, or one that was published until
 *                      this write of it. Left by the write that put it there (contentWriter's
 *                      write in src/write.ts, and the origin sweep's in compactor/src/write.rs),
 *                      and not by one of a post that waits there already
 *   post_accepted      a server moderator or an admin accepted the post from the moderation queue
 *   post_rejected      ...or rejected it there, which deletes it
 *   post_deleted       an admin deleted the post
 *   repost_removed     a server moderator or an admin removed the user's repost of the post
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
 *   csam_match_refused the pdq trust plugin found an image that matches its list of hashes of known
 *                      child sexual abuse material, and the post or comment was refused. Left for
 *                      every admin, by the plugin (compactor/crates/trust/src/plugins/pdq/report.rs): see DETAILED
 *   csam_match_held    ...or was stored, and waits in the moderation queue, on a server that deletes
 *                      nothing on arrival
 *   csam_video_refused the video worker found a video of which a picture matches that list
 *                      (compactor/crates/trust/src/plugins/pdq/video.rs), and the video was refused. Left for every
 *                      admin, as the two above are
 *   video_refused      the post's video matched, so the post was deleted: what its publisher is
 *                      told, which doesn't say why (as a refused image's sender isn't told)
 *   video_update_refused   ...or the update's video did, and the post keeps the one it had
 *   comment_video_refused  ...or the comment's video did, and the comment wasn't published
 *   post_mention       a post that was published mentions the user (`@` and their name, in its text
 *                      or caption). Left by notifyMentions (src/mentions.ts), with who published
 *                      it as the row's sender: see MENTIONS
 *   comment_mention    ...or a comment does, which the row names too (`comment_id`), with its author
 *                      as the sender
 *   claims_barred      a server moderator or an admin barred the user from claiming hashtags
 *   claims_unbarred    ...or let them claim hashtags again
 *   tag_claimed        a user claimed the hashtag, and moderates it now. Left for every admin and
 *                      server moderator (src/moderation/claims.ts), who can end that: see DETAILED
 *   tag_claim_granted  the user's claim to the hashtag went through. Left by no server any more: a
 *                      claim used to wait for an admin or a server moderator to refuse it, and
 *                      this is what words the notices of then that inboxes still hold
 *   tag_claim_refused  ...or it was refused, of which the same goes
 *   tag_moderator_added    an admin, or a moderator of the hashtag, made the user a moderator of it
 *   tag_moderator_removed  ...or one of them, or a server moderator, ended their time as one
 *   tag_moderator_lapsed   the user's time as a moderator of the hashtag ended by itself: they did
 *                          nothing as one for TAG_MODERATOR_INACTIVE_DAYS. Left by the compactor
 *                          (src/moderation/activity.ts)
 */
export const NOTICES = {
  post_held: 'notice.post_held',
  post_accepted: 'notice.post_accepted',
  post_rejected: 'notice.post_rejected',
  post_deleted: 'notice.post_deleted',
  repost_removed: 'notice.repost_removed',
  tag_removed: 'notice.tag_removed',
  last_tag_removed: 'notice.last_tag_removed',
  tag_muted: 'notice.tag_muted',
  tag_unmuted: 'notice.tag_unmuted',
  comment_accepted: 'notice.comment_accepted',
  comment_rejected: 'notice.comment_rejected',
  comment_deleted: 'notice.comment_deleted',
  video_failed: 'notice.video_failed',
  video_update_failed: 'notice.video_update_failed',
  comment_video_failed: 'notice.comment_video_failed',
  video_refused: 'notice.video_refused',
  video_update_refused: 'notice.video_update_refused',
  comment_video_refused: 'notice.comment_video_refused',
  user_banned: 'notice.user_banned',
  user_unbanned: 'notice.user_unbanned',
  claims_barred: 'notice.claims_barred',
  claims_unbarred: 'notice.claims_unbarred',
  csam_match_refused: 'notice.csam_match_refused',
  csam_match_held: 'notice.csam_match_held',
  csam_video_refused: 'notice.csam_video_refused',
  post_mention: 'notice.post_mention',
  comment_mention: 'notice.comment_mention',
  tag_claimed: 'notice.tag_claimed',
  tag_claim_granted: 'notice.tag_claim_granted',
  tag_claim_refused: 'notice.tag_claim_refused',
  tag_moderator_added: 'notice.tag_moderator_added',
  tag_moderator_removed: 'notice.tag_moderator_removed',
  tag_moderator_lapsed: 'notice.tag_moderator_lapsed',
} as const satisfies Record<string, MessageKey>;

export type NoticeKind = keyof typeof NOTICES;

/** The `kind` of a message another user wrote; every other kind is a notice's. */
export const MESSAGE = 'message';

/**
 * The notices that quote no post, and are of something that happened: their `body` is the facts
 * of it as JSON, each a text or a number. A response gives them as the notice's `details`, in
 * place of an excerpt, and the notice's message says them by their names ({username}, {at}).
 * The notice of a claim to a hashtag is one: who claimed it ({userId}, {username}).
 */
const DETAILED: ReadonlySet<string> = new Set<NoticeKind>(['csam_match_refused', 'csam_match_held', 'csam_video_refused', 'tag_claimed']);

/**
 * The notices of a file that matched the pdq plugin's list, whose facts name the item of the
 * quarantine the file is kept as (`quarantineId`) on a server that has one: their message then
 * goes on to say where an admin reads the file, and where they record the report of it.
 */
const QUARANTINED: ReadonlySet<string> = new Set<NoticeKind>(['csam_match_refused', 'csam_match_held', 'csam_video_refused']);

/**
 * The notices of a mention, which are the ones that have a sender: who wrote the post or the
 * comment that mentions the user. A response gives them as the notice's `from`, as a message's
 * is given, and the notice's message names them ({username}). Each is here with the message
 * that words it when it has no sender any more, since their account is gone.
 */
const MENTIONS = {
  post_mention: 'notice.post_mention_unnamed',
  comment_mention: 'notice.comment_mention_unnamed',
} as const satisfies Partial<Record<NoticeKind, MessageKey>>;

/** Whether the `kind` of an inbox row is a mention's (see MENTIONS). */
const isMention = (kind: string): kind is keyof typeof MENTIONS => Object.hasOwn(MENTIONS, kind);

/** Whether the `kind` of an inbox row is one of NOTICES, which has words to say it with. Not a message's, and not a kind this build doesn't know. */
export const isNotice = (kind: string): kind is NoticeKind => Object.hasOwn(NOTICES, kind);

/** The facts a notice's body holds, for a notice that holds them (see DETAILED). Null for any other, and for a body that isn't an object of them. */
function detailsOf({ kind, body }: Pick<InboxRow, 'kind' | 'body'>): Record<string, string | number> | null {
  if (!DETAILED.has(kind) || body === null) return null;
  try {
    const facts: unknown = JSON.parse(body);
    if (typeof facts !== 'object' || facts === null || Array.isArray(facts)) return null;
    return Object.fromEntries(Object.entries(facts).filter((fact): fact is [string, string | number] => typeof fact[1] === 'string' || typeof fact[1] === 'number'));
  } catch {
    return null;
  }
}

/**
 * What is in an inbox, as responses give it: the inbox's own list, and its user's export. A
 * message has who wrote it and its text. A notice has its kind, the post and hashtag it is
 * about, the start of that post, and what it says, which `say` puts in its reader's language.
 * One that holds facts in place of a post's start (see DETAILED) has them as `details`. The
 * notice of a mention has who made it (`from`, as a message has), the post it is in, the comment
 * if it is in one (`commentId`), and the start of the text that mentions the user.
 */
export function inboxItem(r: InboxRow, say: (text: Message) => string) {
  const details = detailsOf(r);
  const times = { sentAt: iso(r.created_at), readAt: r.read_at === null ? null : iso(r.read_at) };
  // No sender: their account is gone.
  const from = r.sender_id !== null && r.username !== null ? { userId: r.sender_id, username: r.username } : null;
  if (r.kind === MESSAGE) {
    return {
      messageId: r.id,
      kind: r.kind,
      from,
      text: r.body ?? '',
      ...times,
    };
  }
  // A notice is worded by its kind, and a mention whose sender is gone in words that name nobody.
  const key = !isNotice(r.kind) ? null : isMention(r.kind) && !from ? MENTIONS[r.kind] : NOTICES[r.kind];
  const params = { ...details, tag: r.tag ?? '', ...(from && { username: from.username }) };
  // A match whose file is kept says where, after what it says of the match.
  const kept = QUARANTINED.has(r.kind) && details?.quarantineId !== undefined ? ` ${say(msg('notice.csam_match_quarantined', params))}` : '';
  return {
    messageId: r.id,
    kind: r.kind,
    ...(isMention(r.kind) && { from }),
    ...(r.content_id !== null && { contentId: r.content_id }),
    ...(r.comment_id !== null && { commentId: r.comment_id }),
    ...(r.tag !== null && { tag: r.tag }),
    ...(details ? { details } : r.body !== null && { excerpt: r.body }),
    // A kind this build doesn't know (left by a newer one) is shown by its name.
    text: key ? `${say(msg(key, params))}${kept}` : r.kind,
    ...times,
  };
}

/**
 * The start of a text, as a notice quotes it. Null for no text at all. A `formatted` text (a post's,
 * a caption, a comment's) is quoted as it reads, without its formatting.
 */
export function excerpt(text: string | null | undefined, formatted = true): string | null {
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
 * A notice about a post quotes its start, read from the post's meta file (as its newest write
 * made it: see effectiveMeta), which is still there when the post has just been set for
 * deletion: the compactor removes it later. A notice about a
 * comment quotes the comment's, which whoever leaves the notice passes on: by then it may be gone.
 */
export async function notify(
  { db, content, now = Date.now }: Pick<AppDeps, 'db' | 'content' | 'now'>,
  { userId, kind, by, contentId, tag, comment }: Notice,
  log: { warn: (o: object, msg?: string) => void },
): Promise<void> {
  if (by === userId) return;
  try {
    await db
      .insertInto('inbox')
      .values({
        id: randomUUID(),
        user_id: userId,
        kind,
        sender_id: null,
        content_id: contentId ?? null,
        tag: tag ?? null,
        body: comment !== undefined ? excerpt(comment) : contentId ? excerptOf(await effectiveMeta(db, content, contentId)) : null,
        created_at: now(),
        read_at: null,
      })
      .execute();
  } catch (err) {
    log.warn({ err, userId, kind, contentId, tag }, 'could not leave the notice in the inbox; the user is not told');
  }
}
