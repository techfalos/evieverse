import http from 'node:http';
import { loadLanguages, msg, type Languages } from '../language.js';
import type { Message } from '../language.types.js';
import { EDGE_SECRET_HEADER, sameSecret } from './edge.js';
import type { RouteFunction } from './handler.js';
import type { FunctionRequest, FunctionResponse } from './handler.types.js';
import type { HttpApiEvent, HttpApiResult, Invocation } from './lambdaRuntime.types.js';

export { EDGE_SECRET_HEADER };

/**
 * An HTTP API event as the request a function takes: the path with its query string, the body
 * decoded to bytes, and the cookies back in a `cookie` header. Content-Length and Transfer-Encoding
 * are dropped, as they were true of the body the gateway was sent. The peer the gateway saw is the
 * request's remote address, and is taken off the end of X-Forwarded-For, where the gateway put it.
 */
export function toRequest(event: HttpApiEvent): FunctionRequest {
  const headers: FunctionRequest['headers'] = { ...event.headers };
  if (event.cookies?.length) headers.cookie = event.cookies.join('; ');
  // The length is the decoded body's, whatever the gateway was sent.
  delete headers['content-length'];
  delete headers['transfer-encoding'];

  // The gateway appends the peer it saw to X-Forwarded-For. That peer becomes the request's remote
  // address instead, so the header lists what it would in front of a server: the hops before the peer.
  const peer = event.requestContext.http.sourceIp;
  const forwarded = headers['x-forwarded-for'];
  if (peer && typeof forwarded === 'string') {
    const hops = forwarded.split(',').map((hop) => hop.trim()).filter(Boolean);
    if (hops.at(-1) === peer) hops.pop();
    if (hops.length) headers['x-forwarded-for'] = hops.join(', ');
    else delete headers['x-forwarded-for'];
  }

  return {
    method: event.requestContext.http.method,
    url: `${event.rawPath}${event.rawQueryString ? `?${event.rawQueryString}` : ''}`,
    headers,
    body: event.body === undefined ? undefined : Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8'),
    remoteAddress: peer,
  };
}

/** Of the connection the app thinks it answers on, not of the response: the gateway sets its own. */
const CONNECTION_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length']);

/** `say` puts what this itself has to tell the client in the request's language (see httpApiHandler). */
export function toResult(res: FunctionResponse, say: (text: Message) => string): HttpApiResult {
  const headers: Record<string, string> = {};
  let cookies: string[] | undefined;
  for (const [name, value] of Object.entries(res.headers)) {
    if (name === 'set-cookie') cookies = Array.isArray(value) ? value : [value];
    else if (!CONNECTION_HEADERS.has(name)) headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  const text = !headers['content-encoding'] && /^text\/|[/+]json\b|[/+]xml\b|^application\/javascript\b/i.test(headers['content-type'] ?? '');
  const body = text ? res.body.toString('utf8') : res.body.toString('base64');
  // Lambda refuses a response over 6 MB; base64 makes a body a third larger.
  if (Buffer.byteLength(body) > 6 * 1024 * 1024 - 64 * 1024) {
    return json(500, { error: say(msg('function.response_too_large')) });
  }
  return { statusCode: res.statusCode, headers, ...(cookies && { cookies }), body, isBase64Encoded: !text };
}

/** A JSON response of the handler's own, which the app had no part in: `body` with the status `statusCode`. */
const json = (statusCode: number, body: object): HttpApiResult => ({
  statusCode,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify(body),
  isBase64Encoded: false,
});

/**
 * A route group's function as the handler of HTTP API events. With `edgeSecret`, requests that don't
 * carry it are refused: the gateway's own address is public, and a request sent straight to it could
 * otherwise name any client address it liked in X-Forwarded-For.
 *
 * What the handler answers by itself, without the app, it says in the language the request's
 * Accept-Language header asks for, of `languages`: by default the files of the languages folder.
 */
export function httpApiHandler(fn: Pick<RouteFunction, 'handle'>, opts: { edgeSecret?: string; languages?: Languages } = {}) {
  const languages = opts.languages ?? loadLanguages();
  return async (event: unknown): Promise<HttpApiResult> => {
    const e = event as HttpApiEvent;
    const say = (text: Message) => languages.render(languages.preferred(e?.headers?.['accept-language']) ?? languages.default, text);
    if (!e?.requestContext?.http?.method || typeof e.rawPath !== 'string') return json(400, { error: say(msg('function.not_http_api')) });
    if (opts.edgeSecret && !sameSecret(e.headers?.[EDGE_SECRET_HEADER], opts.edgeSecret)) return json(403, { error: say(msg('error.forbidden')) });
    const req = toRequest(e);
    delete req.headers[EDGE_SECRET_HEADER];
    return toResult(await fn.handle(req), say);
  };
}

/**
 * What the Lambda Runtime API answered one of `runLambda`'s calls. For the next invocation, its
 * id and its deadline are in the headers and its event is the body.
 */
interface RuntimeReply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/**
 * The Lambda runtime loop, for a container image without AWS's runtime client: asks the Runtime API
 * for the next invocation, runs `handler`, posts its result (or its error), and asks again. Between
 * invocations the instance is frozen inside the request for the next one, so that request has no timeout.
 *
 * `init` runs before the first invocation is asked for, within Lambda's start-up allowance; its
 * failure is reported and ends the process, so Lambda starts a fresh instance.
 */
export async function runLambda(
  handler: (event: unknown, invocation: Invocation) => Promise<unknown>,
  opts: { api?: string; init?: () => Promise<void>; signal?: AbortSignal; log?: (err: unknown, msg: string) => void } = {},
): Promise<void> {
  const api = opts.api ?? process.env.AWS_LAMBDA_RUNTIME_API;
  if (!api) throw new Error('AWS_LAMBDA_RUNTIME_API is not set: this entry point only runs inside Lambda');
  const base = `http://${api}/2018-06-01/runtime`;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const log = opts.log ?? ((err, msg) => console.error(JSON.stringify({ level: 'error', msg, err: describe(err) })));

  const call = (method: 'GET' | 'POST', path: string, body?: string, headers: Record<string, string> = {}) =>
    new Promise<RuntimeReply>((resolve, reject) => {
      const req = http.request(`${base}${path}`, { method, agent, signal: opts.signal, headers: { ...headers, ...(body !== undefined && { 'content-type': 'application/json' }) } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end(body);
    });
  const failure = (err: unknown) => JSON.stringify(describe(err));
  const errorHeaders = { 'lambda-runtime-function-error-type': 'Unhandled' };

  try {
    try {
      await opts.init?.();
    } catch (err) {
      log(err, 'the function could not start');
      await call('POST', '/init/error', failure(err), errorHeaders).catch(() => {});
      throw err;
    }

    while (!opts.signal?.aborted) {
      let next: RuntimeReply;
      try {
        next = await call('GET', '/invocation/next');
      } catch (err) {
        if (opts.signal?.aborted) return;
        // The connection can be cut while the instance is frozen; ask again.
        log(err, 'could not ask for the next invocation');
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      const requestId = String(next.headers['lambda-runtime-aws-request-id'] ?? '');
      if (next.status !== 200 || !requestId) {
        log(new Error(`the Runtime API answered ${next.status}`), 'could not read the next invocation');
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      const id = encodeURIComponent(requestId);
      let result: string;
      try {
        result = JSON.stringify(
          (await handler(JSON.parse(next.body.toString('utf8')), { requestId, deadline: Number(next.headers['lambda-runtime-deadline-ms']) || Date.now() })) ?? null,
        );
      } catch (err) {
        log(err, 'the invocation failed');
        await call('POST', `/invocation/${id}/error`, failure(err), errorHeaders).catch((e) => log(e, 'could not report the failure'));
        continue;
      }
      await call('POST', `/invocation/${id}/response`, result).catch((err) => log(err, 'could not send the response'));
    }
  } finally {
    agent.destroy();
  }
}

function describe(err: unknown) {
  const e = err instanceof Error ? err : new Error(String(err));
  return { errorMessage: e.message, errorType: e.name, stackTrace: (e.stack ?? '').split('\n').slice(1).map((line) => line.trim()) };
}
