import type { TrustImage } from '../../../moderation/trust.types.js';
import type { Match } from './list.types.js';

/** An image that matched the list, and how: what `report` tells the admins of. */
export interface Found extends Match {
  image: TrustImage;
  /** The SHA-256 of the image as it was read: without its metadata. */
  sha256: string;
  /** The image's own PDQ hash, as it is written. */
  pdq: string;
  /** That hash's quality, from 0 to 100. */
  quality: number;
  /** Which frame of the image matched, from 0: always 0 for a still image. */
  frame: number;
}

/**
 * What an admin is told of a match, and what a report of it to the authorities is written from:
 * the body of the notice in their inbox, as JSON, and its `details` when the inbox is read. Each
 * is a text or a number, so that the notice's message can say it.
 *
 * `userId` and `listed` come first, in that order: a notice is told from another of the same
 * user and listed hash by how its body starts (see report).
 */
export interface MatchFacts {
  /** Who sent the image. */
  userId: string;
  /** The hash on the list that the image's is near. */
  listed: string;
  /** Their username when they sent it. */
  username: string;
  /** When, as an ISO 8601 time in UTC. */
  at: string;
  /** The address the request came from, as the server counts it; "unknown" where it has none. */
  ip: string;
  /** The request's User-Agent header, cut short; left out if it sent none. */
  userAgent?: string;
  /** What the image was sent as: a new post's, an update's of the post `contentId`, a comment's on the post `contentId`, or the avatar of the sender's profile. */
  sentAs: 'post' | 'update' | 'comment' | 'avatar';
  /** The post an update is of, or a comment is on. Left out for a new post, which never got an id, and for an avatar. */
  contentId?: string;
  /** The name the image was sent with, cut short; left out if it had none. */
  filename?: string;
  /** Which image its bytes are: image/jpeg and the like. */
  mimeType: string;
  /** The SHA-256 of the image without its metadata, which is how the server read it. The file as it was sent has another. */
  sha256: string;
  /** The image's own PDQ hash. */
  pdq: string;
  /** That hash's quality, from 0 to 100. */
  quality: number;
  /** How many of the 256 bits the image's hash and the listed one differ in. */
  distance: number;
  /** Which frame of the image matched, from 0. */
  frame: number;
  /**
   * What became of what was sent. refused: nothing of it was stored. held: it is stored, and waits
   * unpublished in the moderation queue, which is where a score of 0 goes on a server that deletes
   * nothing on arrival (TRUST_SCORE_DELETE_BELOW=0). An avatar is always refused.
   */
  outcome: 'refused' | 'held';
}
