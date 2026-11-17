import type { RemovedTag } from './moderation/policy.types.js';
import type { Origin, Preview } from './storage/index.js';

/** What the server keeps of a post on another server, from its attestation (see originEntries' summarised). */
export interface OriginSummary {
  /** Its content type: a text's and a link's are their own, and an image, video or audio says its own. */
  mimeType: string;
  /** Where it is, and who published it there. */
  origin: Origin;
  /** Its preview, cut to the length of this server's. */
  preview: Preview;
  /** What there is of it to read, as moderation reads a post: the preview's text or link, the original's address and its publisher's name. */
  texts: (string | undefined)[];
}

/** An entry that a later attestation of its original left as it was: it said what the entry says. */
export interface RefreshedNone {
  change: 'none';
  contentId: string;
  /** Whether the entry waits in the moderation queue. */
  queued: boolean;
}

/** An entry that is hidden: the original's server says it publishes no post at the address. */
export interface RefreshedGone {
  change: 'gone';
  contentId: string;
  /** When the entry was hidden, which is what its deletion is counted from: before this, if it was hidden already. */
  goneAt: number;
  /** Whether the entry was hidden already, so that this only confirmed it. */
  already: boolean;
}

/** An entry that was written over with what its original is now, and is back in feeds if it was hidden. */
export interface RefreshedUpdated {
  change: 'updated';
  contentId: string;
  /** Whether what it now says sent it to the moderation queue. */
  queued: boolean;
  /** The hashtags it has now, and the ones what it now says lost it. */
  tags: string[];
  removedTags: RemovedTag[];
  preview: Preview;
  aiGenerated: boolean;
  origin: Origin;
}
