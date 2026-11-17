import type { ContentMeta, Publisher, StagedBytes, Summary } from './storage/index.js';

/**
 * One write of content, new or an update, as contentWriter's `write` takes it. The routes make it:
 * /store for a post, /repost for the entry that stands for a post on another server, and
 * /repost/refresh for an update of such an entry, from a later attestation of the original.
 */
export interface ContentWrite {
  publisher: Publisher;
  /**
   * The meta file an update writes over, as the request read it (see requireMeta); absent for new
   * content. Its hashtags say which the update drops.
   */
  previous?: ContentMeta;
  /**
   * An update: the content's write number (`content.seq`) as the request read it, before it read
   * `previous`. If the write then takes another number than the one after it, something was
   * written in between, and the content's hashtags are read again as it commits.
   */
  seenSeq?: number;
  /**
   * An update that holds only for the content as the request read it: if something was written to
   * the content since then (see `seenSeq`), this is called as the write commits, with the meta
   * file as it is by then and the content's row locked, and throws to refuse the write.
   */
  recheck?: (current: ContentMeta) => void;
  /** Names the content id; `updatedAt` is when this write is made. What the request answers with: nothing of it is stored here. */
  summary: Summary;
  /** The meta file the write makes: the compactor writes it, with the size `stageBytes` returns in place of the one it has. */
  meta: ContentMeta;
  /**
   * Stages the file of an image, video or audio post for the write whose id it is given (see
   * PostBytes.stage), and returns where it waits and its size as stored, which is the one
   * recorded in the meta file. Absent for a text, a link and a repost of a post on another
   * server: their bytes are in `meta`, and the compactor writes them from it (see payloadBytes).
   */
  stageBytes?: (writeId: string) => Promise<StagedBytes>;
  /**
   * The write's trust score sent it to the moderation queue: the content is stored, but has no
   * summary and is in no feed index until an admin accepts it. Absent: it is published.
   */
  queued?: { trustScore: number };
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

/**
 * The word of another server that it publishes no post at the address of an original this server
 * has an entry for, as contentWriter's `withhold` takes it: what hides the entry.
 */
export interface OriginGone {
  /** The entry. */
  contentId: string;
  /** When the original's server signed that the post is gone, which the entry is then as of (see ContentMeta.originAttestedAt). */
  issuedAt: number;
  /**
   * Called as the write commits, with the entry's meta file as it is by then and its row locked:
   * it throws to refuse word that is no newer than what the entry holds.
   */
  recheck: (current: ContentMeta) => void;
}

/** A repost of content that is there (see contentWriter's repost). */
export interface RepostWrite {
  contentId: string;
  /** Who reposts it. */
  userId: string;
  /** The hashtags the repost gives the content. */
  tags: string[];
  /** The hashtags the content's meta file has, as its newest write made it. */
  carried: string[];
}
