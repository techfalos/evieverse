import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { say } from '../http/language.js';
import { msg } from '../language.js';

/** The header a CDN in front of the functions sends to prove a request came through it (see FUNCTION_EDGE_SECRET). */
export const EDGE_SECRET_HEADER = 'x-edge-secret';

/**
 * Whether `given`, a header's value, is `secret`: false for anything that isn't a string. Values
 * of the same length are compared in constant time, so how long it takes doesn't tell how much
 * matched.
 */
export function sameSecret(given: unknown, secret: string): boolean {
  const a = Buffer.from(typeof given === 'string' ? given : '');
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Refuses requests that don't carry the edge's secret. A function's own address is public, and a
 * request sent straight to it could otherwise name any client address it liked in X-Forwarded-For.
 * `/health` stays open: the platform's probes call the container itself, not the edge.
 * Call it before the routes are added, as hooks only apply to routes added after them.
 */
export function requireEdgeSecret(app: FastifyInstance, secret: string): void {
  app.addHook('onRequest', async (req, reply) => {
    if (req.routeOptions.url === '/health') return;
    if (!sameSecret(req.headers[EDGE_SECRET_HEADER], secret)) return reply.status(403).send({ error: say(req, msg('error.forbidden')) });
    delete req.headers[EDGE_SECRET_HEADER];
  });
}
