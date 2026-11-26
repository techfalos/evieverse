import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { migrateToLatest } from '../src/db/migrator.js';
import { checkSettings, migrateDeployment } from '../src/functions/deploy.js';
import { GROUP_NAMES, type GroupName } from '../src/functions/groups.js';
import { createFunction, functionConfig, type RouteFunction } from '../src/functions/handler.js';
import type { FunctionResponse } from '../src/functions/handler.types.js';
import { EDGE_SECRET_HEADER, httpApiHandler, runLambda, toRequest, toResult } from '../src/functions/lambdaRuntime.js';
import type { HttpApiEvent } from '../src/functions/lambdaRuntime.types.js';
import { loadLanguages } from '../src/language.js';
import type { Message } from '../src/language.types.js';
import { createHotStore } from '../src/storage/index.js';
import { startHarness } from './harness.js';
import { BASE_ENV, readAudit, solution, TEST_REDIS_URL } from './helpers.js';

/** A key prefix of a test's own in the tests' Redis, named after the directory the test keeps its files in. */
const keyPrefixOf = (dir: string) => `test:${dir.split('/').pop()}:`;

/**
 * The route groups as separate functions over one database file, one content directory and one
 * Redis, each with connections of its own, the way a deployment's functions share a database, a
 * bucket and a Redis.
 */
async function deployment() {
  const dir = await mkdtemp(join(tmpdir(), 'evieverse-fn-'));
  const clock = { now: Date.UTC(2026, 10, 6, 12) };
  const now = () => clock.now;
  const settings = {
    logLevel: 'silent',
    redis: { url: TEST_REDIS_URL, keyPrefix: keyPrefixOf(dir) },
    db: { dialect: 'sqlite', url: join(dir, 'db.sqlite'), poolSize: 2, migrateOnStart: false },
    storage: {
      content: { scheme: 'fs', options: { root: join(dir, 'content') } },
      summaries: { scheme: 'fs', options: { root: join(dir, 'summaries') } },
      tmpPath: join(dir, 'tmp'),
    },
    feed: { headCacheMs: 0 },
    // A proof of work quick enough for tests, and an answer accepted at once: the clock stands still here.
    challenge: { powBits: 8, minSolveMs: 0 },
    postRateLimitPerMinute: 0,
  };
  const config = loadConfig(settings, {});
  // The test's own connection to the functions' Redis: where it reads the challenges they ask for, and what it clears when it is done.
  const hot = createHotStore(config.redis);
  const opts = { now, server: { logger: false } };
  const fns = Object.fromEntries(GROUP_NAMES.map((group) => [group, createFunction(group, config, opts)])) as Record<GroupName, RouteFunction>;
  /** The compactor is no function: it is a process of its own beside them, over the same database and stores, with the same settings. */
  let beside: ReturnType<typeof startHarness> | undefined;
  const compact = async () => (await (beside ??= startHarness(dir, settings, clock))).runOnce();
  /** What a deploy does once, before any function runs. */
  const migrate = async () => {
    const db = await createDb(config.db);
    await migrateToLatest(db);
    await db.destroy();
  };
  const call = async (group: GroupName, method: string, url: string, body?: object) => {
    const res = await fns[group].handle({
      method,
      url,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body && Buffer.from(JSON.stringify(body)),
    });
    return { status: res.statusCode, json: () => JSON.parse(res.body.toString('utf8')) };
  };
  /** Registers as a person does: the request again, with the challenge it was answered with solved. */
  const register = async (username: string) => {
    const asked = await call('api', 'POST', '/register', { username });
    if (asked.status !== 428) return asked;
    return call('api', 'POST', '/register', { username, ...(await solution(hot, asked.json().challenge)) });
  };
  return {
    dir,
    config,
    clock,
    hot,
    fns,
    compact,
    migrate,
    call,
    register,
    async close() {
      for (const fn of Object.values(fns)) await fn.close();
      await (await beside)?.close();
      await hot.clear();
      await hot.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe('functions', () => {
  let d: Awaited<ReturnType<typeof deployment>>;
  afterEach(() => d?.close());

  it('gives functions settings for many short-lived instances, unless the environment says otherwise', () => {
    const base = BASE_ENV;
    expect(functionConfig(base)).toMatchObject({
      db: { migrateOnStart: false, poolSize: 2, idleTimeoutMs: 10_000 },
    });
    expect(functionConfig({ ...base, DB_POOL_SIZE: '5', DB_MIGRATE_ON_START: 'true', DB_IDLE_TIMEOUT_MS: '' }).db).toMatchObject({
      migrateOnStart: true,
      poolSize: 5,
      idleTimeoutMs: 10_000,
    });
    // The long-running server keeps migrating when it starts.
    expect(loadConfig({}, base).db).toMatchObject({ migrateOnStart: true, poolSize: 10 });
  });

  it('serves each route group from its own function, which together are the whole server', async () => {
    d = await deployment();
    await d.migrate();

    const registered = await d.register('alice');
    expect(registered.status).toBe(201);
    const alice = registered.json() as { userId: string; apiKey: string };
    // With a title: the deployment has the server's defaults, by which every post has one (POST_TITLES).
    const stored = await d.call('store', 'POST', '/store', { ...alice, type: 'text', title: 'Hello', text: 'hello from a function #news', tags: ['news'] });
    expect(stored.status).toBe(201);
    const { contentId } = stored.json();

    // In the feed once the compactor has run: stored by one function, queued in the database, indexed by another.
    const inFeed = async () => ((await d.call('feed', 'GET', '/feed?tags=news')).json().records as { contentId: string }[]).map((r) => r.contentId);
    expect(await inFeed()).toEqual([]);
    expect(await d.compact()).toEqual({ tags: [`@${alice.userId}`, 'news'], deleted: [], skipped: false });
    expect(await inFeed()).toEqual([contentId]);

    const content = await d.call('content', 'GET', `/content/${contentId}`);
    expect(content.status).toBe(200);
    expect(content.json()).toMatchObject({ contentId, text: 'hello from a function #news' });
    expect((await d.call('api', 'POST', '/like', { ...alice, contentId })).status).toBe(201);

    // Each function has its own routes and nobody else's.
    const routes: [GroupName, string, string][] = [
      ['feed', 'GET', '/feed?tags=news'],
      // The following feed isn't the feed function's: it asks the database who may read it.
      ['api', 'GET', `/feed/following?userId=${alice.userId}`],
      ['content', 'GET', `/content/${contentId}`],
      // What a repost on another server carries is read with the post, and the keys it is checked with are asked of the api function.
      ['content', 'GET', `/content/${contentId}/attestation`],
      ['api', 'GET', '/repost/keys'],
      // A later attestation of a post on another server is brought to the function that takes reposts.
      ['api', 'POST', '/repost/refresh'],
      ['store', 'POST', '/store'],
      ['store', 'POST', '/uploads'],
      ['api', 'POST', '/register'],
      ['api', 'DELETE', `/content/${contentId}`],
      ['api', 'GET', `/users/${alice.userId}`],
      ['api', 'GET', '/tagging'],
      // The rules are read by anyone, and from the database, which the feed function has none of.
      ['api', 'GET', '/rules'],
      // The server's ads are its admins', and so the api function's, though feeds and posts show them.
      ['api', 'GET', '/monetization/ads'],
    ];
    for (const [owner, method, url] of routes) {
      for (const group of GROUP_NAMES) {
        const { status } = await d.call(group, method, url, method === 'GET' ? undefined : {});
        if (group === owner) expect(status, `${method} ${url} on ${group}`).not.toBe(404);
        else expect(status, `${method} ${url} on ${group}`).toBe(404);
      }
    }
    for (const group of GROUP_NAMES) expect((await d.call(group, 'GET', '/health')).json()).toEqual({ ok: true });
    expect((await d.call('api', 'DELETE', `/content/${contentId}`, alice)).status).toBe(202);
    expect((await d.call('content', 'GET', `/content/${contentId}`)).status).toBe(404);
  });

  it('starts the feed function without the database, and the others without migrating it', async () => {
    d = await deployment();
    // Nothing has migrated the database: the file doesn't even exist.
    expect((await d.call('feed', 'GET', '/feed?tags=news')).status).toBe(200);
    expect((await d.call('api', 'GET', '/users/7b0e3a52-5f0c-4e06-9d6c-0d8b1f3f5a10')).status).toBe(500);
    await d.migrate();
    expect((await d.call('api', 'GET', '/users/7b0e3a52-5f0c-4e06-9d6c-0d8b1f3f5a10')).status).toBe(404);
  });

  it('refuses requests that did not come through the edge when given its secret, except health checks', async () => {
    d = await deployment();
    const fn = createFunction('feed', d.config, { server: { logger: false, edgeSecret: 's3cret' } });
    const get = async (url: string, headers: Record<string, string> = {}) => (await fn.handle({ method: 'GET', url, headers })).statusCode;
    try {
      expect(await get('/feed?tags=news')).toBe(403);
      expect(await get('/feed?tags=news', { [EDGE_SECRET_HEADER]: 'guess' })).toBe(403);
      expect(await get('/feed?tags=news', { [EDGE_SECRET_HEADER]: 's3cret' })).toBe(200);
      // The platform's probes call the container itself.
      expect(await get('/health')).toBe(200);
    } finally {
      await fn.close();
    }
  });

  it('tries to start again on the next request after a start that failed', async () => {
    d = await deployment();
    // This function migrates as it starts, and can't yet: where the database's directory goes, there is a file.
    const blocked = join(d.dir, 'later');
    await writeFile(blocked, '');
    const config = loadConfig({ ...d.config, db: { ...d.config.db, url: join(blocked, 'db.sqlite'), migrateOnStart: true } }, {});
    const fn = createFunction('api', config, { server: { logger: false } });
    const request = { method: 'GET', url: '/users/7b0e3a52-5f0c-4e06-9d6c-0d8b1f3f5a10', headers: {} };
    await expect(fn.handle(request)).rejects.toThrow();
    await expect(fn.ready()).rejects.toThrow();
    await rm(blocked);
    expect((await fn.handle(request)).statusCode).toBe(404);
    await fn.close();
  });
});

describe('Lambda adapter', () => {
  const event = (over: Partial<HttpApiEvent> = {}): HttpApiEvent => ({
    rawPath: '/feed',
    rawQueryString: 'tags=news&limit=5',
    headers: { host: 'api.example.com', 'x-forwarded-for': '203.0.113.9, 198.51.100.7' },
    requestContext: { http: { method: 'GET', sourceIp: '198.51.100.7' } },
    ...over,
  });

  it('reads an HTTP API request: path and query, body, cookies, and the peer as the remote address', () => {
    expect(toRequest(event())).toEqual({
      method: 'GET',
      url: '/feed?tags=news&limit=5',
      // The gateway's own entry is the peer; what is left is what the peer forwarded.
      headers: { host: 'api.example.com', 'x-forwarded-for': '203.0.113.9' },
      body: undefined,
      remoteAddress: '198.51.100.7',
    });
    const direct = toRequest(event({ headers: { 'x-forwarded-for': '198.51.100.7' } }));
    expect(direct.headers).toEqual({});
    // The peer is the entry the gateway added, whatever it calls the source: here the client, as it does behind CloudFront.
    const edge = toRequest(event({ headers: { 'x-forwarded-for': '10.9.9.9, 203.0.113.9, 198.51.100.7' }, requestContext: { http: { method: 'GET', sourceIp: '203.0.113.9' } } }));
    expect(edge).toMatchObject({ headers: { 'x-forwarded-for': '10.9.9.9, 203.0.113.9' }, remoteAddress: '198.51.100.7' });
    // With no such header, the source is all there is.
    expect(toRequest(event({ headers: {} }))).toMatchObject({ headers: {}, remoteAddress: '198.51.100.7' });

    const post = toRequest(
      event({
        rawPath: '/store',
        rawQueryString: '',
        headers: { 'content-type': 'application/json', 'content-length': '999' },
        cookies: ['a=1', 'b=2'],
        requestContext: { http: { method: 'POST' } },
        body: Buffer.from('{"type":"text"}').toString('base64'),
        isBase64Encoded: true,
      }),
    );
    expect(post).toMatchObject({ method: 'POST', url: '/store', headers: { 'content-type': 'application/json', cookie: 'a=1; b=2' }, remoteAddress: undefined });
    expect(post.headers['content-length']).toBeUndefined();
    expect(post.body?.toString()).toBe('{"type":"text"}');
  });

  it('encodes the path again, which the gateway gives decoded, and leaves the query string as it came', () => {
    const url = (rawPath: string, rawQueryString = '') => toRequest(event({ rawPath, rawQueryString })).url;
    // A hashtag sent with its "#" (%23): left as it came, the "#" would end the path at /tags/.
    expect(url('/tags/#news/moderators')).toBe('/tags/%23news/moderators');
    expect(url('/tags/#news/muted', 'limit=5&cursor=a%23b')).toBe('/tags/%23news/muted?limit=5&cursor=a%23b');
    expect(url('/tags/what?/moderators', 'limit=5')).toBe('/tags/what%3F/moderators?limit=5');
    expect(url('/tags/100%/moderators')).toBe('/tags/100%25/moderators');
    expect(url('/tags/caf\u00e9 au lait/moderators')).toBe('/tags/caf%C3%A9%20au%20lait/moderators');
    // What a path holds as it is stays as it is.
    expect(url("/cli/install.sh;v=1,2:3@4&5=6+7$8!9*'()~_-")).toBe("/cli/install.sh;v=1,2:3@4&5=6+7$8!9*'()~_-");
    expect(url('/users/7b0e3a52-5f0c-4e06-9d6c-0d8b1f3f5a10/inbox')).toBe('/users/7b0e3a52-5f0c-4e06-9d6c-0d8b1f3f5a10/inbox');
    // Half a surrogate pair has no encoding: the path goes on as it came.
    expect(url('/tags/\ud83d/moderators')).toBe('/tags/\ud83d/moderators');
  });

  it('answers with text as it is and anything else in base64', () => {
    const res = (headers: FunctionResponse['headers'], body: Buffer): FunctionResponse => ({ statusCode: 200, headers, body });
    const languages = loadLanguages();
    const say = (text: Message) => languages.render('en', text);
    expect(toResult(res({ 'content-type': 'application/json; charset=utf-8', 'set-cookie': ['a=1', 'b=2'], vary: ['origin', 'accept'] }, Buffer.from('{"ok":true}')), say)).toEqual({
      statusCode: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', vary: 'origin, accept' },
      cookies: ['a=1', 'b=2'],
      body: '{"ok":true}',
      isBase64Encoded: false,
    });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff]);
    expect(toResult(res({ 'content-type': 'image/png' }, png), say)).toMatchObject({ body: png.toString('base64'), isBase64Encoded: true });
    // Lambda can't return this much; the client is told so rather than left with a gateway error.
    const large = toResult(res({ 'content-type': 'video/mp4' }, Buffer.alloc(5 * 1024 * 1024)), say);
    expect(large.statusCode).toBe(500);
    expect(JSON.parse(large.body)).toEqual({ error: 'the response is too large for a function to return' });
  });

  it('counts a request by the address the gateway saw, and refuses one that did not come through the edge', async () => {
    const d = await deployment();
    try {
      await d.migrate();
      // One registration an hour from an address: it takes two requests. The audit log is where the
      // address a request is taken to come from is written down.
      const audit = join(d.dir, 'audit');
      const config = loadConfig({ ...d.config, trustProxy: 1, registerRateLimitPerHour: 2, audit: { scheme: 'fs', options: { root: audit } } }, {});
      // Over the deployment's Redis, where the challenges it asks for are read from to be solved.
      const fn = createFunction('api', config, { server: { logger: false } });
      const handler = httpApiHandler(fn, { edgeSecret: 's3cret' });
      const send = (body: object, client: string, headers: Record<string, string>) =>
        handler(
          event({
            rawPath: '/register',
            rawQueryString: '',
            // As the gateway sends it: what the client claimed, then the client as the edge saw it, then the edge.
            headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.9.9.9, ${client}, 198.51.100.7`, ...headers },
            requestContext: { http: { method: 'POST', sourceIp: '198.51.100.7' } },
            body: JSON.stringify(body),
          }),
        );
      /** Registers as a person does: the request again, from the same address, with the challenge it was answered with solved. */
      const register = async (username: string, client: string, headers: Record<string, string> = { [EDGE_SECRET_HEADER]: 's3cret' }) => {
        const asked = await send({ username }, client, headers);
        if (asked.statusCode !== 428) return asked;
        return send({ username, ...(await solution(d.hot, JSON.parse(asked.body).challenge)) }, client, headers);
      };
      try {
        expect((await register('alice', '203.0.113.1')).statusCode).toBe(201);
        expect((await register('bob', '203.0.113.1')).statusCode).toBe(429);
        expect((await register('carol', '203.0.113.2')).statusCode).toBe(201);
        expect((await register('dave', '203.0.113.3', {})).statusCode).toBe(403);
        expect((await register('erin', '203.0.113.3', { [EDGE_SECRET_HEADER]: 'guess' })).statusCode).toBe(403);
        expect((await handler({ Records: [] })).statusCode).toBe(400);
        // Behind CloudFront the gateway calls the client the source, and its own peer is still the header's last entry.
        const behindCloudFront = (username: string, client: string) =>
          handler(
            event({
              rawPath: '/register',
              rawQueryString: '',
              headers: { 'content-type': 'application/json', 'x-forwarded-for': `${client}, 198.51.100.8`, [EDGE_SECRET_HEADER]: 's3cret' },
              requestContext: { http: { method: 'POST', sourceIp: client } },
              body: JSON.stringify({ username }),
            }),
          );
        expect((await behindCloudFront('frank', '203.0.113.4')).statusCode).toBe(428);
        expect((await behindCloudFront('frank', '203.0.113.4')).statusCode).toBe(428);
        expect((await behindCloudFront('frank', '203.0.113.4')).statusCode).toBe(429);
        expect((await behindCloudFront('gina', '203.0.113.5')).statusCode).toBe(428);
        const records = await readAudit(d);
        expect(Object.fromEntries(records.map((r) => [(r.body as { username: string }).username, r.ip]))).toEqual({
          alice: '203.0.113.1',
          carol: '203.0.113.2',
        });
        // A hashtag in a path with its "#", which the gateway has decoded from %23 by the time it gets here.
        const moderators = await handler(event({ rawPath: '/tags/#News/moderators', rawQueryString: '', headers: { [EDGE_SECRET_HEADER]: 's3cret' } }));
        expect(moderators.statusCode).toBe(200);
        expect(JSON.parse(moderators.body)).toMatchObject({ tag: 'news', moderators: [] });
      } finally {
        await fn.close();
      }
    } finally {
      await d.close();
    }
  });

  /** A stand-in for the Lambda Runtime API that hands out `events` in turn, then leaves the runtime waiting. */
  async function runtimeApi(events: unknown[]) {
    const calls: { path: string; body: unknown; errorType?: string }[] = [];
    let waiting: (() => void) | undefined;
    const idle = new Promise<void>((resolve) => (waiting = resolve));
    let next = 0;
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const path = req.url!.replace('/2018-06-01/runtime', '');
        if (req.method === 'GET' && path === '/invocation/next') {
          if (next >= events.length) return waiting!();
          const id = `req-${next + 1}`;
          res.writeHead(200, { 'lambda-runtime-aws-request-id': id, 'lambda-runtime-deadline-ms': String(Date.now() + 30_000) });
          return res.end(JSON.stringify(events[next++]));
        }
        const text = Buffer.concat(chunks).toString('utf8');
        calls.push({ path, body: text ? JSON.parse(text) : undefined, errorType: req.headers['lambda-runtime-function-error-type'] as string | undefined });
        res.writeHead(202).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const api = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { api, calls, idle, close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve))) };
  }

  it('runs the Lambda runtime loop: an invocation at a time, its result or its error posted back', async () => {
    const runtime = await runtimeApi([{ n: 1 }, { n: 2 }, { n: 3 }]);
    const stop = new AbortController();
    const seen: unknown[] = [];
    let ready = false;
    const loop = runLambda(
      async (e, { requestId, deadline }) => {
        expect(ready).toBe(true);
        expect(deadline).toBeGreaterThan(Date.now());
        seen.push(e);
        if ((e as { n: number }).n === 2) throw new TypeError('bad invocation');
        return { requestId, echoed: e };
      },
      { api: runtime.api, signal: stop.signal, init: async () => void (ready = true), log: () => {} },
    );
    await runtime.idle;
    stop.abort();
    await loop;
    await runtime.close();

    expect(seen).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(runtime.calls).toEqual([
      { path: '/invocation/req-1/response', body: { requestId: 'req-1', echoed: { n: 1 } }, errorType: undefined },
      { path: '/invocation/req-2/error', body: expect.objectContaining({ errorMessage: 'bad invocation', errorType: 'TypeError' }), errorType: 'Unhandled' },
      { path: '/invocation/req-3/response', body: { requestId: 'req-3', echoed: { n: 3 } }, errorType: undefined },
    ]);
  });

  it('reports a function that could not start, and asks for no invocation', async () => {
    const runtime = await runtimeApi([{ n: 1 }]);
    const failing = runLambda(async () => 'never', { api: runtime.api, init: () => Promise.reject(new Error('no database')), log: () => {} });
    await expect(failing).rejects.toThrow('no database');
    await runtime.close();
    expect(runtime.calls).toEqual([{ path: '/init/error', body: expect.objectContaining({ errorMessage: 'no database' }), errorType: 'Unhandled' }]);
  });

  it('tells the deploy that invoked the migrate function which setting was refused, and stays up for the next try', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'evieverse-deploy-'));
    const runtime = await runtimeApi([{ image: 'a' }, { image: 'a' }]);
    const stop = new AbortController();
    // As lambda.ts runs it: the settings are read by each invocation, here a bad set and then a good one.
    const settings = [deploySettings(dir, { TRUST_OPTIONAL_PLUGINS: 'urlhouse' }), deploySettings(dir)];
    const loop = runLambda(() => migrateDeployment(settings.shift()!), { api: runtime.api, signal: stop.signal, log: () => {} });
    await runtime.idle;
    stop.abort();
    await loop;
    await runtime.close();
    await rm(dir, { recursive: true, force: true });

    expect(runtime.calls).toEqual([
      {
        path: '/invocation/req-1/error',
        body: expect.objectContaining({ errorMessage: expect.stringMatching(/^the functions would not start with these settings, so nothing was changed: TRUST_OPTIONAL_PLUGINS names urlhouse, which isn't one of the trust plugins this server was built with: it has blocked_words, pdq, urlhaus/) }),
        errorType: 'Unhandled',
      },
      { path: '/invocation/req-2/response', body: { migrated: true, dialect: 'sqlite' }, errorType: undefined },
    ]);
  });
});

/** The settings of a deployment as its migrate step is given them: in the environment, as the functions are. */
function deploySettings(dir: string, more: Record<string, string> = {}): Record<string, string> {
  return {
    ...BASE_ENV,
    REDIS_KEY_PREFIX: keyPrefixOf(dir),
    LOG_LEVEL: 'silent',
    DB_DIALECT: 'sqlite',
    DATABASE_URL: join(dir, 'db.sqlite'),
    CONTENT_SCHEME: 'fs',
    CONTENT_OPTIONS: JSON.stringify({ root: join(dir, 'content') }),
    STORAGE_TMP_PATH: join(dir, 'tmp'),
    ...more,
  };
}

describe('the deploy step', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'evieverse-deploy-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  /** The tables of the deployment's database: none until the step has migrated it. */
  const tables = async () => {
    const db = await createDb({ dialect: 'sqlite', url: join(dir, 'db.sqlite'), poolSize: 1 });
    try {
      return (await db.introspection.getTables()).map((table) => table.name);
    } finally {
      await db.destroy();
    }
  };

  it('starts every route group with the settings, and only then migrates and sets up the admin account', async () => {
    const admin = { userId: '7b0e3a52-5f0c-4e06-9d6c-0d8b1f3f5a10', username: 'root', keyHash: 'a'.repeat(64) };
    const env = deploySettings(dir, { BOOTSTRAP_ADMIN: JSON.stringify(admin), TRUST_OPTIONAL_PLUGINS: 'urlhaus', URLHAUS_AUTH_KEY: 'KEY' });
    expect(await tables()).toEqual([]);
    expect(await migrateDeployment(env)).toEqual({
      migrated: true,
      dialect: 'sqlite',
      admin: { userId: admin.userId, username: 'root', created: true, keyChanged: true, keyReplaced: false },
    });
    expect(await tables()).toContain('users');
    // Again, as every deploy that changes a setting runs it: nothing is left to do.
    expect(await migrateDeployment(env)).toMatchObject({ migrated: true, admin: { created: false, keyChanged: false } });
    expect(await checkSettings(env)).toMatchObject({ trust: { optionalPlugins: ['urlhaus'] }, db: { migrateOnStart: false } });
  });

  it('refuses settings a function would not start with, by name, and changes nothing', async () => {
    const refused: [Record<string, string>, RegExp][] = [
      // A typo in a plugin's name, which only loading the plugins finds.
      [{ TRUST_OPTIONAL_PLUGINS: 'urlhouse' }, /TRUST_OPTIONAL_PLUGINS names urlhouse, which isn't one of the trust plugins this server was built with: it has blocked_words, pdq, urlhaus/],
      [{ TRUST_OPTIONAL_PLUGINS: 'urlhaus' }, /TRUST_OPTIONAL_PLUGINS turns on urlhaus, which needs URLHAUS_AUTH_KEY/],
      // Settings that are refused when they are read.
      [{ TRUST_SCORE_DELETE_BELOW: '80' }, /TRUST_SCORE_DELETE_BELOW can be at most TRUST_SCORE_ALLOW_FROM/],
      [{ TAGGING_MODE: 'server' }, /TAGGING_SERVER_TAGS/],
      [{ MAX_UPLOAD_BYTES: 'lots' }, /storage\.maxUploadBytes: /],
      [{ CONTENT_OPTIONS: '{"root":' }, /Unexpected end of JSON input/],
      // A language the server has no file for, which only loading the languages finds.
      [{ DEFAULT_LANGUAGE: 'xx' }, /the default language is "xx" \(DEFAULT_LANGUAGE\)/],
      // A kind of store there isn't, which only opening the stores finds, and a proxy list only the app reads.
      [{ CONTENT_SCHEME: 's4' }, /scheme: s4/],
      [{ TRUST_PROXY: 'yes please' }, /invalid IP address: yes/],
    ];
    for (const [setting, why] of refused) {
      const failed = await migrateDeployment(deploySettings(dir, setting)).then(
        () => null,
        (err: Error) => err.message,
      );
      expect(failed, JSON.stringify(setting)).toMatch(/^the functions would not start with these settings, so nothing was changed: /);
      expect(failed, JSON.stringify(setting)).toMatch(why);
      expect(await tables(), JSON.stringify(setting)).toEqual([]);
    }
    // Every process shares one feed index, which Redis holds: settings that name no Redis are refused like the rest.
    await expect(checkSettings(deploySettings(dir, { REDIS_URL: '' }))).rejects.toThrow(/nothing was changed: redis\.url: REDIS_URL is not set/);
    expect(await tables()).toEqual([]);
  });
});
