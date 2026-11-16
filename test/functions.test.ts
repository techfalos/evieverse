import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCompactor } from '../src/compact/compactor.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { migrateToLatest } from '../src/db/migrator.js';
import { bootstrap } from '../src/deps.js';
import { GROUP_NAMES, type GroupName } from '../src/functions/groups.js';
import { createFunction, functionConfig, type FunctionResponse, type RouteFunction } from '../src/functions/handler.js';
import { EDGE_SECRET_HEADER, httpApiHandler, runLambda, toRequest, toResult, type HttpApiEvent } from '../src/functions/lambdaRuntime.js';
import { loadLanguages, type Message } from '../src/language.js';
import { MemoryHotStore } from '../src/storage/index.js';

/**
 * The route groups as separate functions over one database file, one content directory and one hot
 * store, the way a deployment's functions share a database, a bucket and a Redis.
 */
async function deployment() {
  const dir = await mkdtemp(join(tmpdir(), 'evieverse-fn-'));
  const clock = { now: Date.UTC(2026, 10, 6, 12) };
  const now = () => clock.now;
  const config = loadConfig(
    {
      logLevel: 'silent',
      db: { dialect: 'sqlite', url: join(dir, 'db.sqlite'), poolSize: 2, migrateOnStart: false },
      storage: {
        content: { scheme: 'fs', options: { root: join(dir, 'content') } },
        summaries: { scheme: 'fs', options: { root: join(dir, 'summaries') } },
        tmpPath: join(dir, 'tmp'),
      },
      feed: { headCacheMs: 0 },
      challenge: { register: false, postWindowSeconds: 0 },
      postRateLimitPerMinute: 0,
    },
    {},
  );
  const hot = new MemoryHotStore(now);
  const opts = { now, hot, server: { logger: false } };
  const fns = Object.fromEntries(GROUP_NAMES.map((group) => [group, createFunction(group, config, opts)])) as Record<GroupName, RouteFunction>;
  /** The compactor is no function: it is a process of its own beside them, over the same database and stores. */
  let beside: ReturnType<typeof bootstrap> | undefined;
  const compact = async () => createCompactor(await (beside ??= bootstrap(config, now, hot))).runOnce();
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
  return {
    dir,
    config,
    clock,
    fns,
    compact,
    migrate,
    call,
    async close() {
      for (const fn of Object.values(fns)) await fn.close();
      await (await beside)?.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe('functions', () => {
  let d: Awaited<ReturnType<typeof deployment>>;
  afterEach(() => d?.close());

  it('gives functions settings for many short-lived instances, unless the environment says otherwise', () => {
    const base = { EVIEVERSE_CONFIG: '/nonexistent.json' };
    expect(functionConfig(base)).toMatchObject({
      db: { migrateOnStart: false, poolSize: 2, idleTimeoutMs: 10_000 },
      compact: { inProcess: false },
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

    const registered = await d.call('api', 'POST', '/register', { username: 'alice' });
    expect(registered.status).toBe(201);
    const alice = registered.json() as { userId: string; apiKey: string };
    const stored = await d.call('store', 'POST', '/store', { ...alice, type: 'text', text: 'hello from a function #news', tags: ['news'] });
    expect(stored.status).toBe(201);
    const { contentId } = stored.json();

    // In the feed once the compactor has run: stored by one function, queued in the database, indexed by another.
    const inFeed = async () => ((await d.call('feed', 'GET', '/feed?tags=news')).json().tags.news ?? []).map((r: { contentId: string }) => r.contentId);
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
      ['store', 'POST', '/store'],
      ['store', 'POST', '/uploads'],
      ['api', 'POST', '/register'],
      ['api', 'DELETE', `/content/${contentId}`],
      ['api', 'GET', `/users/${alice.userId}`],
      ['api', 'GET', '/tagging'],
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
    const fn = createFunction('feed', d.config, { hot: new MemoryHotStore(), server: { logger: false, edgeSecret: 's3cret' } });
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
      const config = loadConfig({ ...d.config, trustProxy: 1, registerRateLimitPerHour: 1 }, {});
      const fn = createFunction('api', config, { server: { logger: false } });
      const handler = httpApiHandler(fn, { edgeSecret: 's3cret' });
      const register = (username: string, client: string, headers: Record<string, string> = { [EDGE_SECRET_HEADER]: 's3cret' }) =>
        handler(
          event({
            rawPath: '/register',
            rawQueryString: '',
            // As the gateway sends it: what the client claimed, then the client as the edge saw it, then the edge.
            headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.9.9.9, ${client}, 198.51.100.7`, ...headers },
            requestContext: { http: { method: 'POST', sourceIp: '198.51.100.7' } },
            body: JSON.stringify({ username }),
          }),
        );
      try {
        expect((await register('alice', '203.0.113.1')).statusCode).toBe(201);
        expect((await register('bob', '203.0.113.1')).statusCode).toBe(429);
        expect((await register('carol', '203.0.113.2')).statusCode).toBe(201);
        expect((await register('dave', '203.0.113.3', {})).statusCode).toBe(403);
        expect((await register('erin', '203.0.113.3', { [EDGE_SECRET_HEADER]: 'guess' })).statusCode).toBe(403);
        expect((await handler({ Records: [] })).statusCode).toBe(400);
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
});
