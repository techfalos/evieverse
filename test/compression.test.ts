import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { createFunction } from '../src/functions/handler.js';
import { httpApiHandler } from '../src/functions/lambdaRuntime.js';
import { as, createTestContext, post, readAudit, TARGETS, type TestContext, type User } from './helpers.js';

/** What a browser sends. */
const BROWSER = 'gzip, deflate, br, zstd';

/** A text of about `words` words, none of them the same sentence twice, so it compresses as writing does and not as a repeat. */
const prose = (words: number, about: string) =>
  Array.from({ length: Math.ceil(words / 8) }, (_, i) => `Sentence ${i + 1} of ${about} says something of its own.`).join(' ');

describe('response compression', () => {
  let ctx: TestContext;
  afterEach(async () => {
    await ctx.close();
  });

  const get = (url: string, acceptEncoding?: string, user?: User) =>
    ctx.app.inject({ method: 'GET', url, headers: { ...(acceptEncoding !== undefined && { 'accept-encoding': acceptEncoding }), ...(user && as(user)) } });

  /** A server with a page of posts under #news, in feeds. */
  async function setup(opts: Parameters<typeof createTestContext>[1] = {}) {
    ctx = await createTestContext(TARGETS[0]!, opts);
    const alice = await ctx.register('alice');
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      ctx.clock.now += 1000;
      ids.push(await post(ctx, alice, `${prose(80, `post ${i}`)} #news`, { comments: true }));
    }
    await ctx.compact();
    return { alice, ids };
  }

  // No fresh slots, which a session's seed orders: the same request gets the same page.
  const FEED = '/feed?tags=news&algorithm=chronological';

  it('sends a feed gzipped to a client that takes it, and the same feed as it is to one that says nothing', async () => {
    await setup();
    const plain = await get(FEED);
    expect(plain.statusCode, plain.body).toBe(200);
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.json().count).toBe(12);

    // Gzip, whichever the client names first: it is the server that chooses between the two.
    for (const accepted of [BROWSER, 'br, gzip', 'gzip']) {
      const compressed = await get(FEED, accepted);
      expect(compressed.statusCode, accepted).toBe(200);
      expect(compressed.headers['content-encoding'], accepted).toBe('gzip');
      expect(compressed.headers['content-type']).toBe('application/json; charset=utf-8');
      // A cache between the two must not give one client's encoding to another.
      expect(String(compressed.headers.vary).toLowerCase()).toContain('accept-encoding');
      expect(JSON.parse(gunzipSync(compressed.rawPayload).toString('utf8'))).toEqual(plain.json());
      expect(compressed.rawPayload.length).toBeLessThan(plain.rawPayload.length / 2);
    }
  });

  it('sends Brotli to a client that takes only that, or likes it better, and nothing compressed to one that takes neither', async () => {
    await setup();
    const plain = await get(FEED);

    for (const accepted of ['br', 'br, gzip;q=0.5']) {
      const compressed = await get(FEED, accepted);
      expect(compressed.headers['content-encoding'], accepted).toBe('br');
      expect(String(compressed.headers.vary).toLowerCase()).toContain('accept-encoding');
      expect(JSON.parse(brotliDecompressSync(compressed.rawPayload).toString('utf8'))).toEqual(plain.json());
      expect(compressed.rawPayload.length).toBeLessThan(plain.rawPayload.length / 2);
    }

    for (const accepted of ['deflate', 'identity', 'br;q=0, gzip;q=0']) {
      const res = await get(FEED, accepted);
      expect(res.statusCode, accepted).toBe(200);
      expect(res.headers['content-encoding'], accepted).toBeUndefined();
      expect(res.json(), accepted).toEqual(plain.json());
    }
  });

  it('compresses a response that is not streamed too, and leaves one under a kilobyte as it is', async () => {
    const { ids } = await setup();
    const url = `/content/${ids[0]}`;
    const plain = await get(url);
    expect(plain.rawPayload.length).toBeGreaterThan(1024);
    const compressed = await get(url, BROWSER);
    expect(compressed.headers['content-encoding']).toBe('gzip');
    expect(JSON.parse(gunzipSync(compressed.rawPayload).toString('utf8'))).toEqual(plain.json());

    const health = await get('/health', BROWSER);
    expect(health.headers['content-encoding']).toBeUndefined();
    expect(health.json()).toEqual({ ok: true });
    // An error is a response like any other, and a short one.
    const missing = await get('/content/00000000-0000-0000-0000-000000000000', BROWSER);
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['content-encoding']).toBeUndefined();
    expect(missing.json().error).toEqual(expect.any(String));
  });

  it('sends a post’s bytes as they are stored, with their size, whatever the client takes', async () => {
    const { alice } = await setup();
    // Text, and well over a kilobyte: what would be compressed if the route didn't say otherwise.
    const text = `${prose(400, 'a long post')} #news`;
    expect(Buffer.byteLength(text)).toBeGreaterThan(2048);
    const contentId = await post(ctx, alice, text);

    const res = await get(`/content/${contentId}/raw`, BROWSER);
    expect(res.statusCode, res.body).toBe(200);
    expect(String(res.headers['content-type'])).toMatch(/^text\/plain/);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.headers.vary).toBeUndefined();
    expect(res.body).toBe(text);
    expect(res.headers['content-length']).toBe(String(Buffer.byteLength(text)));
  });

  it('writes down the ids a compressed response named: the audit log reads the response before it is compressed', async () => {
    const { ids } = await setup({ audit: true });
    const bob = await ctx.register('bob');
    const text = prose(200, 'a comment');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/content/${ids[0]}/comments`,
      headers: { ...as(bob), 'accept-encoding': BROWSER },
      payload: { text },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.headers['content-encoding']).toBe('gzip');
    const comment = JSON.parse(gunzipSync(res.rawPayload).toString('utf8')) as { commentId: string; text: string };
    expect(comment.text).toBe(text);

    const records = (await readAudit(ctx)).filter((r) => r.route === '/content/:contentId/comments');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: 201, userId: bob.userId, body: { text }, result: { commentId: comment.commentId } });
  });

  it('answers through the Lambda adapter in base64, which is how a function returns bytes', async () => {
    await setup();
    // The feed's function over the server's own stores, as a deployment's functions share them.
    const fn = createFunction('feed', ctx.config, { now: () => ctx.clock.now, hot: ctx.hot, server: { logger: false } });
    try {
      const handler = httpApiHandler(fn);
      const ask = (headers: Record<string, string>) =>
        handler({ rawPath: '/feed', rawQueryString: 'tags=news&algorithm=chronological', headers, requestContext: { http: { method: 'GET' } } });

      const plain = await ask({});
      expect(plain).toMatchObject({ statusCode: 200, isBase64Encoded: false });
      expect(plain.headers['content-encoding']).toBeUndefined();

      const compressed = await ask({ 'accept-encoding': 'br,gzip' });
      expect(compressed).toMatchObject({ statusCode: 200, isBase64Encoded: true });
      expect(compressed.headers['content-encoding']).toBe('gzip');
      expect(JSON.parse(gunzipSync(Buffer.from(compressed.body, 'base64')).toString('utf8'))).toEqual(JSON.parse(plain.body));
      // Smaller on the way out of the function too, base64 and all.
      expect(compressed.body.length).toBeLessThan(plain.body.length / 2);
    } finally {
      await fn.close();
    }
  });
});
