import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/apiKey.js';
import type { AuthUser } from '../auth/apiKey.types.js';
import type { QuarantineTable } from '../db/schema.js';
import type { AppDeps } from '../deps.types.js';
import { badRequest, conflict, forbidden, notFound } from '../http/errors.js';
import { listPage, listQuery } from '../http/listCursor.js';
import { Credentials, Flag, ListQuery } from '../http/schemas.js';
import { msg } from '../language.js';
import { quarantines, readQuarantined, recordAccess, removeQuarantined } from '../quarantine.js';
import type { QuarantineActor } from '../quarantine.types.js';
import { isNotFound } from '../storage/opendal.js';
import { DAY, iso } from '../time.js';

/** The item a path names. */
const Params = z.object({ quarantineId: z.string().uuid() });
/** A page of the quarantine's list: all of it, or only what a report was recorded of (`reported=true`), or only what waits for one (`reported=false`). */
const Query = ListQuery.extend({ limit: z.coerce.number().int().min(1).max(100).default(50) });
/** Which items a list is of (see Query). */
const ReportedQuery = z.object({ reported: Flag.optional() });
/**
 * What an admin records of the report they made of a file: what the authority calls it
 * (`reportId`, a CyberTipline report's number), if it gave it a name, and when it was made
 * (`reportedAt`, an ISO 8601 time), if that isn't now.
 */
const ReportBody = Credentials.extend({
  reportId: z.string().trim().min(1).max(200).optional(),
  reportedAt: z.iso.datetime({ offset: true }).optional(),
});
/** How many rows of an item's log it is given with: the newest. */
const ACCESS_ROWS = 200;

/** The columns of a row of `quarantine`, as the routes read one. */
type Row = Pick<QuarantineTable, 'id' | 'user_id' | 'sha256' | 'mime_type' | 'size' | 'facts' | 'created_at' | 'last_matched_at' | 'reported_at' | 'reported_by' | 'report_id'> & { matches: number };

/** What the admins were told of the match, from the JSON a row keeps of it. Nothing, of what isn't an object. */
function factsOf(facts: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(facts);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The quarantine, for the server's admins (src/quarantine.ts): the files that matched the pdq
 * trust plugin's list of hashes of known child sexual abuse material, which the server keeps
 * where its operator turned that on (QUARANTINE_SCHEME). Nobody else is answered: a server
 * moderator isn't, and neither is the user who sent the file, who is never told there is one.
 * On a server that has no quarantine, every one of these is 404.
 *
 *   GET    /moderation/quarantine                       what is kept, newest first
 *   GET    /moderation/quarantine/:quarantineId         one item, with what was done with it
 *   GET    /moderation/quarantine/:quarantineId/file    its file, to send with a report
 *   POST   /moderation/quarantine/:quarantineId/report  records that the report was made
 *   DELETE /moderation/quarantine/:quarantineId         deletes one that was never reported
 *
 * The file is given by the one route, as bytes to save, streamed from here: no link to the
 * store is made, and nothing shows it. Each time it is read is written to the quarantine's
 * log first (`quarantine_access`), with the admin and their address, and so is each report
 * and each deletion; the item is given with that log.
 *
 * Recording the report is what starts the item's time: the compactor deletes its file
 * `quarantine.retentionDays` after it (a year, unless the operator set another). Until a
 * report is recorded, the file stays. One that an admin finds is not what the list took it for
 * is theirs to delete; one a report was recorded of is deleted by its time alone.
 */
export function quarantineRoutes(app: FastifyInstance, deps: Pick<AppDeps, 'db' | 'config' | 'now'>) {
  const { db, config, now = Date.now } = deps;

  /** 404 for an item that isn't there, and for every item on a server that has no quarantine. */
  const noItem = () => notFound(msg('quarantine.not_found'));

  /** The caller, who must be an admin, on a server that has a quarantine. */
  async function asAdmin(req: FastifyRequest, body: Credentials = Credentials.parse(req.body ?? {})): Promise<AuthUser> {
    const user = await authenticate(db, req, body);
    if (!user.admin) throw forbidden(msg('moderation.admin_only'));
    if (!quarantines(config)) throw noItem();
    return user;
  }

  /** The admin as the quarantine's log keeps them: who, and where their request came from. */
  const actor = (req: FastifyRequest, admin: AuthUser): QuarantineActor => ({ userId: admin.id, ip: req.ip, userAgent: req.headers['user-agent'] ?? null });

  const rows = () => db.selectFrom('quarantine').select(['id', 'user_id', 'sha256', 'mime_type', 'size', 'facts', 'matches', 'created_at', 'last_matched_at', 'reported_at', 'reported_by', 'report_id']);

  /** The item `id`, or 404. */
  async function load(id: string): Promise<Row> {
    const row = await rows().where('id', '=', id).executeTakeFirst();
    if (!row) throw noItem();
    return { ...row, matches: Number(row.matches) };
  }

  /** An item as responses give it. `deleteAfter` is when its file's time is over, as the server's setting has it now. */
  const item = (row: Row) => ({
    quarantineId: row.id,
    userId: row.user_id,
    sha256: row.sha256,
    mimeType: row.mime_type,
    size: Number(row.size),
    matches: Number(row.matches),
    storedAt: iso(Number(row.created_at)),
    lastMatchedAt: iso(Number(row.last_matched_at)),
    facts: factsOf(row.facts),
    report:
      row.reported_at === null
        ? null
        : {
            reportedAt: iso(Number(row.reported_at)),
            reportedBy: row.reported_by,
            ...(row.report_id !== null && { reportId: row.report_id }),
            deleteAfter: iso(Number(row.reported_at) + config.quarantine.retentionDays * DAY),
          },
  });

  /**
   * What the quarantine holds, newest first, a page at a time (`limit`, `cursor`): each item
   * with what the admins were told of the match (`facts`), how many times its user sent the
   * file (`matches`), and the report recorded of it, or null. `reported=false` lists only the
   * ones that wait for a report, and `reported=true` only the others. The files themselves
   * are not in it.
   */
  app.get('/moderation/quarantine', async (req) => {
    await asAdmin(req);
    const { reported } = ReportedQuery.parse(req.query);
    let query = rows();
    if (reported !== undefined) query = query.where('reported_at', reported ? 'is not' : 'is', null);
    const page = await listPage(query, { createdAt: 'quarantine.created_at', userId: 'quarantine.id' }, listQuery(req.query, Query));
    return { items: page.rows.map((row) => item({ ...row, matches: Number(row.matches) })), nextCursor: page.nextCursor };
  });

  /**
   * One item, as the list gives it, with what was done with it (`access`), newest first: that
   * the server kept the file (`stored`), each time an admin read it (`downloaded`), each
   * report recorded (`reported`), each with the admin's id, their address and when.
   */
  app.get('/moderation/quarantine/:quarantineId', async (req) => {
    await asAdmin(req);
    const { quarantineId } = Params.parse(req.params);
    const row = await load(quarantineId);
    const access = await db
      .selectFrom('quarantine_access')
      .select(['action', 'user_id', 'ip', 'user_agent', 'created_at'])
      .where('quarantine_id', '=', quarantineId)
      .orderBy('created_at', 'desc')
      .orderBy('id')
      .limit(ACCESS_ROWS)
      .execute();
    return {
      ...item(row),
      access: access.map((a) => ({ action: a.action, by: a.user_id, ip: a.ip, userAgent: a.user_agent, at: iso(Number(a.created_at)) })),
    };
  });

  /**
   * The item's file, for the admin to send with their report: the bytes as the server kept
   * them, as a file to save (`application/octet-stream`, as an attachment named by the
   * file's SHA-256), which no browser shows and no cache keeps. That the admin read it is
   * written to the quarantine's log before a byte is sent, and to the server's log, as a
   * warning. Never compressed, and never a redirect: the bytes come from here alone.
   */
  app.get('/moderation/quarantine/:quarantineId/file', { compress: false }, async (req, reply) => {
    const admin = await asAdmin(req);
    const { quarantineId } = Params.parse(req.params);
    const row = await load(quarantineId);
    let file;
    try {
      file = await readQuarantined(deps, quarantineId, actor(req, admin));
    } catch (err) {
      if (!isNotFound(err)) throw err;
      req.log.error({ err, quarantineId }, 'a quarantined file is not in the quarantine store');
      throw noItem();
    }
    req.log.warn({ quarantineId, admin: admin.id, ip: req.ip }, 'an admin read a quarantined file');
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-length', String(row.size));
    reply.header('content-disposition', `attachment; filename="${row.sha256}.bin"`);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('content-security-policy', "default-src 'none'; sandbox");
    reply.header('cache-control', 'private, no-store');
    return reply.send(file);
  });

  /**
   * Records that the file was reported to the authorities, which is the operator's to do and
   * not the server's: with what the authority calls the report (`reportId`), if it has a
   * name, and when it was made (`reportedAt`), which is now unless the request says. From
   * then on the item says so, and its file is deleted `quarantine.retentionDays` after that
   * time. Sent again, it records the report as it is said now, to correct what was recorded.
   *
   * A time before the file was kept is refused (400), and so is one that is yet to come: the
   * first would have the file deleted before its time.
   */
  app.post('/moderation/quarantine/:quarantineId/report', async (req) => {
    const body = ReportBody.parse(req.body ?? {});
    const admin = await asAdmin(req, body);
    const { quarantineId } = Params.parse(req.params);
    const row = await load(quarantineId);
    const at = now();
    const reportedAt = body.reportedAt === undefined ? at : Date.parse(body.reportedAt);
    if (reportedAt > at || reportedAt < Number(row.created_at)) throw badRequest(msg('quarantine.report_time'));
    await db.transaction().execute(async (trx) => {
      await recordAccess(trx, quarantineId, 'reported', at, actor(req, admin));
      await trx.updateTable('quarantine').set({ reported_at: reportedAt, reported_by: admin.id, report_id: body.reportId ?? null }).where('id', '=', quarantineId).execute();
    });
    req.log.warn({ quarantineId, admin: admin.id, reportedAt: iso(reportedAt) }, 'an admin recorded the report of a quarantined file');
    return item({ ...row, reported_at: reportedAt, reported_by: admin.id, report_id: body.reportId ?? null });
  });

  /**
   * Deletes an item that was never reported, and its file: for one that an admin has looked
   * at and found is not what the list took it for. 204. The quarantine's log keeps that it
   * was there, and who deleted it. One a report was recorded of is refused (409): it is kept
   * for its time, and deleted by that alone.
   */
  app.delete('/moderation/quarantine/:quarantineId', async (req, reply) => {
    const admin = await asAdmin(req);
    const { quarantineId } = Params.parse(req.params);
    const row = await load(quarantineId);
    if (row.reported_at !== null) throw conflict(msg('quarantine.reported'));
    await removeQuarantined(deps, quarantineId, 'dismissed', actor(req, admin));
    req.log.warn({ quarantineId, admin: admin.id, sha256: row.sha256, userId: row.user_id }, 'an admin deleted a quarantined file that was never reported');
    return reply.status(204).send();
  });
}
