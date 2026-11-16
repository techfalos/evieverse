import type { FeedAd } from '../monetization.types.js';
import type { Publisher, PublisherStore, Summary, SummaryStore } from '../storage/index.js';
import { toFeedRecord } from '../tagfeed/layout.js';
import type { FeedRecord } from '../tagfeed/layout.types.js';
import type { Candidate } from '../tagfeed/reader.types.js';
import { iso } from '../time.js';
import type { FollowingPick } from './following.types.js';
import type { FeedPlan } from './plan.types.js';

/** What a picked record's summary is kept under in `FeedBodies`: its content id, so the entries of one piece of content share a summary. */
const refKey = (c: { contentId: string }) => c.contentId;

/**
 * What a page's picked records are shown with: their summaries, by content id, and the credits of
 * their publishers (and of those who reposted them, in a following feed), by user id. `loadBodies`
 * makes it, and `renderFeed` and `followingRecords` read it. Content whose summary wasn't found
 * isn't in `summaries`.
 */
interface FeedBodies {
  summaries: Map<string, Summary>;
  publishers: Map<string, Publisher>;
}

/** Every record a tag feed's plan picked. */
export const planned = (plan: FeedPlan) => plan.picks.flat();

/**
 * The summary of every picked record (one MGET for posts younger than the hot window, parallel
 * object-store reads for older ones) and its publisher's credit (one more MGET).
 */
export async function loadBodies(picked: (Candidate & { by?: string })[], summaries: SummaryStore, publishers: PublisherStore): Promise<FeedBodies> {
  // Content picked twice (as its publisher's post and as a repost, say) has one summary, kept under the day of each entry.
  const refs = [...new Map(picked.map((c) => [refKey(c), c])).values()];
  const found = await summaries.getMany(refs);
  const byRef = new Map<string, Summary>();
  refs.forEach((c, i) => {
    if (found[i]) byRef.set(refKey(c), found[i]!);
  });
  return {
    summaries: byRef,
    publishers: await publishers.getMany([
      ...new Set([
        ...[...byRef.values()].map((s) => s.userId),
        // And the credits of those who reposted them, where a following feed says who did.
        ...picked.flatMap((c) => (c.by !== undefined && byRef.has(refKey(c)) ? [c.by] : [])),
      ]),
    ]),
  };
}

/**
 * The summary a record picked under `tag` is shown with, or none, which leaves the record out:
 *
 * - its summary is gone: the content was deleted since the index was built, or an update of it
 *   waits in the moderation queue, which erases the summary (see contentWriter);
 * - its summary doesn't carry `tag` any more: an update dropped the hashtag, or a moderator
 *   removed it.
 *
 * The index is as the compactor's last run left it, and a feed session reads the one its first page
 * did for as long as its cursor lasts. The summary is what the content is now, so this is what
 * keeps content out of a feed it has left before the index says so.
 */
function shown(bodies: FeedBodies, c: Candidate, tag: string): Summary | undefined {
  const s = bodies.summaries.get(refKey(c));
  return s?.tags.includes(tag) ? s : undefined;
}

/**
 * Streams the feed JSON: each hashtag's records, in plan order. A record with no summary to show
 * it with (see `shown`) is left out, and not counted. `tags` are the hashtags the plan was made
 * over, and `related` those of them the feed added to the ones it was asked for; undefined if it
 * wasn't asked to add any.
 *
 * `ads` gives the page's ads (src/monetization.ts), for the number of records the page shows: an
 * ad goes before a record of the page, which is only known here. Undefined where the server shows
 * no ads in feeds, and the response then has no `ads`.
 */
export function* renderFeed(
  plan: FeedPlan,
  tags: string[],
  bodies: FeedBodies,
  nextCursor: string | null,
  related?: string[],
  ads?: (count: number) => FeedAd[],
): Generator<Buffer> {
  const records = tags.map((tag, t) =>
    plan.picks[t]!.flatMap((c) => {
      const s = shown(bodies, c, tag);
      return s ? [JSON.stringify(toFeedRecord(s, c.likes, bodies.publishers.get(s.userId)!, c.moderated, c.repost ? { at: c.createdAt } : undefined))] : [];
    }),
  );
  const count = records.reduce((n, list) => n + list.length, 0);
  yield Buffer.from(
    `${JSON.stringify({
      window: { from: iso(plan.window.from), to: iso(plan.window.to) },
      count,
      truncated: plan.truncated,
      nextCursor,
      ...(related && { related }),
      ...(ads && { ads: ads(count) }),
    }).slice(0, -1)},"tags":{`,
  );

  let firstTag = true;
  for (let t = 0; t < tags.length; t++) {
    if (!records[t]!.length) continue;
    yield Buffer.from(`${firstTag ? '' : ','}${JSON.stringify(tags[t])}:[${records[t]!.join(',')}]`);
    firstTag = false;
  }
  yield Buffer.from('}}');
}

/**
 * The records of a following feed's picks, in order; one whose summary is gone is left out. A
 * repost's record says who reposted it: the followed user whose index it was read from.
 */
export function followingRecords(picks: FollowingPick[], bodies: FeedBodies): FeedRecord[] {
  return picks.flatMap((c) => {
    const s = bodies.summaries.get(refKey(c));
    if (!s) return [];
    return [
      toFeedRecord(
        s,
        c.likes,
        bodies.publishers.get(s.userId)!,
        undefined,
        c.repost ? { at: c.createdAt, by: c.by === undefined ? undefined : bodies.publishers.get(c.by) } : undefined,
      ),
    ];
  });
}
