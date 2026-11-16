import type { HotStore } from './hotStore.types.js';
import type { Publisher } from './publisherStore.types.js';

/** The Redis key of a user's credit, which holds their username and nothing else. */
const publisherKey = (userId: string) => `pub:${userId}`;

/**
 * Publisher credits in Redis: each user's username, one key per user and no expiry, so feeds show a
 * changed name at once. Written on register, profile change and store; the compactor re-syncs
 * changed users, and --rebuild every user.
 */
export class PublisherStore {
  private readonly cache = new Map<string, { at: number; p: Publisher | null }>();

  constructor(
    private readonly hot: HotStore,
    private readonly opts: { cacheMs: number },
    private readonly now: () => number = Date.now,
  ) {}

  async put(p: Publisher): Promise<void> {
    await this.hot.set(publisherKey(p.userId), p.username);
    this.cache.delete(p.userId);
  }

  /** Forgets a user's credit, as a deleted account's is: what is left of their name is a comment's empty username. */
  async remove(userId: string): Promise<void> {
    await this.hot.del([publisherKey(userId)]);
    this.cache.delete(userId);
  }

  /** Credits by user id. A user Redis has no credit for (e.g. lost data before a rebuild) gets an empty username. */
  async getMany(userIds: string[]): Promise<Map<string, Publisher>> {
    const t = this.now();
    const out = new Map<string, Publisher>();
    const missing: string[] = [];
    for (const id of new Set(userIds)) {
      const hit = this.cache.get(id);
      if (hit && t - hit.at < this.opts.cacheMs) out.set(id, hit.p ?? { userId: id, username: '' });
      else missing.push(id);
    }
    const bufs = await this.hot.mget(missing.map(publisherKey));
    missing.forEach((userId, i) => {
      const username = bufs[i]?.toString('utf8');
      const p = username !== undefined ? { userId, username } : null;
      this.cache.set(userId, { at: t, p });
      if (this.cache.size > 10_000) this.cache.delete(this.cache.keys().next().value!);
      out.set(userId, p ?? { userId, username: '' });
    });
    return out;
  }
}
