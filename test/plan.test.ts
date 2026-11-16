import { describe, expect, it } from 'vitest';
import { FEED_ALGORITHMS, planFeed, type FeedPlan, type PlanOptions } from '../src/feed/plan.js';
import type { Candidate } from '../src/tagfeed/reader.js';
import { DAY, HOUR } from '../src/time.js';

/** Noon, so a 24-hour window reaches into the UTC day before. */
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
  ...o,
});

const plan = (items: Item[], tags: string[], o: Partial<PlanOptions> = {}) => planFeed(byTag(items, tags), opts(o));
const ids = (p: FeedPlan) => p.picks.flatMap((l) => l.map((c) => c.contentId));
const idsOf = (items: Item[]) => items.map((i) => i.contentId);

describe('planFeed', () => {
  it('returns the records of the window and no others, however short that leaves the page', () => {
    const [hour, day, older, weeks] = [item(['news'], HOUR), item(['news'], 23 * HOUR), item(['news'], 25 * HOUR), item(['news'], 21 * DAY)];
    const items = [hour!, day!, older!, weeks!];
    const p = plan(items, ['news']);
    expect(ids(p)).toEqual(idsOf([hour!, day!]));
    expect(p.truncated).toBe(false);
    expect(p.window).toEqual({ from: NOW - DAY, to: NOW });
    expect(ids(plan(items, ['news'], { hours: 1 }))).toEqual([]);
    expect(ids(plan(items, ['news'], { hours: 48 }))).toEqual(idsOf([hour!, day!, older!]));
    expect(ids(plan(items, ['news'], { hours: 720 }))).toEqual(idsOf(items));
  });

  it('takes the window from just after its start up to the anchor', () => {
    const [after, atAnchor, inside, atStart] = [item(['news'], -1), item(['news'], 0), item(['news'], DAY - 1), item(['news'], DAY)];
    expect(ids(plan([after!, atAnchor!, inside!, atStart!], ['news']))).toEqual(idsOf([atAnchor!, inside!]));
  });

  it('orders a tag by likes over the whole window, whichever day a record was created on', () => {
    // The most liked is the oldest, and the records of each UTC day are apart in the order.
    const items = [item(['news'], HOUR, 1), item(['news'], 2 * DAY + HOUR, 50), item(['news'], 13 * HOUR, 10), item(['news'], DAY + 2 * HOUR, 30), item(['news'], 3 * HOUR, 20)];
    expect(plan(items, ['news'], { hours: 72 }).picks[0]!.map((c) => c.likes)).toEqual([50, 30, 20, 10, 1]);
    expect(plan(items, ['news']).picks[0]!.map((c) => c.likes)).toEqual([20, 10, 1]);
  });

  it('orders records with the same likes newest first', () => {
    const items = [item(['news'], 2 * DAY, 3), item(['news'], HOUR, 3), item(['news'], DAY, 3), item(['news'], 2 * HOUR, 4)];
    expect(ids(plan(items, ['news'], { hours: 72 }))).toEqual(idsOf([items[3]!, items[1]!, items[2]!, items[0]!]));
  });

  it('gives no day a share of the page: the most liked records fill it, whenever in the window they were created', () => {
    // The older the day, the more its records are liked.
    const items = [0, 1, 2].flatMap((day) => Array.from({ length: 200 }, (_, i) => item(['news'], day * DAY + (i + 1) * 60_000, day * 1000 + i)));
    const p = plan(items, ['news'], { hours: 72 });
    const mostLiked = [...items].sort((a, b) => b.likes - a.likes).slice(0, 100);
    expect(ids(p)).toEqual(idsOf(mostLiked));
    expect(mostLiked.every((i) => i.createdAt <= NOW - 2 * DAY)).toBe(true);
    expect(p.truncated).toBe(true);
  });

  it('shares the page equally across requested tags', () => {
    const items = [
      ...Array.from({ length: 100 }, (_, i) => item(['news'], (i + 1) * 60_000, 500 + i)),
      ...Array.from({ length: 100 }, (_, i) => item(['sports'], (i + 1) * 60_000, i)),
    ];
    const [news, sports] = plan(items, ['news', 'sports'], { limit: 50 }).picks;
    expect([news!.length, sports!.length]).toEqual([25, 25]);
    // Each tag's own most liked, though every news record has more likes than any sports record.
    expect(news!.map((c) => c.likes)).toEqual(Array.from({ length: 25 }, (_, i) => 599 - i));
    expect(sports!.map((c) => c.likes)).toEqual(Array.from({ length: 25 }, (_, i) => 99 - i));
  });

  it('lets other tags continue when one tag runs out', () => {
    const items = [
      ...Array.from({ length: 100 }, (_, i) => item(['news'], (i + 1) * 60_000)),
      ...Array.from({ length: 2 }, (_, i) => item(['sports'], (i + 1) * 60_000)),
    ];
    const [news, sports] = plan(items, ['news', 'sports'], { limit: 50 }).picks;
    expect(sports).toHaveLength(2);
    expect(news).toHaveLength(48);
  });

  it('returns content once even when it is in several requested tags', () => {
    const both = item(['news', 'sports'], HOUR);
    expect(ids(plan([both], ['news', 'sports']))).toEqual([both.contentId]);
  });

  it.each(FEED_ALGORITHMS)('plans the same whatever order the candidates come in (%s)', (algorithm) => {
    const items = [0, 1, 3].flatMap((day) => Array.from({ length: 20 }, (_, i) => item(['news'], day * DAY + (i + 1) * 60_000, (i * 7) % 5)));
    const sorted = [...items].sort((a, b) => b.createdAt - a.createdAt);
    // As a tag's index holds them: a day at a time, newest day first, each by likes.
    const indexOrder = [...items].sort((a, b) => Math.floor(b.createdAt / DAY) - Math.floor(a.createdAt / DAY) || b.likes - a.likes || b.createdAt - a.createdAt);
    const o = { algorithm, hours: 168, limit: 30 };
    expect(ids(planFeed([indexOrder], opts(o)))).toEqual(ids(planFeed([sorted], opts(o))));
    expect(ids(planFeed([indexOrder], opts(o)))).toEqual(ids(planFeed([[...items].reverse()], opts(o))));
  });

  it.each(FEED_ALGORITHMS)('paginates multi-tag feeds with cursor positions, without repeats or gaps (%s)', (algorithm) => {
    const items = [0, 1, 2, 10].flatMap((day) =>
      Array.from({ length: 30 }, (_, i) => item(i % 3 === 0 ? ['news', 'sports'] : i % 3 === 1 ? ['news'] : ['sports', 'tech'], day * DAY + (i + 1) * 60_000, i % 7)),
    );
    const tags = ['news', 'sports', 'tech'];
    const seen: string[] = [];
    let positions: number[] | undefined;
    for (let page = 0; page < 50; page++) {
      const p = plan(items, tags, { algorithm, hours: 72, limit: 30, positions });
      expect(ids(p).length).toBeLessThanOrEqual(30);
      seen.push(...ids(p));
      if (!p.truncated) break;
      positions = p.positions;
    }
    expect(new Set(seen).size).toBe(seen.length);
    // Every record of the window, and none of the ones 10 days old.
    expect(seen.sort()).toEqual(idsOf(items.filter((i) => i.createdAt > NOW - 3 * DAY)).sort());
  });

});

describe('planFeed fresh injection', () => {
  const fresh = (seed: number, positions?: number[]) => ({ every: 4, maxLikes: 0, pool: 200, seed, positions });
  /** A busy tag: 50 liked posts, then 20 newer posts nobody has liked yet. */
  const busy = () => [
    ...Array.from({ length: 50 }, (_, i) => item(['news'], 2 * HOUR + i * 60_000, 5 + i)),
    ...Array.from({ length: 20 }, (_, i) => item(['news'], (i + 1) * 60_000)),
  ];
  const zeroLikes = (p: FeedPlan) => p.picks[0]!.filter((c) => c.likes === 0).map((c) => c.contentId);

  it('injects new 0-like content between the liked content of a busy tag', () => {
    const items = busy();
    expect(zeroLikes(plan(items, ['news'], { limit: 20 }))).toEqual([]);
    const p = plan(items, ['news'], { limit: 20, fresh: fresh(1) });
    const picks = p.picks[0]!;
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

  it("takes fresh content from the window's newest unliked records, whichever day they were created on", () => {
    // Liked posts over three days; the unliked ones are a day and two days old.
    const liked = [0, 1, 2].flatMap((day) => Array.from({ length: 20 }, (_, i) => item(['news'], day * DAY + HOUR + i * 60_000, 5 + i)));
    const yesterday = Array.from({ length: 4 }, (_, i) => item(['news'], DAY + 2 * HOUR + i * 60_000));
    const before = Array.from({ length: 4 }, (_, i) => item(['news'], 2 * DAY + 2 * HOUR + i * 60_000));
    const items = [...liked, ...yesterday, ...before];
    const picks = (o: Partial<PlanOptions>) => plan(items, ['news'], { hours: 72, limit: 16, ...o }).picks[0]!;

    const all = picks({ fresh: fresh(1) });
    expect(all.map((c, i) => (c.likes === 0 ? i + 1 : 0)).filter(Boolean)).toEqual([2, 6, 10, 14]);
    // A pool of four holds only the newest four of them.
    const newest = picks({ fresh: { ...fresh(1), pool: 4 } }).filter((c) => c.likes === 0);
    expect(newest.map((c) => c.contentId).sort()).toEqual(idsOf(yesterday).sort());
    // And none from outside the window.
    expect(zeroLikes(plan(items, ['news'], { hours: 24, limit: 16, fresh: fresh(1) }))).toEqual([]);
  });

  it('paginates with fresh injection without repeats or gaps', () => {
    const items = [0, 1, 10].flatMap((day) =>
      Array.from({ length: 30 }, (_, i) => item(i % 3 === 0 ? ['news', 'sports'] : i % 3 === 1 ? ['news'] : ['sports', 'tech'], day * DAY + (i + 1) * 60_000, i % 4 === 0 ? 0 : i)),
    );
    const tags = ['news', 'sports', 'tech'];
    const seen: string[] = [];
    let positions: number[] | undefined;
    let freshPositions: number[] | undefined;
    for (let page = 0; page < 50; page++) {
      const p = plan(items, tags, { hours: 336, limit: 15, positions, fresh: fresh(7, freshPositions) });
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
  const merged = (p: FeedPlan) => p.picks.flat().sort((a, b) => b.createdAt - a.createdAt);
  const newestFirst = (items: Item[]) => [...items].sort((a, b) => b.createdAt - a.createdAt).map((i) => i.contentId);

  it('orders a tag by creation time, newest first, whatever the likes', () => {
    const items = [item(['news'], 3 * HOUR, 50), item(['news'], HOUR, 1), item(['news'], 2 * HOUR, 10)];
    expect(plan(items, ['news']).picks[0]!.map((c) => c.likes)).toEqual([50, 10, 1]);
    expect(chronological(items, ['news']).picks[0]!.map((c) => c.likes)).toEqual([1, 10, 50]);
  });

  it('fills the page with the newest records of the window', () => {
    const items = [0, 1, 2].flatMap((day) => Array.from({ length: 200 }, (_, i) => item(['news'], day * DAY + (i + 1) * 60_000, i % 9)));
    const p = chronological(items, ['news'], { hours: 72 });
    expect(ids(p)).toEqual(newestFirst(items).slice(0, 100));
    expect(p.truncated).toBe(true);
  });

  it('takes the newest records of the tags together, not a share per tag', () => {
    // Every sports post is newer than any news post.
    const items = [
      ...Array.from({ length: 30 }, (_, i) => item(['news'], 2 * HOUR + i * 60_000, 100)),
      ...Array.from({ length: 30 }, (_, i) => item(['sports'], (i + 1) * 60_000)),
    ];
    const [news, sports] = chronological(items, ['news', 'sports'], { limit: 40 }).picks;
    expect(sports).toHaveLength(30);
    expect(news!.map((c) => c.contentId)).toEqual(items.slice(0, 10).map((i) => i.contentId));
  });

  it('returns the same records of the window as a popular feed, and stops where the window does', () => {
    const items = [0, 1, 5].flatMap((day) => Array.from({ length: 10 }, (_, i) => item(['news'], day * DAY + (i + 1) * 60_000, i)));
    const p = chronological(items, ['news'], { hours: 48, limit: 25 });
    expect(ids(p)).toEqual(newestFirst(items).slice(0, 20));
    expect(p.truncated).toBe(false);
    expect(ids(plan(items, ['news'], { hours: 48, limit: 25 })).sort()).toEqual(ids(p).sort());
  });

  it('pages through every record of the window once, in order of creation', () => {
    const items = [0, 1, 2, 10].flatMap((day) =>
      Array.from({ length: 30 }, (_, i) => item(i % 3 === 0 ? ['news', 'sports'] : i % 3 === 1 ? ['news'] : ['sports', 'tech'], day * DAY + (i + 1) * 60_000, i % 7)),
    );
    const seen: string[] = [];
    let positions: number[] | undefined;
    for (let page = 0; page < 50; page++) {
      const p = chronological(items, ['news', 'sports', 'tech'], { hours: 336, limit: 25, positions });
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
    expect(plan(items, ['news'], { algorithm: 'chronological', fresh }).freshPositions).toEqual([]);
  });
});

describe('planFeed AI filter', () => {
  const items = () =>
    [0, 1, 10].flatMap((day) =>
      Array.from({ length: 30 }, (_, i) => item(i % 2 ? ['news'] : ['news', 'tech'], day * DAY + (i + 1) * 60_000, i % 4 === 0 ? 0 : i, i % 3 === 0)),
    );
  const tags = ['news', 'tech'];
  /** A window that holds every one of them. */
  const hours = 336;

  it('returns only the records matching aiGenerated, in the order the unfiltered feed gives them', () => {
    const all = items();
    const unfiltered = ids(plan(all, ['news'], { hours }));
    expect(unfiltered).toHaveLength(all.length);
    for (const aiGenerated of [true, false]) {
      const wanted = new Set(all.filter((i) => i.aiGenerated === aiGenerated).map((i) => i.contentId));
      expect(ids(plan(all, ['news'], { hours, aiGenerated }))).toEqual(unfiltered.filter((id) => wanted.has(id)));
    }
  });

  it.each(FEED_ALGORITHMS)('paginates the filtered lists without repeats or gaps (%s)', (algorithm) => {
    const all = items();
    for (const aiGenerated of [true, false]) {
      const seen: string[] = [];
      let positions: number[] | undefined;
      let freshPositions: number[] | undefined;
      for (let page = 0; page < 50; page++) {
        const fresh = { every: 4, maxLikes: 0, pool: 200, seed: 3, positions: freshPositions };
        const p = plan(all, tags, { algorithm, hours, limit: 15, aiGenerated, positions, fresh });
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
    const unfiltered = ids(plan(all, ['news'], { hours }));
    for (const moderated of [true, false]) {
      const wanted = new Set(all.filter((i) => i.moderated === moderated).map((i) => i.contentId));
      expect(wanted.size).toBeGreaterThan(0);
      expect(ids(plan(all, ['news'], { hours, moderated }))).toEqual(unfiltered.filter((id) => wanted.has(id)));
      const both = new Set(all.filter((i) => i.moderated === moderated && i.aiGenerated).map((i) => i.contentId));
      expect(ids(plan(all, ['news'], { hours, moderated, aiGenerated: true }))).toEqual(unfiltered.filter((id) => both.has(id)));

      // Page by page, the filtered lists are what the positions index.
      const seen: string[] = [];
      let positions: number[] | undefined;
      for (let page = 0; page < 50; page++) {
        const p = plan(all, tags, { hours, limit: 15, moderated, positions });
        seen.push(...ids(p));
        if (!p.truncated) break;
        positions = p.positions;
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.sort()).toEqual([...wanted].sort());
    }
  });
});
