import { buildApp } from './app.js';
import { startAuthorIndexing } from './authorIndex.js';
import { createCompactor } from './compact/compactor.js';
import { bootstrap } from './deps.js';
import { createOriginSweep } from './originSweep.js';
import { startVideoWorker } from './video/worker.js';

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
let stopOriginSweep: (() => Promise<void>) | undefined;
let stopAuthorIndexing: (() => Promise<void>) | undefined;
let stopVideoWorker: (() => Promise<void>) | undefined;
if (config.compact.inProcess) {
  const compactor = createCompactor(deps, app.log);
  // The in-process store starts empty on every boot.
  if (!config.redis.url) await compactor.runOnce({ rebuild: true });
  stopCompactor = compactor.start();
  // Beside the compactor, in the one process that runs it: what asks other servers after the posts this one holds reposts of.
  stopOriginSweep = (await createOriginSweep(deps, app.log)).start();
  // And what indexes, by who wrote or liked them, the comments that are older than that index.
  stopAuthorIndexing = startAuthorIndexing(deps, app.log);
  // And what makes the videos users send into videos that play, where the server processes them: it needs ffmpeg, and the server doesn't start without it.
  stopVideoWorker = await startVideoWorker(deps, app.log);
}

/**
 * Stops the server on SIGINT or SIGTERM: the app first, so it takes no more requests, then what
 * asks other servers after reposts' originals, what indexes old comments and what processes videos (the one
 * under way is the next process's to start again), then the compactor, whose run under way finishes
 * the writes it is making and is waited for, then the connections. The process exits with 0.
 */
const shutdown = async () => {
  app.log.info('shutting down');
  await app.close();
  await stopOriginSweep?.();
  await stopAuthorIndexing?.();
  await stopVideoWorker?.();
  await stopCompactor?.();
  await close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await app.listen({ host: config.host, port: config.port });
