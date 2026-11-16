import type { Publisher, PublisherStore, Summary, SummaryStore } from '../storage/index.js';
import { toFeedRecord } from '../tagfeed/layout.js';
import type { Candidate } from '../tagfeed/reader.js';
import type { FeedPlan } from './plan.js';

const iso = (ms: number) => new Date(ms).toISOString();
const refKey = (c: { contentId: string; version: number }) => `${c.contentId}:${c.version}`;

export interface FeedBodies {
  summaries: Map<string, Summary>;
  publishers: Map<string, Publisher>;
}

/**
 * The summary of every planned record (one MGET for posts younger than the hot window, parallel
 * object-store reads for older ones) and its publisher's credit (one more MGET).
 */
export async function loadBodies(plan: FeedPlan, summaries: SummaryStore, publishers: PublisherStore): Promise<FeedBodies> {
  const picks = new Map<string, Candidate>();
  for (const slice of plan.slices) for (const list of slice.picks) for (const c of list) picks.set(refKey(c), c);
  const refs = [...picks.values()];
  const found = await summaries.getMany(refs);
  const byRef = new Map<string, Summary>();
  refs.forEach((c, i) => {
    if (found[i]) byRef.set(refKey(c), found[i]!);
  });
  return { summaries: byRef, publishers: await publishers.getMany([...byRef.values()].map((s) => s.userId)) };
}

/**
 * Streams the feed JSON in plan order. A record whose summary is gone (erased after the plan was
 * made) is left out.
 */
export function* renderFeed(plan: FeedPlan, tags: string[], bodies: FeedBodies, nextCursor: string | null): Generator<Buffer> {
  const head = {
    window: { from: iso(plan.window.from), to: iso(plan.window.to) },
    estimatedTokens: plan.estimatedTokens,
    truncated: plan.truncated,
    nextCursor,
  };
  yield Buffer.from(`${JSON.stringify(head).slice(0, -1)},"days":[`);

  let firstDay = true;
  for (const slice of plan.slices) {
    const meta = {
      from: iso(slice.from),
      to: iso(slice.to),
      extended: slice.extended,
      allocatedTokens: slice.allocated,
      usedTokens: slice.used,
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
