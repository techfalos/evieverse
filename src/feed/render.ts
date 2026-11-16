import type { Publisher, PublisherStore, Summary, SummaryStore } from '../storage/index.js';
import { toFeedRecord, type FeedRecord } from '../tagfeed/layout.js';
import type { Candidate } from '../tagfeed/reader.js';
import type { FeedPlan } from './plan.js';

const iso = (ms: number) => new Date(ms).toISOString();
const refKey = (c: { contentId: string; version: number }) => `${c.contentId}:${c.version}`;

export interface FeedBodies {
  summaries: Map<string, Summary>;
  publishers: Map<string, Publisher>;
}

/** Every record a tag feed's plan picked. */
export const planned = (plan: FeedPlan) => plan.slices.flatMap((s) => s.picks.flat());

/**
 * The summary of every picked record (one MGET for posts younger than the hot window, parallel
 * object-store reads for older ones) and its publisher's credit (one more MGET).
 */
export async function loadBodies(picked: Candidate[], summaries: SummaryStore, publishers: PublisherStore): Promise<FeedBodies> {
  const refs = [...new Map(picked.map((c) => [refKey(c), c])).values()];
  const found = await summaries.getMany(refs);
  const byRef = new Map<string, Summary>();
  refs.forEach((c, i) => {
    if (found[i]) byRef.set(refKey(c), found[i]!);
  });
  return { summaries: byRef, publishers: await publishers.getMany([...byRef.values()].map((s) => s.userId)) };
}

/**
 * Streams the feed JSON in plan order. A record whose summary is gone (erased after the plan was
 * made) is left out, and not counted.
 */
export function* renderFeed(plan: FeedPlan, tags: string[], bodies: FeedBodies, nextCursor: string | null): Generator<Buffer> {
  const counts = plan.slices.map((s) => s.picks.reduce((n, list) => n + list.filter((c) => bodies.summaries.has(refKey(c))).length, 0));
  const head = {
    window: { from: iso(plan.window.from), to: iso(plan.window.to) },
    count: counts.reduce((a, b) => a + b, 0),
    truncated: plan.truncated,
    nextCursor,
  };
  yield Buffer.from(`${JSON.stringify(head).slice(0, -1)},"days":[`);

  let firstDay = true;
  for (const [i, slice] of plan.slices.entries()) {
    const meta = {
      from: iso(slice.from),
      to: iso(slice.to),
      extended: slice.extended,
      allocated: slice.allocated,
      count: counts[i],
    };
    yield Buffer.from(`${firstDay ? '' : ','}${JSON.stringify(meta).slice(0, -1)},"tags":{`);
    firstDay = false;

    let firstTag = true;
    for (let t = 0; t < tags.length; t++) {
      const records: string[] = [];
      for (const c of slice.picks[t]!) {
        const s = bodies.summaries.get(refKey(c));
        if (s) records.push(JSON.stringify(toFeedRecord(s, c.likes, bodies.publishers.get(s.userId)!)));
      }
      if (!records.length) continue;
      yield Buffer.from(`${firstTag ? '' : ','}${JSON.stringify(tags[t])}:[${records.join(',')}]`);
      firstTag = false;
    }
    yield Buffer.from('}}');
  }
  yield Buffer.from(']}');
}

/** The records of a following feed's picks, in order; one whose summary is gone is left out. */
export function followingRecords(picks: Candidate[], bodies: FeedBodies): FeedRecord[] {
  return picks.flatMap((c) => {
    const s = bodies.summaries.get(refKey(c));
    return s ? [toFeedRecord(s, c.likes, bodies.publishers.get(s.userId)!)] : [];
  });
}
