import pino from 'pino';
import { loadConfig } from '../config.js';
import { createDb } from '../db/index.js';
import { migrateToLatest } from '../db/migrator.js';
import { createStores } from '../deps.js';
import { Compactor } from './compactor.js';

/**
 * Standalone compactor: `npm run compact` loops, `npm run compact -- --once` runs a single pass (e.g.
 * from cron). `--all` first rebuilds every day of every tag. `--rebuild` first rebuilds the whole feed
 * index, the summaries and the publisher credits from the database and the meta files: run it after
 * Redis lost data, or to migrate from the tag-file layout.
 */
const config = loadConfig();
const log = pino({ level: config.logLevel });
if (!config.redis.url) {
  log.error('the standalone compactor needs REDIS_URL: without it the feed index lives inside each API process');
  process.exit(1);
}
const db = await createDb(config.db);
await migrateToLatest(db);
const { hot, summaries, content } = createStores(config);
const compactor = new Compactor({ config, db, hot, summaries, content, log });

const opts = { all: process.argv.includes('--all'), rebuild: process.argv.includes('--rebuild') };
const close = async () => {
  await hot.close();
  await db.destroy();
};
if (process.argv.includes('--once')) {
  const { tags, deleted, skipped } = await compactor.runOnce(opts);
  if (!skipped) log.info({ tags: tags.length, deleted: deleted.length }, 'compaction pass complete');
  await close();
} else {
  if (opts.all || opts.rebuild) {
    const { tags, skipped } = await compactor.runOnce(opts);
    if (!skipped) log.info({ tags: tags.length }, opts.rebuild ? 'rebuilt the feed index' : 'rebuilt every tag');
  }
  const stop = compactor.start();
  const shutdown = async () => {
    await stop();
    await close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  log.info({ intervalSeconds: config.compact.intervalSeconds }, 'compactor started');
}
