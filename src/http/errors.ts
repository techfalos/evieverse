import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { UploadTooLargeError } from '../storage/spool.js';

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly details?: unknown,
    /** More top-level fields of the response. */
    public readonly extra?: Record<string, unknown>,
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);
export const unauthorized = (msg = 'Invalid userId or apiKey') => new HttpError(401, msg);
export const forbidden = (msg: string) => new HttpError(403, msg);
export const notFound = (msg: string) => new HttpError(404, msg);
export const conflict = (msg: string) => new HttpError(409, msg);
/** Nothing was done: the request has to be sent again with the challenge's solution. */
export const challengeRequired = (msg: string, challenge: unknown) => new HttpError(428, msg, undefined, { challenge });
export const tooManyRequests = (msg: string, retryAfterSeconds: number) =>
  new HttpError(429, msg, undefined, { retryAfterSeconds }, { 'retry-after': String(retryAfterSeconds) });

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      if (err.headers) reply.headers(err.headers);
      return reply.status(err.statusCode).send({ error: err.message, details: err.details, ...err.extra });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'Invalid request', details: err.issues });
    }
    if (err instanceof UploadTooLargeError) {
      return reply.status(413).send({ error: err.message });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.status(status).send({ error: (err as Error).message });
    }
    req.log.error({ err }, 'Unhandled error');
    return reply.status(500).send({ error: 'Internal server error' });
  });
}
