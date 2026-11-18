import { Redis } from 'ioredis';
import type { HotEntry, HotStore, LexRange } from './hotStore.types.js';

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

/** INCRBY of a key that is there, which keeps its expiry. ARGV: what to add. A missing key is left missing: false, which a client reads as null. */
const BUMP = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return false
end
return redis.call('INCRBY', KEYS[1], ARGV[1])`;

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

/** An expiry as both stores set it: a whole number of ms, rounded up, and 1 at the least, so nothing is set to expire at once or in the past. */
const ttl = (ms: number) => Math.max(1, Math.ceil(ms));

/** A range's lower bound as ZRANGEBYLEX takes it: `after`, which is not part of the range, or `-` for none. */
const lexMin = ({ after }: LexRange) => (after === undefined ? '-' : `(${after}`);
/** A range's upper bound as ZRANGEBYLEX takes it: `before`, which is not part of the range, or `+` for none. */
const lexMax = ({ before }: LexRange) => (before === undefined ? '+' : `(${before}`);

function check(results: [Error | null, unknown][] | null): unknown[] {
  if (!results) throw new Error('redis transaction aborted');
  return results.map(([err, value]) => {
    if (err) throw err;
    return value;
  });
}

class RedisHotStore implements HotStore {
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

  async setMany(entries: HotEntry[]) {
    if (!entries.length) return;
    const p = this.redis.pipeline();
    for (const { key, value, ttlMs } of entries) {
      if (ttlMs === undefined) p.set(this.k(key), value);
      else p.set(this.k(key), value, 'PX', ttl(ttlMs));
    }
    check(await p.exec());
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

  async bump(key: string, by = 1) {
    return (await this.redis.eval(BUMP, 1, this.k(key), by)) as number | null;
  }

  async swap(key: string, expected: string | null, next: string | null, ttlMs?: number) {
    return (
      (await this.redis.eval(
        SWAP,
        1,
        this.k(key),
        expected === null ? '0' : '1',
        expected ?? '',
        next === null ? '0' : '1',
        next ?? '',
        ttlMs === undefined ? '' : String(ttl(ttlMs)),
      )) === 1
    );
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
    for await (const keys of this.redis.scanStream({ match: `${this.prefix}*`, count: 500 }) as AsyncIterable<string[]>) {
      if (keys.length) await this.redis.unlink(...keys);
    }
  }

  async close() {
    await this.redis.quit();
  }
}

/** An ordered set's members. */
class LexSet {
  readonly members = new Set<string>();
}

type Value = Buffer | LexSet;
/** Whether what a key of MemoryHotStore holds is an ordered set, and not bytes: what its lex* methods ask before they read one. */
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

  private put(key: string, value: Buffer | string, ttlMs?: number) {
    this.map.set(key, { v: Buffer.from(value), exp: ttlMs === undefined ? null : this.now() + ttl(ttlMs) });
  }

  async set(key: string, value: Buffer | string, ttlMs?: number) {
    this.put(key, value, ttlMs);
  }

  async setMany(entries: HotEntry[]) {
    for (const { key, value, ttlMs } of entries) this.put(key, value, ttlMs);
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

  async bump(key: string, by = 1) {
    const e = this.live(key);
    if (!e) return null;
    if (!Buffer.isBuffer(e.v)) throw new Error(`WRONGTYPE ${key}`);
    const count = Number(e.v) + by;
    e.v = Buffer.from(String(count));
    return count;
  }

  async swap(key: string, expected: string | null, next: string | null, ttlMs?: number) {
    if ((this.value(key, Buffer.isBuffer)?.toString('utf8') ?? null) !== expected) return false;
    if (next === null) this.map.delete(key);
    else await this.set(key, next, ttlMs);
    return true;
  }

  async lexAdd(key: string, members: string[], ttlMs: number) {
    if (!members.length) return;
    let set = this.value(key, isLexSet);
    if (!set) this.map.set(key, { v: (set = new LexSet()), exp: this.now() + ttl(ttlMs) });
    for (const member of members) set.members.add(member);
  }

  async lexRange(key: string, { after, before, limit, reverse }: LexRange & { limit: number; reverse?: boolean }) {
    const within = [...(this.value(key, isLexSet)?.members ?? [])].filter((m) => (after === undefined || m > after) && (before === undefined || m < before)).sort();
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

/**
 * The hot store the settings ask for (`redis` of the configuration): the Redis-protocol server at
 * `url`, every key under `keyPrefix`, or with no `url`, a store in this process, whose expiry
 * follows `now` and which has no use for the prefix.
 */
export function createHotStore(cfg: { url?: string; keyPrefix: string }, now: () => number = Date.now): HotStore {
  return cfg.url ? new RedisHotStore(cfg.url, cfg.keyPrefix) : new MemoryHotStore(now);
}
