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

/** Runs `fn` over `items` with at most `limit` running at once. */
export async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}
