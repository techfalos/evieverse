import { setTimeout as sleep } from 'node:timers/promises';
import { CompactorLease } from '../compact/lease.js';
import type { AppDeps } from '../deps.types.js';
import { mapLimit } from '../util.js';
import type { ReindexResult } from './backfill.types.js';
import { indexContent } from './index.js';
import { foldUsername } from './keywords.js';

/** The posts, or the users, one step of a reindex reads and brings up to date. */
const BATCH = 500;

/** How long until the lease is asked for again when a compactor run holds it. */
const LEASE_RETRY_MS = 1000;

/**
 * Brings what search reads up to what the server holds: the terms of every post (`search_terms`),
 * from its meta file, and the folded name of every user (`users.username_folded`), from their
 * username. It is what `npm run reindex` runs (src/search/reindex.ts), once after the upgrade
 * that brought search: the posts that were there before have no terms until then, and are found
 * by none, and the names the migration could only put in lower case are folded as a search
 * folds what it is asked for. It can be run again, at any time, and beside a server and a
 * compactor that are up: what is already right is read and left.
 *
 * The posts are gone through by id, `BATCH` at a time, and the terms of each are made by what
 * the compactor makes them with (see indexContent). Each batch is read and written under the
 * compactor's lease (see CompactorLease), which is waited for while a run holds it and given
 * back after the batch: so no run writes a meta file while its post's terms are made from the
 * one before, and a post isn't deleted under the rows written for it. Between two batches the
 * lease is left free for as long as the batch held it, so that the compactor's runs, which are
 * skipped while it is held, get their turn about half the times they ask, and posts go on being
 * published meanwhile, a little later than they are otherwise.
 *
 * A post that has no meta file is one the compactor hasn't applied yet, which gets its terms
 * when it does. `progress` is told where the work is after each batch.
 */
export async function reindex(
  { db, config, content, now = Date.now }: Pick<AppDeps, 'db' | 'config' | 'content' | 'now'>,
  progress: (soFar: ReindexResult) => void = () => {},
): Promise<ReindexResult> {
  const result: ReindexResult = { posts: 0, pending: 0, usernames: 0 };

  for (let after = '', more = true; more; ) {
    const lease = new CompactorLease(db, config.compact.leaseSeconds * 1000, now);
    while (!(await lease.acquire())) await sleep(LEASE_RETRY_MS);
    const heldSince = Date.now();
    try {
      // Read under the lease: none of these is deleted, nor its meta file written, until it is given back.
      const rows = await db.selectFrom('content').select(['id', 'created_at']).where('id', '>', after).orderBy('id').limit(BATCH).execute();
      await mapLimit(rows, config.compact.concurrency, async (row) => {
        const meta = await content.getMeta(row.id);
        if (!meta) {
          result.pending++;
          return;
        }
        await lease.check();
        await indexContent(db, config.db.dialect, row, meta, config.search.maxKeywords);
        result.posts++;
      });
      more = rows.length === BATCH;
      after = rows.at(-1)?.id ?? after;
    } finally {
      await lease.release();
    }
    progress({ ...result });
    if (more) await sleep(Date.now() - heldSince);
  }

  for (let after = '', more = true; more; ) {
    const rows = await db.selectFrom('users').select(['id', 'username', 'username_folded']).where('id', '>', after).orderBy('id').limit(BATCH).execute();
    for (const row of rows) {
      const folded = foldUsername(row.username);
      if (row.username_folded === folded) continue;
      // Only while the name is the one that was folded: a user who was renamed since has the new name's.
      const { numUpdatedRows } = await db.updateTable('users').set({ username_folded: folded }).where('id', '=', row.id).where('username', '=', row.username).executeTakeFirst();
      result.usernames += Number(numUpdatedRows);
    }
    more = rows.length === BATCH;
    after = rows.at(-1)?.id ?? after;
    progress({ ...result });
  }
  return result;
}
