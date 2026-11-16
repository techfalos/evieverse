import type { HotStore } from './hotStore.js';

const followingKey = (userId: string) => `fol:${userId}`;

/**
 * Whom each user follows, in Redis, so following feeds never read the `follows` table (all they ask
 * the database is who may read them): one key per user who follows anyone, with no expiry. Written on every follow and unfollow; the compactor re-syncs users
 * who followed someone since its last run, and --rebuild every user.
 */
export class FollowStore {
  constructor(private readonly hot: HotStore) {}

  /** The user ids `userId` follows. A user Redis has none for follows nobody, as far as feeds can tell. */
  async get(userId: string): Promise<string[]> {
    const buf = await this.hot.get(followingKey(userId));
    return buf ? buf.toString('utf8').split('\n').filter(Boolean) : [];
  }

  async put(userId: string, followees: string[]): Promise<void> {
    if (followees.length) await this.hot.set(followingKey(userId), followees.join('\n'));
    else await this.hot.del([followingKey(userId)]);
  }
}
