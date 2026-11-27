import type { FeedAd } from '../monetization.types.js';
import type { CommentStore, Publisher, PublisherStore, Summary, SummaryStore } from '../storage/index.js';
import { countsOf, toFeedRecord } from '../tagfeed/layout.js';
import type { FeedRecord } from '../tagfeed/layout.types.js';
import type { Candidate } from '../tagfeed/reader.types.js';
import { iso } from '../time.js';
import type { FollowingPick } from './following.types.js';
import type { FeedPlan } from './plan.types.js';

/** What a picked record's summary is kept under in `FeedBodies`: its content id, so the entries of one piece of content share a summary. */
const refKey = (c: { contentId: string }) => c.contentId;

/**
 * What a page's picked records are shown with: their summaries, by content id, and the credits of
 * their publishers (and of those who reposted them, in a following feed), by user id, and how
 * many comments each has, by content id. `loadBodies` makes it, and `renderFeed` and
 * `followingRecords` read it. Content whose summary wasn't found isn't in `summaries`, nor in
 * `commentCounts`.
 */
interface FeedBodies {
  summaries: Map<string, Summary>;
  publishers: Map<string, Publisher>;
  commentCounts: Map<string, number>;
}

/** Every record a tag feed's plan picked. */
export const planned = (plan: FeedPlan) => plan.picks.flat();

/**
 * The summary of every picked record (one MGET for posts younger than the hot window, parallel
 * object-store reads for older ones), its publisher's credit (one more MGET) and how many
 * comments it has (another, made alongside: see `CommentStore.liveCounts`).
 */
export async function loadBodies(
  picked: (Candidate & { by?: string })[],
  summaries: SummaryStore,
  publishers: PublisherStore,
  comments: CommentStore,
): Promise<FeedBodies> {
  // Content picked twice (as its publisher's post and as a repost, say) has one summary, kept under the day of each entry.
  const refs = [...new Map(picked.map((c) => [refKey(c), c])).values()];
  const found = await summaries.getMany(refs);
  const byRef = new Map<string, Summary>();
  refs.forEach((c, i) => {
    if (found[i]) byRef.set(refKey(c), found[i]!);
  });
  const ids = [...byRef.keys()];
  const [credits, counts] = await Promise.all([
    publishers.getMany([
      ...new Set([
        ...[...byRef.values()].map((s) => s.userId),
        // And the credits of those who reposted them, where a following feed says who did.
        ...picked.flatMap((c) => (c.by !== undefined && byRef.has(refKey(c)) ? [c.by] : [])),
      ]),
    ]),
    comments.liveCounts(ids),
  ]);
  return { summaries: byRef, publishers: credits, commentCounts: new Map(ids.map((id, i) => [id, counts[i]!])) };
}

/**
 * The summary a record picked under `tag` is shown with, or none, which leaves the record out:
 *
 * - its summary is gone: the content was deleted since the index was built, or an update of it
 *   waits in the moderation queue, which erases the summary (see contentWriter);
 * - its summary doesn't carry `tag` any more: an update dropped the hashtag, or a moderator
 *   removed it.
 *
 * The index is as the compactor's last run left it, whichever page of a feed reads it (see
 * TagFeedReader). The summary is what the content is now, so this is what keeps content out of a
 * feed it has left before the index says so.
 */
function shown(bodies: FeedBodies, c: Candidate, tag: string): Summary | undefined {
  const s = bodies.summaries.get(refKey(c));
  return s?.tags.includes(tag) ? s : undefined;
}

/**
 * The record of a pick made under `tag`, shown with the summary `s`: its counts, its flag and its
 * repost are the index entry's, and it says which hashtag's index that was (`listedUnder`).
 * `dislikesOn` is whether the server has dislikes on, which is whether the record gives the
 * entry's count of them or null (see `countsOf`).
 */
const recordOf = (bodies: FeedBodies, c: Candidate, s: Summary, tag: string, dislikesOn: boolean): FeedRecord => ({
  ...toFeedRecord(
    s,
    countsOf(c, dislikesOn),
    bodies.commentCounts.get(refKey(c)) ?? 0,
    bodies.publishers.get(s.userId)!,
    c.moderated,
    c.repost ? { at: c.createdAt } : undefined,
  ),
  listedUnder: tag,
});

/**
 * A page's records as one list, in the order the plan picked them, which is the feed's order:
 * what a page is written from, as JSON (`renderFeed`) and as RSS (`renderRss`). A record with no
 * summary to show it with (see `shown`) is left out. `tags` are the hashtags the plan was made
 * over, and `dislikesOn` whether the server has dislikes on (see `recordOf`).
 */
export function pageRecords(plan: FeedPlan, tags: string[], bodies: FeedBodies, dislikesOn: boolean): FeedRecord[] {
  /** How many of each tag's picks are behind. */
  const at = tags.map(() => 0);
  return plan.order.flatMap((t) => {
    const c = plan.picks[t]![at[t]!++]!;
    const s = shown(bodies, c, tags[t]!);
    return s ? [recordOf(bodies, c, s, tags[t]!, dislikesOn)] : [];
  });
}

/**
 * Streams the feed JSON: the page's records as one list, in the feed's order (see `pageRecords`),
 * each naming the hashtag it is listed under. A record with no summary to show it with (see
 * `shown`) is left out, and not counted. `tags` are the hashtags the plan was made over, and
 * `related` those of them the feed added to the ones it was asked for; undefined if it wasn't
 * asked to add any. `dislikesOn` is whether the server has dislikes on: each record's `dislikes`
 * is then its count, and null otherwise (see `recordOf`).
 *
 * `ads` gives the page's ads (src/monetization.ts), for the number of records the page shows: an
 * ad goes before a record of the page, which is only known here. Undefined where the server shows
 * no ads in feeds, and the response then has no `ads`.
 */
export function* renderFeed(
  plan: FeedPlan,
  tags: string[],
  bodies: FeedBodies,
  dislikesOn: boolean,
  nextCursor: string | null,
  related?: string[],
  ads?: (count: number) => FeedAd[],
): Generator<Buffer> {
  const records = pageRecords(plan, tags, bodies, dislikesOn);
  yield Buffer.from(
    `${JSON.stringify({
      window: { from: iso(plan.window.from), to: iso(plan.window.to) },
      count: records.length,
      truncated: plan.truncated,
      nextCursor,
      ...(related && { related }),
      ...(ads && { ads: ads(records.length) }),
    }).slice(0, -1)},"records":[`,
  );
  for (const [i, record] of records.entries()) yield Buffer.from(`${i ? ',' : ''}${JSON.stringify(record)}`);
  yield Buffer.from(']}');
}

/**
 * The records of a following feed's picks, in order; one whose summary is gone is left out. A
 * repost's record says who reposted it: the followed user whose index it was read from.
 *
 * `blocked` are the users the feed's reader blocks, of those the page credits (src/blocks.ts):
 * a post one of them published is left out, as one whose summary is gone is, and so is a post
 * one of them reposted. The first is what a followed user reposted of theirs; the second is
 * there only until the reader's list of follows is written without them.
 *
 * `dislikesOn` is whether the server has dislikes on: each record's `dislikes` is then its
 * entry's count, and null otherwise (see `countsOf`).
 */
export function followingRecords(picks: FollowingPick[], bodies: FeedBodies, dislikesOn: boolean, blocked: ReadonlySet<string> = new Set()): FeedRecord[] {
  return picks.flatMap((c) => {
    const s = bodies.summaries.get(refKey(c));
    if (!s || blocked.has(s.userId) || (c.by !== undefined && blocked.has(c.by))) return [];
    return [
      toFeedRecord(
        s,
        countsOf(c, dislikesOn),
        bodies.commentCounts.get(refKey(c)) ?? 0,
        bodies.publishers.get(s.userId)!,
        undefined,
        c.repost ? { at: c.createdAt, by: c.by === undefined ? undefined : bodies.publishers.get(c.by) } : undefined,
      ),
    ];
  });
}
