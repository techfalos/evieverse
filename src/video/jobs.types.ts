import type { TrustClient } from '../moderation/trust.types.js';

/** A video to process, as the write that staged it names it to addVideoJob. */
export interface VideoJobWrite {
  /** The post the video is of, or the post the comment it came with is on. */
  contentId: string;
  /** The number of the write whose row of `pending_writes` names the staged file: a post's own, or UNNUMBERED for a new comment's. */
  seq: number;
  /** The key of that row, for a write that took no number (see UnnumberedWrite.key): a new comment's id. */
  key?: string;
  /** The comment the video came with; none for a post's. */
  commentId?: string;
  /** When the write was made: jobs are taken oldest first. */
  at: number;
  /** Who sent the write's request, on a server that checks videos against a list (see jobClient); none on any other. */
  client?: TrustClient;
}

/** A job a worker has taken (see claimVideoJob): a row of `media_jobs`, its until the lease it took runs out. */
export interface VideoJob {
  /** The job's id; for a post's video, also the id of the version of the video it makes (see StoredVideo.id). */
  id: string;
  contentId: string;
  seq: number;
  /** The key of the write's row: empty for a post's own write. */
  key: string;
  /** The comment the video came with; null for a post's. */
  commentId: string | null;
  /** How many times the job has been taken, this time included. */
  attempts: number;
  /** When the job's write was made, which is when its video was sent. */
  createdAt: number;
  /** Who sent the video, where the job's write kept it (see jobClient); null where it didn't. */
  client: TrustClient | null;
}
