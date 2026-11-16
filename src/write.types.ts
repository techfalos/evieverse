import type { Repost } from './reposts.js';
import type { ContentMeta, Publisher, StoredBytes, Summary } from './storage/index.js';

/**
 * One write of content, new or an update, as contentWriter's `write` takes it. The routes make it:
 * /store for a post, and /repost for the entry that stands for a post on another server.
 */
export interface ContentWrite {
  publisher: Publisher;
  /** The meta file an update writes over; absent for new content. */
  previous?: ContentMeta;
  /** Names the content id; `updatedAt` is when this write is made. */
  summary: Summary;
  meta: ContentMeta;
  /** Writes the content's bytes, and returns their size as stored, which is the one recorded in the meta file. */
  putBytes: () => Promise<StoredBytes>;
  /**
   * The write's trust score sent it to the moderation queue: the content is stored, but has no
   * summary and is in no feed index until an admin accepts it. Absent: it is published.
   */
  queued?: { trustScore: number };
  /**
   * An update of content that was reposted: the places reposts gave it (see `reposts`), as the
   * request read them. The hashtags among them are the content's like its publisher's own, and are
   * in `summary.tags` and `meta.tags` unless `droppedReposts` names them.
   */
  reposts?: Repost[];
  /**
   * The hashtags a repost gave the content that this update is refused: its publisher is muted on
   * them now, or what it now says has their blocked words. They aren't the publisher's to send
   * again, so the write's commit records each as removed from the content (`tag_moderation`, with
   * no moderator), which keeps it off the content for good, as a moderator's removal does.
   */
  droppedReposts?: string[];
  /** New content that is a repost of a post on another server: the hash of the original's address (see `content.origin_hash`). */
  originHash?: string;
}

/** A repost of content that is there (see contentWriter's repost). */
export interface RepostWrite {
  contentId: string;
  /** Who reposts it. */
  userId: string;
  /** The hashtags the repost gives the content. */
  tags: string[];
  /** The hashtags the content's meta file has. */
  carried: string[];
}
