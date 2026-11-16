import type { HotStore } from './hotStore.js';

export interface Publisher {
  userId: string;
  username: string;
  publisherUrl: string | null;
}

export const publisherKey = (userId: string) => `pub:${userId}`;

/**
 * Publisher credits (username, publisherUrl) in Redis, one key per user and no expiry, so feeds show a
 * profile change at once. Written on register, profile change and store; the compactor re-syncs
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
    // The URL can't hold a newline, so it goes first and the username takes the rest.
    await this.hot.set(publisherKey(p.userId), `${p.publisherUrl ?? ''}\n${p.username}`);
    this.cache.delete(p.userId);
  }

  /** Credits by user id. A user Redis has no credit for (e.g. lost data before a rebuild) gets an empty username. */
  async getMany(userIds: string[]): Promise<Map<string, Publisher>> {
    const t = this.now();
    const out = new Map<string, Publisher>();
    const missing: string[] = [];
    for (const id of new Set(userIds)) {
      const hit = this.cache.get(id);
      if (hit && t - hit.at < this.opts.cacheMs) out.set(id, hit.p ?? { userId: id, username: '', publisherUrl: null });
      else missing.push(id);
    }
    const bufs = await this.hot.mget(missing.map(publisherKey));
    missing.forEach((userId, i) => {
      const text = bufs[i]?.toString('utf8');
      const nl = text?.indexOf('\n') ?? -1;
      const p = text !== undefined && nl >= 0 ? { userId, username: text.slice(nl + 1), publisherUrl: text.slice(0, nl) || null } : null;
      this.cache.set(userId, { at: t, p });
      if (this.cache.size > 10_000) this.cache.delete(this.cache.keys().next().value!);
      out.set(userId, p ?? { userId, username: '', publisherUrl: null });
    });
    return out;
  }
}
