import type { FastifyRateLimitStore, FastifyRateLimitStoreCtor } from '@fastify/rate-limit';
import type { HotStore } from '../storage/index.js';

/**
 * What a route is registered with to be limited to `max` requests a minute from one address
 * (`{ config: perMinute(max) }`): the plugin counts them by the client's address (see app.ts),
 * for this route alone, and refuses one more (429) before the route reads anything. 0: no limit.
 */
export const perMinute = (max: number) => ({ rateLimit: max > 0 ? { max, timeWindow: '1 minute' } : (false as const) });

/**
 * Where @fastify/rate-limit counts requests: in the hot store rather than in each process, so a
 * limit holds across every node and function instance (in memory when there is no Redis, which is a
 * single node anyway). A route's counters are its own; each lasts one time window from its first request.
 */
export function rateLimitStore(hot: HotStore): FastifyRateLimitStoreCtor {
  return class HotRateLimitStore implements FastifyRateLimitStore {
    constructor(
      _options: unknown,
      private readonly prefix = 'limit:',
    ) {}

    incr(key: string, callback: (error: Error | null, result?: { current: number; ttl: number }) => void, timeWindow: number) {
      hot.incr(`${this.prefix}${key}`, timeWindow).then(
        ({ count, ttlMs }) => callback(null, { current: count, ttl: ttlMs }),
        (err) => callback(err instanceof Error ? err : new Error(String(err))),
      );
    }

    /** The plugin passes a route's merged limit options, with the route itself as `routeInfo`. */
    child(options: unknown) {
      const { method, url } = (options as { routeInfo?: { method?: string | string[]; url?: string } }).routeInfo ?? {};
      return new HotRateLimitStore(options, `limit:${[method].flat().join(',')} ${url ?? ''}:`);
    }
  };
}
