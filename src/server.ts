import { buildApp } from './app.js';
import { bootstrap } from './deps.js';
import { setUpFirstAdmin } from './moderation/firstAdmin.js';

/**
 * The server: the API, in one process that serves every group of routes. What its requests
 * commit reaches the stores and the feeds through the compactor, which is a process of its own
 * beside it (compactor/src/main.rs, `npm run compact`): one of them, however many servers there
 * are, on the same database, Redis and stores.
 */

/** What the long-running server works with: its settings, the stores and the database. `close` ends their connections, as the server shuts down. */
const { close, ...deps } = await bootstrap();
/** The server's settings, as `loadConfig` read them from the config file and the environment. */
const { config } = deps;
/** The app with every group of routes: this one process serves them all. */
const app = await buildApp(deps);

// The admin of a server that has none, where the settings name a file to keep its key in (FIRST_ADMIN_PROFILE), as the Docker image does: created before the first request is taken.
await setUpFirstAdmin(deps, app.log);

/**
 * Stops the server on SIGINT or SIGTERM: the app first, so it takes no more requests and ends
 * the ones under way, then the connections. The process exits with 0.
 */
const shutdown = async () => {
  app.log.info('shutting down');
  await app.close();
  await close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await app.listen({ host: config.host, port: config.port });
