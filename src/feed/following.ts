import { compareRecent, indexAuthor } from '../tagfeed/layout.js';
import type { DayRef } from '../tagfeed/layout.types.js';
import type { TagFeedReader } from '../tagfeed/reader.js';
import type { OpenTag } from '../tagfeed/reader.types.js';
import { utcDay } from '../time.js';
import type { FollowingOptions, FollowingPick, FollowingPlan } from './following.types.js';

/**
 * A page of a following feed: the newest records of the followed publishers' own indexes, after
 * `after`. Their day indexes are loaded newest day first, and only as far back as the page needs.
 * Each day's entry count says how many days could fill it, so those are loaded at once: one round
 * trip, unless the filters leave too few records.
 *
 * A user's own index holds their posts and what they reposted (src/reposts.ts), each repost at
 * its own time, as a new post. So a post is in the feed once for its publisher, if they are
 * followed, and once more for each followed user who reposted it, where it says who (`by`).
 */
export async function planFollowing(reader: TagFeedReader, indexes: OpenTag[], opts: FollowingOptions): Promise<FollowingPlan> {
  const { after, limit } = opts;
  const found: FollowingPick[] = [];

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
    const read = [...batch];
    (await Promise.all(read.map(([ix, refs]) => reader.loadDays(ix, refs)))).forEach((list, n) => {
      const by = indexAuthor(read[n]![0].tag) ?? undefined;
      // The reader's entries are shared and never changed: a repost's is copied to say whose index it is from.
      for (const c of list) {
        if (c.createdAt > opts.oldest && (opts.aiGenerated === undefined || c.aiGenerated === opts.aiGenerated) && (!after || compareRecent(after, c) < 0)) {
          found.push(c.repost ? { ...c, by } : c);
        }
      }
    });
  }

  found.sort(compareRecent);
  // Two followed users who reposted a post in the same second have one place between them, as far as a cursor can tell.
  const picks = found.filter((c, i) => i === 0 || compareRecent(found[i - 1]!, c) !== 0);
  return { picks: picks.slice(0, limit), truncated: picks.length > limit };
}
