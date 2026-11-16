import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { Challenges } from './challenge/challenges.js';
import type { Db } from './db/index.js';
import type { RouteDeps, StoreDeps } from './deps.js';
import { requireEdgeSecret } from './functions/edge.js';
import { GROUP_NAMES, GROUPS, type GroupName } from './functions/groups.js';
import { HttpError, registerErrorHandler } from './http/errors.js';
import { registerLanguages } from './http/language.js';
import { rateLimitStore } from './http/rateLimitStore.js';
import { loadLanguages, msg, type Languages } from './language.js';
import { loadTrustPlugins, type TrustPlugin } from './moderation/trust.js';
import { loadCliRelease, requireCliBuild, type CliRelease } from './routes/cli.js';
import { contentWriter } from './write.js';

export interface AppOptions extends FastifyServerOptions {
  /** Refuse requests that don't carry this in X-Edge-Secret (functions/edge.ts). */
  edgeSecret?: string;
  /** The CLI the server ships, or null for none. By default, the one built with it, if it was (routes/cli.ts). */
  cli?: CliRelease | null;
  /** The trust plugins, in the order they run. By default, the folders of src/plugins/trust (moderation/trust.ts). */
  trustPlugins?: TrustPlugin[];
  /** The languages the server answers in. By default, the files of src/languages (language.ts). */
  languages?: Languages;
}

/**
 * The app serving `groups` of routes (src/functions/groups.ts): all of them for the long-running
 * server, one for a function. Only groups that use the database need `deps.db`.
 */
export async function buildApp(
  deps: StoreDeps & { db?: Db },
  { edgeSecret, cli = loadCliRelease(), trustPlugins, languages, ...opts }: AppOptions = {},
  groups: readonly GroupName[] = GROUP_NAMES,
) {
  const { trustProxy } = deps.config;
  // Loaded before anything else: a language file that can't be read stops the app here, not at the first error it has to word.
  languages ??= loadLanguages(deps.config.defaultLanguage);
  const app = Fastify({
    logger: { level: deps.config.logLevel },
    // Fastify trusts no one when given a count, as a count can't tell a proxy from a client that
    // connects directly; behind a gateway that is the only way in, counting hops is what there is.
    trustProxy: typeof trustProxy === 'number' ? (_address: string, hop: number) => hop < trustProxy : trustProxy,
    ...opts,
  });

  // First, so that whatever refuses a request after this does it in the request's language.
  registerLanguages(app, languages);
  app.log.info({ languages: languages.list().map((language) => language.code), default: languages.default }, 'languages loaded');
  for (const { code, keys } of languages.missing()) {
    app.log.warn({ language: code, missing: keys }, `the language ${code} lacks messages, which are said in ${languages.default} instead`);
  }
  registerErrorHandler(app);
  if (edgeSecret) requireEdgeSecret(app, edgeSecret);
  // In every group, so an out-of-date CLI is told so whichever function its request reaches.
  if (cli) requireCliBuild(app, cli);
  const { corsOrigins } = deps.config;
  if (corsOrigins.length > 0) {
    await app.register(cors, {
      origin: corsOrigins.includes('*') ? '*' : corsOrigins,
      // The plugin allows only GET, HEAD and POST unless told otherwise.
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
      exposedHeaders: ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'content-disposition'],
      maxAge: 600,
    });
  }
  await app.register(rateLimit, {
    global: false,
    store: rateLimitStore(deps.hot),
    // The plugin's own words are English only. It sets Retry-After itself.
    errorResponseBuilder: (_req, { statusCode, ttl }) => new HttpError(statusCode, msg('error.rate_limited', { count: Math.max(1, Math.ceil(ttl / 60_000)) })),
  });
  await app.register(multipart, {
    limits: {
      fileSize: deps.config.storage.maxUploadBytes,
      files: 1,
      fields: 20,
      fieldSize: 32 * 1024 * 1024,
    },
  });

  app.get('/health', async () => ({ ok: true }));
  const { db } = deps;
  const writing: RouteDeps | undefined = db && {
    ...deps,
    db,
    cli,
    challenges: new Challenges(deps),
    writer: contentWriter({ ...deps, db }, app.log),
    // Loaded once, as the app starts: a plugin that can't be loaded stops it there, not at the first post.
    trustPlugins: trustPlugins ?? (await loadTrustPlugins()),
  };
  if (writing) app.log.info({ trustPlugins: writing.trustPlugins.map((plugin) => plugin.name) }, 'trust plugins loaded');
  for (const name of new Set(groups)) {
    const group = GROUPS[name];
    if (!group.database) group.register(app, deps);
    else if (writing) group.register(app, writing);
    else throw new Error(`the ${name} routes need the database`);
  }

  return app;
}
