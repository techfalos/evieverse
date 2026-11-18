import type { Mention } from '../mentions.types.js';
import type { Origin, Preview, Publisher } from '../storage/index.js';

/** A feed record, in exactly the shape the feed returns. */
export interface FeedRecord {
  contentId: string;
  publisher: Publisher;
  mimeType: string;
  aiGenerated: boolean;
  /** Whether the post takes comments, which are read at /content/:contentId/comments. */
  comments: boolean;
  preview: Preview;
  /**
   * The users the preview's text mentions, each with the name it has them by: what the text is
   * read with, to show each `@name` of theirs as a link to their profile (src/format.ts). Absent
   * where it mentions nobody.
   */
  mentions?: Mention[];
  tags: string[];
  likes: number;
  /**
   * Whether a moderator of the hashtag the record is listed under has approved it there. Only on
   * the records of a hashtag's feed: moderation is per hashtag.
   */
  moderated?: boolean;
  /** When the post was published, which for a reposted one is before it was placed here (see `repost`). */
  createdAt: string;
  updatedAt: string;
  /**
   * On a record a repost put where it was read: under a hashtag the repost gave the post, or in a
   * following feed, by someone the user follows. `at` is when, which is where the feed orders the
   * record, and `likes` are those since. `by` is who reposted it, in a following feed, where the
   * record is read from their own index; a hashtag's feed doesn't say.
   */
  repost?: { at: string; by?: Publisher };
  /**
   * On a repost of a post on another server: the original, which the record is a link to, and who
   * published it there. `publisher` is who reposted it here.
   */
  origin?: Origin;
}

/** The repost that put a record where it was read: when, and by whom if the index it was read from says. */
export interface RepostMark {
  at: number;
  by?: Publisher;
}

/** One post in a day index. */
export interface IndexEntry {
  contentId: string;
  /**
   * When the content was placed in this index, which is where feeds order it: its creation, or
   * for a repost's entry, the repost. UTC epoch ms; day indexes keep whole seconds.
   */
  createdAt: number;
  /** The content's likes; for a repost's entry, those since the repost. */
  likes: number;
  /** Declared by the publisher at /store. */
  aiGenerated: boolean;
  /**
   * A moderator of this hashtag approved the content under it. The compactor sets it, from
   * `tag_moderation`, when it builds a day index. Never set in a publisher's own index.
   */
  moderated: boolean;
  /**
   * A repost put the content here: under a hashtag it gave it, or in the reposter's own index.
   * The entry's time and likes are then the repost's (see above).
   */
  repost: boolean;
}

/**
 * The start of a tag's index, under `headKey(tag)`: the one key of it that is overwritten. Once a
 * run of the compactor has written the tag's new manifest and day indexes, it swaps the head to
 * name that manifest (`compactedAt` is when the run started), which is when the run's writes show.
 * Readers start from it.
 */
export interface Head {
  v: 5;
  /** The manifest readers should use; null until the tag's first compaction. */
  manifest: string | null;
  compactedAt: number;
}

/** One UTC day's index. */
export interface DayRef {
  /** UTC day number (ms / DAY). */
  day: number;
  gen: string;
  /** The most posts the index was trimmed to; when the day's quota shrinks with age, it's re-trimmed. */
  quota: number;
  count: number;
}

/**
 * The list of a tag's day indexes, under `manifestKey(tag, id)`, and never changed once written.
 * The compactor writes a new one in each run that changes the tag's day indexes (`createdAt` is
 * when that run started), and the tag's head names the one to read.
 */
export interface Manifest {
  v: 5;
  tag: string;
  id: string;
  createdAt: number;
  /** Newest day first. */
  days: DayRef[];
}
