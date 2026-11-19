import type { Config } from './config.js';
import type { Db } from './db/index.js';

/** What the quarantine works with: the database, the settings (which name its store), and the clock. */
export interface QuarantineDeps {
  db: Db;
  config: Config;
  now?: () => number;
}

/** The log of whatever deletes the files whose time is over (see expireQuarantine): the compactor's. */
export interface QuarantineLog {
  info(o: object, msg?: string): void;
  warn(o: object, msg?: string): void;
  error(o: object, msg?: string): void;
}

/** A file to keep in the quarantine, as whatever found the match gives it (see quarantineFile). */
export interface QuarantineFile {
  /** Who sent it. */
  userId: string;
  /** The path of a file on this machine that holds it: read, and neither changed nor kept. */
  path: string;
  /** The SHA-256 of that file, in hex. */
  sha256: string;
  /** What it was sent as. */
  mimeType: string;
  /** What the admins are told of the match (MatchFacts), which is kept with the file for as long as the file is. */
  facts: object;
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
