import { buildApp } from './app.js';
import { createCompactor } from './compact/compactor.js';
import { bootstrap } from './deps.js';

/** What the long-running server works with: its settings, the stores and the database. `close` ends their connections, as the server shuts down. */
const { close, ...deps } = await bootstrap();
/** The server's settings, as `loadConfig` read them from the config file and the environment. */
const { config } = deps;
/** The app with every group of routes: this one process serves them all. */
const app = await buildApp(deps);

if (!config.redis.url) {
  app.log.warn('REDIS_URL is not set: the feed index lives in this process only, so run a single node with COMPACT_IN_PROCESS=true.');
}

let stopCompactor: (() => Promise<void>) | undefined;
if (config.compact.inProcess) {
  const compactor = createCompactor(deps, app.log);
  // The in-process store starts empty on every boot.
  if (!config.redis.url) await compactor.runOnce({ rebuild: true });
  stopCompactor = compactor.start();
}

/**
 * Stops the server on SIGINT or SIGTERM: the app first, so it takes no more requests, then the
 * compactor, whose run under way is waited for, then the connections. The process exits with 0.
 */
const shutdown = async () => {
  app.log.info('shutting down');
  await app.close();
  await stopCompactor?.();
  await close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await app.listen({ host: config.host, port: config.port });
