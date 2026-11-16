import type { FastifyRequest } from 'fastify';
import { authenticateIfNamed } from './auth/apiKey.js';
import type { Db } from './db/index.js';
import { forbidden, notFound } from './http/errors.js';
import { msg } from './language.js';
import type { FollowStore } from './storage/index.js';
import { mapLimit } from './util.js';

/** Rewrites the Redis copy of whom each of these users follows from the database. */
export async function syncFollowing(db: Db, follows: FollowStore, userIds: string[]): Promise<void> {
  if (!userIds.length) return;
  const rows = await db.selectFrom('follows').select(['follower_id', 'followee_id']).where('follower_id', 'in', userIds).execute();
  const following = new Map(userIds.map((id): [string, string[]] => [id, []]));
  for (const r of rows) following.get(r.follower_id)!.push(r.followee_id);
  await mapLimit([...following], 16, ([userId, followees]) => follows.put(userId, followees));
}

/** Each side of a user's follows: the setting of theirs that shows it, and what others are told of one they don't show. */
const SIDES = {
  following: { shown: 'show_following', hidden: 'follow.following_hidden' },
  followers: { shown: 'show_followers', hidden: 'follow.followers_hidden' },
} as const;

/**
 * Holds a request to what `userId` shows of their follows: whom they follow (`following`), which
 * is the list of them and the following feed alike, or who follows them (`followers`). Each is
 * hidden until the user shows it (PATCH /users/:userId): anyone can read one that is shown, and
 * only the user themselves, by their key, one that isn't.
 *
 * 404 for a user who isn't there, 403 for anyone else asking for what the user doesn't show, with
 * a key of their own or without one, and 401 for a wrong key. What is shown looks no key up.
 */
export async function requireShownFollows(db: Db, req: FastifyRequest, userId: string, side: keyof typeof SIDES): Promise<void> {
  const user = await db.selectFrom('users').select(['id', 'show_following', 'show_followers']).where('id', '=', userId).where('deleted_at', 'is', null).executeTakeFirst();
  if (!user) throw notFound(msg('user.not_found'));
  const { shown, hidden } = SIDES[side];
  if (user[shown] === 1) return;
  const reader = await authenticateIfNamed(db, req);
  if (reader?.id !== userId) throw forbidden(msg(hidden));
}
