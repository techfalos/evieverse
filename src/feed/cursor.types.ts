import type { EngagementWeights } from './engagement.types.js';
import type { FeedAlgorithm } from './plan.js';
import type { Boundary, EngagedBoundary } from './plan.types.js';

/**
 * A hashtag feed's cursor says where the feed has got to, not what it read: the last record taken
 * from each tag's list, and in an engaged feed from its fresh pool. The next page is planned over the index as it is
 * by then and carries on after those, so the cursor pins nothing. It lasts until a server whose
 * cursors are of a newer version reads it, which refuses it as expired (410, see decodeCursor).
 */
export interface CursorState {
  /** The instant the first page was computed for, which ends the window; later pages reuse it so the window stays the same. */
  anchor: number;
  hours: number;
  tags: string[];
  /**
   * The related hashtags the first page added to `tags` (addRelated), which every page reads after
   * them: what has been counted since could name others, and `after` is in the order of these.
   * Undefined when the feed didn't ask for them.
   */
  related?: string[];
  /** `after` is a place in the algorithm's order, so later pages must use the same algorithm. */
  algorithm: FeedAlgorithm;
  /** The feed's filter on content created with AI, which later pages must keep; undefined when it has none. */
  aiGenerated?: boolean;
  /** The same for the filter on moderated records. */
  moderated?: boolean;
  /** Per tag, the last record the feed took from its ordered list or passed over; null when it took none. */
  after: (Boundary | null)[];
  /**
   * The session's own: it orders an engaged feed's fresh pools and its matching records, and any
   * feed's ads (see orderAds). Fixed for the session, so each page carries on in the order of the last.
   */
  seed: number;
  /** Per tag, the key of the last record the feed took from its fresh pool; null when it took none. Empty in a feed with no fresh slots. */
  freshAfter: (number | null)[];
  /**
   * What an engaged feed goes by: the engagement its first page was given, as the weights made of
   * it. Later pages read it here, and nothing the request then sends, so the session's matching
   * records keep their order. Undefined when the feed isn't engaged, or was given no engagement.
   */
  engaged?: EngagedCursor;
}

/** What the cursor of a feed that goes by an engagement carries for it. */
export interface EngagedCursor {
  weights: EngagementWeights;
  /** Per tag, the last record the feed took from its list of matching records; null when it took none. */
  after: (EngagedBoundary | null)[];
  /** The content the first page led with, which isn't at the start of any list the cursor names a place in. */
  led: string[];
}

/**
 * A following feed's cursor is the last record of the page: the next page starts after it in
 * compareRecent order, whatever has changed since, so it never expires.
 */
export interface FollowingCursor {
  createdAt: number;
  contentId: string;
}
