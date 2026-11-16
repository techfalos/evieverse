import { loadLanguages } from '../language.js';
import { migrateDeployment } from './deploy.js';
import { isGroup } from './groups.js';
import { createFunction, functionConfig, requireRedis } from './handler.js';
import { httpApiHandler, runLambda } from './lambdaRuntime.js';

/**
 * The entry point of every AWS Lambda function, which all run the one image (`node dist/functions/lambda.js`).
 * FUNCTION_GROUP says which this is:
 *
 *   feed | content | store | api   a route group (groups.ts) behind an API Gateway HTTP API
 *   migrate                        the step a deploy invokes once, before it updates the others
 *                                  (deploy.ts): given their settings, it checks that they start
 *                                  with them, then brings the schema up to date and sets up the
 *                                  admin account in BOOTSTRAP_ADMIN, if there is one
 *
 * The compactor isn't a function: it is a process that stays up (`node dist/compact/main.js`), which
 * a deployment runs from the same image as a container of its own.
 *
 * FUNCTION_EDGE_SECRET, if set, is what the CDN in front of the gateway sends as X-Origin-Secret.
 */

/** FUNCTION_GROUP as the environment has it: which function this is, a route group's or `migrate`. Anything else is refused below. */
const group = process.env.FUNCTION_GROUP;

if (group === 'migrate') {
  // The settings are read inside the invocation, not as the instance starts: what refuses them is
  // then the invocation's error, which is what the deploy that invoked it is told.
  await runLambda(() => migrateDeployment());
} else if (isGroup(group)) {
  const config = functionConfig();
  requireRedis(config);
  // Read once, for the app and for what the handler answers without it.
  const languages = loadLanguages(config.defaultLanguage);
  const fn = createFunction(group, config, { server: { languages } });
  await runLambda(httpApiHandler(fn, { edgeSecret: process.env.FUNCTION_EDGE_SECRET || undefined, languages }), { init: () => fn.ready() });
} else {
  throw new Error(`FUNCTION_GROUP must be feed, content, store, api or migrate (got ${JSON.stringify(group)})`);
}
