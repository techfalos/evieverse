import type { Config } from './config.js';
import type { Db } from './db/index.js';

/** What the quarantine works with: the database, the settings (which name its store), and the clock. */
export interface QuarantineDeps {
  db: Db;
  config: Config;
  now?: () => number;
}


/**
 * What can be done with an item of the quarantine, each of which leaves a row of
 * `quarantine_access`: the server kept the file (stored), an admin read it (downloaded) or
 * recorded a report of it (reported), an admin deleted one that was never reported (dismissed),
 * or the compactor deleted it once its time after the report was over (expired).
 */
export type QuarantineAction = 'stored' | 'downloaded' | 'reported' | 'dismissed' | 'expired';

/** The admin who does something with an item, and where their request came from: what the quarantine's log keeps of them. */
export interface QuarantineActor {
  userId: string;
  ip: string;
  userAgent: string | null;
}
