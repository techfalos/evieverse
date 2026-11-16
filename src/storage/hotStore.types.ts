/**
 * The RAM tier: the feed index (heads, manifests, day indexes), hot summaries, publisher credits,
 * whom each user follows, related hashtags, the ads, and comments with their likes; and what is
 * only kept for a while: challenges, the counts that limits are held to, and the compactor's state.
 * Keys are relative to REDIS_KEY_PREFIX, and whatever keeps a kind of thing here names its keys
 * with a prefix of its own (`sum:`, `pub:`, `head:`, ...). Any Redis-protocol server
 * works (Redis, Valkey, ElastiCache, Memorystore, Azure); without one, MemoryHotStore keeps
 * everything in this process, which only suits a single node.
 */
export interface HotStore {
  get(key: string): Promise<Buffer | null>;
  mget(keys: string[]): Promise<(Buffer | null)[]>;
  /** Without `ttlMs` the key never expires (and is never evicted under a volatile-* policy). */
  set(key: string, value: Buffer | string, ttlMs?: number): Promise<void>;
  /** Sets several keys in one round trip, each as `set` does. Not atomic: if it fails, some may be set. */
  setMany(entries: HotEntry[]): Promise<void>;
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
   * Adds one to a counter that is there, which keeps its expiry, and returns the count. A counter
   * that isn't there is left missing, and null returned: a count somebody cached is kept up, and
   * one nobody cached isn't begun at 1. Atomic.
   */
  bump(key: string): Promise<number | null>;
  /**
   * Sets a key to `next` (or deletes it, if null), but only if it holds `expected` (null: if it is
   * missing), and returns whether it did. Atomic, so of concurrent callers that read the same value
   * only one changes it. `ttlMs` is as for `set`.
   */
  swap(key: string, expected: string | null, next: string | null, ttlMs?: number): Promise<boolean>;
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

/** A key to set (see setMany). */
export interface HotEntry {
  key: string;
  value: Buffer | string;
  ttlMs?: number;
}

/** The bounds of a range of an ordered set (see lexRange): neither is part of the range. */
export interface LexRange {
  after?: string;
  before?: string;
}
