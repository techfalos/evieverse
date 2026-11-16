import { buildApp } from './app.js';
import { Compactor } from './compact/compactor.js';
import { loadConfig } from './config.js';
import { createDb } from './db/index.js';
import { migrateToLatest } from './db/migrator.js';
import { createStores } from './deps.js';

const config = loadConfig();
const db = await createDb(config.db);
await migrateToLatest(db);
const stores = createStores(config);
const app = await buildApp({ config, db, ...stores });

if (!config.redis.url) {
  app.log.warn('REDIS_URL is not set: the feed index lives in this process only, so run a single node with COMPACT_IN_PROCESS=true.');
}

let stopCompactor: (() => Promise<void>) | undefined;
if (config.compact.inProcess) {
  const compactor = new Compactor({ config, db, hot: stores.hot, summaries: stores.summaries, content: stores.content, log: app.log });
  // The in-process store starts empty on every boot.
  if (!config.redis.url) await compactor.runOnce({ rebuild: true });
  stopCompactor = compactor.start();
}

const shutdown = async () => {
  app.log.info('shutting down');
  await app.close();
  await stopCompactor?.();
  await stores.hot.close();
  await db.destroy();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await app.listen({ host: config.host, port: config.port });
