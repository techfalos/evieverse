import { setTimeout as sleep } from 'node:timers/promises';
import pino from 'pino';
import { loadConfig } from '../config.js';
import { bootstrap } from '../deps.js';
import { createOriginSweep } from '../originSweep.js';
import { createCompactor } from './compactor.js';

/**
 * The compactor as a process of its own, which is how a deployment runs it: one copy, always up.
 * `npm run compact` runs pass after pass until it is stopped, never two at once and never more than
 * one in COMPACT_INTERVAL_SECONDS. A second copy does no harm (the lease lets one of them run at a
 * time) and no good.
 *
 * Beside the passes, the process asks other servers after the posts this one holds reposts of
 * (src/originSweep.ts), so it has to reach them over https: without that, a repost learns what
 * its original became only from an attestation a client brings.
 *
 * `--all` first rebuilds every day of every tag, and works out every hashtag's related hashtags
 * again. `--rebuild` first rebuilds the whole feed index, the summaries, the publisher credits and
 * the related hashtags from the database and the meta files: run it after Redis lost data. `--once`
 * runs a single pass and exits, which is how to run either of those by hand beside the process that
 * is already up: a rebuild that finds that process mid-pass waits for it, rather than being skipped
 * as an ordinary pass is.
 */

/** The process's settings, as `loadConfig` read them from the config file and the environment. */
const config = loadConfig();
/** Where this process and its compactor log, as JSON lines on stdout, at the level LOG_LEVEL sets. */
const log = pino({ level: config.logLevel });
if (!config.redis.url) {
  log.error('the standalone compactor needs REDIS_URL: without it the feed index lives inside each API process');
  process.exit(1);
}
/**
 * The database and the stores the compactor works on (`deps`), the schema brought up to date first
 * unless DB_MIGRATE_ON_START is off, and `close`, which ends their connections.
 */
const { close, ...deps } = await bootstrap(config);
/** The one compactor of this process: every pass below is its, the ones asked for by hand and the ones it then makes on its own. */
const compactor = createCompactor(deps, log);

/**
 * What the command line asks the first pass to rebuild: `--all`, `--rebuild` (see above). The
 * passes after it rebuild only what changed.
 */
const opts = { all: process.argv.includes('--all'), rebuild: process.argv.includes('--rebuild') };
/** Whether a rebuild was asked for by hand: such a pass waits for its turn where an ordinary one is skipped (see `pass`). */
const asked = opts.all || opts.rebuild;

/** One pass. What was asked for by hand isn't lost to a pass another compactor is making: it takes the next turn. */
async function pass() {
  for (;;) {
    const result = await compactor.runOnce(opts);
    if (!result.skipped || !asked) return result;
    await sleep(1000);
  }
}

if (process.argv.includes('--once')) {
  const { tags, deleted, skipped } = await pass();
  if (!skipped) log.info({ tags: tags.length, deleted: deleted.length }, 'compaction pass complete');
  await close();
} else {
  if (asked) {
    log.info({ tags: (await pass()).tags.length }, opts.rebuild ? 'rebuilt the feed index' : 'rebuilt every tag');
  }
  const stop = compactor.start();
  // Beside the compactor, as this is the one process that is always up: what asks other servers after the posts this one holds reposts of.
  const stopOriginSweep = (await createOriginSweep(deps, log)).start();
  const shutdown = async () => {
    await stopOriginSweep();
    await stop();
    await close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  log.info({ intervalSeconds: config.compact.intervalSeconds }, 'compactor started');
}
