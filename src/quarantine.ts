import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Operator } from 'opendal';
import type { Config } from './config.js';
import { isUniqueViolation, type Db } from './db/index.js';
import type { QuarantineAction, QuarantineActor, QuarantineDeps, QuarantineFile, QuarantineLog } from './quarantine.types.js';
import { createOperator, streamObject } from './storage/opendal.js';
import { DAY } from './time.js';

/**
 * The quarantine: where the server keeps the files that matched the pdq trust plugin's list of
 * hashes of known child sexual abuse material (src/plugins/trust/pdq), on a server whose
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
 *   day (expireQuarantine). One that no admin has recorded a report of is not deleted by the
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
 * Keeps a file that matched, and returns the id of its item; null on a server that has no
 * quarantine. The file is written first, under an id nothing names yet, and then its row: a
 * file whose row couldn't be written is deleted again. A file the same user sent before is
 * the item it already is, which counts one more match.
 *
 * It throws if the file can't be kept. Whoever calls it is refusing the file whatever becomes
 * of this, and says so in the log (see the pdq plugin's `report`).
 */
export async function quarantineFile({ db, config, now = Date.now }: QuarantineDeps, { userId, path, sha256, mimeType, facts }: QuarantineFile): Promise<string | null> {
  const op = storeOf(config);
  if (!op) return null;
  const at = now();
  /** The item the file already is, counted once more; null if it is none yet. */
  const again = async (): Promise<string | null> => {
    const kept = await db.selectFrom('quarantine').select('id').where('user_id', '=', userId).where('sha256', '=', sha256).executeTakeFirst();
    if (!kept) return null;
    await db.updateTable('quarantine').set((eb) => ({ matches: eb('matches', '+', 1), last_matched_at: at })).where('id', '=', kept.id).execute();
    return kept.id;
  };
  const kept = await again();
  if (kept !== null) return kept;

  const id = randomUUID();
  const { size } = await stat(path);
  // As bytes, whatever it was sent as: nothing that reads the store is to show it.
  await pipeline(createReadStream(path), (await op.writer(fileKey(id), { contentType: 'application/octet-stream' })).createWriteStream());
  try {
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('quarantine')
        .values({ id, user_id: userId, sha256, mime_type: mimeType.slice(0, 255), size, facts: JSON.stringify(facts), created_at: at, last_matched_at: at, reported_at: null, reported_by: null, report_id: null })
        .execute();
      await recordAccess(trx, id, 'stored', at);
    });
  } catch (err) {
    await op.delete(fileKey(id)).catch(() => {});
    // The same file, sent twice at once: the other request kept it.
    const other = isUniqueViolation(err) ? await again() : null;
    if (other !== null) return other;
    throw err;
  }
  return id;
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

/**
 * Deletes the files whose time is over: those an admin recorded a report of
 * `quarantine.retentionDays` ago or longer, counted from the time of the report. The compactor
 * calls it, once a day. One that can't be deleted is logged, and tried again the next day.
 *
 * A file nobody recorded a report of is never deleted here, however old: deleting what may yet
 * have to be reported is not the server's to decide. The log is told how many wait, each day,
 * until an admin has reported or dismissed them.
 *
 * Does nothing on a server that has no quarantine.
 */
export async function expireQuarantine(deps: QuarantineDeps, log?: QuarantineLog): Promise<void> {
  const { db, config, now = Date.now } = deps;
  if (!quarantines(config)) return;
  const due = await db.selectFrom('quarantine').select(['id', 'reported_at']).where('reported_at', '<=', now() - config.quarantine.retentionDays * DAY).execute();
  for (const { id, reported_at: reportedAt } of due) {
    try {
      await removeQuarantined(deps, id, 'expired');
      log?.info({ quarantineId: id, reportedAt: new Date(Number(reportedAt)).toISOString(), days: config.quarantine.retentionDays }, 'deleted a quarantined file: the time it is kept for after its report is over');
    } catch (err) {
      log?.error({ err, quarantineId: id }, 'could not delete a quarantined file whose time is over; it is tried again tomorrow');
    }
  }
  const { waiting } = await db
    .selectFrom('quarantine')
    .select((eb) => eb.fn.countAll().as('waiting'))
    .where('reported_at', 'is', null)
    .executeTakeFirstOrThrow();
  if (Number(waiting) > 0) {
    log?.warn(
      { files: Number(waiting) },
      'the quarantine holds files that matched the list of hashes of known child sexual abuse material and that no admin has recorded a report of, or dismissed: GET /moderation/quarantine?reported=false lists them',
    );
  }
}
