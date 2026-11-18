import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/apiKey.js';
import type { AppDeps } from '../deps.types.js';
import { exporter } from '../export.js';
import { forbidden, tooManyRequests } from '../http/errors.js';
import { say } from '../http/language.js';
import { Credentials, ListQuery } from '../http/schemas.js';
import { msg } from '../language.js';
import { MINUTE } from '../time.js';

/** The path of a user's export: the user's id. */
const Params = z.object({ userId: z.string().uuid() });
/** A page of an export: up to 1,000 records, and 500 unless the request says. It also ends once its records come to about a megabyte (src/export.ts). */
const ExportQuery = ListQuery.extend({ limit: z.coerce.number().int().min(1).max(1000).default(500) });

/**
 * A user's export of their own data: everything the server holds of them, to keep or to take
 * elsewhere (what the GDPR calls access and portability). src/export.ts says what it holds, how
 * it is read, and why an account of any size costs a request no more than a page.
 */
export function exportRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, config, hot } = deps;
  const page = exporter(deps);

  /**
   * A page of the caller's export: `{ userId, records, nextCursor }`. Each record says what it is
   * (`type`). `nextCursor` is the `cursor` of the page after it, and null on the last: a client
   * asks for pages until then, and has the whole export. A page holds up to `limit` records
   * (1,000 at most, 500 by default) and fewer where they are large. The last one can be empty.
   *
   * Only the user themself, with their own key (403): nobody exports another user's data, an
   * admin included. 429 past the pages a user can read in a minute (EXPORT_PAGES_PER_MINUTE).
   * 400 for a cursor that isn't an export's.
   */
  app.get('/users/:userId/export', async (req) => {
    const { userId } = Params.parse(req.params);
    const query = ExportQuery.parse(req.query);
    const user = await authenticate(db, req, Credentials.parse(req.body ?? {}));
    if (user.id !== userId) throw forbidden(msg('export.own_only'));

    const { pagesPerMinute } = config.export;
    if (pagesPerMinute > 0) {
      const { count, ttlMs } = await hot.incr(`export:${userId}`, MINUTE);
      const seconds = Math.max(1, Math.ceil(ttlMs / 1000));
      if (count > pagesPerMinute) throw tooManyRequests(msg('export.rate_limited', { count: seconds }), seconds);
    }
    // Where an export starts: who took their data, and when, is for the server's log to say.
    if (query.cursor === undefined) req.log.info({ userId }, 'started an export of the account');
    return { userId, ...(await page(userId, query, (text) => say(req, text))) };
  });
}
