import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { msg, type Text } from '../language.js';
import type { Message, MessageParams } from '../language.types.js';
import { UploadTooLargeError } from '../storage/spool.js';
import { say } from './language.js';

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    /** What the response says, which the error handler puts in the language the request is answered in. */
    public readonly text: Text,
    public readonly details?: unknown,
    /** More top-level fields of the response. */
    public readonly extra?: Record<string, unknown>,
    public readonly headers?: Record<string, string>,
  ) {
    // For logs, which are in no user's language: the message's key.
    super(typeof text === 'string' ? text : text.key);
  }
}

/** 400: a request the server can't take as it is. `details`, if there are any, go into the response as they are. */
export const badRequest = (text: Message, details?: unknown) => new HttpError(400, text, details);
/** 401: credentials that aren't a user's. It says they are invalid unless given other words, as a request that carries none is told they are required. */
export const unauthorized = (text: Message = msg('auth.invalid')) => new HttpError(401, text);
/** 403: the user is who they say, and may not do what the request asks. */
export const forbidden = (text: Message) => new HttpError(403, text);
/** 404: what the request is about isn't there. */
export const notFound = (text: Message) => new HttpError(404, text);
/** 409: a valid request that things as they are refuse: a username that is taken, a list that is full, a post that is being deleted. */
export const conflict = (text: Message) => new HttpError(409, text);
/** A valid request whose content moderation refuses. Its words may be a trust plugin's own. */
export const unprocessable = (text: Text, extra?: Record<string, unknown>) => new HttpError(422, text, undefined, extra);
/** Nothing was done: the request has to be sent again with the challenge's solution. */
export const challengeRequired = (text: Message, challenge: unknown) => new HttpError(428, text, undefined, { challenge });
/** 429: the user is past a rate limit. When to try again is said twice: `retryAfterSeconds` in the body, and the Retry-After header. */
export const tooManyRequests = (text: Message, retryAfterSeconds: number) =>
  new HttpError(429, text, undefined, { retryAfterSeconds }, { 'retry-after': String(retryAfterSeconds) });
/** 503: the server has as many such requests under way as it answers at a time, whoever sent them. When to try again is said as a 429 says it. */
export const busy = (text: Message, retryAfterSeconds: number) =>
  new HttpError(503, text, undefined, { retryAfterSeconds }, { 'retry-after': String(retryAfterSeconds) });

/**
 * Makes every error thrown while a request is handled a JSON response with an `error`: an
 * `HttpError` with its status, details, extra fields and headers, a zod error as 400 with its
 * issues as `details`, and an upload over the limit as 413, all in the language the request is
 * answered in; the framework's own refusals as it words them. Anything else is logged and answered
 * 500, which doesn't say what went wrong.
 */
export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      if (err.headers) reply.headers(err.headers);
      return reply.status(err.statusCode).send({ error: say(req, err.text), details: err.details, ...err.extra });
    }
    if (err instanceof ZodError) {
      // A schema's own message is a key of the language files (see messageKey), filled in with the issue's
      // `params`. The others are zod's, which says what is wrong with each field in English.
      const details = err.issues.map((issue) => {
        if (!app.languages.has(issue.message)) return issue;
        const { params, ...rest } = issue as typeof issue & { params?: MessageParams };
        return { ...rest, message: say(req, msg(issue.message, params)) };
      });
      return reply.status(400).send({ error: say(req, msg('error.invalid_request')), details });
    }
    if (err instanceof UploadTooLargeError) {
      return reply.status(413).send({ error: say(req, msg('error.upload_too_large', { limit: err.limit })) });
    }
    // The framework's own refusals (a body that isn't JSON, a route that isn't there), as it words them.
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.status(status).send({ error: (err as Error).message });
    }
    req.log.error({ err }, 'Unhandled error');
    return reply.status(500).send({ error: say(req, msg('error.internal')) });
  });
}
