import { describe, expect, it } from 'vitest';
import { ENGAGED_EVERY, ENGAGED_LEAD, FEED_ALGORITHMS, planFeed } from '../src/feed/plan.js';
import type { Boundary, EngagedBoundary, FeedPlan, PlanOptions } from '../src/feed/plan.types.js';
import type { Candidate } from '../src/tagfeed/reader.types.js';
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
    views: 0,
    dislikes: 0,
    aiGenerated,
    moderated: false,
    repost: false,
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
/** A page's picks as the one list the response is: in the order they were made, whichever tag each was made under (as `pageRecords` puts them). */
function inOrder(p: FeedPlan): Candidate[] {
  const at = p.picks.map(() => 0);
  return p.order.map((t) => p.picks[t]![at[t]!++]!);
}
/** The popular feed's order: most liked first, then newest, then by id. */
const mostLikedFirst = (items: Item[]) => [...items].sort((a, b) => b.likes - a.likes || b.createdAt - a.createdAt || (a.contentId < b.contentId ? -1 : 1)).map((i) => i.contentId);

const FRESH = { every: 4, maxLikes: 0, pool: 200 };

/**
 * A feed session: each page is planned from where the one before stopped, over whatever the tags'
 * indexes hold by then (`items` is read again for every page, so a test changes it between them).
 */
function session(items: () => Item[], tags: string[], o: Partial<PlanOptions> = {}, seed?: number) {
  let after: (Boundary | null)[] | undefined;
  let freshAfter: (number | null)[] | undefined;
  let engagedAfter: (EngagedBoundary | null)[] | undefined;
  let led: string[] | undefined;
  let done = false;
  const page = () => {
    const p = plan(items(), tags, {
      ...o,
      after,
      ...(seed !== undefined && { fresh: { ...FRESH, seed, after: freshAfter } }),
      ...(o.engaged && { engaged: { ...o.engaged, after: engagedAfter, led } }),
    });
    // What a page hands on is all the next one is given: it goes through JSON, as a cursor does.
    ({ after, freshAfter, engagedAfter, led } = JSON.parse(JSON.stringify({ after: p.after, freshAfter: p.freshAfter, engagedAfter: p.engagedAfter, led: p.led })) as Pick<
      FeedPlan,
      'after' | 'freshAfter' | 'engagedAfter' | 'led'
    >);
    done = !p.truncated;
    return p;
  };
  /** The pages left, to the end of the feed. */
  const rest = () => {
    const pages: FeedPlan[] = [];
    while (!done && pages.length < 100) pages.push(page());
    expect(done).toBe(true);
    return pages;
  };
  return { page, rest };
}

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

  it('takes the most liked records of the tags together, not a share per tag', () => {
    // Every news record has more likes than any sports record.
    const items = [
      ...Array.from({ length: 100 }, (_, i) => item(['news'], (i + 1) * 60_000, 500 + i)),
      ...Array.from({ length: 100 }, (_, i) => item(['sports'], (i + 1) * 60_000, i)),
    ];
    for (const algorithm of [undefined, 'popular'] as const) {
      const [news, sports] = plan(items, ['news', 'sports'], { algorithm, limit: 50 }).picks;
      expect([news!.length, sports!.length]).toEqual([50, 0]);
      expect(news!.map((c) => c.likes)).toEqual(Array.from({ length: 50 }, (_, i) => 599 - i));
    }
    // Whichever tag is asked for first.
    expect(plan(items, ['sports', 'news'], { limit: 50 }).picks.map((l) => l.length)).toEqual([0, 50]);
    // Past the end of the tag that is liked most, the page carries on with the other's most liked.
    const p = plan(items, ['news', 'sports'], { limit: 120 });
    expect(p.picks.map((l) => l.length)).toEqual([100, 20]);
    expect(p.picks[1]!.map((c) => c.likes)).toEqual(Array.from({ length: 20 }, (_, i) => 99 - i));
  });

  it('puts the tags in one order of likes, in which a record with fewer likes never comes before one with more', () => {
    // The tags' likes are among each other's, and some records are under two of them.
    const items = Array.from({ length: 90 }, (_, i) => item(i % 5 === 0 ? ['news', 'sports'] : [['news'], ['sports'], ['tech']][i % 3]!, (i + 1) * 60_000, (i * 37) % 23));
    const tags = ['news', 'sports', 'tech'];
    const p = plan(items, tags, { limit: 40 });
    expect(inOrder(p).map((c) => c.contentId)).toEqual(mostLikedFirst(items).slice(0, 40));
    expect(p.truncated).toBe(true);
    // A record under two of the tags is picked under the one asked for first.
    const both = new Set(idsOf(items.filter((i) => i.tags.length === 2)));
    expect(p.picks[1]!.some((c) => both.has(c.contentId))).toBe(false);
    expect(plan(items, ['sports', 'news', 'tech'], { limit: 40 }).picks[1]!.some((c) => both.has(c.contentId))).toBe(false);
  });

  it('pages through every record of the window once, in order of likes', () => {
    const items = [0, 1, 2, 10].flatMap((day) =>
      Array.from({ length: 30 }, (_, i) => item(i % 3 === 0 ? ['news', 'sports'] : i % 3 === 1 ? ['news'] : ['sports', 'tech'], day * DAY + (i + 1) * 60_000, (i * 11 + day) % 9)),
    );
    const pages = session(() => items, ['news', 'sports', 'tech'], { hours: 336, limit: 25 }).rest();
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flatMap((p) => inOrder(p).map((c) => c.contentId))).toEqual(mostLikedFirst(items));
  });

  it('shares the page equally across requested tags in an engaged feed, where tags take turns', () => {
    const items = [
      ...Array.from({ length: 100 }, (_, i) => item(['news'], (i + 1) * 60_000, 500 + i)),
      ...Array.from({ length: 100 }, (_, i) => item(['sports'], (i + 1) * 60_000, i)),
    ];
    const p = plan(items, ['news', 'sports'], { algorithm: 'engaged', limit: 50 });
    const [news, sports] = p.picks;
    expect([news!.length, sports!.length]).toEqual([25, 25]);
    expect(p.order).toEqual(Array.from({ length: 50 }, (_, i) => i % 2));
    // Each tag's own most liked, though every news record has more likes than any sports record.
    expect(news!.map((c) => c.likes)).toEqual(Array.from({ length: 25 }, (_, i) => 599 - i));
    expect(sports!.map((c) => c.likes)).toEqual(Array.from({ length: 25 }, (_, i) => 99 - i));
  });

  it('lets other tags continue when one tag runs out', () => {
    const items = [
      ...Array.from({ length: 100 }, (_, i) => item(['news'], (i + 1) * 60_000)),
      ...Array.from({ length: 2 }, (_, i) => item(['sports'], (i + 1) * 60_000)),
    ];
    for (const algorithm of FEED_ALGORITHMS) {
      const [news, sports] = plan(items, ['news', 'sports'], { algorithm, limit: 50 }).picks;
      expect(sports, algorithm).toHaveLength(2);
      expect(news, algorithm).toHaveLength(48);
    }
  });

  it.each(FEED_ALGORITHMS)('returns content once even when it is in several requested tags (%s)', (algorithm) => {
    const both = item(['news', 'sports'], HOUR);
    expect(ids(plan([both], ['news', 'sports'], { algorithm }))).toEqual([both.contentId]);
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

  it.each(FEED_ALGORITHMS)('paginates multi-tag feeds from where each page stopped, without repeats or gaps (%s)', (algorithm) => {
    const items = [0, 1, 2, 10].flatMap((day) =>
      Array.from({ length: 30 }, (_, i) => item(i % 3 === 0 ? ['news', 'sports'] : i % 3 === 1 ? ['news'] : ['sports', 'tech'], day * DAY + (i + 1) * 60_000, i % 7)),
    );
    const tags = ['news', 'sports', 'tech'];
    const pages = session(() => items, tags, { algorithm, hours: 72, limit: 30 }).rest();
    expect(pages.length).toBeGreaterThan(1);
    for (const p of pages) expect(ids(p).length).toBeLessThanOrEqual(30);
    const seen = pages.flatMap(ids);
    expect(new Set(seen).size).toBe(seen.length);
    // Every record of the window, and none of the ones 10 days old.
    expect(seen.sort()).toEqual(idsOf(items.filter((i) => i.createdAt > NOW - 3 * DAY)).sort());
  });

});

describe('planFeed fresh injection', () => {
  const fresh = (seed: number) => ({ ...FRESH, seed });
  /** A busy tag: 50 liked posts, then 20 newer posts nobody has liked yet. */
  const busy = () => [
    ...Array.from({ length: 50 }, (_, i) => item(['news'], 2 * HOUR + i * 60_000, 5 + i)),
    ...Array.from({ length: 20 }, (_, i) => item(['news'], (i + 1) * 60_000)),
  ];
  const zeroLikes = (p: FeedPlan) => p.picks[0]!.filter((c) => c.likes === 0).map((c) => c.contentId);
  /** Fresh slots are the engaged feed's: these plan one that is told nothing of its reader, which is the popular feed with them. */
  const plan = (items: Item[], tags: string[], o: Partial<PlanOptions> = {}) => planFeed(byTag(items, tags), opts({ algorithm: 'engaged', ...o }));

  it('gives the popular feed no fresh slot: the page is in the order of its likes, whatever the settings', () => {
    const items = [...busy(), ...Array.from({ length: 30 }, (_, i) => item(['sports'], (i + 1) * 60_000, i % 3 === 0 ? 0 : i))];
    for (const algorithm of [undefined, 'popular'] as const) {
      const p = plan(items, ['news', 'sports'], { algorithm, limit: 60, fresh: fresh(1) });
      // The tags together: the 60 most liked of the 100, with none of those nobody has liked ahead of one that somebody has.
      expect(inOrder(p).map((c) => c.contentId)).toEqual(mostLikedFirst(items).slice(0, 60));
      expect(inOrder(p).some((c) => c.likes === 0)).toBe(false);
      // Nothing of a fresh pool is planned, or handed on to the next page.
      expect(p.freshAfter).toEqual([]);
      expect(ids(p)).toEqual(ids(plan(items, ['news', 'sports'], { algorithm, limit: 60 })));
    }
    // The same request as an engaged feed has them.
    const engaged = plan(items, ['news', 'sports'], { limit: 60, fresh: fresh(1) });
    expect(engaged.picks[0]!.map((c) => c.likes)[1]).toBe(0);
    expect(engaged.freshAfter).toHaveLength(2);
  });

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
    const pages = session(() => items, tags, { algorithm: 'engaged', hours: 336, limit: 15 }, 7).rest();
    expect(pages.some((p) => p.freshAfter.some((key) => key !== null))).toBe(true);
    const seen = pages.flatMap(ids);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(items.length);
  });

  it('keeps the order of a fresh pool as records leave it and join it, so pages carry on in it', () => {
    // 60 liked posts, and 30 newer ones nobody has liked: a pool of 20 holds the newest 20 of those.
    const liked = Array.from({ length: 60 }, (_, i) => item(['news'], 2 * HOUR + i * 60_000, 5 + i));
    const unliked = Array.from({ length: 30 }, (_, i) => item(['news'], (i + 1) * 60_000));
    let items = [...liked, ...unliked];
    const o = { limit: 16, fresh: { ...FRESH, pool: 20, seed: 5 } };
    const freshOf = (p: FeedPlan) => zeroLikes(p);

    const first = plan(items, ['news'], o);
    const shown = freshOf(first);
    expect(shown).toHaveLength(4);
    const whole = [...shown, ...freshOf(plan(items, ['news'], { ...o, after: first.after, fresh: { ...o.fresh, after: first.freshAfter } }))];
    expect(new Set(whole).size).toBe(8);

    // Two of the pool's records that weren't shown are deleted, so two older ones join it.
    const pool = idsOf(unliked.slice(0, 20));
    const gone = pool.filter((id) => !whole.includes(id)).slice(0, 2);
    items = items.filter((i) => !gone.includes(i.contentId));
    const second = freshOf(plan(items, ['news'], { ...o, after: first.after, fresh: { ...o.fresh, after: first.freshAfter } }));
    // None again, and of the records the second page would have shown, the ones still there, in the same order.
    expect(second.filter((id) => shown.includes(id))).toEqual([]);
    const kept = second.filter((id) => pool.includes(id));
    expect(kept).toEqual(whole.slice(4).filter((id) => kept.includes(id)));
    expect(kept.length).toBeGreaterThanOrEqual(2);
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
    const pages = session(() => items, ['news', 'sports', 'tech'], { algorithm: 'chronological', hours: 336, limit: 25 }).rest();
    expect(pages.flatMap((p) => merged(p).map((c) => c.contentId))).toEqual(newestFirst(items));
  });

  it('has no fresh slots', () => {
    const items = [
      ...Array.from({ length: 30 }, (_, i) => item(['news'], 2 * HOUR + i * 60_000, 5 + i)),
      ...Array.from({ length: 10 }, (_, i) => item(['news'], (i + 1) * 60_000)),
    ];
    const fresh = { every: 4, maxLikes: 0, pool: 200, seed: 1 };
    const run = (o: Partial<PlanOptions>) => ids(plan(items, ['news'], { limit: 12, ...o }));
    expect(run({ algorithm: 'engaged', fresh })).not.toEqual(run({ algorithm: 'engaged' }));
    expect(run({ algorithm: 'chronological', fresh })).toEqual(run({ algorithm: 'chronological' }));
    expect(plan(items, ['news'], { algorithm: 'chronological', fresh }).freshAfter).toEqual([]);
  });
});

describe('planFeed engaged algorithm', () => {
  /** How much each of some items matches what the feed's reader has liked and viewed. */
  const scoresOf = (pairs: [Item, number][]) => new Map(pairs.map(([i, score]) => [i.contentId, score]));
  const engaged = (items: Item[], tags: string[], scores: [Item, number][], o: Partial<PlanOptions> = {}) =>
    plan(items, tags, { algorithm: 'engaged', engaged: { scores: scoresOf(scores), seed: 1 }, ...o });
  /** A tag's posts, a minute apart, the older the more liked: the likes order is the order of time turned round. */
  const tagOf = (name: string, count = 30) => Array.from({ length: count }, (_, i) => item([name], (i + 1) * 60_000, i + 1));

  it("is each tag's most liked in turn, with fresh slots, where it is told nothing of its reader or nothing matches: of one tag, the popular feed with them, pick for pick", () => {
    const items = [...tagOf('news'), ...tagOf('sports')];
    const tags = ['news', 'sports'];
    const fresh = { ...FRESH, maxLikes: 5, seed: 3 };
    // Of one tag, the fresh slots are all that tells it from the popular feed: with none, it is that feed.
    const one = plan(items, ['news'], { limit: 20, fresh });
    expect(one.picks.flat().some((c) => c.likes <= 5)).toBe(false);
    expect(plan(items, ['news'], { algorithm: 'engaged', limit: 20, fresh }).picks[0]![1]!.likes).toBeLessThanOrEqual(5);
    const plain = plan(items, ['news'], { algorithm: 'engaged', limit: 20 });
    expect([plain.picks, plain.order, plain.after, plain.truncated]).toEqual([one.picks, one.order, one.after, one.truncated]);
    // Of several, each has its fresh slots, and the tags take turns (which a popular feed's don't).
    const popular = plan(items, tags, { limit: 40, fresh });
    expect(popular.picks.flat().some((c) => c.likes <= 5)).toBe(false);
    const untold = plan(items, tags, { algorithm: 'engaged', limit: 40, fresh });
    expect(untold.picks.map((list) => list[1]!.likes <= 5)).toEqual([true, true]);
    expect(untold.order).toEqual(Array.from({ length: 40 }, (_, i) => i % 2));
    for (const told of [{ scores: new Map<string, number>(), seed: 3 }, { scores: new Map([['c-elsewhere', 500]]), seed: 3 }]) {
      const p = plan(items, tags, { algorithm: 'engaged', limit: 40, fresh, engaged: told });
      expect([p.picks, p.order, p.after, p.freshAfter, p.truncated]).toEqual([untold.picks, untold.order, untold.after, untold.freshAfter, untold.truncated]);
      expect(p.led).toEqual([]);
    }
    // And no other algorithm reads what an engaged feed goes by.
    const all = { scores: scoresOf(items.map((i) => [i, 1])), seed: 3 };
    expect(ids(plan(items, tags, { limit: 40, fresh, engaged: all }))).toEqual(ids(popular));
    expect(ids(plan(items, tags, { algorithm: 'chronological', limit: 40, engaged: all }))).toEqual(ids(plan(items, tags, { algorithm: 'chronological', limit: 40 })));
  });

  it('leads with the newest records that match, then gives every third pick to the one that matches most', () => {
    const items = tagOf('news');
    const at = (...places: number[]) => idsOf(places.map((i) => items[i]!));
    // The two newest of those that match are not the two that match most.
    const p = engaged(items, ['news'], [[items[3]!, 10], [items[7]!, 500], [items[12]!, 20], [items[20]!, 300], [items[25]!, 15]], { limit: 11 });
    expect(ids(p)).toEqual(at(3, 7, /* the most liked */ 29, 28, /* matches most */ 20, 27, 26, /* matches next */ 12, 25, 24, /* none left that match */ 23));
    expect(p.led).toEqual(at(3, 7));
    expect(ENGAGED_LEAD).toBe(2);
    expect(ENGAGED_EVERY).toBe(3);
    // One record that matches leads alone.
    const one = engaged(items, ['news'], [[items[9]!, 1]], { limit: 4 });
    expect(ids(one)).toEqual(at(9, 29, 28, 27));
    expect(one.led).toEqual(at(9));
  });

  it('picks matching records whatever their likes or their age, in the order of how much they match', () => {
    const items = tagOf('news', 40);
    // The ten newest, which are the ten least liked, each matching by another amount.
    const scores = items.slice(0, 10).map((i, n): [Item, number] => [i, ((n * 7) % 10) + 1]);
    const p = engaged(items, ['news'], scores, { limit: 26 });
    const picks = idsOf(p.picks[0] as Item[]);
    expect(picks.slice(0, 2)).toEqual(idsOf(items.slice(0, 2)));
    const rest = picks.slice(2);
    const byScore = scores.slice(2).sort((a, b) => b[1] - a[1]).map(([i]) => i.contentId);
    expect(rest.filter((_, n) => n % 3 === 2)).toEqual(byScore);
    // Every other pick is the next most liked.
    expect(rest.filter((_, n) => n % 3 !== 2)).toEqual(idsOf(items.slice(24).reverse()));
  });

  it('orders the records that match as much as each other by the session, not by their likes or their age', () => {
    const items = tagOf('news', 60);
    const matching = (seed: number) => {
      const p = plan(items, ['news'], { algorithm: 'engaged', limit: 60, engaged: { scores: scoresOf(items.map((i) => [i, 7])), seed } });
      return idsOf(p.picks[0] as Item[]).slice(2).filter((_, n) => n % 3 === 2);
    };
    const a = matching(1);
    expect(matching(1)).toEqual(a);
    expect(matching(2)).not.toEqual(a);
    // Neither most liked first nor newest first: both would be in the order of the ids, one way or the other.
    expect(a).not.toEqual([...a].sort());
    expect(a).not.toEqual([...a].sort().reverse());
  });

  it('has each tag lead with its newest match, and a tag that is still to pick anything else lead again', () => {
    const [news, sports] = [tagOf('news'), tagOf('sports')];
    const items = [...news, ...sports];
    const both = engaged(items, ['news', 'sports'], [[news[4]!, 1], [news[2]!, 9], [sports[8]!, 1], [sports[6]!, 9]], { limit: 4 });
    expect(both.picks.map(idsOf as (l: unknown) => string[])).toEqual([idsOf([news[2]!, news[29]!]), idsOf([sports[6]!, sports[29]!])]);
    expect(both.order).toEqual([0, 1, 0, 1]);
    expect(both.led).toEqual(idsOf([news[2]!, sports[6]!]));

    // Nothing under #news matches: #sports gives both, at its first two turns.
    const one = engaged(items, ['news', 'sports'], [[sports[8]!, 1], [sports[6]!, 9]], { limit: 6 });
    expect(one.picks.map(idsOf as (l: unknown) => string[])).toEqual([idsOf([news[29]!, news[28]!, news[27]!]), idsOf([sports[6]!, sports[8]!, sports[29]!])]);
    expect(one.led).toEqual(idsOf([sports[6]!, sports[8]!]));
  });

  it('gives a pick that is both a fresh slot and a matching one to the record that matches', () => {
    const liked = Array.from({ length: 40 }, (_, i) => item(['news'], 2 * HOUR + i * 60_000, 5 + i));
    const unliked = Array.from({ length: 10 }, (_, i) => item(['news'], (i + 1) * 60_000));
    // The six newest of the liked ones match: two lead, and four are left for the matching picks.
    const scores = liked.slice(0, 6).map((i): [Item, number] => [i, 1]);
    const p = engaged([...liked, ...unliked], ['news'], scores, { limit: 16, fresh: { ...FRESH, seed: 1 } });
    const rest = p.picks[0]!.slice(2);
    const matches = new Set(idsOf(liked.slice(0, 6)));
    const places = (is: (c: Candidate) => boolean) => rest.map((c, n) => (is(c) ? n + 1 : 0)).filter(Boolean);
    expect(places((c) => matches.has(c.contentId))).toEqual([3, 6, 9, 12]);
    // The 2nd pick and every 4th after are fresh, but for the 6th, which is the matching record's.
    expect(places((c) => c.likes === 0)).toEqual([2, 10, 14]);
  });

  it('leads on its first page alone, and pages through every record of the window once', () => {
    const items = [0, 1, 10].flatMap((day) =>
      Array.from({ length: 30 }, (_, i) => item(i % 3 === 0 ? ['news', 'sports'] : i % 3 === 1 ? ['news'] : ['sports', 'tech'], day * DAY + (i + 1) * 60_000, i % 4 === 0 ? 0 : i)),
    );
    const tags = ['news', 'sports', 'tech'];
    // Every other record matches, many of them as much as each other.
    const scores = scoresOf(items.flatMap((i, n): [Item, number][] => (n % 2 ? [[i, (n % 5) + 1]] : [])));
    const pages = session(() => items, tags, { algorithm: 'engaged', hours: 336, limit: 15, engaged: { scores, seed: 7 } }, 7).rest();
    expect(pages.length).toBeGreaterThan(2);
    const seen = pages.flatMap(ids);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(items.length);
    // What the first page led with is all the session leads with.
    expect(pages[0]!.led).toHaveLength(2);
    for (const p of pages) expect(p.led).toEqual(pages[0]!.led);
    // Both are the newest matching record of the tag they were picked under.
    expect(pages[0]!.picks.slice(0, 2).map((list) => list[0]!.contentId)).toEqual(pages[0]!.led);
  });

  it('carries on after what was deleted since, with no record twice', () => {
    let items = [0, 1, 2].flatMap((day) => Array.from({ length: 30 }, (_, i) => item(i % 2 ? ['news'] : ['news', 'sports'], day * DAY + (i + 1) * 60_000, 10 * (10 + day * 30 + ((i * 7) % 30)))));
    const scores = scoresOf(items.flatMap((i, n): [Item, number][] => (n % 3 ? [] : [[i, (n % 7) + 1]])));
    const s = session(() => items, ['news', 'sports'], { algorithm: 'engaged', hours: 72, limit: 12, engaged: { scores, seed: 4 } }, 4);
    const first = ids(s.page());
    const second = ids(s.page());
    // Some that were shown, what the feed led with among them, and some that weren't yet, are deleted.
    const shown = [first[0]!, first[1]!, first[7]!, second[2]!, second[11]!];
    const unseen = idsOf(items).filter((id) => !first.includes(id) && !second.includes(id)).filter((_, n) => n % 4 === 0);
    items = items.filter((i) => !shown.includes(i.contentId) && !unseen.includes(i.contentId));

    const seen = [...first, ...second, ...s.rest().flatMap(ids)];
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual([...idsOf(items), ...shown].sort());
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
      const seen = session(() => all, tags, { algorithm, hours, limit: 15, aiGenerated }, 3).rest().flatMap(ids);
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

      // Page by page, over the filtered lists.
      const seen = session(() => all, tags, { hours, limit: 15, moderated }).rest().flatMap(ids);
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.sort()).toEqual([...wanted].sort());
    }
  });
});

describe('planFeed over indexes that change between pages', () => {
  const tags = ['news', 'sports', 'tech'];
  const tagsOf = (i: number) => (i % 3 === 0 ? ['news', 'sports'] : i % 3 === 1 ? ['news'] : ['sports', 'tech']);
  /** 90 records over three days; every like count is used once, so the likes order has no ties. */
  const corpus = () => [0, 1, 2].flatMap((day) => Array.from({ length: 30 }, (_, i) => item(tagsOf(i), day * DAY + (i + 1) * 60_000, 10 * (10 + day * 30 + ((i * 7) % 30)))));
  const hours = 72;

  it.each(FEED_ALGORITHMS)('leaves out what was deleted since, and neither repeats nor skips anything else (%s)', (algorithm) => {
    let items = corpus();
    const s = session(() => items, tags, { algorithm, hours, limit: 12 }, 9);
    const first = ids(s.page());
    const second = ids(s.page());
    // Some that were shown, and some that weren't yet, are deleted; the rest stay.
    const shown = [first[0]!, first[5]!, second[3]!, second[11]!];
    const unseen = idsOf(items).filter((id) => !first.includes(id) && !second.includes(id)).filter((_, n) => n % 4 === 0);
    items = items.filter((i) => !shown.includes(i.contentId) && !unseen.includes(i.contentId));

    const seen = [...first, ...second, ...s.rest().flatMap(ids)];
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual([...idsOf(items), ...shown].sort());
  });

  it.each(FEED_ALGORITHMS)('carries on after the last record of a list even when that record is gone, or the whole list is (%s)', (algorithm) => {
    let items = corpus();
    const s = session(() => items, tags, { algorithm, hours, limit: 12 });
    const first = s.page();
    // Each list's last pick is deleted, and so is everything that was shown.
    items = items.filter((i) => !ids(first).includes(i.contentId));
    const second = s.page();
    expect(ids(second).filter((id) => ids(first).includes(id))).toEqual([]);
    // Then every record of #tech goes: its place is kept, and the feed ends without it.
    items = items.filter((i) => !i.tags.includes('tech'));
    const seen = [...ids(first), ...ids(second), ...s.rest().flatMap(ids)];
    expect(new Set(seen).size).toBe(seen.length);
    expect(idsOf(items).filter((id) => !seen.includes(id))).toEqual([]);
  });

  it.each(FEED_ALGORITHMS)('keeps the place of each tag through the pages that take nothing from it (%s)', (algorithm) => {
    const items = corpus();
    // Fewer records in a page than the feed has tags.
    const pages = session(() => items, tags, { algorithm, hours, limit: 2 }).rest();
    const seen = pages.flatMap(ids);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual(idsOf(items).sort());
  });

  it('does not show a record again, in order of time, under another tag after it left the one it was shown under', () => {
    const both = item(['news', 'sports'], HOUR);
    let items = [both, ...Array.from({ length: 3 }, (_, i) => item(['news'], 2 * HOUR + i * 60_000)), ...Array.from({ length: 3 }, (_, i) => item(['sports'], 3 * HOUR + i * 60_000))];
    const s = session(() => items, ['news', 'sports'], { algorithm: 'chronological', hours, limit: 1 });
    expect(s.page().picks.map(idsOf as (l: unknown) => string[])).toEqual([[both.contentId], []]);
    items = items.map((i) => (i === both ? { ...i, tags: ['sports'] } : i));
    expect(s.rest().flatMap(ids)).toEqual(idsOf(items.slice(1)));
  });

  it('never shows again a record that was liked since, and misses one that the likes took ahead of where the feed has got to', () => {
    let items = corpus().filter((i) => i.tags.length === 1 && i.tags[0] === 'news');
    const s = session(() => items, ['news'], { hours, limit: 10 });
    const first = ids(s.page());
    const likes = (id: string) => items.find((i) => i.contentId === id)!.likes;
    const least = Math.min(...first.map(likes));
    const behind = items.filter((i) => !first.includes(i.contentId)).sort((a, b) => b.likes - a.likes);
    // One the feed hasn't reached is liked past everything it has shown; another only moves up among those to come.
    const [jumped, moved] = [behind.at(-1)!.contentId, behind.at(-2)!.contentId];
    const liked = new Map([[first[0]!, 5000], [first[9]!, least + 4000], [jumped, least + 1], [moved, behind[0]!.likes + 5]]);
    expect(liked.get(moved)).toBeLessThan(least);
    items = items.map((i) => (liked.has(i.contentId) ? { ...i, likes: liked.get(i.contentId)! } : i));

    const rest = s.rest().flatMap(ids);
    const seen = [...first, ...rest];
    expect(new Set(seen).size).toBe(seen.length);
    expect(rest[0]).toBe(moved);
    expect(idsOf(items).filter((id) => !seen.includes(id))).toEqual([jumped]);
  });

  it('shows a record that reaches the index late if it belongs after where the feed has got to, and misses it otherwise', () => {
    const all = corpus();
    const late = [all[3]!, all[80]!];
    let items = all.filter((i) => !late.includes(i));
    const s = session(() => items, tags, { algorithm: 'chronological', hours, limit: 12 });
    const first = ids(s.page());
    // One newer than everything the first page returned, one older.
    expect(late[0]!.createdAt).toBeGreaterThan(Math.min(...items.filter((i) => first.includes(i.contentId)).map((i) => i.createdAt)));
    items = all;

    const seen = [...first, ...s.rest().flatMap(ids)];
    expect(new Set(seen).size).toBe(seen.length);
    expect(idsOf(all).filter((id) => !seen.includes(id))).toEqual([late[0]!.contentId]);
  });

  it('shows a record under another tag once it has left the one the feed would have shown it under', () => {
    // Two posts under both hashtags, which the feed lists under #news, the one asked for first: the most liked of all, and one far behind.
    const both = [item(['news', 'sports'], HOUR, 30), item(['news', 'sports'], 2 * HOUR, 2)];
    let items = [
      ...Array.from({ length: 6 }, (_, i) => item(['news'], (i + 1) * 60_000, 1)),
      ...both,
      ...Array.from({ length: 6 }, (_, i) => item(['sports'], (i + 1) * 60_000, 10 + i)),
    ];
    const s = session(() => items, ['news', 'sports'], { hours, limit: 2 });
    const first = s.page();
    expect(ids(first)).toEqual([both[0]!.contentId, items.at(-1)!.contentId]);
    expect(first.order).toEqual([0, 1]);
    // The second loses #news before the feed reaches it there: it is still returned, under #sports.
    items = items.map((i) => (i === both[1] ? { ...i, tags: ['sports'] } : i));
    const rest = s.rest();
    expect(rest.flatMap((p) => idsOf(p.picks[0] as Item[]))).not.toContain(both[1]!.contentId);
    expect(rest.flatMap((p) => idsOf(p.picks[1] as Item[]))).toContain(both[1]!.contentId);
    const seen = rest.flatMap(ids);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).not.toContain(both[0]!.contentId);
  });
});
