import { buildApp } from '../app.js';
import { bootstrap, bootstrapStores } from '../deps.js';
import { GROUPS, isGroup } from './groups.js';
import { functionConfig, requireRedis } from './handler.js';

/**
 * The entry point of a function on a platform that runs containers behind HTTP and scales them with
 * traffic, down to none (Cloud Run, Azure Container Apps): `node dist/functions/http.js`, listening
 * on PORT. FUNCTION_GROUP says which route group (groups.ts) it serves, and nothing else: feed,
 * content, store or api.
 *
 * The compactor isn't one of them: it is a process that stays up (`node dist/compact/main.js`),
 * which the same platforms run from the same image as a worker with no address.
 *
 * FUNCTION_EDGE_SECRET, if set, is what the CDN in front of a route group sends as
 * X-Origin-Secret; requests without it are refused. Set it where the platform can't keep other
 * callers out itself.
 */

/** FUNCTION_GROUP as the environment has it: the route group this container serves, once it is checked to name one (below). */
const group = process.env.FUNCTION_GROUP;
/** The function's settings: the environment's, over the defaults of a function (see `functionConfig`). */
const config = functionConfig();
requireRedis(config);
if (!isGroup(group)) {
  throw new Error(`FUNCTION_GROUP must be feed, content, store or api (got ${JSON.stringify(group)})`);
}

/** What the group's routes work with: the stores, and the database only for a group that uses it, so the feed's container never connects to it. */
const deps = GROUPS[group].database ? await bootstrap(config) : bootstrapStores(config);
/** The app with this group's routes and no others; with FUNCTION_EDGE_SECRET set, it refuses the requests that don't carry it (see `requireEdgeSecret`). */
const app = await buildApp(deps, { edgeSecret: process.env.FUNCTION_EDGE_SECRET || undefined }, [group]);

/**
 * Ends the process when the platform stops the container (SIGINT, SIGTERM): closes the app, then
 * the connections of its stores and of its database, if it has one, and exits with 0.
 */
const shutdown = async () => {
  app.log.info('shutting down');
  await app.close();
  await deps.close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await app.listen({ host: config.host, port: config.port });
