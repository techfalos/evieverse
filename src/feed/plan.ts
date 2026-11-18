import { compareRecent, compareRecords } from '../tagfeed/layout.js';
import type { Candidate } from '../tagfeed/reader.types.js';
import { HOUR } from '../time.js';
import type { Boundary, FeedPlan, FreshOptions, PlanOptions } from './plan.types.js';

/**
 * popular: the window's most liked records first, the tags taking turns (with fresh slots).
 * chronological: the window's newest records first, whatever their tag or their likes.
 */
export const FEED_ALGORITHMS = ['popular', 'chronological'] as const;
export type FeedAlgorithm = (typeof FEED_ALGORITHMS)[number];

/** The windows a feed can be asked for, in hours: the past 1, 2, 4, 8 or 12 hours, or 1, 2, 3, 7, 14, 21, 30, 60 or 90 days. */
export const FEED_HOURS: readonly number[] = [1, 2, 4, 8, 12, 24, 48, 72, 168, 336, 504, 720, 1440, 2160];

/** Orders records by content id, lowest first: what settles the order of a fresh pool's records created at the same instant, or with the same key. */
const byId = (a: { contentId: string }, b: { contentId: string }) => (a.contentId < b.contentId ? -1 : a.contentId > b.contentId ? 1 : 0);

/**
 * A record's place in a session's fresh pools: a 32-bit hash of its id and the session's seed
 * (FNV-1a, then murmur3's final mix). It depends on nothing else, so the records of a pool keep
 * their order from page to page whichever others join or leave it, and each seed has its own order.
 */
function freshKey(seed: number, contentId: string): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < contentId.length; i++) h = Math.imul(h ^ contentId.charCodeAt(i), 0x01000193);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** The newest `pool` records with few likes, in the order of their keys for this session. */
function freshPool(list: Candidate[], fresh: FreshOptions): { records: Candidate[]; keys: number[] } {
  const pool = list
    .filter((c) => c.likes <= fresh.maxLikes)
    .sort((a, b) => b.createdAt - a.createdAt || byId(a, b))
    .slice(0, fresh.pool)
    .map((c) => ({ c, key: freshKey(fresh.seed, c.contentId) }))
    .sort((a, b) => a.key - b.key || byId(a.c, b.c));
  return { records: pool.map((p) => p.c), keys: pool.map((p) => p.key) };
}

/** How many values at the start of `sorted` are `passed`, which holds for all of them up to some point and for none after it. */
function countPassed<T>(sorted: T[], passed: (v: T) => boolean): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (passed(sorted[mid]!)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Plans a feed page of at most `limit` records of the requested tags (index entries only; bodies
 * are fetched afterwards). Items of one content in several tags are returned once.
 *
 * The feed is of the window and nothing else: the records created in the `hours` up to the anchor,
 * as one span of time. A record's place depends on its likes or on when it was created, never on
 * which day that was, and a page the window can't fill is left short rather than filled with older
 * records.
 *
 * The popular algorithm returns the window's most liked records first. Each tag's records are
 * ordered by likes (most first), then recency, and the tags take turns picking one record each, so
 * every tag gets an equal share of the page; a tag that runs out lets the others continue.
 *
 * Fresh injection (popular only): every `fresh.every`th pick per tag comes from the window's newest
 * low-like records, in an order of the session's own, so new content is seen (and can earn likes)
 * even on busy tags.
 *
 * The chronological algorithm works the same way, in order of time instead: each tag's records are
 * ordered by creation time alone, and a pick goes to whichever tag's next record is the newest
 * rather than to each tag in turn. So a page is the newest `limit` records of the tags together,
 * and the next page carries on from there. It has no fresh slots, which exist to lift new records
 * out of a likes order.
 *
 * A later page is planned over the lists as they are by then, not as the page before read them. It
 * starts each tag's list after the record the page before stopped at (`after`), and its fresh pool
 * after the key it stopped at: whatever is at or ahead of those counts as shown. So a record that
 * was shown isn't shown again while it stays where it was listed, and one that has left the lists
 * since is simply not there. What a session can miss is a record that came to be ahead of where it
 * had got to, and what it can be shown twice is one that came to be behind it: in the popular
 * order, a record that was shown and has lost likes since (DELETE /like). With `aiGenerated` or
 * `moderated` set, every other record is left out before any of this.
 */
export function planFeed(perTag: Candidate[][], opts: PlanOptions): FeedPlan {
  const { anchor } = opts;
  const chronological = opts.algorithm === 'chronological';
  const order = chronological ? compareRecent : compareRecords;
  const windowStart = anchor - opts.hours * HOUR;
  const T = perTag.length;

  // Each tag's records of the window, in the algorithm's order. A tag's index is in likes order only
  // within each of the days it is stored by, so the window's records are sorted as one list.
  const lists = perTag.map((candidates) =>
    candidates
      .filter(
        (c) =>
          c.createdAt > windowStart &&
          c.createdAt <= anchor &&
          (opts.aiGenerated === undefined || c.aiGenerated === opts.aiGenerated) &&
          (opts.moderated === undefined || c.moderated === opts.moderated),
      )
      .sort(order),
  );

  /** Content earlier pages returned, and this one has picked: it isn't returned again under another tag, or from another list. */
  const seen = new Set<string>();
  /** Marks the first `upTo` records of a list as shown by earlier pages. */
  const shown = (list: Candidate[], upTo: number) => {
    for (let i = 0; i < upTo; i++) seen.add(list[i]!.contentId);
    return upTo;
  };
  const pos = lists.map((list, t) => {
    const after = opts.after?.[t];
    return after ? shown(list, countPassed(list, (c) => order(c, after) <= 0)) : 0;
  });
  const start = [...pos];

  const fresh = !chronological && opts.fresh && opts.fresh.every > 0 ? opts.fresh : null;
  const freshPools = fresh ? lists.map((list) => freshPool(list, fresh)) : [];
  const pools = freshPools.map((p) => p.records);
  const freshPos = freshPools.map(({ records, keys }, t) => {
    const after = fresh?.after?.[t];
    return after == null ? 0 : shown(records, countPassed(keys, (key) => key <= after));
  });
  const freshStart = [...freshPos];
  /** This page's picks per tag so far, which decide where its fresh slots are. */
  const picked: number[] = Array(T).fill(0);

  /** Advances past records already shown (dedupe across tags and lists); returns the next record. */
  const next = (from: Candidate[][], at: number[], t: number): Candidate | undefined => {
    const list = from[t]!;
    while (at[t]! < list.length && seen.has(list[at[t]!]!.contentId)) at[t]!++;
    return list[at[t]!];
  };
  /** The ordered list holds every record of the tag, so it alone tells whether tag t has more. */
  const peek = (t: number) => next(lists, pos, t);

  /**
   * Where tag t's next pick comes from: its fresh pool on the 2nd and every `every`th pick after,
   * unless the ordered list has already reached low-like records (then nothing is being buried).
   */
  const source = (t: number): { from: Candidate[][]; at: number[] } => {
    if (!fresh || picked[t]! % fresh.every !== 1 % fresh.every || peek(t)!.likes <= fresh.maxLikes || !next(pools, freshPos, t)) return { from: lists, at: pos };
    return { from: pools, at: freshPos };
  };

  /** The tag whose turn it is, where tags take turns. */
  let rr = 0;
  /**
   * The tag the next pick comes from, or -1 once none has a record left: the next tag in turn that
   * has one or, in chronological order, the tag whose next record is the newest (of tags whose next
   * records were created in the same second, the one with the lower content id, as in each list).
   */
  const turn = (): number => {
    let t = -1;
    for (let step = 0; step < T; step++) {
      const candidate = chronological ? step : (rr + step) % T;
      const c = peek(candidate);
      if (!c) continue;
      if (!chronological) return candidate;
      if (t < 0 || compareRecent(c, peek(t)!) < 0) t = candidate;
    }
    return t;
  };

  const picks: Candidate[][] = Array.from({ length: T }, () => []);
  for (let used = 0; used < opts.limit; used++) {
    const t = turn();
    if (t < 0) break;
    const { from, at } = source(t);
    const c = next(from, at, t)!;
    seen.add(c.contentId);
    at[t]!++;
    picks[t]!.push(c);
    picked[t]!++;
    rr = (t + 1) % T;
  }

  // Every tag's place is moved past what was shown under another, so the next page starts each list after that too.
  const more = lists.map((_, t) => peek(t) !== undefined);
  // A list the page took nothing from keeps the place it had, even if nothing is left ahead of it.
  const boundary = ({ likes, createdAt, contentId }: Candidate): Boundary => ({ likes, createdAt, contentId });
  return {
    window: { from: windowStart, to: anchor },
    picks,
    truncated: more.includes(true),
    after: lists.map((list, t) => (pos[t]! > start[t]! ? boundary(list[pos[t]! - 1]!) : (opts.after?.[t] ?? null))),
    freshAfter: freshPools.map(({ keys }, t) => (freshPos[t]! > freshStart[t]! ? keys[freshPos[t]! - 1]! : (fresh?.after?.[t] ?? null))),
  };
}
