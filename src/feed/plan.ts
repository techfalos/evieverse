import { compareRecent, compareRecords } from '../tagfeed/layout.js';
import type { Candidate } from '../tagfeed/reader.types.js';
import { HOUR } from '../time.js';
import type { Boundary, EngagedBoundary, FeedPlan, FreshOptions, PlanOptions } from './plan.types.js';

/**
 * popular: the window's most liked records first, whatever their tag: one list of the tags
 * together, in the order of their likes and nothing else, which is what a reader who asks for it
 * expects.
 * chronological: the window's newest records first, whatever their tag or their likes.
 * engaged: the tags take turns, each giving its most liked records, with fresh slots, led by the
 * newest records that match what its reader has liked and viewed, with more that match among the
 * rest. For a reader it is told nothing of, it is each tag's most liked in turn, with fresh slots.
 */
export const FEED_ALGORITHMS = ['popular', 'chronological', 'engaged'] as const;
export type FeedAlgorithm = (typeof FEED_ALGORITHMS)[number];

/** The most records an engaged feed leads with: the newest that match, at the start of its first page. */
export const ENGAGED_LEAD = 2;
/** In an engaged feed, one in this many picks per tag (the 3rd, then every 3rd after) is a record that matches, whatever its likes or its age. */
export const ENGAGED_EVERY = 3;

/** The windows a feed can be asked for, in hours: the past 1, 2, 4, 8 or 12 hours, or 1, 2, 3, 7, 14, 21, 30, 60 or 90 days. */
export const FEED_HOURS: readonly number[] = [1, 2, 4, 8, 12, 24, 48, 72, 168, 336, 504, 720, 1440, 2160];

/** Orders records by content id, lowest first: what settles the order of a fresh pool's records created at the same instant, or with the same key. */
const byId = (a: { contentId: string }, b: { contentId: string }) => (a.contentId < b.contentId ? -1 : a.contentId > b.contentId ? 1 : 0);

/**
 * A record's place in a session's fresh pools: a 32-bit hash of its id and the session's seed
 * (FNV-1a, then murmur3's final mix). It depends on nothing else, so the records of a pool keep
 * their order from page to page whichever others join or leave it, and each seed has its own order.
 * An engaged feed's matching records that match as much as each other are in this order too.
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

/** Order of an engaged feed's matching records: those that match most first, then by their keys for this session, then id. */
const compareMatches = (a: EngagedBoundary, b: EngagedBoundary) => b.score - a.score || a.key - b.key || byId(a, b);

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
 * The popular algorithm returns the window's most liked records first, whatever their tag. Each
 * tag's records are ordered by likes (most first), then recency, and a pick goes to whichever
 * tag's next record is first in that order. So a page is the most liked `limit` records of the
 * tags together, and the next page carries on from there: no tag has a share of the page, and one
 * whose records are liked less than the others' gives none until those are used up. Nothing else
 * decides a pick, so a record with fewer likes never comes before one with more.
 *
 * The chronological algorithm works the same way, in order of time instead: each tag's records are
 * ordered by creation time alone, and a pick goes to whichever tag's next record is the newest.
 * So a page is the newest `limit` records of the tags together.
 *
 * The engaged algorithm is the one where the tags take turns: each tag's records are ordered by
 * likes, as in a popular feed, and the tags pick one record each in turn, so every tag gets an
 * equal share of the page; a tag that runs out lets the others continue. And some of its picks go
 * by something other than likes. It is the feed made for its reader rather than a sort they chose,
 * so it is where those belong:
 *
 * - Fresh injection: every `fresh.every`th pick per tag comes from the window's newest low-like
 *   records, in an order of the session's own, so new content is seen (and can earn likes) even
 *   on busy tags. Only this algorithm has it, whatever it is told of its reader.
 *
 * And two things more for the records that match what the feed's reader has liked and viewed
 * (`engaged.scores`), where it is given any:
 *
 * - The first page leads with the newest of them: each tag's first pick is its newest matching
 *   record, until the page has led with ENGAGED_LEAD, and a tag that is still to make a pick of
 *   its own gives another when its turn comes again. So one tag alone gives both.
 * - After that, every ENGAGED_EVERYth pick per tag (the 3rd, then every 3rd after) is the tag's
 *   next matching record: those that match most first, and those that match as much as each
 *   other in an order of the session's own, so neither their likes nor their age decides which.
 *   Where such a pick is also a fresh slot, it is the matching record's.
 *
 * Every other pick is the tag's next most liked record. With no `engaged`, or where nothing
 * matches, it is each tag's most liked in turn, with fresh slots; of one tag, with no fresh slots
 * either, it is the popular feed, pick for pick.
 *
 * A later page is planned over the lists as they are by then, not as the page before read them. It
 * starts each tag's list after the record the page before stopped at (`after`), and its fresh pool
 * after the key it stopped at, and its matching records after the one it stopped at
 * (`engaged.after`): whatever is at or ahead of those counts as shown, and so does what the
 * session led with (`engaged.led`). So a record that
 * was shown isn't shown again while it stays where it was listed, and one that has left the lists
 * since is simply not there. What a session can miss is a record that came to be ahead of where it
 * had got to, and what it can be shown twice is one that came to be behind it: in the popular
 * order, a record that was shown and has lost likes since (DELETE /like). With `aiGenerated` or
 * `moderated` set, every other record is left out before any of this.
 */
export function planFeed(perTag: Candidate[][], opts: PlanOptions): FeedPlan {
  const { anchor } = opts;
  const order = opts.algorithm === 'chronological' ? compareRecent : compareRecords;
  // A popular or a chronological feed is one list of the tags together, in its order. In an engaged one the tags take turns.
  const merged = opts.algorithm !== 'engaged';
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

  // Fresh slots are the engaged feed's alone: a popular feed is in the order of its likes, and a chronological one of time.
  const fresh = !merged && opts.fresh && opts.fresh.every > 0 ? opts.fresh : null;
  const freshPools = fresh ? lists.map((list) => freshPool(list, fresh)) : [];
  const pools = freshPools.map((p) => p.records);
  const freshPos = freshPools.map(({ records, keys }, t) => {
    const after = fresh?.after?.[t];
    return after == null ? 0 : shown(records, countPassed(keys, (key) => key <= after));
  });
  const freshStart = [...freshPos];

  const engaged = !merged && opts.engaged ? opts.engaged : null;
  for (const contentId of engaged?.led ?? []) seen.add(contentId);
  /** Each tag's records of the window that match, with what orders them, in that order. */
  const matches = engaged
    ? lists.map((list) =>
        list
          .flatMap((c) => {
            const score = engaged.scores.get(c.contentId) ?? 0;
            return score > 0 ? [{ c, score, key: freshKey(engaged.seed, c.contentId), contentId: c.contentId }] : [];
          })
          .sort(compareMatches),
      )
    : [];
  const matching = matches.map((list) => list.map((m) => m.c));
  const matchPos = matches.map((list, t) => {
    const after = engaged?.after?.[t];
    return after ? shown(matching[t]!, countPassed(list, (m) => compareMatches(m, after) <= 0)) : 0;
  });
  const matchStart = [...matchPos];
  /** The same records newest first, which a first page leads with: a page that has a cursor leads with none. */
  const newest = engaged && !opts.after ? matching.map((list) => [...list].sort(compareRecent)) : [];
  const newestPos = newest.map(() => 0);
  /** The content this page led with, and how many more it may lead with. */
  const led: string[] = [];
  let leads = newest.length > 0 ? ENGAGED_LEAD : 0;

  /** This page's picks per tag so far, but for those it led with: they decide where its fresh slots and its matching ones are. */
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
   * Where tag t's next pick comes from: its ordered list, in a popular or a chronological feed,
   * which has no other.
   *
   * In an engaged feed, it is its fresh pool on the 2nd and every `every`th pick after, unless the
   * ordered list has already reached low-like records (then nothing is being buried). And where
   * the feed goes by an engagement, two come before that: its newest matching record while the
   * page is still leading and the tag has made no other pick (`lead`), and its next matching
   * record on every ENGAGED_EVERYth pick. A tag with no matching record left picks as it would otherwise.
   */
  const source = (t: number): { from: Candidate[][]; at: number[]; lead?: true } => {
    if (leads > 0 && picked[t] === 0 && next(newest, newestPos, t)) return { from: newest, at: newestPos, lead: true };
    if (engaged && picked[t]! % ENGAGED_EVERY === ENGAGED_EVERY - 1 && next(matching, matchPos, t)) return { from: matching, at: matchPos };
    if (!fresh || picked[t]! % fresh.every !== 1 % fresh.every || peek(t)!.likes <= fresh.maxLikes || !next(pools, freshPos, t)) return { from: lists, at: pos };
    return { from: pools, at: freshPos };
  };

  /** The tag whose turn it is, where tags take turns. */
  let rr = 0;
  /**
   * The tag the next pick comes from, or -1 once none has a record left. In a popular or a
   * chronological feed, the tag whose next record is first in the feed's order: the most liked, or
   * the newest (of tags whose next records are at the same place in it, the one asked for first,
   * which is where content under several of them is listed). In an engaged feed, the next tag in
   * turn that has a record.
   */
  const turn = (): number => {
    let t = -1;
    for (let step = 0; step < T; step++) {
      const candidate = merged ? step : (rr + step) % T;
      const c = peek(candidate);
      if (!c) continue;
      if (!merged) return candidate;
      if (t < 0 || order(c, peek(t)!) < 0) t = candidate;
    }
    return t;
  };

  const picks: Candidate[][] = Array.from({ length: T }, () => []);
  const pickOrder: number[] = [];
  for (let used = 0; used < opts.limit; used++) {
    const t = turn();
    if (t < 0) break;
    const { from, at, lead } = source(t);
    const c = next(from, at, t)!;
    seen.add(c.contentId);
    at[t]!++;
    picks[t]!.push(c);
    pickOrder.push(t);
    if (lead) {
      led.push(c.contentId);
      leads--;
    } else {
      picked[t]!++;
    }
    rr = (t + 1) % T;
  }

  // Every tag's place is moved past what was shown under another, so the next page starts each list after that too.
  const more = lists.map((_, t) => peek(t) !== undefined);
  // A list the page took nothing from keeps the place it had, even if nothing is left ahead of it.
  const boundary = ({ likes, createdAt, contentId }: Candidate): Boundary => ({ likes, createdAt, contentId });
  return {
    window: { from: windowStart, to: anchor },
    picks,
    order: pickOrder,
    truncated: more.includes(true),
    after: lists.map((list, t) => (pos[t]! > start[t]! ? boundary(list[pos[t]! - 1]!) : (opts.after?.[t] ?? null))),
    freshAfter: freshPools.map(({ keys }, t) => (freshPos[t]! > freshStart[t]! ? keys[freshPos[t]! - 1]! : (fresh?.after?.[t] ?? null))),
    engagedAfter: matches.map((list, t) => {
      if (matchPos[t]! === matchStart[t]!) return engaged?.after?.[t] ?? null;
      const { score, key, contentId } = list[matchPos[t]! - 1]!;
      return { score, key, contentId };
    }),
    led: engaged ? [...(engaged.led ?? []), ...led] : [],
  };
}
