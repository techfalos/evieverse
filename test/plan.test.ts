import { describe, expect, it } from 'vitest';
import { FEED_ALGORITHMS, planFeed, type FeedPlan, type PlanOptions } from '../src/feed/plan.js';
import type { Candidate } from '../src/tagfeed/reader.js';
import { DAY, HOUR } from '../src/time.js';

const NOW = Date.UTC(2026, 10, 6, 12);

let seq = 0;
interface Item extends Candidate {
  tags: string[];
}
function item(tags: string[], ageMs: number, likes = 0, aiGenerated = false): Item {
  seq++;
  return {
    contentId: `c-${String(seq).padStart(6, '0')}`,
    createdAt: NOW - ageMs,
    likes,
    aiGenerated,
    moderated: false,
    tags,
  };
}

/** Each requested tag's index holds the items carrying that tag. */
const byTag = (items: Item[], tags: string[]) => tags.map((t) => items.filter((i) => i.tags.includes(t)));

const opts = (o: Partial<PlanOptions> = {}): PlanOptions => ({
  hours: 24,
  anchor: NOW,
  limit: 100,
  maxLookbackDays: 90,
  ...o,
});

const plan = (items: Item[], tags: string[], o: Partial<PlanOptions> = {}) => planFeed(byTag(items, tags), opts(o));
const ids = (p: FeedPlan) => p.slices.flatMap((s) => s.picks.flatMap((l) => l.map((c) => c.contentId)));

describe('planFeed', () => {
  it('halves the page per day: 50% newest, 25% next, oldest window day takes the remainder', () => {
    const items = [0, 1, 2].flatMap((day) => Array.from({ length: 200 }, (_, i) => item(['news'], day * DAY + (i + 1) * 60_000)));
    const p = plan(items, ['news'], { hours: 72 });
    expect(p.slices.map((s) => s.used)).toEqual([50, 25, 25]);
    for (const s of p.slices) expect(s.picks[0]).toHaveLength(s.used);
    expect(ids(p)).toHaveLength(100);
    expect(p.truncated).toBe(true);
  });

  it('rounds day shares to whole posts on the running total, so newer days get the rounding', () => {
    const items = [0, 1, 2, 3, 4, 5, 6].flatMap((day) => Array.from({ length: 60 }, (_, i) => item(['news'], day * DAY + (i + 1) * 60_000)));
    expect(plan(items, ['news'], { hours: 168, limit: 50 }).slices.map((s) => s.used)).toEqual([25, 13, 6, 3, 1, 1, 1]);
    expect(ids(plan(items, ['news'], { hours: 72, limit: 1 }))).toEqual([items[0]!.contentId]);
  });

  it('carries unused allowance from an empty day to the next older day', () => {
    const items = [1, 2].flatMap((day) => Array.from({ length: 200 }, (_, i) => item(['news'], day * DAY + (i + 1) * 60_000)));
    const p = plan(items, ['news'], { hours: 72 });
    expect(p.slices.map((s) => s.used)).toEqual([75, 25]);
  });

  it('extends past the window (and past 168h) when the window does not fill the page', () => {
    const old = item(['news'], 21 * DAY);
    const p = plan([old], ['news']);
    expect(ids(p)).toEqual([old.contentId]);
    expect(p.slices[0]!.extended).toBe(true);
    expect(p.truncated).toBe(false);
  });

  it('does not reach beyond the max lookback', () => {
    expect(ids(plan([item(['news'], 100 * DAY)], ['news']))).toEqual([]);
  });

  it('gives leftover allowance back to newer days when older days have nothing', () => {
    const items = Array.from({ length: 50 }, (_, i) => item(['news'], (i + 1) * 60_000));
    const p = plan(items, ['news'], { hours: 72 });
    expect(ids(p)).toHaveLength(50);
    expect(p.truncated).toBe(false);
  });

  it('shares each day equally across requested tags', () => {
    const items = [
      ...Array.from({ length: 100 }, (_, i) => item(['news'], (i + 1) * 60_000)),
      ...Array.from({ length: 100 }, (_, i) => item(['sports'], (i + 1) * 60_000)),
    ];
    const [news, sports] = plan(items, ['news', 'sports'], { limit: 50 }).slices[0]!.picks;
    expect(Math.abs(news!.length - sports!.length)).toBeLessThanOrEqual(1);
  });

  it('lets other tags continue when one tag runs out', () => {
    const items = [
      ...Array.from({ length: 100 }, (_, i) => item(['news'], (i + 1) * 60_000)),
      ...Array.from({ length: 2 }, (_, i) => item(['sports'], (i + 1) * 60_000)),
    ];
    const [news, sports] = plan(items, ['news', 'sports'], { limit: 50 }).slices[0]!.picks;
    expect(sports).toHaveLength(2);
    expect(news!.length).toBeGreaterThan(2);
  });

  it('orders by likes within a tag and UTC day', () => {
    const items = [item(['news'], HOUR, 1), item(['news'], 2 * HOUR, 50), item(['news'], 3 * HOUR, 10)];
    expect(plan(items, ['news']).slices[0]!.picks[0]!.map((c) => c.likes)).toEqual([50, 10, 1]);
  });

  it('orders days newest first', () => {
    const items = [item(['news'], 3 * DAY + HOUR), item(['news'], HOUR), item(['news'], DAY + HOUR)];
    const froms = plan(items, ['news'], { hours: 168 }).slices.map((s) => s.from);
    expect([...froms].sort((a, b) => b - a)).toEqual(froms);
  });

  it('returns content once even when it is in several requested tags', () => {
    const both = item(['news', 'sports'], HOUR);
    expect(ids(plan([both], ['news', 'sports']))).toEqual([both.contentId]);
  });

  it('plans the same from day-file order as from unordered candidates', () => {
    const items = [0, 1, 3].flatMap((day) => Array.from({ length: 20 }, (_, i) => item(['news'], day * DAY + (i + 1) * 60_000, (i * 7) % 5)));
    const sorted = [...items].sort((a, b) => b.createdAt - a.createdAt);
    const fileOrder = [...items].sort((a, b) => Math.floor(b.createdAt / DAY) - Math.floor(a.createdAt / DAY) || b.likes - a.likes || b.createdAt - a.createdAt);
    const o = { hours: 96, limit: 30 };
    expect(ids(planFeed([fileOrder], opts(o)))).toEqual(ids(planFeed([sorted], opts(o))));
    expect(ids(planFeed([fileOrder], opts(o)))).toEqual(ids(planFeed([[...items].reverse()], opts(o))));
  });

  it.each(FEED_ALGORITHMS)('paginates multi-tag feeds with cursor positions, without repeats or gaps (%s)', (algorithm) => {
    const items = [0, 1, 2, 10].flatMap((day) =>
      Array.from({ length: 30 }, (_, i) => item(i % 3 === 0 ? ['news', 'sports'] : i % 3 === 1 ? ['news'] : ['sports', 'tech'], day * DAY + (i + 1) * 60_000, i % 7)),
    );
    const tags = ['news', 'sports', 'tech'];
    const seen: string[] = [];
    let positions: Record<number, number[]> | undefined;
    for (let page = 0; page < 50; page++) {
      const p = plan(items, tags, { algorithm, hours: 72, limit: 30, positions });
      seen.push(...ids(p));
      if (!p.truncated) break;
      positions = p.positions;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(items.length);
  });

  it.each(FEED_ALGORITHMS)('skips hidden records, and a hidden record passed on an earlier page does not hide the same content in another tag (%s)', (algorithm) => {
    const moved = item(['sports'], 23 * HOUR);
    const replaced: Item = { ...moved, tags: ['news'], hidden: true };
    const items = [item(['news'], HOUR), replaced, ...Array.from({ length: 20 }, (_, i) => item(['sports'], (i + 1) * 60_000)), moved];
    const picked: Candidate[] = [];
    let positions: Record<number, number[]> | undefined;
    for (let page = 0; page < 20; page++) {
      const p = plan(items, ['news', 'sports'], { algorithm, limit: 5, positions });
      picked.push(...p.slices.flatMap((s) => s.picks.flat()));
      if (!p.truncated) break;
      positions = p.positions;
    }
    expect(picked).not.toContain(replaced);
    expect(picked.map((c) => c.contentId).sort()).toEqual(items.filter((i) => !i.hidden).map((i) => i.contentId).sort());
  });
});

describe('planFeed fresh injection', () => {
  const fresh = (seed: number, positions?: number[]) => ({ every: 4, maxLikes: 0, pool: 200, seed, positions });
  /** A busy tag: 50 liked posts today, then 20 newer posts nobody has liked yet. */
  const busy = () => [
    ...Array.from({ length: 50 }, (_, i) => item(['news'], 2 * HOUR + i * 60_000, 5 + i)),
    ...Array.from({ length: 20 }, (_, i) => item(['news'], (i + 1) * 60_000)),
  ];
  const zeroLikes = (p: FeedPlan) => p.slices[0]!.picks[0]!.filter((c) => c.likes === 0).map((c) => c.contentId);

  it('injects new 0-like content into the newest slice of a busy tag', () => {
    const items = busy();
    expect(zeroLikes(plan(items, ['news'], { limit: 20 }))).toEqual([]);
    const p = plan(items, ['news'], { limit: 20, fresh: fresh(1) });
    const picks = p.slices[0]!.picks[0]!;
    expect(picks).toHaveLength(20);
    // The 2nd pick, then every 4th: 2, 6, 10, 14, 18.
    expect(picks.map((c, i) => (c.likes === 0 ? i + 1 : 0)).filter(Boolean)).toEqual([2, 6, 10, 14, 18]);
    // The remaining picks keep the likes order.
    const liked = picks.filter((c) => c.likes > 0).map((c) => c.likes);
    expect(liked).toEqual([...liked].sort((a, b) => b - a));
  });

  it('samples fresh content per session seed, reproducibly', () => {
    const items = busy();
    const a = zeroLikes(plan(items, ['news'], { limit: 20, fresh: fresh(1) }));
    expect(zeroLikes(plan(items, ['news'], { limit: 20, fresh: fresh(1) }))).toEqual(a);
    expect(zeroLikes(plan(items, ['news'], { limit: 20, fresh: fresh(2) }))).not.toEqual(a);
  });

  it('keeps plain recency order when nothing liked outranks the new content', () => {
    const items = Array.from({ length: 10 }, (_, i) => item(['news'], (i + 1) * 60_000));
    expect(ids(plan(items, ['news'], { fresh: fresh(1) }))).toEqual(items.map((i) => i.contentId));
  });

  it('leaves older slices ordered strictly by likes', () => {
    const items = [...busy(), ...Array.from({ length: 30 }, (_, i) => item(['news'], DAY + HOUR + i * 60_000, i % 3 === 0 ? 0 : i))];
    const older = plan(items, ['news'], { hours: 48, limit: 40, fresh: fresh(1) }).slices[1]!.picks[0]!.map((c) => c.likes);
    expect(older).toEqual([...older].sort((a, b) => b - a));
  });

  it('paginates with fresh injection without repeats or gaps', () => {
    const items = [0, 1, 10].flatMap((day) =>
      Array.from({ length: 30 }, (_, i) => item(i % 3 === 0 ? ['news', 'sports'] : i % 3 === 1 ? ['news'] : ['sports', 'tech'], day * DAY + (i + 1) * 60_000, i % 4 === 0 ? 0 : i)),
    );
    const tags = ['news', 'sports', 'tech'];
    const seen: string[] = [];
    let positions: Record<number, number[]> | undefined;
    let freshPositions: number[] | undefined;
    for (let page = 0; page < 50; page++) {
      const p = plan(items, tags, { hours: 72, limit: 15, positions, fresh: fresh(7, freshPositions) });
      seen.push(...ids(p));
      if (!p.truncated) break;
      positions = p.positions;
      freshPositions = p.freshPositions;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(items.length);
  });
});

describe('planFeed chronological algorithm', () => {
  const chronological = (items: Item[], tags: string[], o: Partial<PlanOptions> = {}) => plan(items, tags, { algorithm: 'chronological', ...o });
  /** A page's records in the order a client shows them: the tags' lists merged, newest first. */
  const merged = (p: FeedPlan) => p.slices.flatMap((s) => s.picks.flat().sort((a, b) => b.createdAt - a.createdAt));
  const newestFirst = (items: Item[]) => [...items].sort((a, b) => b.createdAt - a.createdAt).map((i) => i.contentId);

  it('orders a tag by creation time, newest first, whatever the likes', () => {
    const items = [item(['news'], 3 * HOUR, 50), item(['news'], HOUR, 1), item(['news'], 2 * HOUR, 10)];
    expect(plan(items, ['news']).slices[0]!.picks[0]!.map((c) => c.likes)).toEqual([50, 10, 1]);
    expect(chronological(items, ['news']).slices[0]!.picks[0]!.map((c) => c.likes)).toEqual([1, 10, 50]);
  });

  it('fills the page with the newest records of the window, not a share per day', () => {
    const items = [0, 1, 2].flatMap((day) => Array.from({ length: 200 }, (_, i) => item(['news'], day * DAY + (i + 1) * 60_000, i % 9)));
    const p = chronological(items, ['news'], { hours: 72 });
    expect(p.slices.map((s) => s.used)).toEqual([100]);
    expect(ids(p)).toEqual(newestFirst(items).slice(0, 100));
    expect(p.truncated).toBe(true);
  });

  it('takes the newest records of the tags together, not a share per tag', () => {
    // Every sports post is newer than any news post.
    const items = [
      ...Array.from({ length: 30 }, (_, i) => item(['news'], 2 * HOUR + i * 60_000, 100)),
      ...Array.from({ length: 30 }, (_, i) => item(['sports'], (i + 1) * 60_000)),
    ];
    const [news, sports] = chronological(items, ['news', 'sports'], { limit: 40 }).slices[0]!.picks;
    expect(sports).toHaveLength(30);
    expect(news!.map((c) => c.contentId)).toEqual(items.slice(0, 10).map((i) => i.contentId));
  });

  it('reaches older days, and past the window, only once the newer ones are used up', () => {
    const items = [0, 1, 5].flatMap((day) => Array.from({ length: 10 }, (_, i) => item(['news'], day * DAY + (i + 1) * 60_000)));
    const p = chronological(items, ['news'], { hours: 48, limit: 25 });
    expect(p.slices.map((s) => [s.used, s.extended])).toEqual([[10, false], [10, false], [5, true]]);
    expect(ids(p)).toEqual(newestFirst(items).slice(0, 25));
  });

  it('pages through every record once, in order of creation', () => {
    const items = [0, 1, 2, 10].flatMap((day) =>
      Array.from({ length: 30 }, (_, i) => item(i % 3 === 0 ? ['news', 'sports'] : i % 3 === 1 ? ['news'] : ['sports', 'tech'], day * DAY + (i + 1) * 60_000, i % 7)),
    );
    const seen: string[] = [];
    let positions: Record<number, number[]> | undefined;
    for (let page = 0; page < 50; page++) {
      const p = chronological(items, ['news', 'sports', 'tech'], { hours: 72, limit: 25, positions });
      seen.push(...merged(p).map((c) => c.contentId));
      if (!p.truncated) break;
      positions = p.positions;
    }
    expect(seen).toEqual(newestFirst(items));
  });

  it('has no fresh slots', () => {
    const items = [
      ...Array.from({ length: 30 }, (_, i) => item(['news'], 2 * HOUR + i * 60_000, 5 + i)),
      ...Array.from({ length: 10 }, (_, i) => item(['news'], (i + 1) * 60_000)),
    ];
    const fresh = { every: 4, maxLikes: 0, pool: 200, seed: 1 };
    const run = (o: Partial<PlanOptions>) => ids(plan(items, ['news'], { limit: 12, ...o }));
    expect(run({ fresh })).not.toEqual(run({}));
    expect(run({ algorithm: 'chronological', fresh })).toEqual(run({ algorithm: 'chronological' }));
  });
});

describe('planFeed AI filter', () => {
  const items = () =>
    [0, 1, 10].flatMap((day) =>
      Array.from({ length: 30 }, (_, i) => item(i % 2 ? ['news'] : ['news', 'tech'], day * DAY + (i + 1) * 60_000, i % 4 === 0 ? 0 : i, i % 3 === 0)),
    );
  const tags = ['news', 'tech'];

  it('returns only the records matching aiGenerated, in the order the unfiltered feed gives them', () => {
    const all = items();
    const unfiltered = ids(plan(all, ['news'], { hours: 72 }));
    expect(unfiltered).toHaveLength(all.length);
    for (const aiGenerated of [true, false]) {
      const wanted = new Set(all.filter((i) => i.aiGenerated === aiGenerated).map((i) => i.contentId));
      expect(ids(plan(all, ['news'], { hours: 72, aiGenerated }))).toEqual(unfiltered.filter((id) => wanted.has(id)));
    }
  });

  it.each(FEED_ALGORITHMS)('paginates the filtered lists without repeats or gaps (%s)', (algorithm) => {
    const all = items();
    for (const aiGenerated of [true, false]) {
      const seen: string[] = [];
      let positions: Record<number, number[]> | undefined;
      let freshPositions: number[] | undefined;
      for (let page = 0; page < 50; page++) {
        const fresh = { every: 4, maxLikes: 0, pool: 200, seed: 3, positions: freshPositions };
        const p = plan(all, tags, { algorithm, hours: 72, limit: 15, aiGenerated, positions, fresh });
        seen.push(...ids(p));
        if (!p.truncated) break;
        positions = p.positions;
        freshPositions = p.freshPositions;
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.sort()).toEqual(all.filter((i) => i.aiGenerated === aiGenerated).map((i) => i.contentId).sort());
    }
  });

  it('returns only the records matching moderated, which is a moderation queue when false, alone or with aiGenerated', () => {
    // Every other record is approved, under each of its hashtags.
    const all = items().map((i, n) => ({ ...i, moderated: n % 2 === 0 }));
    const unfiltered = ids(plan(all, ['news'], { hours: 72 }));
    for (const moderated of [true, false]) {
      const wanted = new Set(all.filter((i) => i.moderated === moderated).map((i) => i.contentId));
      expect(wanted.size).toBeGreaterThan(0);
      expect(ids(plan(all, ['news'], { hours: 72, moderated }))).toEqual(unfiltered.filter((id) => wanted.has(id)));
      const both = new Set(all.filter((i) => i.moderated === moderated && i.aiGenerated).map((i) => i.contentId));
      expect(ids(plan(all, ['news'], { hours: 72, moderated, aiGenerated: true }))).toEqual(unfiltered.filter((id) => both.has(id)));

      // Page by page, the filtered lists are what the positions index.
      const seen: string[] = [];
      let positions: Record<number, number[]> | undefined;
      for (let page = 0; page < 50; page++) {
        const p = plan(all, tags, { hours: 72, limit: 15, moderated, positions });
        seen.push(...ids(p));
        if (!p.truncated) break;
        positions = p.positions;
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.sort()).toEqual([...wanted].sort());
    }
  });
});
