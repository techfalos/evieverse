import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createTestContext, TARGETS, type TestContext } from './helpers.js';

describe('TRUST_PROXY', () => {
  it('reads none, any, a number of proxies, or their addresses', () => {
    const read = (value?: string) => loadConfig({}, { EVIEVERSE_CONFIG: '/nonexistent.json', TRUST_PROXY: value }).trustProxy;
    expect(read()).toBe(false);
    expect(read('')).toBe(false);
    expect(read('false')).toBe(false);
    expect(read('true')).toBe(true);
    expect(read('2')).toBe(2);
    expect(read('10.0.0.0/8, 127.0.0.1')).toEqual(['10.0.0.0/8', '127.0.0.1']);
    expect(read('10.0.0.1')).toEqual(['10.0.0.1']);
  });
});

for (const target of TARGETS) {
  describe(`shared limits (${target.name})`, () => {
    let ctx: TestContext;
    afterEach(() => ctx.close());

    it('counts in the hot store, each counter lasting one window from its first count', async () => {
      ctx = await createTestContext(target);
      const counts = await Promise.all(Array.from({ length: 20 }, () => ctx.hot.incr('visits', 60_000)));
      expect(counts.map((c) => c.count).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      for (const c of counts) {
        expect(c.ttlMs).toBeGreaterThan(50_000);
        expect(c.ttlMs).toBeLessThanOrEqual(60_000);
      }
      expect((await ctx.hot.incr('other', 60_000)).count).toBe(1);

      // The window isn't pushed back by later counts.
      expect((await ctx.hot.incr('brief', 200)).count).toBe(1);
      if (target.hot === 'memory') ctx.clock.now += 150;
      else await sleep(150);
      const later = await ctx.hot.incr('brief', 200);
      expect(later.count).toBe(2);
      expect(later.ttlMs).toBeLessThanOrEqual(60);
      if (target.hot === 'memory') ctx.clock.now += 100;
      else await sleep(100);
      expect((await ctx.hot.incr('brief', 200)).count).toBe(1);
    });

    it('swaps a value in the hot store only for a caller that knows what it holds, so of concurrent swaps one wins', async () => {
      ctx = await createTestContext(target);
      const held = async () => (await ctx.hot.get('cell'))?.toString() ?? null;
      expect(await ctx.hot.swap('cell', 'a', 'b')).toBe(false);
      expect(await ctx.hot.swap('cell', null, 'a')).toBe(true);
      expect(await ctx.hot.swap('cell', null, 'b')).toBe(false);
      expect(await held()).toBe('a');

      const swaps = await Promise.all(Array.from({ length: 20 }, (_, i) => ctx.hot.swap('cell', 'a', `b${i}`)));
      expect(swaps.filter(Boolean)).toHaveLength(1);
      expect(await held()).toBe(`b${swaps.indexOf(true)}`);

      // Null deletes the key, and a time to live makes it expire.
      expect(await ctx.hot.swap('cell', 'a', null)).toBe(false);
      expect(await ctx.hot.swap('cell', await held(), null)).toBe(true);
      expect(await held()).toBeNull();
      expect(await ctx.hot.swap('cell', null, 'brief', 100)).toBe(true);
      if (target.hot === 'memory') ctx.clock.now += 150;
      else await sleep(150);
      expect(await held()).toBeNull();
    });

    it('adds one to a count the hot store has, and leaves one it does not have missing', async () => {
      ctx = await createTestContext(target);
      const held = async () => (await ctx.hot.get('tally'))?.toString() ?? null;
      expect(await ctx.hot.bump('tally')).toBeNull();
      expect(await held()).toBeNull();

      await ctx.hot.set('tally', '5', 200);
      const bumps = await Promise.all(Array.from({ length: 20 }, () => ctx.hot.bump('tally')));
      expect([...bumps].sort((a, b) => a! - b!)).toEqual(Array.from({ length: 20 }, (_, i) => i + 6));
      expect(await held()).toBe('25');

      // It keeps the time the count had left: it expires when it would have.
      if (target.hot === 'memory') ctx.clock.now += 250;
      else await sleep(250);
      expect(await ctx.hot.bump('tally')).toBeNull();
      expect(await held()).toBeNull();
    });
  });
}
