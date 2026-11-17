import { setTimeout as sleep } from 'node:timers/promises';
import type { FastifyBaseLogger } from 'fastify';
import { MAX_ATTESTATION_CHARS } from './attestation.js';
import type { AppDeps } from './deps.types.js';
import { HttpError } from './http/errors.js';
import { fetchPublicAnswer } from './http/publicFetch.js';
import { loadTrustPlugins } from './moderation/trust.js';
import { OriginKeys } from './originKeys.js';
import { originEntries } from './origins.js';
import type { AttestationAnswer, OriginSweepOptions } from './originSweep.types.js';
import { effectiveMeta } from './pending.js';
import { HOUR, MINUTE } from './time.js';
import { contentWriter, GONE_RECHECK_MS } from './write.js';

/**
 * The server's own asking after the posts it holds reposts of. An entry for a post on another
 * server says what the post was when it was last attested (see routes/reposts.ts), and learns
 * what the post became from a later attestation. A client can bring one (POST /repost/refresh),
 * but nothing makes a client do it, so an edit or a deletion of the original would reach this
 * server only by chance. So the server asks too: every REPOSTS_REFRESH_HOURS, it gets the
 * attestation of each such post from the post's own server (GET <the post's address>/attestation
 * there, which answers anyone), checks it as it checks one a client brings, and does with it
 * what a refresh does (see originEntries). A post that is gone there has its entry hidden, and
 * is asked about again every GONE_RECHECK_MS until it is back or the entry is deleted
 * (REPOSTS_GONE_DAYS).
 *
 * It runs beside the compactor, in the one process that runs that (src/compact/main.ts, or the
 * server's own with COMPACT_IN_PROCESS), and outside the compactor's lease: what it changes, it
 * commits as a request does, and the compactor applies. A second copy does no harm: an entry is
 * claimed before it is asked about, by moving the time it is next due (`content.origin_check_at`).
 *
 * It asks slowly, one post at a time with a pause in between (PAUSE_MS), which keeps it under
 * the limit another server of this software puts on that route by default, and makes it no
 * burden on anyone. That is 30 posts a minute, some 43,000 a day: a server that holds more
 * reposts of posts elsewhere than that asks about each less often than the setting says.
 *
 * The address asked is one somebody else chose, so it is asked as another server's keys are
 * (http/publicFetch.ts): over https, at a public address, once, for a short time. It is the
 * post's address as its own server attested it when the entry was made, which was checked then.
 */

/** How long the server waits after asking one server about a post before it asks about the next. */
const PAUSE_MS = 2000;

/** How many entries one look at the database takes: the ones longest due. */
const BATCH = 50;

/** How long until the next look, after one that found fewer than BATCH entries due. */
const IDLE_MS = MINUTE;

/**
 * How long an entry isn't asked about again after its original's server gave no answer that
 * could be used, and how long none of that server's other posts are asked about either: one
 * that is down is asked once in this long, however many of its posts this server holds.
 */
const RETRY_MS = HOUR;

/** The largest answer that is read: an attestation, and what little JSON there is around it. */
const MAX_ANSWER_BYTES = MAX_ATTESTATION_CHARS + 8 * 1024;

/** The most servers that are remembered as having given no answer; past it they are all forgotten, and asked again. */
const MAX_DOWN = 1000;

/** Where a post's own server gives its attestation, from the post's address there. */
export const attestationAddress = (url: string) => `${url}/attestation`;

/** What asks another server for a post's attestation, unless a test gives another: 200 with the attestation, or 404 with one that says the post is gone. */
const askAttestation = (address: string): Promise<AttestationAnswer> => fetchPublicAnswer(address, [200, 404], MAX_ANSWER_BYTES);

/**
 * The attestation in a server's answer: `attestation` beside 200, `gone` beside 404 (see GET
 * /content/:id/attestation). Null if there is none: a 404 that carries nothing signed says
 * nothing this server can believe.
 */
function attestationIn({ status, body }: AttestationAnswer): string | null {
  const { attestation, gone } = (typeof body === 'object' && body !== null ? body : {}) as { attestation?: unknown; gone?: unknown };
  const written = status === 200 ? attestation : gone;
  return typeof written === 'string' && written.length <= MAX_ATTESTATION_CHARS ? written : null;
}

/**
 * What asks after the originals of the server's entries for posts on other servers (see above).
 * `sweep` is one look: it asks about the entries that are due, up to BATCH of them, and returns
 * how many were due. `start` keeps looking until what it returns is called, which resolves once
 * the look under way has stopped. With REPOSTS_REFRESH_HOURS=0 `start` does nothing.
 */
export async function createOriginSweep(deps: AppDeps, log: FastifyBaseLogger, { fetcher = askAttestation, keyFetcher, trustPlugins, pauseMs = PAUSE_MS }: OriginSweepOptions = {}) {
  const { db, config, content, now = Date.now } = deps;
  const refreshMs = config.reposts.refreshHours * HOUR;
  const origins = originEntries({
    ...deps,
    writer: contentWriter(deps, log),
    trustPlugins: trustPlugins ?? (await loadTrustPlugins(config.trust.optionalPlugins)),
    originKeys: new OriginKeys(deps.hot, keyFetcher, deps.now, log),
  });
  /** The servers that gave no answer that could be used, by host, with when: none of them is asked again within RETRY_MS. */
  const down = new Map<string, number>();

  /**
   * Asks about one entry that is due, and brings it up to the answer. False if nobody was asked:
   * another process took the entry, or its original's server gave no answer a moment ago.
   *
   * The entry is claimed first, by moving when it is next due to RETRY_MS from now, which holds
   * only if it is still due as it was read. So that is when it is asked about again if anything
   * here fails. An answer sets it to what the entry is asked by from then on: REPOSTS_REFRESH_HOURS,
   * or GONE_RECHECK_MS for one that is hidden.
   *
   * An answer the entry doesn't take leaves it as it is, as a refresh a client sends would (see
   * originEntries' refresh): it is no newer than what the entry holds, the post is of another
   * type now, or what it now says is refused by its trust score.
   */
  async function check(contentId: string, dueAt: number): Promise<boolean> {
    const at = now();
    const claimed = await db
      .updateTable('content')
      .set({ origin_check_at: at + RETRY_MS })
      .where('id', '=', contentId)
      .where('origin_check_at', '=', dueAt)
      .where('delete_requested_at', 'is', null)
      .executeTakeFirst();
    if (Number(claimed.numUpdatedRows) === 0) return false;
    const url = (await effectiveMeta(db, content, contentId))?.origin?.url;
    if (url === undefined) {
      log.warn({ contentId }, 'an entry for a post on another server has no address of its original, so it cannot be asked about');
      return false;
    }
    const { host } = new URL(url);
    if ((down.get(host) ?? -Infinity) > at - RETRY_MS) return false;

    let said: Awaited<ReturnType<typeof origins.attested>>;
    try {
      const attestation = attestationIn(await fetcher(attestationAddress(url)));
      if (attestation === null) throw new Error('it answered with no attestation');
      // Checked as one a client brings is. Its keys are asked for where Redis doesn't hold them, with no user to count it against.
      said = await origins.attested(attestation, async () => {});
      if (said.url !== url) throw new Error(`it attested ${said.url}, which is another address`);
    } catch (err) {
      if (down.size >= MAX_DOWN) down.clear();
      down.set(host, at);
      log.warn({ err, contentId, origin: url }, "could not get the attestation of a post from its own server, so the repost of it stays as it is: that server's posts are asked about again in an hour");
      return true;
    }

    try {
      const done = await origins.refresh(said, { log });
      if (done.change === 'gone' && !done.already) log.info({ contentId, origin: url }, 'hid the repost of a post that its own server says it no longer publishes');
      else if (done.change === 'updated') log.info({ contentId, origin: url, queued: done.queued }, 'brought the repost of a post on another server up to what the post is now');
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      log.info({ err, contentId, origin: url }, 'the repost of a post on another server did not take what the post is now, and stays as it is');
    }
    // Asked again by what the entry is now, whether or not it took the answer: sooner while it is hidden.
    const entry = await db.selectFrom('content').select('origin_gone_at').where('id', '=', contentId).executeTakeFirst();
    await db
      .updateTable('content')
      .set({ origin_check_at: now() + (entry?.origin_gone_at != null ? GONE_RECHECK_MS : refreshMs) })
      .where('id', '=', contentId)
      .where('delete_requested_at', 'is', null)
      .execute();
    return true;
  }

  /**
   * One look: asks about the entries whose time has come, the longest due first and of those
   * the oldest, one after
   * another with a pause after each that had a server asked. One that fails is logged, and left
   * for RETRY_MS. Stops early once `signal` is aborted. Returns how many entries were due.
   */
  async function sweep(signal?: AbortSignal): Promise<number> {
    const due = await db
      .selectFrom('content')
      .select(['id', 'origin_check_at'])
      .where('origin_hash', 'is not', null)
      .where('delete_requested_at', 'is', null)
      .where('origin_check_at', '<=', now())
      .orderBy('origin_check_at')
      .orderBy('created_at')
      .limit(BATCH)
      .execute();
    for (const entry of due) {
      if (signal?.aborted) break;
      const asked = await check(entry.id, Number(entry.origin_check_at)).catch((err: unknown) => {
        log.error({ err, contentId: entry.id }, 'could not bring the repost of a post on another server up to date; it is asked about again in an hour');
        return true;
      });
      if (asked && pauseMs > 0) await sleep(pauseMs, undefined, { signal }).catch(() => {});
    }
    return due.length;
  }

  /** Looks again and again until stopped: at once after a look that found a full batch due, else after IDLE_MS. */
  function start(): () => Promise<void> {
    if (refreshMs === 0) return async () => {};
    const stop = new AbortController();
    const running = (async () => {
      while (!stop.signal.aborted) {
        const due = await sweep(stop.signal).catch((err: unknown) => {
          log.error({ err }, 'could not look for the reposts of posts on other servers that are due to be asked about');
          return 0;
        });
        await sleep(due === BATCH ? pauseMs : IDLE_MS, undefined, { signal: stop.signal }).catch(() => {});
      }
    })();
    return async () => {
      stop.abort();
      await running;
    };
  }

  return { sweep, start };
}
