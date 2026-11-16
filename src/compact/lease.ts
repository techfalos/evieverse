import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';

/** The id of the one row of `compactor_lease`, which the first migration inserts: every compactor run takes, renews and frees the lease on it. */
const LEASE_ID = 'compactor';

export class LeaseLostError extends Error {
  constructor() {
    super('another compactor run took over the lease; this run stopped before writing anything more');
    this.name = 'LeaseLostError';
  }
}

/**
 * Keeps compactor runs from overlapping, across processes and machines. A run takes the lease row in
 * the database, or skips if a live run holds it, and calls `check()` before every write that publishes
 * a head or deletes something. `check()` renews the lease once a third of its lifetime has passed and
 * throws if another run has taken it, so every such write starts with at least two thirds of the
 * lifetime (less clock skew between nodes) left before another run could take over.
 */
export class CompactorLease {
  private readonly holder = randomUUID();
  private renewedAt = -Infinity;
  private lost = false;
  private renewing: Promise<void> | null = null;

  constructor(
    private readonly db: Db,
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  /** Takes the lease if it is free or has expired; false if a live run holds it. */
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
    return true;
  }

  /** Throws LeaseLostError unless this run still holds the lease. */
  async check(): Promise<void> {
    if (this.lost) throw new LeaseLostError();
    if (this.now() - this.renewedAt < this.ttlMs / 3) return;
    this.renewing ??= this.renew().finally(() => (this.renewing = null));
    await this.renewing;
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

  /** Frees the lease for the next run, if this run still holds it. */
  async release(): Promise<void> {
    await this.db
      .updateTable('compactor_lease')
      .set({ holder: null, expires_at: 0 })
      .where('id', '=', LEASE_ID)
      .where('holder', '=', this.holder)
      .execute();
  }
}
