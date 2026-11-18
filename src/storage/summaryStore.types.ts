import type { Mention } from '../mentions.types.js';
import type { Origin, Preview, StoredVideo } from './contentStore.types.js';

/** Everything a feed record holds except its likes and the publisher's name. */
export interface Summary {
  contentId: string;
  createdAt: number;
  /** When the content was last written. */
  updatedAt: number;
  userId: string;
  mimeType: string;
  /** Declared by the publisher at /store. */
  aiGenerated: boolean;
  /** Whether the post takes comments, which its publisher says at /store. */
  comments: boolean;
  tags: string[];
  preview: Preview;
  /** On a repost of a post on another server: the original, which the preview is of. */
  origin?: Origin;
  /**
   * The users the preview's text mentions: those of the post's mentions (see ContentMeta.mentions)
   * that its preview has, which is what the preview is read with. Absent where it mentions nobody.
   */
  mentions?: Mention[];
  /**
   * When the content was reposted, once for each repost of it. It isn't part of what a summary
   * says, and a summary that is read has none: it says where one that is written is kept (see
   * SummaryRef).
   */
  repostedAt?: number[];
}

/**
 * What a summary keeps of its preview beside the text, where its post has any of it (see
 * encodeSummary): written as JSON on a header line of its own.
 */
export interface SummaryExtras {
  /** An image post's alternative texts, one for each image in their order (see Preview.alt). */
  alt?: string[];
  /** What a processed video is (see Preview.video). */
  video?: StoredVideo;
  /** The users the preview's text mentions (see Summary.mentions). */
  mentions?: Mention[];
}

/**
 * What locates a summary. A feed finds one by its index entry, which holds the content's id and a
 * time: the content's creation, or, where a repost placed the content in the index, the repost's.
 * That time's UTC day picks the object-store prefix, and its age the tier.
 *
 * So a summary is kept under the day the content was created and under each day it was reposted
 * (`repostedAt`), the same bytes under each. To read one, `createdAt` is the entry's time, whichever
 * it is. To write or erase one, `createdAt` is the content's and `repostedAt` its reposts', which
 * covers every copy.
 */
export interface SummaryRef {
  contentId: string;
  createdAt: number;
  repostedAt?: number[];
}

/**
 * How a SummaryStore keeps and reads summaries. createStores makes it from the configuration
 * (`feed.summary*` and `publicBaseUrl`, which is what the URL of an image's, video's or audio's
 * bytes begins with in a summary that is read), and the store reads it.
 */
export interface SummaryStoreOptions {
  /** Posts younger than this are kept in Redis too. */
  hotDays: number;
  /** Brotli quality, 0-11. */
  quality: number;
  /** Compressed summaries from the object store kept in this process... */
  cacheSize: number;
  /** ...for this long: how long a node may go on showing a post as it was before an update. */
  cacheSeconds: number;
  publicBaseUrl: string;
}
