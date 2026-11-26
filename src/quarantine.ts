import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { Operator } from 'opendal';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import type { QuarantineAction, QuarantineActor, QuarantineDeps } from './quarantine.types.js';
import { createOperator, streamObject } from './storage/opendal.js';

/**
 * The quarantine: where the server keeps the files that matched the pdq trust plugin's list of
 * hashes of known child sexual abuse material (compactor/crates/trust/src/plugins/pdq), on a server whose
 * operator turned it on (QUARANTINE_SCHEME). Without it a file that matched is refused and
 * nothing of it is kept, which leaves the operator nothing to send with a report of it, and
 * nothing to keep once the report is made. In the United States a provider that reports to the
 * CyberTipline has to keep what it reported for a year, securely, and may keep it longer
 * (18 U.S.C. 2258A(h)); the law elsewhere asks for other things. What this gives an operator is
 * the means to do what theirs asks:
 *
 * - **A store of its own** (`quarantine.scheme`, `quarantine.options`): any OpenDAL scheme, and
 *   never the content store, the summaries' or the audit log's (the configuration refuses those).
 *   Nothing else is written there, and nothing is served from it: no link to a file of it is
 *   ever signed. How the store itself is locked down (who may reach the bucket, its encryption,
 *   its own access log) is the deployment's to do.
 * - **Only an admin reads a file,** through the API (routes/quarantine.ts), which streams it
 *   from here.
 * - **Every access is recorded** (`quarantine_access`): that the file was kept, each time an
 *   admin read it, the report an admin recorded, and its deletion. The row is written before
 *   the thing is done, and stays when the item is gone.
 * - **A file is deleted `quarantine.retentionDays` after its report,** by the compactor, once a
 *   day (compactor/crates/core/src/quarantine.rs). One that no admin has recorded a report of is not deleted by the
 *   server: an admin dismisses it, if it is not what the list took it for.
 *
 * A file is kept as the server read it: an image without its metadata, which the server strips
 * before any plugin sees it, and a video as it was sent. The same file sent again by the same
 * user is kept once, and counted.
 *
 * The server reports nothing to anyone itself, and sends no file anywhere.
 */

/** The quarantine's store of each configuration that was asked for: an operator is made once. Null where the configuration names none. */
const stores = new WeakMap<Config, Operator | null>();

/** The object a quarantined file is, by its item's id. */
const fileKey = (id: string) => `files/${id}`;

/** The quarantine's store, or null on a server that has none. */
function storeOf(config: Config): Operator | null {
  let op = stores.get(config);
  if (op === undefined) {
    const { scheme, options } = config.quarantine;
    op = scheme ? createOperator(scheme, options ?? {}) : null;
    stores.set(config, op);
  }
  return op;
}

/** Whether the server keeps the files that match: whether its configuration names a store for them. */
export const quarantines = (config: Config): boolean => config.quarantine.scheme !== undefined;

/** Writes a row of the quarantine's log: what was done with an item, when, and by whom (nobody, where the server did it itself). */
export async function recordAccess(db: Pick<Db, 'insertInto'>, quarantineId: string, action: QuarantineAction, at: number, actor?: QuarantineActor): Promise<void> {
  await db
    .insertInto('quarantine_access')
    .values({
      id: randomUUID(),
      quarantine_id: quarantineId,
      action,
      user_id: actor?.userId ?? null,
      ip: actor?.ip.slice(0, 64) ?? null,
      user_agent: actor?.userAgent?.slice(0, 255) ?? null,
      created_at: at,
    })
    .execute();
}

/**
 * The bytes of an item's file, as a stream, for the admin `actor`. That they read it is
 * recorded first: if it can't be, nothing is read. Throws an error `isNotFound` knows for a
 * file that isn't in the store.
 */
export async function readQuarantined({ db, config, now = Date.now }: QuarantineDeps, id: string, actor: QuarantineActor): Promise<Readable> {
  const op = storeOf(config);
  if (!op) throw new Error('this server has no quarantine (QUARANTINE_SCHEME)');
  await recordAccess(db, id, 'downloaded', now(), actor);
  return streamObject(op, fileKey(id));
}

/**
 * Deletes an item: its file, and then its row. Recorded first, as `action` (an admin's
 * dismissal, or the end of its time), so the log says it of a deletion that stopped halfway
 * too, which is then made again. A file that is already gone is no error.
 */
export async function removeQuarantined({ db, config, now = Date.now }: QuarantineDeps, id: string, action: Extract<QuarantineAction, 'dismissed' | 'expired'>, actor?: QuarantineActor): Promise<void> {
  const op = storeOf(config);
  if (!op) throw new Error('this server has no quarantine (QUARANTINE_SCHEME)');
  await recordAccess(db, id, action, now(), actor);
  await op.delete(fileKey(id));
  await db.deleteFrom('quarantine').where('id', '=', id).execute();
}
