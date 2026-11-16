export class Lru<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly max: number) {}
  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  delete(key: string) {
    this.map.delete(key);
  }
  set(key: string, v: V) {
    if (this.max <= 0) return;
    this.map.delete(key);
    this.map.set(key, v);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
}

/** Caches a load per key for `ttlMs`; a failed load is forgotten at once. */
export class TtlCache<V> {
  private readonly map = new Map<string, { at: number; v: Promise<V> }>();
  constructor(private readonly ttlMs: number, private readonly now: () => number) {}
  get(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.map.get(key);
    const t = this.now();
    if (hit && t - hit.at < this.ttlMs) return hit.v;
    const v = load();
    v.catch(() => this.map.delete(key));
    this.map.set(key, { at: t, v });
    if (this.map.size > 10_000) this.map.delete(this.map.keys().next().value!);
    return v;
  }
}

/**
 * Runs `fn` over `items` with at most `limit` running at once. If one fails, no more are started,
 * the ones under way are waited for, and the first failure is thrown. So nothing of it is still
 * running once it has returned or thrown: a caller that gives something up then (the compactor
 * its lease) gives it up with no write of its own under way.
 */
export async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (!failed && next < items.length) {
        try {
          await fn(items[next++]!);
        } catch (err) {
          if (!failed) failure = err;
          failed = true;
        }
      }
    }),
  );
  if (failed) throw failure;
}

/**
 * Gives what runs the functions it is handed with at most `limit` of them running at once: the
 * others wait their turn, in the order they were handed over. A function that waits for one it
 * handed over itself holds its place meanwhile, so it should hand over none.
 */
export function limiter(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async (fn) => {
    // One that waited is given the place of the one that woke it, which is why that one doesn't count itself out.
    if (running >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    else running++;
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };
}

/**
 * Waits for every one of `tasks`, whatever becomes of each, and then throws the first failure
 * among them, in the order they are given, if there is one. So, as with mapLimit, none is still
 * running once it has returned or thrown.
 */
export async function allDone(tasks: Promise<unknown>[]): Promise<void> {
  const failed = (await Promise.allSettled(tasks)).find((task) => task.status === 'rejected');
  if (failed) throw failed.reason;
}
