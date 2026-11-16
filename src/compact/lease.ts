import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';

/** The id of the one row of `compactor_lease`, which the first migration inserts: every compactor run takes, renews and frees the lease on it. */
const LEASE_ID = 'compactor';

export class LeaseLostError extends Error {
  constructor(message = 'another compactor run took over the lease; this run stopped before writing anything more') {
    super(message);
    this.name = 'LeaseLostError';
  }
}

/**
 * What `check()` throws to a run that was told to stop (see CompactorLease.stop). To the run it
 * is a lease that is lost: it writes nothing more, and whatever passes a LeaseLostError on passes
 * this on.
 */
export class RunStoppedError extends LeaseLostError {
  constructor() {
    super('the compactor was told to stop; this run stopped before writing anything more');
    this.name = 'RunStoppedError';
  }
}

/**
 * Keeps compactor runs from overlapping, across processes and machines. A run takes the lease row in
 * the database, or skips if a live run holds it, and calls `check()` before every write to the
 * stores, and before every write that publishes a head or deletes something.
 *
 * The lease is renewed in two ways. For as long as it is held, a timer renews it every third of
 * its lifetime, whatever the run is doing: a write that takes longer than the lifetime doesn't let
 * the lease lapse under it, as long as the process is alive and reaches the database. And
 * `check()` renews it once a third of its lifetime has passed with no renewal, and throws if it
 * can't, or if another run has taken the lease. So every write starts with at least two thirds
 * of the lifetime (less clock skew between nodes) left before another run could take over, and
 * goes on being covered while it lasts.
 *
 * A run that is told to stop (`stop`) is refused its next `check()`, as one that lost the lease
 * is: it finishes the write it is making and makes no other.
 */
export class CompactorLease {
  private readonly holder = randomUUID();
  private renewedAt = -Infinity;
  private lost = false;
  private stopped = false;
  private renewing: Promise<void> | null = null;
  private beat: NodeJS.Timeout | undefined;

  constructor(
    private readonly db: Db,
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  /** Takes the lease if it is free or has expired, and keeps it renewed until it is released; false if a live run holds it. */
  async acquire(): Promise<boolean> {
    const at = this.now();
    if (
      Number(
        (
          await this.db
            .updateTable('compactor_lease')
            .set({ holder: this.holder, expires_at: at + this.ttlMs })
            .where('id', '=', LEASE_ID)
            .where('expires_at', '<=', at)
            .executeTakeFirst()
        ).numUpdatedRows,
      ) !== 1
    )
      return false;
    this.renewedAt = at;
    // A renewal that fails here is `check()`'s to find: it renews again itself, and throws what it gets.
    this.beat = setInterval(() => void this.renewed().catch(() => {}), this.ttlMs / 3);
    // The lease is no reason for the process to stay up.
    this.beat.unref();
    return true;
  }

  /** Throws unless this run still holds the lease and may go on: LeaseLostError if another took it, RunStoppedError if it was told to stop. */
  async check(): Promise<void> {
    if (this.stopped) throw new RunStoppedError();
    if (this.lost) throw new LeaseLostError();
    if (this.now() - this.renewedAt < this.ttlMs / 3) return;
    await this.renewed();
  }

  /** Has the run stop at its next `check()`: the write it is making is its last. */
  stop(): void {
    this.stopped = true;
  }

  /** One renewal at a time: whoever asks while one is under way waits for that one. */
  private renewed(): Promise<void> {
    return (this.renewing ??= this.renew().finally(() => (this.renewing = null)));
  }

  /** Extends the lease, provided no other run has taken it since this one did (even after it expired). */
  private async renew(): Promise<void> {
    const at = this.now();
    if (
      Number(
        (
          await this.db
            .updateTable('compactor_lease')
            .set({ expires_at: at + this.ttlMs })
            .where('id', '=', LEASE_ID)
            .where('holder', '=', this.holder)
            .executeTakeFirst()
        ).numUpdatedRows,
      ) !== 1
    ) {
      this.lost = true;
      throw new LeaseLostError();
    }
    this.renewedAt = at;
  }

  /** Stops renewing the lease and frees it for the next run, if this run still holds it. */
  async release(): Promise<void> {
    clearInterval(this.beat);
    // A renewal under way ends first, so that it finds the lease still this run's.
    await this.renewing?.catch(() => {});
    await this.db
      .updateTable('compactor_lease')
      .set({ holder: null, expires_at: 0 })
      .where('id', '=', LEASE_ID)
      .where('holder', '=', this.holder)
      .execute();
  }
}
