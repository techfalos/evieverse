import type { Db } from './db/index.js';
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
