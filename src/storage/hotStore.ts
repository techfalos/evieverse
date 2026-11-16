import { Redis } from 'ioredis';

/**
 * The RAM tier: the feed index (heads, manifests, day indexes), tail lists, hot summaries and
 * publisher credits. Keys are relative; each store adds its own prefix. Any Redis-protocol server
 * works (Redis, Valkey, ElastiCache, Memorystore, Azure); without one, MemoryHotStore keeps
 * everything in this process, which only suits a single node.
 */
export interface HotStore {
  get(key: string): Promise<Buffer | null>;
  mget(keys: string[]): Promise<(Buffer | null)[]>;
  /** Without `ttlMs` the key never expires (and is never evicted under a volatile-* policy). */
  set(key: string, value: Buffer | string, ttlMs?: number): Promise<void>;
  /** Gets and deletes a key in one step, so of concurrent callers only one gets its value. */
  take(key: string): Promise<Buffer | null>;
  del(keys: string[]): Promise<void>;
  /** Makes existing keys expire `ttlMs` from now; missing keys are ignored. */
  expire(keys: string[], ttlMs: number): Promise<void>;
  exists(keys: string[]): Promise<boolean[]>;
  /**
   * Adds `index.score` to a sorted set, then appends `value` to a list. Not atomic: a failure can
   * leave a listed window without its list, which reads as empty, never a list nobody can find.
   */
  push(list: string, value: string, index: { key: string; score: number }): Promise<void>;
  /** Every element of each list; a missing list is empty. */
  lists(keys: string[]): Promise<Buffer[][]>;
  /** Members (numbers, each its own score) of a sorted set in [min, max), ascending. */
  scores(key: string, min: number, max: number): Promise<number[]>;
  zrem(key: string, members: number[]): Promise<void>;
  /** Deletes every key under this store's prefix. */
  clear(): Promise<void>;
  close(): Promise<void>;
}

const ttl = (ms: number) => Math.max(1, Math.ceil(ms));

function check(results: [Error | null, unknown][] | null): unknown[] {
  if (!results) throw new Error('redis transaction aborted');
  return results.map(([err, value]) => {
    if (err) throw err;
    return value;
  });
}

export class RedisHotStore implements HotStore {
  private readonly redis: Redis;

  constructor(url: string, private readonly prefix: string) {
    // Concurrent commands from parallel requests share round trips.
    this.redis = new Redis(url, { enableAutoPipelining: true, maxRetriesPerRequest: 2 });
  }

  private k(key: string) {
    return this.prefix + key;
  }

  get(key: string) {
    return this.redis.getBuffer(this.k(key));
  }

  async mget(keys: string[]) {
    return keys.length ? this.redis.mgetBuffer(...keys.map((key) => this.k(key))) : [];
  }

  async set(key: string, value: Buffer | string, ttlMs?: number) {
    if (ttlMs === undefined) await this.redis.set(this.k(key), value);
    else await this.redis.set(this.k(key), value, 'PX', ttl(ttlMs));
  }

  take(key: string) {
    return this.redis.getdelBuffer(this.k(key));
  }

  async del(keys: string[]) {
    if (keys.length) await this.redis.unlink(...keys.map((key) => this.k(key)));
  }

  async expire(keys: string[], ttlMs: number) {
    if (!keys.length) return;
    const p = this.redis.pipeline();
    for (const key of keys) p.pexpire(this.k(key), ttl(ttlMs));
    check(await p.exec());
  }

  async exists(keys: string[]) {
    if (!keys.length) return [];
    const p = this.redis.pipeline();
    for (const key of keys) p.exists(this.k(key));
    return check(await p.exec()).map((n) => n === 1);
  }

  async push(list: string, value: string, index: { key: string; score: number }) {
    // Separate commands rather than MULTI, so the two keys may live on different shards behind a proxy.
    await this.redis.zadd(this.k(index.key), index.score, String(index.score));
    await this.redis.rpush(this.k(list), value);
  }

  async lists(keys: string[]) {
    if (!keys.length) return [];
    const p = this.redis.pipeline();
    for (const key of keys) p.lrangeBuffer(this.k(key), 0, -1);
    return check(await p.exec()) as Buffer[][];
  }

  async scores(key: string, min: number, max: number) {
    const members = await this.redis.zrangebyscore(this.k(key), String(min), Number.isFinite(max) ? `(${max}` : '+inf');
    return members.map(Number);
  }

  async zrem(key: string, members: number[]) {
    if (members.length) await this.redis.zrem(this.k(key), ...members.map(String));
  }

  async clear() {
    const stream = this.redis.scanStream({ match: `${this.prefix}*`, count: 500 });
    for await (const keys of stream as AsyncIterable<string[]>) if (keys.length) await this.redis.unlink(...keys);
  }

  async close() {
    await this.redis.quit();
  }
}

type Value = Buffer | Buffer[] | Set<number>;

/** In-process stand-in for Redis (development, tests, single-node setups). Expiry follows the injected clock. */
export class MemoryHotStore implements HotStore {
  private readonly map = new Map<string, { v: Value; exp: number | null }>();

  constructor(private readonly now: () => number = Date.now) {}

  private live(key: string) {
    const e = this.map.get(key);
    if (e && e.exp !== null && e.exp <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    return e;
  }

  private value<T extends Value>(key: string, is: (v: Value) => v is T): T | undefined {
    const e = this.live(key);
    if (e && !is(e.v)) throw new Error(`WRONGTYPE ${key}`);
    return e?.v as T | undefined;
  }

  async get(key: string) {
    return this.value(key, Buffer.isBuffer) ?? null;
  }

  async mget(keys: string[]) {
    return keys.map((key) => this.value(key, Buffer.isBuffer) ?? null);
  }

  async set(key: string, value: Buffer | string, ttlMs?: number) {
    this.map.set(key, { v: Buffer.from(value), exp: ttlMs === undefined ? null : this.now() + ttl(ttlMs) });
  }

  async take(key: string) {
    const v = this.value(key, Buffer.isBuffer) ?? null;
    this.map.delete(key);
    return v;
  }

  async del(keys: string[]) {
    for (const key of keys) this.map.delete(key);
  }

  async expire(keys: string[], ttlMs: number) {
    for (const key of keys) {
      const e = this.live(key);
      if (e) e.exp = this.now() + ttl(ttlMs);
    }
  }

  async exists(keys: string[]) {
    return keys.map((key) => this.live(key) !== undefined);
  }

  async push(list: string, value: string, index: { key: string; score: number }) {
    const items = this.value(list, Array.isArray) ?? [];
    const set = this.value(index.key, (v): v is Set<number> => v instanceof Set) ?? new Set<number>();
    items.push(Buffer.from(value));
    set.add(index.score);
    if (!this.map.has(list)) this.map.set(list, { v: items, exp: null });
    if (!this.map.has(index.key)) this.map.set(index.key, { v: set, exp: null });
  }

  async lists(keys: string[]) {
    return keys.map((key) => [...(this.value(key, Array.isArray) ?? [])]);
  }

  async scores(key: string, min: number, max: number) {
    const set = this.value(key, (v): v is Set<number> => v instanceof Set);
    return [...(set ?? [])].filter((s) => s >= min && s < max).sort((a, b) => a - b);
  }

  async zrem(key: string, members: number[]) {
    const set = this.value(key, (v): v is Set<number> => v instanceof Set);
    for (const m of members) set?.delete(m);
    if (set && !set.size) this.map.delete(key);
  }

  async clear() {
    this.map.clear();
  }

  async close() {}
}

export function createHotStore(cfg: { url?: string; keyPrefix: string }, now: () => number = Date.now): HotStore {
  return cfg.url ? new RedisHotStore(cfg.url, cfg.keyPrefix) : new MemoryHotStore(now);
}
