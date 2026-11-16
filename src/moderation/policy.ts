import type { AuthUser } from '../auth/apiKey.js';
import type { Db } from '../db/index.js';
import { unprocessable } from '../http/errors.js';
import { SERVER_LIST, WordScanner } from './words.js';

/** Why a post didn't get a hashtag: a moderator removed it from the content, the publisher is muted on it, or its blocked words. */
export type RemovalReason = 'removed' | 'muted' | 'blocked_word';
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

/** Makes a user an admin, or not; null if there's no such user. A userId wins over a username that happens to look like one. */
export async function setAdmin(db: Db, user: string, admin: boolean): Promise<{ userId: string; username: string } | null> {
  const select = db.selectFrom('users').select(['id', 'username']);
  const row = (await select.where('id', '=', user).executeTakeFirst()) ?? (await select.where('username', '=', user).executeTakeFirst());
  if (!row) return null;
  await db.updateTable('users').set({ admin: admin ? 1 : 0 }).where('id', '=', row.id).execute();
  return { userId: row.id, username: row.username };
}

export interface PostRules {
  /**
   * Fed the post's text and filename, if it has them, to find its blocked words; null when no list
   * applies to the post, so nothing needs reading.
   */
  scanner: WordScanner | null;
  /**
   * The hashtags the post gets, and those it doesn't with why. Throws 422 if it can't be published: it
   * has a word of the server's list, or no hashtag left.
   */
  apply(): { tags: string[]; removedTags: RemovedTag[] };
}

/**
 * Moderation of a new post or version by `userId` with `tags`; `contentId` for a new version of existing
 * content. The server's blocked words refuse the post. A hashtag a moderator removed from the content,
 * one its publisher is muted on, and one whose blocked words it has, are dropped. Hashtags are scanned
 * for blocked words too.
 */
export async function postRules(db: Db, post: { userId: string; tags: string[]; contentId?: string }): Promise<PostRules> {
  const { userId, tags, contentId } = post;
  const [words, mutes, removals] = await Promise.all([
    db.selectFrom('blocked_words').select(['tag', 'word']).where('tag', 'in', [SERVER_LIST, ...tags]).execute(),
    tags.length ? db.selectFrom('tag_mutes').select('tag').where('user_id', '=', userId).where('tag', 'in', tags).execute() : [],
    contentId ? db.selectFrom('removed_tags').select('tag').where('content_id', '=', contentId).execute() : [],
  ]);
  const lists = new Map<string, string[]>();
  for (const { tag, word } of words) {
    const list = lists.get(tag);
    if (list) list.push(word);
    else lists.set(tag, [word]);
  }
  const muted = new Set(mutes.map((r) => r.tag));
  const removed = new Set(removals.map((r) => r.tag));
  const scanner = lists.size ? new WordScanner(lists) : null;

  return {
    scanner,
    apply() {
      for (const tag of tags) scanner?.scan(tag);
      if (scanner?.matched.has(SERVER_LIST)) throw unprocessable("the post contains a word or phrase this server doesn't allow, so it wasn't published");
      const removedTags: RemovedTag[] = [];
      const kept = tags.filter((tag) => {
        const reason = removed.has(tag) ? 'removed' : muted.has(tag) ? 'muted' : scanner?.matched.has(tag) ? 'blocked_word' : null;
        if (reason) removedTags.push({ tag, reason });
        return !reason;
      });
      if (!kept.length) throw unprocessable("none of the post's hashtags is allowed on it, and a post needs one, so it wasn't published", { removedTags });
      return { tags: kept, removedTags };
    },
  };
}
