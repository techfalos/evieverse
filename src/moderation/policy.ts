import type { AuthUser } from '../auth/apiKey.js';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { forbidden, unprocessable } from '../http/errors.js';
import { msg } from '../language.js';
import { routeOf, trustOf, type TrustPlugin, type TrustRoute } from './trust.js';
import { WordScanner } from './words.js';

/** Why a post didn't get a hashtag: the publisher is muted on it, a moderator removed it from this content, or its blocked words. */
type RemovalReason = 'muted' | 'removed' | 'blocked_word';
export interface RemovedTag {
  tag: string;
  reason: RemovalReason;
}

/** Whether `user` can moderate `tag`: an admin, or one of the tag's moderators. */
export async function moderates(db: Db, user: AuthUser, tag: string): Promise<boolean> {
  if (user.admin) return true;
  const row = await db.selectFrom('tag_moderators').select('tag').where('tag', '=', tag).where('user_id', '=', user.id).executeTakeFirst();
  return row !== undefined;
}

/**
 * Whether `user` works through the server's moderation queue: reads it and the content that waits
 * in it, and accepts or rejects that content. And through its report queue: accepts or deletes the
 * content users reported. A server moderator, or an admin.
 */
export const moderatesServer = (user: AuthUser): boolean => user.admin || user.moderator;

/**
 * Refuses (403) a user who was banned: what writes a post, a comment or a message, or a link to
 * upload a post's file with, is not for them. Reading, their inbox, their own posts' deletion and
 * their own account (its settings, its key, its deletion) are.
 */
export function refuseBanned(user: AuthUser): void {
  if (user.banned) throw forbidden(msg('user.banned'));
}

/** Makes a user an admin, or not; null if there's no such user. A userId wins over a username that happens to look like one. */
export async function setAdmin(db: Db, user: string, admin: boolean): Promise<{ userId: string; username: string } | null> {
  const select = db.selectFrom('users').select(['id', 'username']).where('deleted_at', 'is', null);
  const row = (await select.where('id', '=', user).executeTakeFirst()) ?? (await select.where('username', '=', user).executeTakeFirst());
  if (!row) return null;
  await db.updateTable('users').set({ admin: admin ? 1 : 0 }).where('id', '=', row.id).execute();
  return { userId: row.id, username: row.username };
}

/** What moderation of a post or a comment works with: the database, the settings, and the trust plugins. */
export interface ModerationDeps {
  db: Db;
  config: Config;
  trustPlugins: TrustPlugin[];
  now?: () => number;
}

/**
 * Moderation of a new comment by `userId` on the post `contentId`, or of an edit of one. It goes
 * through the gate a post does: the same trust plugins give it a score, each told it is a comment
 * (`commentOn`), and the same thresholds say where the score sends it (see routeOf). What there
 * is of it to read is its text, and the name of the image or video it comes with (`filename`), as
 * a post's caption and filename are. Throws 422 for a comment whose score has it deleted: nothing
 * of it is stored.
 *
 * That is all of it. A comment has no hashtags, so what a hashtag's moderators keep (its blocked
 * words, its mutes) doesn't reach the comments on posts under it: they have no say over comments.
 */
export async function moderateComment(
  { db, config, trustPlugins, now = Date.now }: ModerationDeps,
  comment: { userId: string; contentId: string; text: string; filename?: string | null },
): Promise<{ trustScore: number; route: Exclude<TrustRoute, 'delete'> }> {
  const texts = [comment.text, comment.filename].filter((text): text is string => !!text);
  const trust = await trustOf(trustPlugins, { userId: comment.userId, commentOn: comment.contentId, tags: [], texts }, { db, config, now });
  const route = routeOf(trust.score, config.trust);
  if (route === 'delete') throw unprocessable(trust.reason ?? msg('comment.not_trusted'));
  return { trustScore: trust.score, route };
}

export interface Moderated {
  /** The hashtags the post gets. */
  tags: string[];
  /** Those it doesn't, with why. */
  removedTags: RemovedTag[];
  /** How far the server trusts the post (see trustOf). Kept only with a post that waits in the moderation queue. */
  trustScore: number;
  /** Where the score sends the post: to the moderation queue, or straight to the feeds. */
  route: Exclude<TrustRoute, 'delete'>;
}

/**
 * Moderation of a new post, or of an update of `contentId`, by `userId` with `tags`. `texts` is what
 * there is of it to read: its text or caption, link, and filename.
 *
 * The post is given a trust score by the trust plugins, each of which may lower it (see trustOf),
 * and the score says where the post goes (see routeOf; `config.trust` holds the thresholds). Throws
 * 422 for a post whose score has it deleted: nothing of it is stored.
 *
 * Returns the hashtags the post gets, and those it doesn't with why: one its publisher is muted on,
 * one a moderator removed from this content, and one whose blocked words it has. Hashtags are
 * scanned for blocked words too. Throws 422 if no hashtag is left.
 */
export async function moderatePost(
  { db, config, trustPlugins, now = Date.now }: ModerationDeps,
  post: { userId: string; contentId?: string; tags: string[]; texts: (string | null | undefined)[] },
): Promise<Moderated> {
  const { userId, contentId, tags } = post;
  const texts = post.texts.filter((text): text is string => !!text);
  const [trust, words, mutes, removals] = await Promise.all([
    trustOf(trustPlugins, { userId, contentId, tags, texts }, { db, config, now }),
    tags.length ? db.selectFrom('blocked_words').select(['tag', 'word']).where('tag', 'in', tags).execute() : [],
    tags.length ? db.selectFrom('tag_mutes').select('tag').where('user_id', '=', userId).where('tag', 'in', tags).execute() : [],
    contentId && tags.length
      ? db.selectFrom('tag_moderation').select('tag').where('content_id', '=', contentId).where('decision', '=', 'removed').where('tag', 'in', tags).execute()
      : [],
  ]);
  const route = routeOf(trust.score, config.trust);
  if (route === 'delete') throw unprocessable(trust.reason ?? msg('moderation.not_trusted'));

  const lists = new Map<string, string[]>();
  for (const { tag, word } of words) {
    const list = lists.get(tag);
    if (list) list.push(word);
    else lists.set(tag, [word]);
  }
  const muted = new Set(mutes.map((r) => r.tag));
  const removed = new Set(removals.map((r) => r.tag));
  // With no hashtag's list that applies to the post, nothing needs reading.
  const scanner = lists.size ? new WordScanner(lists) : null;
  for (const text of [...texts, ...tags]) scanner?.scan(text);

  const removedTags: RemovedTag[] = [];
  const kept = tags.filter((tag) => {
    const reason = muted.has(tag) ? 'muted' : removed.has(tag) ? 'removed' : scanner?.matched.has(tag) ? 'blocked_word' : null;
    if (reason) removedTags.push({ tag, reason });
    return !reason;
  });
  if (!kept.length) throw unprocessable(msg('moderation.no_tags_left'), { removedTags });
  return { tags: kept, removedTags, trustScore: trust.score, route };
}
