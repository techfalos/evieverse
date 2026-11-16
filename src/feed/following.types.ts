import type { Candidate } from '../tagfeed/reader.types.js';

/** What `planFollowing` is asked for a page of a following feed: GET /feed/following makes it from the request, its cursor and the lookback setting. */
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

/** A record of a following feed: an entry of a followed user's own index. */
export interface FollowingPick extends Candidate {
  /** For a repost's entry: who reposted the content, which is whose index it was read from. */
  by?: string;
}

/**
 * A page of a following feed as `planFollowing` returns it: index entries, with no bodies. The
 * route loads their summaries and renders them (`followingRecords`), and makes the next page's
 * cursor from the last pick.
 */
export interface FollowingPlan {
  /** Newest first. */
  picks: FollowingPick[];
  /** More records come after the last pick. */
  truncated: boolean;
}
