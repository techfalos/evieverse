import { ZodError } from 'zod';
import type { Config } from '../config.js';
import { createDb } from '../db/index.js';
import { migrateToLatest } from '../db/migrator.js';
import { loadLanguages } from '../language.js';
import { bootstrapAdmin } from '../moderation/bootstrap.js';
import type { Deployed } from './deploy.types.js';
import { GROUP_NAMES } from './groups.js';
import { createFunction, functionConfig, requireRedis } from './handler.js';
import type { FunctionOptions } from './handler.types.js';

/**
 * The step a deployment of functions runs once, before any function or the compactor gets a new
 * image or new settings: the `migrate` function on AWS Lambda (lambda.ts), and a job that runs
 * `node dist/functions/migrate.js` elsewhere (migrate.ts). It is given the settings the functions
 * are about to get, and with them:
 *
 *   1. checks that they are settings a function starts with (checkSettings)
 *   2. brings the schema up to date
 *   3. sets up the admin account in BOOTSTRAP_ADMIN, if there is one
 *
 * The check is there because deploying a function doesn't start it. A setting the server refuses,
 * such as a misspelt name in TRUST_OPTIONAL_PLUGINS, would otherwise show only once the deploy had
 * succeeded, as every request failing. Here it fails the deploy instead, with the functions that
 * are running left as they are.
 */

/** Why a start failed, in a line: a refused setting by its name and what is wrong with it. */
function reasonOf(err: unknown): string {
  if (err instanceof ZodError) return err.issues.map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message)).join('; ');
  return err instanceof Error ? err.message : String(err);
}

/**
 * Checks the settings in `env` by doing with them what a function does when it starts: reads them,
 * and builds each route group's app, which loads the languages and the trust plugins and opens the
 * stores. Each app is closed again, and none takes a request. So there is one set of rules, the
 * server's own: what would stop a function from starting stops this, with the reason.
 *
 * It doesn't tell whether the settings are right, only that the server starts with them: an
 * Auth-Key that URLhaus refuses, say, passes. The compactor reads the same settings, less the few
 * that only functions are given.
 *
 * `opts.hot` is the hot store to use instead of Redis, which functions otherwise need.
 */
export async function checkSettings(env: NodeJS.ProcessEnv = process.env, opts: FunctionOptions = {}): Promise<Config> {
  try {
    const config = functionConfig(env);
    if (!opts.hot) requireRedis(config);
    const languages = loadLanguages(config.defaultLanguage);
    for (const group of GROUP_NAMES) {
      const fn = createFunction(group, config, { ...opts, server: { languages } });
      try {
        await fn.ready();
      } finally {
        await fn.close();
      }
    }
    return config;
  } catch (err) {
    throw new Error(`the functions would not start with these settings, so nothing was changed: ${reasonOf(err)}`, { cause: err });
  }
}

/** The whole step: the check, then the migrations and the admin account, which a check that fails keeps from running. */
export async function migrateDeployment(env: NodeJS.ProcessEnv = process.env, opts: FunctionOptions = {}): Promise<Deployed> {
  const config = await checkSettings(env, opts);
  const db = await createDb(config.db);
  try {
    await migrateToLatest(db);
    const admin = await bootstrapAdmin(db, env);
    return { migrated: true, dialect: config.db.dialect, ...(admin && { admin }) };
  } finally {
    await db.destroy();
  }
}
