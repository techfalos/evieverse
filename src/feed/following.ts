import { compareRecent, type DayRef } from '../tagfeed/layout.js';
import type { Candidate, OpenTag, TagFeedReader } from '../tagfeed/reader.js';
import { utcDay } from '../time.js';

export interface FollowingOptions {
  /** Most records in the page. */
  limit: number;
  /** The previous page's last record: this page holds only records after it, in compareRecent order. */
  after?: { createdAt: number; contentId: string };
  /** Only records created with AI (true) or without (false); omitted, both. */
  aiGenerated?: boolean;
  /** Records created at or before this instant are left out (the lookback limit). */
  oldest: number;
}

export interface FollowingPlan {
  /** Newest first. */
  picks: Candidate[];
  /** More records come after the last pick. */
  truncated: boolean;
}

/**
 * A page of a following feed: the newest records of the followed publishers' own indexes, after
 * `after`. Their day indexes are loaded newest day first, and only as far back as the page needs.
 * Each day's entry count says how many days could fill it, so those are loaded at once: one round
 * trip, unless the filters leave too few records.
 */
export async function planFollowing(reader: TagFeedReader, indexes: OpenTag[], opts: FollowingOptions): Promise<FollowingPlan> {
  const { after, limit } = opts;
  const keep = (c: Candidate) =>
    c.createdAt > opts.oldest &&
    (opts.aiGenerated === undefined || c.aiGenerated === opts.aiGenerated) &&
    (!after || compareRecent(after, c) < 0);
  const found: Candidate[] = [];

  // Days the cursor has passed, or older than the lookback, hold nothing for this page.
  const newestDay = after ? utcDay(after.createdAt) : Infinity;
  const oldestDay = utcDay(opts.oldest);
  const byDay = new Map<number, [OpenTag, DayRef][]>();
  for (const ix of indexes) {
    for (const ref of ix.days) {
      if (ref.day > newestDay || ref.day < oldestDay) continue;
      let refs = byDay.get(ref.day);
      if (!refs) byDay.set(ref.day, (refs = []));
      refs.push([ix, ref]);
    }
  }
  const days = [...byDay.keys()].sort((a, b) => b - a);

  for (let i = 0; i < days.length; ) {
    // Newer days are loaded, so every record newer than this day is found.
    const settled = found.filter((c) => utcDay(c.createdAt) > days[i]!).length;
    if (settled > limit) break;
    let wanted = limit + 1 - settled;
    const batch = new Map<OpenTag, DayRef[]>();
    for (; i < days.length && wanted > 0; i++) {
      for (const [ix, ref] of byDay.get(days[i]!)!) {
        let refs = batch.get(ix);
        if (!refs) batch.set(ix, (refs = []));
        refs.push(ref);
        wanted -= ref.count;
      }
    }
    const loaded = await Promise.all([...batch].map(([ix, refs]) => reader.loadDays(ix, refs)));
    for (const list of loaded) for (const c of list) if (keep(c)) found.push(c);
  }

  found.sort(compareRecent);
  return { picks: found.slice(0, limit), truncated: found.length > limit };
}
