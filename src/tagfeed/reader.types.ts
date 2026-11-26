import type { DayRef } from './layout.types.js';

/** One post available to the feed: an entry of a day index. Never mutated once built. */
export interface Candidate {
  contentId: string;
  /** When the content was placed in the index: its creation, or the repost that put it there (see IndexEntry). */
  createdAt: number;
  /** For a repost's entry, the likes since the repost. */
  likes: number;
  /** How many times the content was viewed by a user account, as the compactor last wrote it; 0 in an index written before entries had it. */
  views: number;
  /** How many users dislike the content, likewise: what a feed shows where the server has dislikes on. */
  dislikes: number;
  aiGenerated: boolean;
  /** Approved by a moderator of the hashtag whose index this is: flagged in its day index. */
  moderated: boolean;
  /** A repost put the content in this index, at `createdAt`. */
  repost: boolean;
}

/** A tag's whole index, read: what `TagFeedReader.view` returns, and a hashtag feed plans its page over (`planFeed`). */
export interface TagView {
  tag: string;
  /** Every day index's entries in index order (newest day first). */
  candidates: Candidate[];
}

/** A tag's head and manifest, read; `TagFeedReader.loadDays` loads the day indexes it needs. */
export interface OpenTag {
  tag: string;
  /** The version of the layout the manifest's day indexes are of (`Manifest.v`), which is how their entries are read. */
  v: number;
  /** Every UTC day's index the manifest names, newest first. */
  days: DayRef[];
}
