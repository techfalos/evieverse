/** The video worker of a process (see createVideoWorker). */
export interface VideoWorker {
  /** Throws, with what is missing and what to do about it, in a process that lacks the ffmpeg videos are processed with. */
  check(): Promise<void>;
  /**
   * Takes the oldest video that waits and processes it. Returns whether there was one to take:
   * false when nothing waits, or what waits is another worker's for now.
   */
  runOnce(): Promise<boolean>;
  /**
   * Starts taking the videos that wait, one after another, for as long as the process runs, and
   * returns what stops it: called as the process shuts down, it stops the video being processed,
   * which the next worker takes up from its start, and resolves once that is done.
   */
  start(): () => Promise<void>;
}

/** What became of a job a worker took (see createVideoWorker). */
export type VideoOutcome =
  /** The video is processed, and its write is the compactor's to apply. */
  | 'processed'
  /** The video is the one the post already has, sent again: the write keeps that, and nothing was made (see the worker's `keepVideo`). */
  | 'kept'
  /** The video couldn't be processed, and its write was made without it, or taken back (see the worker's `failed`). */
  | 'failed'
  /** The write was no longer there to process a video for: superseded by a newer one, removed, or its post deleted. */
  | 'dropped';
