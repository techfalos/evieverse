import { buildApp } from '../app.js';
import { bootstrap, bootstrapStores } from '../deps.js';
import { GROUPS, isGroup } from './groups.js';
import { functionConfig } from './handler.js';

/**
 * The entry point of a function on a platform that runs containers behind HTTP and scales them with
 * traffic, down to none (Cloud Run, Azure Container Apps): `node dist/functions/http.js`, listening
 * on PORT. FUNCTION_GROUP says which route group (groups.ts) it serves, and nothing else: feed,
 * content, store or api.
 *
 * The compactor isn't one of them: it is a process that stays up (`node dist/compact/main.js`),
 * which the same platforms run from the same image as a worker with no address.
 *
 * FUNCTION_EDGE_SECRET, if set, is what the CDN in front of a route group sends as X-Edge-Secret;
 * requests without it are refused. Set it where the platform can't keep other callers out itself.
 */
const group = process.env.FUNCTION_GROUP;
const config = functionConfig();
if (!config.redis.url) {
  throw new Error('functions need REDIS_URL: without it the feed index would live inside each instance');
}
if (!isGroup(group)) {
  throw new Error(`FUNCTION_GROUP must be feed, content, store or api (got ${JSON.stringify(group)})`);
}

const deps = GROUPS[group].database ? await bootstrap(config) : bootstrapStores(config);
const app = await buildApp(deps, { edgeSecret: process.env.FUNCTION_EDGE_SECRET || undefined }, [group]);

const shutdown = async () => {
  app.log.info('shutting down');
  await app.close();
  await deps.close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await app.listen({ host: config.host, port: config.port });
