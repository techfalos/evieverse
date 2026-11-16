import { buildApp } from './app.js';
import { createCompactor } from './compact/compactor.js';
import { bootstrap } from './deps.js';

const { close, ...deps } = await bootstrap();
const { config } = deps;
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
