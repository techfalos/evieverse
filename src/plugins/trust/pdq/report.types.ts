import type { TrustImage } from '../../../moderation/trust.types.js';
import type { Match } from './list.types.js';

/** An image that matched the list, or a video of which a picture did, and how: what `report` tells the admins of. */
export interface Found extends Match {
  /**
   * The file that matched: an image as the plugin read it, or for a video, the file as it was
   * sent (see checkVideo), which is described as an image is: what it was sent as, the name it
   * came with, where it is on this machine, and its SHA-256.
   */
  image: TrustImage;
  /** The SHA-256 of the file as it was read: an image's without its metadata, a video's as it was sent. */
  sha256: string;
  /** The PDQ hash of the picture that matched, as it is written. */
  pdq: string;
  /** That hash's quality, from 0 to 100. */
  quality: number;
  /** Which frame matched, from 0: always 0 for a still image, and for a video, which of the pictures that were checked. */
  frame: number;
  /** For a video, which is checked after its request was answered: where in it the picture is, in seconds, and when it was sent. */
  video?: { seconds: number; sentAt: number };
}

/** What was sent with the file that matched, as far as `report` tells of it: a post, an update, a comment or a profile, and whose. */
export interface Sent {
  /** Who sent it. */
  userId: string;
  /** The content an update writes over. */
  contentId?: string;
  /** For a comment: the post it is on. */
  commentOn?: string;
  /** True for an avatar. */
  profile?: true;
  /**
   * For a new post whose file was found to match only once the post had an id, which is a
   * video's: that post, which is deleted for it. A new post whose image matches never gets one.
   */
  created?: string;
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
  /** The post an update is of, or a comment is on, or the new post a video came with, which is deleted. Left out for a new post with an image, which never got an id, and for an avatar. */
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
   * nothing on arrival (TRUST_SCORE_DELETE_BELOW=0). An avatar is always refused, and so is a video.
   */
  outcome: 'refused' | 'held';
  /** `video` where it was a video that matched, by one of its pictures; left out for an image. */
  media?: 'video';
  /** For a video: where in it the picture that matched is, in seconds from its start. */
  seconds?: number;
  /** The item of the quarantine the file is kept as (src/quarantine.ts); left out on a server that has none, and where the file couldn't be kept. */
  quarantineId?: string;
}
