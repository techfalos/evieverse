import { afterEach, describe, expect, it, vi } from 'vitest';
import { Compactor } from '../src/compact/compactor.js';
import { loadConfig } from '../src/config.js';

const INTERVAL = 5000;

type Pass = { start: number; end: number | null };

/**
 * A compactor that is started, whose passes take the times given, in order, and then no time. What
 * its passes do is tested in feedindex.test.ts; here they only record when each started and ended,
 * in milliseconds since the compactor was started.
 */
function started(durations: number[] = []) {
  vi.useFakeTimers();
  const config = loadConfig({ logLevel: 'silent', compact: { intervalSeconds: INTERVAL / 1000 } }, {});
  const compactor = new Compactor({ config } as ConstructorParameters<typeof Compactor>[0]);
  const t0 = Date.now();
  const passes: Pass[] = [];
  const runOnce = vi.spyOn(compactor, 'runOnce').mockImplementation(async () => {
    const pass: Pass = { start: Date.now() - t0, end: null };
    passes.push(pass);
    await new Promise((resolve) => setTimeout(resolve, durations[passes.length - 1] ?? 0));
    pass.end = Date.now() - t0;
    return { tags: [], deleted: [], skipped: false };
  });
  return { stop: compactor.start(), passes, runOnce };
}

describe('the compactor as a process', () => {
  afterEach(() => vi.useRealTimers());

  it('makes pass after pass for as long as it is up, one every COMPACT_INTERVAL_SECONDS', async () => {
    const { stop, passes } = started();
    await vi.advanceTimersByTimeAsync(26_000);
    await stop();
    expect(passes.map((p) => p.start)).toEqual([5000, 10_000, 15_000, 20_000, 25_000]);
  });

  it('never makes two passes at once, nor more than one in the interval: a pass that outlasts it is followed by the next as it ends', async () => {
    const { stop, passes } = started([12_000, 1000, 7000]);
    await vi.advanceTimersByTimeAsync(40_000);
    await stop();
    expect(passes).toHaveLength(6);
    for (const [i, next] of passes.entries()) {
      const previous = passes[i - 1];
      if (!previous) continue;
      expect(next.start).toBeGreaterThanOrEqual(previous.end!);
      expect(next.start - previous.start).toBeGreaterThanOrEqual(INTERVAL);
    }
    // A timer of no time at all still takes a millisecond or so, hence "within".
    const within = (ms: number, of: number) => ms >= of && ms <= of + 5;
    const [first, second, third, fourth] = passes as [Pass, Pass, Pass, Pass];
    expect([first.start, first.end]).toEqual([5000, 17_000]);
    // The first outlasted the interval, so the second followed as it ended.
    expect(within(second.start, first.end!)).toBe(true);
    // The second didn't, so the third waited the interval out.
    expect(within(third.start, second.start + INTERVAL)).toBe(true);
    expect(within(fourth.start, third.end!)).toBe(true);
  });

  it('carries on after a pass that fails', async () => {
    const { stop, passes, runOnce } = started();
    runOnce.mockRejectedValueOnce(new Error('redis is unavailable'));
    await vi.advanceTimersByTimeAsync(16_000);
    await stop();
    expect(runOnce).toHaveBeenCalledTimes(3);
    expect(passes.map((p) => p.start)).toEqual([10_000, 15_000]);
  });

  it('finishes the pass it is making when it is stopped, and starts no other', async () => {
    const { stop, passes } = started([3000]);
    await vi.advanceTimersByTimeAsync(6000);
    let stopped = false;
    const stopping = stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(1000);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    await stopping;
    expect(passes).toEqual([{ start: 5000, end: 8000 }]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(passes).toHaveLength(1);
  });
});
