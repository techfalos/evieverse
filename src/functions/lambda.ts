import { createDb } from '../db/index.js';
import { migrateToLatest } from '../db/migrator.js';
import { loadLanguages } from '../language.js';
import { bootstrapAdmin } from '../moderation/bootstrap.js';
import { isGroup } from './groups.js';
import { createFunction, functionConfig } from './handler.js';
import { httpApiHandler, runLambda } from './lambdaRuntime.js';

/**
 * The entry point of every AWS Lambda function, which all run the one image (`node dist/functions/lambda.js`).
 * FUNCTION_GROUP says which this is:
 *
 *   feed | content | store | api   a route group (groups.ts) behind an API Gateway HTTP API
 *   migrate                        brings the schema up to date, and sets up the admin account in
 *                                  BOOTSTRAP_ADMIN if there is one; a deploy invokes it once
 *
 * The compactor isn't a function: it is a process that stays up (`node dist/compact/main.js`), which
 * a deployment runs from the same image as a container of its own.
 *
 * FUNCTION_EDGE_SECRET, if set, is what the CDN in front of the gateway sends as X-Edge-Secret.
 */
const group = process.env.FUNCTION_GROUP;
const config = functionConfig();
if (!config.redis.url && group !== 'migrate') {
  throw new Error('functions need REDIS_URL: without it the feed index would live inside each instance');
}

if (group === 'migrate') {
  await runLambda(async () => {
    const db = await createDb(config.db);
    try {
      await migrateToLatest(db);
      const admin = await bootstrapAdmin(db);
      return { migrated: true, dialect: config.db.dialect, ...(admin && { admin }) };
    } finally {
      await db.destroy();
    }
  });
} else if (isGroup(group)) {
  // Read once, for the app and for what the handler answers without it.
  const languages = loadLanguages(config.defaultLanguage);
  const fn = createFunction(group, config, { server: { languages } });
  await runLambda(httpApiHandler(fn, { edgeSecret: process.env.FUNCTION_EDGE_SECRET || undefined, languages }), { init: () => fn.ready() });
} else {
  throw new Error(`FUNCTION_GROUP must be feed, content, store, api or migrate (got ${JSON.stringify(group)})`);
}
