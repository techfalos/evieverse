import { setTimeout as sleep } from 'node:timers/promises';
import type { FastifyBaseLogger } from 'fastify';
import type { AppDeps } from './deps.types.js';
import { MINUTE } from './time.js';

/**
 * Bringing users' indexes of comments up to what the store holds. The comment store keeps, for
 * each user, an index of the comments they wrote and of the ones they liked
 * (storage/commentStore.ts), which the compactor writes with each comment and like. A server
 * that had comments before it kept that index has none for them: this is what writes theirs,
 * once, in the one process that runs the compactor (src/compact/main.ts, or the server's own
 * with COMPACT_IN_PROCESS), beside its runs and outside its lease (see CommentStore.indexAuthors
 * for why that is safe).
 *
 * On a server with no comment older than the index, which is every new one, it finds nothing to
 * do, says in the store that the indexes hold everything, and is over. Until the store says
 * so, a user's export gives none of their comments (src/export.ts): it would lack the old ones.
 */

/** How long until the work is taken up again after it failed: the store couldn't be read or written. */
const RETRY_MS = MINUTE;

/**
 * Starts that work, unless the store says it is done, and returns what stops it: called as the
 * process shuts down, it resolves once the post whose comments are being indexed has its marks.
 * The work goes on from there the next time a process starts it. A failure is logged, and the
 * work taken up again a minute later.
 */
export function startAuthorIndexing({ comments }: Pick<AppDeps, 'comments'>, log: FastifyBaseLogger): () => Promise<void> {
  const stop = new AbortController();
  const stopped = () => stop.signal.aborted;
  const work = (async () => {
    while (!stopped()) {
      try {
        if (await comments.indexed()) return;
        log.info("indexing the comments and likes that are older than users' indexes of them");
        if (await comments.indexAuthors(stopped)) log.info("users' indexes of their comments and likes hold everything");
        return;
      } catch (err) {
        log.error({ err }, "could not index users' comments and likes; trying again in a minute");
        await sleep(RETRY_MS, undefined, { signal: stop.signal }).catch(() => {});
      }
    }
  })();
  return async () => {
    stop.abort();
    await work;
  };
}
