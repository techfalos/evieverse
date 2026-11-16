import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CompactorLease, LeaseLostError, RunStoppedError } from '../src/compact/lease.js';
import { createDb, type Db } from '../src/db/index.js';
import { migrateToLatest } from '../src/db/migrator.js';

/** A lease's lifetime here, in milliseconds: it is renewed every third of that. */
const TTL = 300;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What keeps compactor runs apart (CompactorLease). What a run does with it is tested in feedindex.test.ts. */
describe('the compactor lease', () => {
  let db: Db;
  beforeEach(async () => {
    db = await createDb({ dialect: 'sqlite', url: ':memory:', poolSize: 1 });
    await migrateToLatest(db);
  });
  afterEach(() => db.destroy());

  const row = async () => {
    const { holder, expires_at: expiresAt } = await db.selectFrom('compactor_lease').select(['holder', 'expires_at']).executeTakeFirstOrThrow();
    return { holder, expiresAt: Number(expiresAt) };
  };

  it('is renewed for as long as it is held, whatever its run is doing, and no longer', async () => {
    const lease = new CompactorLease(db, TTL, Date.now);
    expect(await lease.acquire()).toBe(true);

    // A run that makes one long write asks nothing meanwhile: the lease outlasts its lifetime all the same.
    await wait(TTL * 2.5);
    const other = new CompactorLease(db, TTL, Date.now);
    expect(await other.acquire()).toBe(false);
    expect((await row()).expiresAt).toBeGreaterThan(Date.now());

    // Released, it is free, and is renewed no more.
    await lease.release();
    expect(await row()).toEqual({ holder: null, expiresAt: 0 });
    await wait(TTL);
    expect(await row()).toEqual({ holder: null, expiresAt: 0 });
    expect(await other.acquire()).toBe(true);
    await other.release();
  });

  it('is lost to a run whose renewal finds another holder, before the run asks', async () => {
    // A clock that stands still: asked now, the lease was renewed a moment ago, and `check` alone would look no further.
    const lease = new CompactorLease(db, TTL, () => 1_000_000);
    expect(await lease.acquire()).toBe(true);
    await lease.check();

    // Another run took the lease, as it can once this one let it expire.
    await db.updateTable('compactor_lease').set({ holder: 'another-run' }).execute();
    await wait(TTL);
    await expect(lease.check()).rejects.toBeInstanceOf(LeaseLostError);
    // It frees nothing that isn't its own.
    await lease.release();
    expect((await row()).holder).toBe('another-run');
  });

  it('refuses a run that was told to stop at its next check, as it does one that lost the lease', async () => {
    const lease = new CompactorLease(db, TTL, Date.now);
    expect(await lease.acquire()).toBe(true);
    await lease.check();

    lease.stop();
    const refused = await lease.check().catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(RunStoppedError);
    // Whatever passes on a lost lease passes this on.
    expect(refused).toBeInstanceOf(LeaseLostError);
    // The lease is still the run's, to free once nothing of it is under way.
    expect((await row()).holder).not.toBeNull();
    await lease.release();
    expect(await row()).toEqual({ holder: null, expiresAt: 0 });
  });
});
