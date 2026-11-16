import type { FastifyBaseLogger } from 'fastify';
import type { AuthUser } from '../auth/apiKey.types.js';
import type { Db } from '../db/index.js';
import { plainText } from '../format.js';
import { forbidden, unprocessable } from '../http/errors.js';
import { msg } from '../language.js';
import type { Moderated, ModerationDeps, RemovedTag } from './policy.types.js';
import { routeOf, trustOf, type TrustRoute } from './trust.js';
import { scanTexts } from './words.js';

/**
 * Whether `user` works through the server's moderation queue: reads it and the content that waits
 * in it, and accepts or rejects that content. And through its report queue: accepts or deletes the
 * content users reported. A server moderator, or an admin. Both moderate every hashtag too (see
 * moderates).
 */
export const moderatesServer = (user: AuthUser): boolean => user.admin || user.moderator;

/**
 * Whether `user` can moderate `tag`: an admin or a server moderator, who moderate every hashtag
 * and need no row for it, or one of the tag's moderators.
 */
export async function moderates(db: Db, user: AuthUser, tag: string): Promise<boolean> {
  if (moderatesServer(user)) return true;
  return (await db.selectFrom('tag_moderators').select('tag').where('tag', '=', tag).where('user_id', '=', user.id).executeTakeFirst()) !== undefined;
}

/**
 * Refuses (403) a user who was banned: what writes a post, a comment or a message, likes a post or
 * a comment, or gives a link to upload a post's file with, is not for them. Reading, their inbox,
 * their own posts' deletion and their own account (its settings, its key, its deletion) are.
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
  { db, config, trustPlugins, now = Date.now, log }: ModerationDeps,
  comment: { userId: string; contentId: string; text: string; filename?: string | null },
): Promise<{ trustScore: number; route: Exclude<TrustRoute, 'delete'> }> {
  const trust = await trustOf(
    trustPlugins,
    {
      userId: comment.userId,
      commentOn: comment.contentId,
      tags: [],
      // Its text as its readers read it: without its formatting, with where its links lead (format.ts).
      texts: [plainText(comment.text, true), comment.filename].filter((text): text is string => !!text),
    },
    { db, config, now, log },
  );
  const route = routeOf(trust.score, config.trust);
  if (route === 'delete') throw unprocessable(trust.reason ?? msg('comment.not_trusted'));
  return { trustScore: trust.score, route };
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
 * one a moderator removed from this content, and one whose blocked words it has, or whose blocked
 * patterns match it. Hashtags are scanned for blocked words too. Throws 422 if a new post is left
 * with no hashtag, since it needs one to be published under. An update can be: the content is
 * there already, and stays, in no hashtag's feed.
 */
export async function moderatePost(
  { db, config, trustPlugins, now = Date.now, log }: ModerationDeps,
  post: { userId: string; contentId?: string; tags: string[]; texts: (string | null | undefined)[] },
): Promise<Moderated> {
  const { userId, contentId, tags } = post;
  const texts = post.texts.filter((text): text is string => !!text);
  const [trust, rules] = await Promise.all([
    trustOf(trustPlugins, { userId, contentId, tags, texts }, { db, config, now, log }),
    tagRules(db, { userIds: [userId], contentId, tags }),
  ]);
  const route = routeOf(trust.score, config.trust);
  if (route === 'delete') throw unprocessable(trust.reason ?? msg('moderation.not_trusted'));

  const { kept, removedTags } = rules.apply(texts, log);
  if (!kept.length && contentId === undefined) throw unprocessable(msg('moderation.no_tags_left'), { removedTags });
  return { tags: kept, removedTags, trustScore: trust.score, route };
}

/**
 * What a repost's hashtags are held to: what the post's publisher's own are, as far as the
 * hashtags go. Returns the ones the content gets, and those it doesn't with why: one the reposter
 * or the content's publisher is muted on (a mute keeps a user's posts out of the hashtag, whoever
 * would put them there), one a moderator removed from this content, and one whose blocked words
 * the content has. `texts` is what there is of the content to read, as for a post.
 *
 * No trust score is worked out: the content got one when it was written, and a repost changes
 * nothing of what it says.
 */
export async function moderateRepost(
  { db, log }: Pick<ModerationDeps, 'db' | 'log'>,
  repost: { userId: string; publisherId: string; contentId: string; tags: string[]; texts: (string | null | undefined)[] },
): Promise<Pick<Moderated, 'tags' | 'removedTags'>> {
  const { userId, publisherId, contentId, tags } = repost;
  const { kept, removedTags } = (await tagRules(db, { userIds: [userId, publisherId], contentId, tags })).apply(repost.texts.filter((text): text is string => !!text), log);
  return { tags: kept, removedTags };
}

/**
 * What hashtags' moderators keep that says whether content gets their hashtag: the mutes of
 * `userIds` on these `tags`, the hashtags a moderator removed from `contentId`, and their blocked
 * words. `apply` holds the hashtags to them, given what there is of the content to read.
 */
async function tagRules(db: Db, { userIds, contentId, tags }: { userIds: string[]; contentId?: string; tags: string[] }) {
  const [words, mutes, removals] = await Promise.all([
    tags.length ? db.selectFrom('blocked_words').select(['tag', 'word']).where('tag', 'in', tags).execute() : [],
    tags.length ? db.selectFrom('tag_mutes').select('tag').where('user_id', 'in', userIds).where('tag', 'in', tags).execute() : [],
    contentId && tags.length
      ? db.selectFrom('tag_moderation').select('tag').where('content_id', '=', contentId).where('decision', '=', 'removed').where('tag', 'in', tags).execute()
      : [],
  ]);
  const lists = new Map<string, string[]>();
  for (const { tag, word } of words) {
    const list = lists.get(tag);
    if (list) list.push(word);
    else lists.set(tag, [word]);
  }
  const muted = new Set(mutes.map((r) => r.tag));
  const removed = new Set(removals.map((r) => r.tag));

  return {
    apply: (texts: string[], log?: FastifyBaseLogger) => {
      // With no hashtag's list that applies to the post, nothing needs reading.
      const blocked = lists.size ? scanTexts(lists, [...texts, ...tags], log) : null;
      const removedTags: RemovedTag[] = [];
      return {
        kept: tags.filter((tag) => {
          const reason = muted.has(tag) ? 'muted' : removed.has(tag) ? 'removed' : blocked?.has(tag) ? 'blocked_word' : null;
          if (reason) removedTags.push({ tag, reason });
          return !reason;
        }),
        removedTags,
      };
    },
  };
}
