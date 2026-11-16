import { compareRecords, utcDay } from '../tagfeed/layout.js';
import type { Candidate } from '../tagfeed/reader.js';

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

/**
 * popular: each tag's records by likes, most first (with fresh slots in the newest slice).
 * balanced: the most liked, middle and least liked thirds of each UTC day take turns.
 */
export const FEED_MODES = ['popular', 'balanced'] as const;
export type FeedMode = (typeof FEED_MODES)[number];

export interface PlanOptions {
  /** Defaults to popular. */
  mode?: FeedMode;
  hours: number;
  /** End of the window (inclusive, UTC epoch ms); later pages of a cursor reuse the first page's anchor. */
  anchor: number;
  /** Most records in the page. */
  limit: number;
  maxLookbackDays: number;
  /** Per slice index, how far into each requested tag's ordered list earlier pages consumed. */
  positions?: Record<number, number[]>;
  /** Fresh-content injection for the newest slice; omitted, `every: 0` or balanced mode disables it. */
  fresh?: FreshOptions;
  /** Only records created with AI (true) or without (false); omitted, both. */
  aiGenerated?: boolean;
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

export interface PlannedSlice {
  index: number;
  from: number;
  to: number;
  extended: boolean;
  allocated: number;
  used: number;
  /** Picked records per requested tag, in output order. */
  picks: Candidate[][];
}

export interface FeedPlan {
  window: { from: number; to: number };
  slices: PlannedSlice[];
  truncated: boolean;
  positions: Record<number, number[]>;
  /** Per tag, how far into the newest slice's fresh pool the feed has consumed (empty when disabled). */
  freshPositions: number[];
}

interface Slice extends PlannedSlice {
  lists: Candidate[][];
  pos: number[];
  rr: number;
  seen: Set<string>;
  /** Only on the newest slice when fresh injection is enabled. */
  fresh: { lists: Candidate[][]; pos: number[]; picked: number[] } | null;
}

const isOrdered = (list: Candidate[]) => list.every((c, i) => i === 0 || compareRecords(list[i - 1]!, c) <= 0);

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
 * Balanced order of one tag's slice, from its likes order: each UTC day's records are split by rank
 * into thirds (most liked, middle, least liked), which take turns, each in likes order. When a day's
 * count isn't a multiple of three, the upper thirds take the extra records.
 */
function balance(list: Candidate[]): Candidate[] {
  const out: Candidate[] = [];
  for (let start = 0; start < list.length; ) {
    const day = utcDay(list[start]!.createdAt);
    let end = start + 1;
    while (end < list.length && utcDay(list[end]!.createdAt) === day) end++;
    const middle = start + Math.ceil((end - start) / 3);
    const bottom = start + Math.ceil((2 * (end - start)) / 3);
    for (let i = 0; start + i < middle; i++) {
      out.push(list[start + i]!);
      if (middle + i < bottom) out.push(list[middle + i]!);
      if (bottom + i < end) out.push(list[bottom + i]!);
    }
    start = end;
  }
  return out;
}

/**
 * Plans a feed page of at most `limit` records of the requested tags (index entries only; bodies
 * are fetched afterwards). Items of one content in several tags are returned once.
 *
 * Time is cut into 24h slices counted back from the anchor. Slice i of the requested window is
 * allotted limit / 2^(i+1) records (50%, 25%, 12.5%, ...), with the oldest window slice taking the
 * remainder. Within a slice, tags take turns (equal share per tag); each tag's records are ordered
 * by UTC day, then likes. Unused allowance carries to the next older slice; anything left after the
 * window extends further back (up to maxLookbackDays); anything still left flows back to the newest
 * slices that had records they couldn't fit.
 *
 * Fresh injection: in the newest slice, every `fresh.every`th pick per tag comes from a seeded
 * shuffle of the newest low-like records, so new content is seen (and can earn likes) even on
 * busy tags. Older slices are ordered strictly by likes.
 *
 * Balanced mode reorders each tag's records within each UTC day so the most liked, middle and least
 * liked thirds take turns (see balance). It has no fresh slots: the least liked third already gets a
 * third of the picks. The order depends only on the records, so cursor positions stay valid.
 *
 * With `aiGenerated` set, every other record is left out before any of this, so the positions index
 * the filtered lists and later pages must use the same filter.
 */
export function planFeed(perTag: Candidate[][], opts: PlanOptions): FeedPlan {
  const { anchor } = opts;
  const balanced = opts.mode === 'balanced';
  const windowStart = anchor - opts.hours * HOUR;
  const lookbackStart = Math.min(windowStart, anchor - opts.maxLookbackDays * DAY);
  const windowSlices = Math.ceil(opts.hours / 24);
  const T = perTag.length;

  const sliceBounds = (index: number) => {
    if (index < windowSlices) {
      return { from: Math.max(anchor - (index + 1) * DAY, windowStart), to: anchor - index * DAY, extended: false };
    }
    const k = index - windowSlices;
    return { from: Math.max(windowStart - (k + 1) * DAY, lookbackStart), to: windowStart - k * DAY, extended: true };
  };
  const sliceIndexOf = (ts: number) =>
    ts > windowStart ? Math.floor((anchor - ts) / DAY) : windowSlices + Math.floor((windowStart - ts) / DAY);

  const slices = new Map<number, Slice>();
  perTag.forEach((candidates, t) => {
    for (const c of candidates) {
      if (c.createdAt > anchor || c.createdAt <= lookbackStart) continue;
      if (opts.aiGenerated !== undefined && c.aiGenerated !== opts.aiGenerated) continue;
      const index = sliceIndexOf(c.createdAt);
      let slice = slices.get(index);
      if (!slice) {
        slice = {
          index,
          ...sliceBounds(index),
          allocated: 0,
          used: 0,
          picks: Array.from({ length: T }, () => []),
          lists: Array.from({ length: T }, () => []),
          pos: Array(T).fill(0),
          rr: 0,
          seen: new Set(),
          fresh: null,
        };
        slices.set(index, slice);
      }
      slice.lists[t]!.push(c);
    }
  });

  for (const slice of slices.values()) {
    // Day indexes are already in this order, so slices without tail entries usually skip the sort.
    for (const list of slice.lists) if (!isOrdered(list)) list.sort(compareRecords);
    if (balanced) slice.lists = slice.lists.map(balance);
    const saved = opts.positions?.[slice.index];
    if (saved) {
      slice.lists.forEach((list, t) => {
        slice.pos[t] = Math.min(saved[t] ?? 0, list.length);
        for (const c of list.slice(0, slice.pos[t])) if (!c.hidden) slice.seen.add(c.contentId);
      });
    }
  }

  const fresh = !balanced && opts.fresh && opts.fresh.every > 0 ? opts.fresh : null;
  const newest = slices.get(0);
  if (fresh && newest) {
    const lists = newest.lists.map((list, t) => freshPool(list, fresh, t));
    const pos = lists.map((list, t) => Math.min(fresh.positions?.[t] ?? 0, list.length));
    lists.forEach((list, t) => {
      for (const c of list.slice(0, pos[t])) if (!c.hidden) newest.seen.add(c.contentId);
    });
    newest.fresh = { lists, pos, picked: Array(T).fill(0) };
  }

  /**
   * Advances past records already shown (dedupe across tags and lists) or hidden by a tombstone;
   * returns the next record. Hidden records stay in the lists, so positions from a cursor written
   * before a tombstone arrived still point at the same records.
   */
  const next = (slice: Slice, lists: Candidate[][], pos: number[], t: number): Candidate | undefined => {
    const list = lists[t]!;
    while (pos[t]! < list.length && (list[pos[t]!]!.hidden || slice.seen.has(list[pos[t]!]!.contentId))) pos[t]!++;
    return list[pos[t]!];
  };
  /** The ranked list holds every record of the slice, so it alone tells whether tag t has more. */
  const peek = (slice: Slice, t: number) => next(slice, slice.lists, slice.pos, t);

  /**
   * Where tag t's next pick comes from: its fresh pool on the 2nd and every `every`th pick after,
   * unless the ranked list has already reached low-like records (then nothing is being buried).
   */
  const source = (slice: Slice, t: number): { lists: Candidate[][]; pos: number[] } => {
    const f = slice.fresh;
    if (!f || !fresh || f.picked[t]! % fresh.every !== 1 % fresh.every) return slice;
    if (peek(slice, t)!.likes <= fresh.maxLikes || !next(slice, f.lists, f.pos, t)) return slice;
    return f;
  };
  const hasMore = (slice: Slice) => slice.lists.some((_, t) => peek(slice, t) !== undefined);

  /** Tags take turns until the allowance is used or the slice is exhausted. */
  const fill = (slice: Slice, allowance: number): number => {
    let used = 0;
    slice.allocated += allowance;
    while (used < allowance) {
      let t = -1;
      for (let step = 0; step < T; step++) {
        const candidate = (slice.rr + step) % T;
        if (peek(slice, candidate)) {
          t = candidate;
          break;
        }
      }
      if (t < 0) break;
      const from = source(slice, t);
      const c = next(slice, from.lists, from.pos, t)!;
      slice.seen.add(c.contentId);
      from.pos[t]!++;
      slice.picks[t]!.push(c);
      if (slice.fresh) slice.fresh.picked[t]!++;
      used++;
      slice.rr = (t + 1) % T;
    }
    slice.used += used;
    return used;
  };

  // Pass 1: the requested window, newest slice first, halving allocations with carry-over.
  let carry = 0;
  let allocatedSoFar = 0;
  for (let i = 0; i < windowSlices; i++) {
    // Rounded on the running total, so the oldest slice doesn't collect every slice's rounding.
    const through = i === windowSlices - 1 ? opts.limit : Math.round(opts.limit * (1 - 2 ** -(i + 1)));
    const allowance = through - allocatedSoFar + carry;
    allocatedSoFar = through;
    const slice = slices.get(i);
    carry = slice ? allowance - fill(slice, allowance) : allowance;
  }
  let remaining = carry;

  const ordered = [...slices.values()].sort((a, b) => a.index - b.index);

  // Extension: reach back past the window while budget remains.
  for (const s of ordered) {
    if (remaining <= 0) break;
    if (s.extended) remaining -= fill(s, remaining);
  }

  // Pass 2: leftover budget flows back to the newest slices that still have records.
  for (const s of ordered) {
    if (remaining <= 0) break;
    if (hasMore(s)) remaining -= fill(s, remaining);
  }

  const positions: Record<number, number[]> = {};
  for (const s of ordered) if (s.pos.some((p) => p > 0)) positions[s.index] = [...s.pos];

  return {
    window: { from: windowStart, to: anchor },
    slices: ordered
      .filter((s) => s.picks.some((p) => p.length > 0))
      .map(({ index, from, to, extended, allocated, used, picks }) => ({ index, from, to, extended, allocated, used, picks })),
    truncated: ordered.some(hasMore),
    positions,
    freshPositions: newest?.fresh ? [...newest.fresh.pos] : [],
  };
}
