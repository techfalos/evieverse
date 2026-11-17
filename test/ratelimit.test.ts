import { EventEmitter } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { setImmediate as tick, setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { atMostAtOnce } from '../src/http/concurrency.js';
import { busy } from '../src/http/errors.js';
import { msg } from '../src/language.js';
import type { TagFeedReader } from '../src/tagfeed/reader.js';
import { HOUR, MINUTE } from '../src/time.js';
import { as, createTestContext, TARGETS, type TestContext } from './helpers.js';

type App = TestContext['app'];

/** GET /feed, from the address a proxy says it came from, if one is given. It is sent at once, awaited or not. */
const read = (app: App, forwardedFor?: string, url = '/feed?tags=news') =>
  app.inject({ method: 'GET', url, headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {} }).then((res) => res);

/**
 * A feed reader with a gate in front: while it is shut, every feed asked of the reader waits there,
 * which is a request under way for as long as a test wants it to be. It is shut to begin with.
 * The feed of #through is never kept waiting.
 */
function gated(reader: TagFeedReader) {
  let shut = true;
  let changed = () => {};
  const waiting: (() => void)[] = [];
  return {
    reader: Object.assign(Object.create(reader) as TagFeedReader, {
      async view(tag: string) {
        if (shut && tag !== 'through') {
          await new Promise<void>((go) => {
            waiting.push(go);
            changed();
          });
        }
        return reader.view(tag);
      },
    }),
    /** Returns once `count` feeds wait at the gate. */
    async holds(count: number) {
      while (waiting.length < count) {
        await new Promise<void>((resolve) => {
          changed = resolve;
        });
      }
    },
    shut() {
      shut = true;
    },
    /** Lets the feeds that wait go on, and those that come after them pass. */
    open() {
      shut = false;
      for (const go of waiting.splice(0)) go();
    },
  };
}

/** Whether the next connection the app takes has closed, as the app sees it. */
const nextConnectionClosed = (app: App) => new Promise<void>((resolve) => app.server.once('connection', (socket) => socket.once('close', () => resolve())));

describe('TRUST_PROXY', () => {
  it('reads none, any, a number of proxies, or their addresses', () => {
    const read = (value?: string) => loadConfig({}, { EVIEVERSE_CONFIG: '/nonexistent.json', TRUST_PROXY: value }).trustProxy;
    expect(read()).toBe(false);
    expect(read('')).toBe(false);
    expect(read('false')).toBe(false);
    expect(read('true')).toBe(true);
    expect(read('2')).toBe(2);
    expect(read('10.0.0.0/8, 127.0.0.1')).toEqual(['10.0.0.0/8', '127.0.0.1']);
    expect(read('10.0.0.1')).toEqual(['10.0.0.1']);
  });
});

describe('atMostAtOnce', () => {
  it('gives a place back once, though a response and its connection both tell of the same close', async () => {
    const hooks = atMostAtOnce(1, () => busy(msg('feed.busy'), 1));
    const enter = hooks.preHandler as unknown as (req: unknown) => Promise<void>;
    const sending = hooks.onSend as unknown as (req: unknown, reply: unknown) => Promise<void>;
    const request = () => {
      const [socket, response] = [new EventEmitter(), new EventEmitter()];
      // As a server has it: a response learns that its connection closed from a listener of the connection's.
      socket.on('close', () => response.emit('close'));
      return { socket, response, req: { raw: { socket } }, reply: { raw: response } };
    };

    // A reader goes away while its response is being sent.
    const first = request();
    await enter(first.req);
    await sending(first.req, first.reply);
    expect([first.socket.listenerCount('close'), first.response.listenerCount('close')]).toEqual([2, 1]);
    first.socket.emit('close');
    // Nothing is left listening, on a connection that may carry more requests.
    expect([first.socket.listenerCount('close'), first.response.listenerCount('close')]).toEqual([1, 0]);

    // One place is free, not two.
    const [second, third] = [request(), request()];
    await enter(second.req);
    await expect(enter(third.req)).rejects.toMatchObject({ statusCode: 503 });
    // What is sent for a request that had no place gives none back.
    await sending(third.req, third.reply);
    await expect(enter(third.req)).rejects.toMatchObject({ statusCode: 503 });
    await sending(second.req, second.reply);
    second.response.emit('close');
    await enter(third.req);
  });

  it('is no hooks at all where no limit is set', () => {
    expect(atMostAtOnce(0, () => busy(msg('feed.busy'), 1))).toEqual({});
  });
});

for (const target of TARGETS) {
  describe(`shared limits (${target.name})`, () => {
    let ctx: TestContext;
    afterEach(() => ctx.close());

    /**
     * POST /register as a person sends it, which is two requests: the one answered with a challenge,
     * and the same again with the challenge solved. Returns the last response, whatever it is.
     */
    const register = async (app: TestContext['app'], username: string, forwardedFor?: string) => {
      const headers: Record<string, string> = forwardedFor ? { 'x-forwarded-for': forwardedFor } : {};
      const asked = await app.inject({ method: 'POST', url: '/register', payload: { username }, headers });
      if (asked.statusCode !== 428) return asked;
      return app.inject({ method: 'POST', url: '/register', payload: { username, ...(await ctx.solve(asked.json().challenge)) }, headers });
    };

    it('counts in the hot store, each counter lasting one window from its first count', async () => {
      ctx = await createTestContext(target);
      const counts = await Promise.all(Array.from({ length: 20 }, () => ctx.hot.incr('visits', 60_000)));
      expect(counts.map((c) => c.count).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      for (const c of counts) {
        expect(c.ttlMs).toBeGreaterThan(50_000);
        expect(c.ttlMs).toBeLessThanOrEqual(60_000);
      }
      expect((await ctx.hot.incr('other', 60_000)).count).toBe(1);

      // The window isn't pushed back by later counts.
      expect((await ctx.hot.incr('brief', 200)).count).toBe(1);
      if (target.hot === 'memory') ctx.clock.now += 150;
      else await sleep(150);
      const later = await ctx.hot.incr('brief', 200);
      expect(later.count).toBe(2);
      expect(later.ttlMs).toBeLessThanOrEqual(60);
      if (target.hot === 'memory') ctx.clock.now += 100;
      else await sleep(100);
      expect((await ctx.hot.incr('brief', 200)).count).toBe(1);
    });

    it('swaps a value in the hot store only for a caller that knows what it holds, so of concurrent swaps one wins', async () => {
      ctx = await createTestContext(target);
      const held = async () => (await ctx.hot.get('cell'))?.toString() ?? null;
      expect(await ctx.hot.swap('cell', 'a', 'b')).toBe(false);
      expect(await ctx.hot.swap('cell', null, 'a')).toBe(true);
      expect(await ctx.hot.swap('cell', null, 'b')).toBe(false);
      expect(await held()).toBe('a');

      const swaps = await Promise.all(Array.from({ length: 20 }, (_, i) => ctx.hot.swap('cell', 'a', `b${i}`)));
      expect(swaps.filter(Boolean)).toHaveLength(1);
      expect(await held()).toBe(`b${swaps.indexOf(true)}`);

      // Null deletes the key, and a time to live makes it expire.
      expect(await ctx.hot.swap('cell', 'a', null)).toBe(false);
      expect(await ctx.hot.swap('cell', await held(), null)).toBe(true);
      expect(await held()).toBeNull();
      expect(await ctx.hot.swap('cell', null, 'brief', 100)).toBe(true);
      if (target.hot === 'memory') ctx.clock.now += 150;
      else await sleep(150);
      expect(await held()).toBeNull();
    });

    it('adds one to a count the hot store has, and leaves one it does not have missing', async () => {
      ctx = await createTestContext(target);
      const held = async () => (await ctx.hot.get('tally'))?.toString() ?? null;
      expect(await ctx.hot.bump('tally')).toBeNull();
      expect(await held()).toBeNull();

      await ctx.hot.set('tally', '5', 200);
      const bumps = await Promise.all(Array.from({ length: 20 }, () => ctx.hot.bump('tally')));
      expect([...bumps].sort((a, b) => a! - b!)).toEqual(Array.from({ length: 20 }, (_, i) => i + 6));
      expect(await held()).toBe('25');

      // It keeps the time the count had left: it expires when it would have.
      if (target.hot === 'memory') ctx.clock.now += 250;
      else await sleep(250);
      expect(await ctx.hot.bump('tally')).toBeNull();
      expect(await held()).toBeNull();
    });

    it('limits registrations from one address across every server sharing the hot store', async () => {
      // Two registrations an hour: each takes two requests.
      ctx = await createTestContext(target, { registerRateLimitPerHour: 4 });
      // A second node, or another instance of a function: its own process state, the same Redis.
      const { app: _, ...deps } = ctx;
      const other = await buildApp({ ...deps, now: () => ctx.clock.now }, { logger: false, cli: null });
      try {
        const asked = await ctx.app.inject({ method: 'POST', url: '/register', payload: { username: 'alice' } });
        expect(asked.statusCode, asked.body).toBe(428);
        expect(asked.headers['x-ratelimit-remaining']).toBe('3');
        const first = await ctx.app.inject({ method: 'POST', url: '/register', payload: { username: 'alice', ...(await ctx.solve(asked.json().challenge)) } });
        expect(first.statusCode, first.body).toBe(201);
        expect(first.headers['x-ratelimit-remaining']).toBe('2');
        expect((await register(other, 'bob')).statusCode).toBe(201);
        for (const app of [ctx.app, other]) {
          const refused = await register(app, 'carol');
          expect(refused.statusCode).toBe(429);
          expect(Number(refused.headers['retry-after'])).toBeGreaterThan(3500);
        }
        // Other routes aren't counted with it.
        expect((await ctx.app.inject({ method: 'GET', url: `/users/${first.json().userId}` })).statusCode).toBe(200);

        if (target.hot === 'memory') {
          ctx.clock.now += HOUR;
          expect((await register(other, 'carol')).statusCode).toBe(201);
        }
      } finally {
        await other.close();
      }
    });

    it('counts by the client’s address behind proxies it is told to trust, and by the connection’s otherwise', async () => {
      // One registration an hour from an address.
      ctx = await createTestContext(target, { registerRateLimitPerHour: 2, trustProxy: 1 });
      // One proxy is trusted: the last address is the one it saw, whatever a client put before it.
      expect((await register(ctx.app, 'alice', '203.0.113.1')).statusCode).toBe(201);
      expect((await register(ctx.app, 'bob', '203.0.113.2')).statusCode).toBe(201);
      expect((await register(ctx.app, 'carol', '198.51.100.99, 203.0.113.2')).statusCode).toBe(429);
      await ctx.close();

      ctx = await createTestContext(target, { registerRateLimitPerHour: 2 });
      expect((await register(ctx.app, 'alice', '203.0.113.1')).statusCode).toBe(201);
      expect((await register(ctx.app, 'bob', '203.0.113.2')).statusCode).toBe(429);
    });

    it('limits feeds from one address across every server sharing the hot store', async () => {
      ctx = await createTestContext(target, { feed: { rateLimitPerMinute: 3 } });
      const { app: _, ...deps } = ctx;
      const other = await buildApp({ ...deps, now: () => ctx.clock.now }, { logger: false, cli: null });
      try {
        const first = await read(ctx.app);
        expect(first.statusCode, first.body).toBe(200);
        expect(first.headers['x-ratelimit-limit']).toBe('3');
        expect(first.headers['x-ratelimit-remaining']).toBe('2');
        expect((await read(other)).statusCode).toBe(200);
        // A request that is refused for what it asks is counted like any.
        expect((await read(ctx.app, undefined, '/feed?tags=')).statusCode).toBe(400);
        for (const app of [ctx.app, other]) {
          const refused = await read(app);
          expect(refused.statusCode).toBe(429);
          expect(refused.json()).toEqual({ error: 'Rate limit exceeded, retry in 1 minute' });
          expect(Number(refused.headers['retry-after'])).toBeGreaterThan(50);
          expect(Number(refused.headers['retry-after'])).toBeLessThanOrEqual(60);
          expect(refused.headers['x-ratelimit-remaining']).toBe('0');
        }
        // Whatever feed it asks for.
        expect((await read(other, undefined, '/feed?tags=sports,weather&hours=168&algorithm=chronological')).statusCode).toBe(429);

        // The following feed and the other reads aren't counted with it.
        const alice = await ctx.register('alice');
        for (const url of [`/feed/following?userId=${alice.userId}`, '/tags', `/users/${alice.userId}`, '/health']) {
          const res = await ctx.app.inject({ method: 'GET', url, headers: as(alice) });
          expect(res.statusCode, `${url} ${res.body}`).toBe(200);
          expect(res.headers['x-ratelimit-limit']).toBeUndefined();
        }

        if (target.hot === 'memory') {
          ctx.clock.now += MINUTE;
          const again = await read(other);
          expect(again.statusCode, again.body).toBe(200);
          expect(again.headers['x-ratelimit-remaining']).toBe('2');
        }
      } finally {
        await other.close();
      }
    });

    it('counts feeds by address: an IPv6 address with the rest of its /64, and an IPv4 address the same however it is written', async () => {
      // One feed a minute from an address, behind one proxy.
      ctx = await createTestContext(target, { feed: { rateLimitPerMinute: 1 }, trustProxy: 1 });
      const status = async (address: string) => (await read(ctx.app, address)).statusCode;
      expect(await status('203.0.113.1')).toBe(200);
      expect(await status('203.0.113.2')).toBe(200);
      expect(await status('203.0.113.1')).toBe(429);
      // What a client put before the proxy's own word doesn't count.
      expect(await status('198.51.100.99, 203.0.113.2')).toBe(429);

      // An IPv4 address written as an IPv6 one is that IPv4 address.
      expect(await status('::ffff:203.0.113.2')).toBe(429);
      expect(await status('::ffff:203.0.113.3')).toBe(200);
      expect(await status('203.0.113.3')).toBe(429);

      // A host has a whole /64 to send from, so it is the /64 that is counted.
      expect(await status('2001:db8:1:2::1')).toBe(200);
      expect(await status('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe(429);
      expect(await status('2001:DB8:1:2:0:0:0:9')).toBe(429);
      expect(await status('2001:db8:1:3::1')).toBe(200);
    });

    it('limits feeds by address only where a limit is set', async () => {
      ctx = await createTestContext(target, { feed: { rateLimitPerMinute: 0 } });
      for (let i = 0; i < 5; i++) {
        const res = await read(ctx.app);
        expect(res.statusCode, res.body).toBe(200);
        expect(res.headers['x-ratelimit-limit']).toBeUndefined();
      }
      // The setting is the server's own unless it is given another: 120 a minute.
      const { feed } = loadConfig({}, { EVIEVERSE_CONFIG: '/nonexistent.json' });
      expect([feed.rateLimitPerMinute, feed.maxConcurrent]).toEqual([120, 100]);
      const set = loadConfig({}, { EVIEVERSE_CONFIG: '/nonexistent.json', FEED_RATE_LIMIT_PER_MINUTE: '30', FEED_MAX_CONCURRENT: '0' }).feed;
      expect([set.rateLimitPerMinute, set.maxConcurrent]).toEqual([30, 0]);
    });

    describe('feeds at a time', () => {
      let started: App | undefined;
      afterEach(async () => {
        await started?.close();
        started = undefined;
      });

      /** A server that answers `max` feeds at a time, with a gate in front of its feed reader. */
      const start = async (max: number) => {
        ctx = await createTestContext(target, { feed: { maxConcurrent: max } });
        const { app: _, ...deps } = ctx;
        const gate = gated(ctx.feedReader);
        const app = await buildApp({ ...deps, feedReader: gate.reader, now: () => ctx.clock.now }, { logger: false, cli: null });
        started = app;
        return { app, gate };
      };

      /** That the app answers `max` feeds at a time, no fewer and no more: that many are let in, and the next is refused. */
      const answersAtATime = async (to: App, gate: ReturnType<typeof gated>, max: number) => {
        gate.shut();
        const sent = Array.from({ length: max }, () => read(to));
        await gate.holds(max);
        expect((await read(to)).statusCode).toBe(503);
        gate.open();
        for (const res of await Promise.all(sent)) expect(res.statusCode, res.body).toBe(200);
        await tick();
      };

      it('answers so many, and refuses the rest until one of them is answered', async () => {
        const { app, gate } = await start(2);
        const [first, second] = [read(app), read(app)];
        await gate.holds(2);

        const refused = await read(app);
        expect(refused.statusCode).toBe(503);
        expect(refused.headers['retry-after']).toBe('1');
        expect(refused.json()).toEqual({ error: 'the server is answering as many feeds as it can at once; try again in 1 second', retryAfterSeconds: 1 });
        // Whoever sends it: it isn't a limit on an address.
        expect((await read(app, '203.0.113.7')).statusCode).toBe(503);
        // The other routes are answered meanwhile.
        expect((await app.inject({ method: 'GET', url: '/tags' })).statusCode).toBe(200);

        gate.open();
        expect((await first).statusCode).toBe(200);
        expect((await second).statusCode).toBe(200);
        await tick();
        for (let i = 0; i < 5; i++) expect((await read(app)).statusCode).toBe(200);

        // A feed refused for what it asks, and one that is refused here, leave as many places as there were.
        expect((await read(app, undefined, '/feed?tags=')).statusCode).toBe(400);
        await answersAtATime(app, gate, 2);
        await answersAtATime(app, gate, 2);
      });

      it('answers as many as come where no limit is set', async () => {
        const { app, gate } = await start(0);
        const sent = Array.from({ length: 25 }, () => read(app));
        await gate.holds(25);
        gate.open();
        for (const res of await Promise.all(sent)) expect(res.statusCode, res.body).toBe(200);
      });

      it('keeps the place of a reader who went away until its feed is done, and then gives it back', async () => {
        const { app, gate } = await start(1);
        const address = await app.listen({ host: '127.0.0.1', port: 0 });
        const closed = nextConnectionClosed(app);
        const req = http.get(`${address}/feed?tags=news`);
        req.on('error', () => {});
        await gate.holds(1);
        req.destroy();
        await closed;
        await tick();
        // The feed is still being made, for nobody: that is work, so its place is taken.
        expect((await read(app)).statusCode).toBe(503);

        gate.open();
        await vi.waitFor(async () => expect((await read(app)).statusCode).toBe(200));
        await answersAtATime(app, gate, 1);

        // One whose reader stays is answered over the connection, and gives its place back as well.
        const res = await fetch(`${address}/feed?tags=news`);
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ count: 0, truncated: false });
        await vi.waitFor(async () => expect((await read(app)).statusCode).toBe(200));
        await answersAtATime(app, gate, 1);
      });

      it('gives back the places of feeds asked for one after another on a connection, answered or not', async () => {
        const { app, gate } = await start(2);
        await app.listen({ host: '127.0.0.1', port: 0 });
        const { port } = app.server.address() as net.AddressInfo;
        const pipelined = 'GET /feed?tags=news HTTP/1.1\r\nHost: localhost\r\n\r\n'.repeat(2);
        const connect = async () => {
          const socket = net.connect(port, '127.0.0.1');
          socket.on('error', () => {});
          await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
          return socket;
        };

        // Both are answered, the second once the first has been.
        let socket = await connect();
        let answers = '';
        socket.on('data', (chunk) => (answers += chunk.toString('latin1')));
        socket.write(pipelined);
        await gate.holds(2);
        expect((await read(app)).statusCode).toBe(503);
        gate.open();
        await vi.waitFor(() => expect(answers.match(/HTTP\/1\.1 200 OK/g)).toHaveLength(2));
        socket.destroy();
        await answersAtATime(app, gate, 2);

        // The connection closes while both are being made. The second's response never had the
        // connection, so nothing tells it that it closed.
        gate.shut();
        const closed = nextConnectionClosed(app);
        socket = await connect();
        socket.write(pipelined);
        await gate.holds(2);
        socket.destroy();
        await closed;
        await tick();
        expect((await read(app)).statusCode).toBe(503);
        gate.open();
        await vi.waitFor(async () => expect((await read(app)).statusCode).toBe(200));
        await answersAtATime(app, gate, 2);

        // The second is made while the first is still being: its response waits for the connection,
        // which closes before it gets it. Its place is free then, and the first one's isn't yet.
        gate.shut();
        const closedEarly = nextConnectionClosed(app);
        socket = await connect();
        socket.write('GET /feed?tags=news HTTP/1.1\r\nHost: localhost\r\n\r\nGET /feed?tags=through HTTP/1.1\r\nHost: localhost\r\n\r\n');
        await gate.holds(1);
        await vi.waitFor(async () => expect((await read(app)).statusCode).toBe(503));
        socket.destroy();
        await closedEarly;
        await tick();
        const next = read(app);
        await gate.holds(2);
        expect((await read(app)).statusCode).toBe(503);
        gate.open();
        expect((await next).statusCode).toBe(200);
        await vi.waitFor(async () => expect((await read(app)).statusCode).toBe(200));
        await answersAtATime(app, gate, 2);
      });
    });

    it('warns once of a forwarded address it was not told to trust', async () => {
      ctx = await createTestContext(target);
      const { app: _, ...deps } = ctx;
      /** What a server that trusts `trustProxy` proxies warns of, when feeds reach it from three forwarded addresses. */
      const logged = async (trustProxy: false | number) => {
        const lines: { level: number; msg: string }[] = [];
        const logger = { level: 'warn', stream: { write: (line: string) => void lines.push(JSON.parse(line)) } };
        const app = await buildApp({ ...deps, config: { ...ctx.config, trustProxy }, now: () => ctx.clock.now }, { logger, cli: null });
        try {
          expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
          for (const address of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) expect((await read(app, address)).statusCode).toBe(200);
        } finally {
          await app.close();
        }
        return lines.map((line) => line.msg);
      };
      const warnings = await logged(false);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/X-Forwarded-For.*TRUST_PROXY/);
      expect(await logged(0)).toHaveLength(1);
      expect(await logged(1)).toEqual([]);
    });
  });
}
