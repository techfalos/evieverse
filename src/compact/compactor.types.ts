/**
 * What a compactor run is asked to rebuild beside what changed since the last one (see
 * `Compactor.runOnce`). compact/main.ts sets them from `--all` and `--rebuild`; a server that
 * compacts in its own process, with no Redis, asks for `rebuild` as it starts.
 */
export interface RunOptions {
  all?: boolean;
  rebuild?: boolean;
}

/** What a compactor run did: `Compactor.runOnce` returns it, with whether the run was skipped, and compact/main.ts logs its counts. */
export interface RunResult {
  /** Hashtags (and publishers' own indexes) compacted. */
  tags: string[];
  /** Content deleted for good. */
  deleted: string[];
}
