import type { Candidate } from '../tagfeed/reader.types.js';
import type { FeedAlgorithm } from './plan.js';

/** What `planFeed` is asked for a page of a hashtag feed: GET /feed makes it from the request, its cursor and the feed settings. */
export interface PlanOptions {
  /** Defaults to popular. */
  algorithm?: FeedAlgorithm;
  /** The window: only records created in the `hours` up to the anchor are in the feed. */
  hours: number;
  /** End of the window (inclusive, UTC epoch ms); later pages of a cursor reuse the first page's anchor. */
  anchor: number;
  /** Most records in the page. */
  limit: number;
  /** Where earlier pages stopped in each requested tag's ordered list; none for a first page, or a tag they took nothing from. */
  after?: (Boundary | null)[];
  /** Fresh-content injection, which only the engaged algorithm has; omitted, or with `every: 0`, it has none either. */
  fresh?: FreshOptions;
  /** Only records created with AI (true) or without (false); omitted, both. */
  aiGenerated?: boolean;
  /** Only records a moderator of their hashtag approved (true), or those none has yet (false), which is the hashtag's moderation queue; omitted, both. */
  moderated?: boolean;
  /** What the engaged algorithm goes by; omitted, or with no content that matches, its tags take turns giving their most liked records, with fresh slots. No other algorithm reads it. */
  engaged?: EngagedOptions;
}

/**
 * How the engaged feed gives some of each tag's picks to the records that match what its reader
 * has liked and viewed (see `planFeed`). GET /feed makes it: `scores` from the engagement the
 * session began with (src/feed/engagement.ts), and `seed`, `after` and `led` from its cursor.
 */
export interface EngagedOptions {
  /** How much each piece of content matches, by content id: more is closer. Content that isn't there doesn't match. */
  scores: ReadonlyMap<string, number>;
  /** Per feed session (kept in the cursor): orders the records that match as much as each other. */
  seed: number;
  /** Where earlier pages stopped in each tag's list of matching records; none for a first page, or a tag they took none from. */
  after?: (EngagedBoundary | null)[];
  /** The content the session's first page led with, which no later page shows again. */
  led?: string[];
}

/**
 * Where a page stopped in a tag's list of matching records: the last one it took from it. The
 * list goes by `score`, most first, then by `key`, which is the record's place in the session's
 * own order (see freshKey), then by content id.
 */
export interface EngagedBoundary {
  score: number;
  key: number;
  contentId: string;
}

/**
 * How the engaged feed gives some of each tag's picks to new records with few likes (see
 * `planFeed`). No other feed has such picks. GET /feed makes it: `every`, `maxLikes` and `pool` are the server's settings, `seed`
 * and `after` the session's, which its cursor carries.
 */
export interface FreshOptions {
  /** One in every `every` picks per tag (the 2nd, then every `every`th after) comes from the fresh pool. */
  every: number;
  /** Records with at most this many likes are eligible. */
  maxLikes: number;
  /** Only the newest `pool` eligible records per tag are eligible; `seed` decides the order they're picked in. */
  pool: number;
  /** Per feed session (kept in the cursor), so different viewers see different fresh records. */
  seed: number;
  /** Where earlier pages stopped in each tag's fresh pool: the key (see freshKey) of the last record they took from it. */
  after?: (number | null)[];
}

/**
 * Where a page stopped in a tag's ordered list: the last record it took from it, or passed over as
 * already shown. The next page starts after it in the algorithm's order, whatever the list then
 * holds. A record's creation time never changes, and its likes mostly grow, so a record seldom
 * moves from ahead of a boundary to behind it: what was shown isn't shown again, but for a
 * record that lost likes since (DELETE /like) and is now behind where the session had got to in
 * a likes order, which the session comes to once more. One that moves ahead of the boundary
 * meanwhile (liked, or indexed late) is missed.
 */
export interface Boundary {
  likes: number;
  createdAt: number;
  contentId: string;
}

/**
 * A page of a hashtag feed as `planFeed` returns it: index entries, with no bodies. `renderFeed`
 * writes the response from it, as one list (`order`), `window` (UTC epoch ms) included, and `after`, `freshAfter`,
 * `engagedAfter` and `led` go in the next page's cursor.
 */
export interface FeedPlan {
  window: { from: number; to: number };
  /** Picked records per requested tag, each tag's in the order they were picked. */
  picks: Candidate[][];
  /** The tag each pick was made under, in the order the picks were made, which is the feed's order: what puts `picks` in one list (see `pageRecords`). */
  order: number[];
  /** Whether the window holds records no page has returned yet. */
  truncated: boolean;
  /** Where the feed has got to in each requested tag's ordered list; null for a tag nothing was taken from yet. */
  after: (Boundary | null)[];
  /** The same in each tag's fresh pool (empty where the feed has no fresh slots: one that isn't engaged, or with them turned off). */
  freshAfter: (number | null)[];
  /** The same in each tag's list of matching records (empty unless the feed is planned with engagement). */
  engagedAfter: (EngagedBoundary | null)[];
  /** The content the session has led with, this page's among it (empty unless the feed is planned with engagement). */
  led: string[];
}
