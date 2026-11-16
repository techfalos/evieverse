import { compareRecent, compareRecords } from '../tagfeed/layout.js';
import type { Candidate } from '../tagfeed/reader.js';
import { HOUR } from '../time.js';

/**
 * popular: the window's most liked records first, the tags taking turns (with fresh slots).
 * chronological: the window's newest records first, whatever their tag or their likes.
 */
export const FEED_ALGORITHMS = ['popular', 'chronological'] as const;
export type FeedAlgorithm = (typeof FEED_ALGORITHMS)[number];

/** The windows a feed can be asked for, in hours: the past 1, 2, 4, 8 or 12 hours, or 1, 2, 3, 7, 14, 21, 30, 60 or 90 days. */
export const FEED_HOURS: readonly number[] = [1, 2, 4, 8, 12, 24, 48, 72, 168, 336, 504, 720, 1440, 2160];

export interface PlanOptions {
  /** Defaults to popular. */
  algorithm?: FeedAlgorithm;
  /** The window: only records created in the `hours` up to the anchor are in the feed. */
  hours: number;
  /** End of the window (inclusive, UTC epoch ms); later pages of a cursor reuse the first page's anchor. */
  anchor: number;
  /** Most records in the page. */
  limit: number;
  /** How far into each requested tag's ordered list earlier pages consumed. */
  positions?: number[];
  /** Fresh-content injection; omitted, `every: 0` or the chronological algorithm disables it. */
  fresh?: FreshOptions;
  /** Only records created with AI (true) or without (false); omitted, both. */
  aiGenerated?: boolean;
  /** Only records a moderator of their hashtag approved (true), or those none has yet (false), which is the hashtag's moderation queue; omitted, both. */
  moderated?: boolean;
}

export interface FreshOptions {
  /** One in every `every` picks per tag (the 2nd, then every `every`th after) comes from the fresh pool. */
  every: number;
  /** Records with at most this many likes are eligible. */
  maxLikes: number;
  /** Only the newest `pool` eligible records per tag are eligible; they're shuffled by `seed`. */
  pool: number;
  /** Per feed session (kept in the cursor), so different viewers see different fresh records. */
  seed: number;
  /** How far into each tag's fresh pool earlier pages consumed. */
  positions?: number[];
}

export interface FeedPlan {
  window: { from: number; to: number };
  /** Picked records per requested tag, in output order. */
  picks: Candidate[][];
  /** Whether the window holds records no page has returned yet. */
  truncated: boolean;
  /** How far into each requested tag's ordered list the feed has consumed. */
  positions: number[];
  /** Per tag, how far into its fresh pool the feed has consumed (empty when disabled). */
  freshPositions: number[];
}

/** Small deterministic PRNG (mulberry32), so the same seed reproduces the same shuffle on every page. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The newest `pool` records with few likes, newest first, then shuffled by the session seed. */
function freshPool(list: Candidate[], fresh: FreshOptions, t: number): Candidate[] {
  const pool = list
    .filter((c) => c.likes <= fresh.maxLikes)
    .sort((a, b) => b.createdAt - a.createdAt || (a.contentId < b.contentId ? -1 : a.contentId > b.contentId ? 1 : 0))
    .slice(0, fresh.pool);
  const random = rng(fresh.seed ^ Math.imul(t + 1, 0x9e3779b9));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool;
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
 * Fresh injection (popular only): every `fresh.every`th pick per tag comes from a seeded shuffle of
 * the window's newest low-like records, so new content is seen (and can earn likes) even on busy
 * tags.
 *
 * The chronological algorithm works the same way, in order of time instead: each tag's records are
 * ordered by creation time alone, and a pick goes to whichever tag's next record is the newest
 * rather than to each tag in turn. So a page is the newest `limit` records of the tags together,
 * and the next page carries on from there. It has no fresh slots, which exist to lift new records
 * out of a likes order.
 *
 * Either order depends only on the records, so cursor positions stay valid. With `aiGenerated` or
 * `moderated` set, every other record is left out before any of this, so the positions index the
 * filtered lists and later pages must use the same filters.
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
  const consumed = (from: Candidate[][], saved: number[] | undefined) =>
    from.map((list, t) => {
      const upTo = Math.min(saved?.[t] ?? 0, list.length);
      for (const c of list.slice(0, upTo)) seen.add(c.contentId);
      return upTo;
    });
  const pos = consumed(lists, opts.positions);

  const fresh = !chronological && opts.fresh && opts.fresh.every > 0 ? opts.fresh : null;
  const pools = fresh ? lists.map((list, t) => freshPool(list, fresh, t)) : [];
  const freshPos = consumed(pools, fresh?.positions);
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
    const ordered = { from: lists, at: pos };
    if (!fresh || picked[t]! % fresh.every !== 1 % fresh.every) return ordered;
    if (peek(t)!.likes <= fresh.maxLikes || !next(pools, freshPos, t)) return ordered;
    return { from: pools, at: freshPos };
  };

  /**
   * The tag the next pick comes from, or -1 once none has a record left: the next tag in turn that
   * has one or, in chronological order, the tag whose next record is the newest (of tags whose next
   * records were created in the same second, the one with the lower content id, as in each list).
   */
  let rr = 0;
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

  return {
    window: { from: windowStart, to: anchor },
    picks,
    truncated: lists.some((_, t) => peek(t) !== undefined),
    positions: [...pos],
    freshPositions: [...freshPos],
  };
}
