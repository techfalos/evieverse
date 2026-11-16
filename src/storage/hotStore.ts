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
  /** Sets a key that isn't there, to expire in `ttlMs`; one that is there is left as it is. */
  setIfAbsent(key: string, value: Buffer, ttlMs: number): Promise<void>;
  /** Gets and deletes a key in one step, so of concurrent callers only one gets its value. */
  take(key: string): Promise<Buffer | null>;
  del(keys: string[]): Promise<void>;
  /** Makes existing keys expire `ttlMs` from now; missing keys are ignored. */
  expire(keys: string[], ttlMs: number): Promise<void>;
  /** Makes keys never expire. For each, whether it is still there: false if it expired or was evicted first. */
  persist(keys: string[]): Promise<boolean[]>;
  exists(keys: string[]): Promise<boolean[]>;
  /**
   * Adds one to a counter that starts at zero and is deleted `ttlMs` after its first count. Returns
   * the count and how long the counter has left. Atomic, so processes counting together miss nothing.
   */
  incr(key: string, ttlMs: number): Promise<{ count: number; ttlMs: number }>;
  /**
   * Sets a key to `next` (or deletes it, if null), but only if it holds `expected` (null: if it is
   * missing), and returns whether it did. Atomic, so of concurrent callers that read the same value
   * only one changes it. `ttlMs` is as for `set`.
   */
  swap(key: string, expected: string | null, next: string | null, ttlMs?: number): Promise<boolean>;
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
  /**
   * Adds members to a set that is kept in the order of its members, which must be ASCII (byte order
   * is then the order of the strings). A set that is new, or somehow has no expiry, expires `ttlMs`
   * from now; one that has an expiry keeps it, so the set lasts `ttlMs` from when it was begun.
   */
  lexAdd(key: string, members: string[], ttlMs: number): Promise<void>;
  /**
   * Up to `limit` of an ordered set's members after `after` and before `before` (neither included;
   * left out: no bound), in order, or with `reverse` from the last back. A missing set is empty.
   */
  lexRange(key: string, range: LexRange & { limit: number; reverse?: boolean }): Promise<string[]>;
  /** How many of an ordered set's members are within the bounds. */
  lexCount(key: string, range?: LexRange): Promise<number>;
  /** Whether an ordered set has the member. */
  lexHas(key: string, member: string): Promise<boolean>;
  lexRem(key: string, members: string[]): Promise<void>;
  /** Deletes every key under this store's prefix. */
  clear(): Promise<void>;
  close(): Promise<void>;
}

/** The bounds of a range of an ordered set (see lexRange): neither is part of the range. */
export interface LexRange {
  after?: string;
  before?: string;
}

const ttl = (ms: number) => Math.max(1, Math.ceil(ms));

/** A range's bounds as ZRANGEBYLEX takes them. */
const lexMin = ({ after }: LexRange) => (after === undefined ? '-' : `(${after}`);
const lexMax = ({ before }: LexRange) => (before === undefined ? '+' : `(${before}`);

/** Members a lexAdd sends in one command. */
const LEX_BATCH = 1000;

/** ZADD of every member at score 0, which is what orders a sorted set by its members, giving the set its expiry if it has none. */
const LEX_ADD = `
for i = 2, #ARGV do
  redis.call('ZADD', KEYS[1], 0, ARGV[i])
end
if redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return 1`;

/** INCR, giving the counter its expiry when it is new (or somehow has none). Returns the count and the time left. */
const COUNT = `
local count = redis.call('INCR', KEYS[1])
local left = redis.call('PTTL', KEYS[1])
if left < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  left = tonumber(ARGV[1])
end
return {count, left}`;

/**
 * Compare-and-set. ARGV: whether a value is expected ('1') and the value; whether one is set ('1') and
 * the value; its expiry in ms, or ''. GET gives false for a missing key.
 */
const SWAP = `
local current = redis.call('GET', KEYS[1])
if ARGV[1] == '1' then
  if current ~= ARGV[2] then return 0 end
elseif current then
  return 0
end
if ARGV[3] ~= '1' then
  redis.call('DEL', KEYS[1])
elseif ARGV[5] == '' then
  redis.call('SET', KEYS[1], ARGV[4])
else
  redis.call('SET', KEYS[1], ARGV[4], 'PX', ARGV[5])
end
return 1`;

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

  async setIfAbsent(key: string, value: Buffer, ttlMs: number) {
    await this.redis.set(this.k(key), value, 'PX', ttl(ttlMs), 'NX');
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

  async persist(keys: string[]) {
    if (!keys.length) return [];
    const p = this.redis.pipeline();
    // PERSIST alone can't tell a missing key from one that never had an expiry.
    for (const key of keys) p.persist(this.k(key)).exists(this.k(key));
    return check(await p.exec())
      .filter((_, i) => i % 2 === 1)
      .map((n) => n === 1);
  }

  async exists(keys: string[]) {
    if (!keys.length) return [];
    const p = this.redis.pipeline();
    for (const key of keys) p.exists(this.k(key));
    return check(await p.exec()).map((n) => n === 1);
  }

  async incr(key: string, ttlMs: number) {
    // One key, so the script runs wherever the key lives, behind a proxy or in a cluster.
    const [count, left] = (await this.redis.eval(COUNT, 1, this.k(key), ttl(ttlMs))) as [number, number];
    return { count, ttlMs: left };
  }

  async swap(key: string, expected: string | null, next: string | null, ttlMs?: number) {
    const args = [expected === null ? '0' : '1', expected ?? '', next === null ? '0' : '1', next ?? '', ttlMs === undefined ? '' : String(ttl(ttlMs))];
    return (await this.redis.eval(SWAP, 1, this.k(key), ...args)) === 1;
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

  async lexAdd(key: string, members: string[], ttlMs: number) {
    // One key, so the script runs wherever the key lives, as for incr.
    for (let i = 0; i < members.length; i += LEX_BATCH) {
      await this.redis.eval(LEX_ADD, 1, this.k(key), ttl(ttlMs), ...members.slice(i, i + LEX_BATCH));
    }
  }

  lexRange(key: string, { limit, reverse, ...range }: LexRange & { limit: number; reverse?: boolean }) {
    return reverse
      ? this.redis.zrevrangebylex(this.k(key), lexMax(range), lexMin(range), 'LIMIT', 0, limit)
      : this.redis.zrangebylex(this.k(key), lexMin(range), lexMax(range), 'LIMIT', 0, limit);
  }

  lexCount(key: string, range: LexRange = {}) {
    return this.redis.zlexcount(this.k(key), lexMin(range), lexMax(range));
  }

  async lexHas(key: string, member: string) {
    return (await this.redis.zscore(this.k(key), member)) !== null;
  }

  async lexRem(key: string, members: string[]) {
    if (members.length) await this.redis.zrem(this.k(key), ...members);
  }

  async clear() {
    const stream = this.redis.scanStream({ match: `${this.prefix}*`, count: 500 });
    for await (const keys of stream as AsyncIterable<string[]>) if (keys.length) await this.redis.unlink(...keys);
  }

  async close() {
    await this.redis.quit();
  }
}

/** An ordered set's members. A class of its own, which tells it from the set of a tag's tail windows. */
class LexSet {
  readonly members = new Set<string>();
}

type Value = Buffer | Buffer[] | Set<number> | LexSet;
const isLexSet = (v: Value): v is LexSet => v instanceof LexSet;

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

  async setIfAbsent(key: string, value: Buffer, ttlMs: number) {
    if (!this.live(key)) await this.set(key, value, ttlMs);
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

  async persist(keys: string[]) {
    return keys.map((key) => {
      const e = this.live(key);
      if (e) e.exp = null;
      return e !== undefined;
    });
  }

  async exists(keys: string[]) {
    return keys.map((key) => this.live(key) !== undefined);
  }

  async incr(key: string, ttlMs: number) {
    const count = Number(this.value(key, Buffer.isBuffer) ?? 0) + 1;
    const exp = this.live(key)?.exp ?? this.now() + ttl(ttlMs);
    this.map.set(key, { v: Buffer.from(String(count)), exp });
    return { count, ttlMs: exp - this.now() };
  }

  async swap(key: string, expected: string | null, next: string | null, ttlMs?: number) {
    const current = this.value(key, Buffer.isBuffer)?.toString('utf8') ?? null;
    if (current !== expected) return false;
    if (next === null) this.map.delete(key);
    else await this.set(key, next, ttlMs);
    return true;
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

  async lexAdd(key: string, members: string[], ttlMs: number) {
    if (!members.length) return;
    let set = this.value(key, isLexSet);
    if (!set) this.map.set(key, { v: (set = new LexSet()), exp: this.now() + ttl(ttlMs) });
    for (const member of members) set.members.add(member);
  }

  async lexRange(key: string, { after, before, limit, reverse }: LexRange & { limit: number; reverse?: boolean }) {
    const set = this.value(key, isLexSet);
    const within = [...(set?.members ?? [])].filter((m) => (after === undefined || m > after) && (before === undefined || m < before)).sort();
    return (reverse ? within.reverse() : within).slice(0, limit);
  }

  async lexCount(key: string, range: LexRange = {}) {
    return (await this.lexRange(key, { ...range, limit: Infinity })).length;
  }

  async lexHas(key: string, member: string) {
    return this.value(key, isLexSet)?.members.has(member) ?? false;
  }

  async lexRem(key: string, members: string[]) {
    const set = this.value(key, isLexSet);
    for (const member of members) set?.members.delete(member);
    if (set && !set.members.size) this.map.delete(key);
  }

  async clear() {
    this.map.clear();
  }

  async close() {}
}

export function createHotStore(cfg: { url?: string; keyPrefix: string }, now: () => number = Date.now): HotStore {
  return cfg.url ? new RedisHotStore(cfg.url, cfg.keyPrefix) : new MemoryHotStore(now);
}
