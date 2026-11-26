import type { Mention } from '../mentions.types.js';
import type { Origin, Preview, Publisher } from '../storage/index.js';

/** A post's counts, as a response gives them (see `countsOf`). */
export interface Counts {
  /** How many users like the post. */
  likes: number;
  /** How many times the post was viewed by a user account (see `countView`). */
  views: number;
  /**
   * How many users dislike the post, from 0, on a server that has dislikes on; null on one that
   * has them off, where a client shows no dislikes at all.
   */
  dislikes: number | null;
}

/** A feed record, in exactly the shape the feed returns. */
export interface FeedRecord {
  contentId: string;
  publisher: Publisher;
  mimeType: string;
  aiGenerated: boolean;
  /** Whether the post takes comments, which are read at /content/:contentId/comments. */
  comments: boolean;
  /**
   * The post's title: one line of plain text. Absent on a post that has none, and on every post
   * of a server whose titles are off (`postTitles` of GET /rules).
   */
  title?: string;
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
   * How many times the post was viewed by a user account, as the index it was read from has it:
   * the compactor's last run. The post's whole count, on a repost's record too.
   */
  views: number;
  /**
   * How many users dislike the post, likewise, on a server that has dislikes on: 0 for a post
   * nobody dislikes. Null on a server that has them off, which is how a client knows not to show
   * dislikes at all.
   */
  dislikes: number | null;
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
   * record, and `likes` are those since (`views` and `dislikes` are the post's whole counts). `by`
   * is who reposted it, in a following feed, where the record is read from their own index; a
   * hashtag's feed doesn't say.
   */
  repost?: { at: string; by?: Publisher };
  /**
   * On a repost of a post on another server: the original, which the record is a link to, and who
   * published it there. `publisher` is who reposted it here.
   */
  origin?: Origin;
  /**
   * The hashtag the record is listed under, of those the feed reads: the one whose index it was
   * picked from, which is whose `moderated` it has. Only on the records of a hashtag's feed. A
   * post under several of the feed's hashtags is listed once, under one of them.
   */
  listedUnder?: string;
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
  /** How many times the content was viewed by a user account (`content.view_count`): all of them, on a repost's entry too. 0 in an index of version 5. */
  views: number;
  /** How many users dislike the content (`content.dislike_count`), whether the server shows dislikes or not: all of them, on a repost's entry too. 0 in an index of version 5. */
  dislikes: number;
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
  /** The version of the layout the compactor that wrote it writes (`LAYOUT_VERSION`). Readers go by the manifest's. */
  v: number;
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
  /**
   * The version of the layout every day index it names is of, which says how long their entries
   * are (`dayEntryBytes`): 6, or 5 for one written before entries had views and dislikes.
   */
  v: number;
  tag: string;
  id: string;
  createdAt: number;
  /** Newest day first. */
  days: DayRef[];
}
