import type { FastifyInstance } from 'fastify';
import { buildApp, type AppOptions } from '../app.js';
import { loadConfig, type Config } from '../config.js';
import { bootstrap, bootstrapStores } from '../deps.js';
import type { HotStore } from '../storage/index.js';
import { GROUPS, type GroupName } from './groups.js';

/** An HTTP request as a function receives it, whatever the platform calls its parts. */
export interface FunctionRequest {
  method: string;
  /** Path and query string. */
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body?: Buffer;
  /** The peer the platform saw: the client, or the last proxy before the function (see TRUST_PROXY). */
  remoteAddress?: string;
}

export interface FunctionResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
}

export interface FunctionOptions {
  /** Injectable clock (UTC epoch ms). */
  now?: () => number;
  /** The hot store to use instead of the configured one: functions in one process sharing an in-memory store. */
  hot?: HotStore;
}

/** What a function's settings default to where the environment doesn't say (see functionConfig). */
const FUNCTION_DEFAULTS: NodeJS.ProcessEnv = {
  // A deploy migrates once (`npm run migrate`); instances starting together must not race to.
  DB_MIGRATE_ON_START: 'false',
  // An instance serves few requests at a time and there may be very many instances, so each holds
  // few connections, and gives them up soon after going idle.
  DB_POOL_SIZE: '2',
  DB_IDLE_TIMEOUT_MS: '10000',
  // The compactor is a process that stays up, which a function isn't: it is deployed beside them.
  COMPACT_IN_PROCESS: 'false',
};

/** The settings of a function: the environment's, over defaults that suit many short-lived instances. */
export function functionConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const merged = { ...env };
  for (const [name, value] of Object.entries(FUNCTION_DEFAULTS)) if (!merged[name]) merged[name] = value;
  return loadConfig({}, merged);
}

/**
 * One route group as a function, for any platform: the app is built once per instance, on the first
 * request (or by `ready()`, where the platform gives time to start), and each request passed through
 * it without a socket. A group that doesn't use the database never connects to it.
 */
export function createFunction(group: GroupName, config: Config = functionConfig(), opts: FunctionOptions & { server?: AppOptions } = {}) {
  let starting: Promise<{ app: FastifyInstance; close(): Promise<void> }> | undefined;
  const start = async () => {
    const deps = GROUPS[group].database ? await bootstrap(config, opts.now, opts.hot) : bootstrapStores(config, opts.now, opts.hot);
    try {
      const app = await buildApp(deps, opts.server, [group]);
      await app.ready();
      return { app, close: deps.close };
    } catch (err) {
      await deps.close().catch(() => {});
      throw err;
    }
  };
  const started = () => {
    // A start that failed (the database was unreachable, say) is tried again by the next request.
    starting ??= start().catch((err) => {
      starting = undefined;
      throw err;
    });
    return starting;
  };

  return {
    group,
    async ready(): Promise<void> {
      await started();
    },
    async handle(req: FunctionRequest): Promise<FunctionResponse> {
      const { app } = await started();
      const res = await app.inject({
        method: req.method as 'GET',
        url: req.url,
        headers: req.headers,
        payload: req.body,
        remoteAddress: req.remoteAddress,
      });
      const headers: FunctionResponse['headers'] = {};
      for (const [name, value] of Object.entries(res.headers)) {
        if (value !== undefined) headers[name] = Array.isArray(value) ? value : String(value);
      }
      return { statusCode: res.statusCode, headers, body: res.rawPayload };
    },
    async close(): Promise<void> {
      const running = await starting?.catch(() => undefined);
      starting = undefined;
      await running?.app.close();
      await running?.close();
    },
  };
}

export type RouteFunction = ReturnType<typeof createFunction>;
