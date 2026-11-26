import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { BASE_ENV, createTestContext, TARGETS, type TestContext } from './helpers.js';

const APP = 'http://localhost:5173';

describe('CORS', () => {
  let ctx: TestContext;
  afterEach(async () => {
    await ctx.close();
  });

  const preflight = (origin: string, method: string, url: string) =>
    ctx.app.inject({
      method: 'OPTIONS',
      url,
      headers: { origin, 'access-control-request-method': method, 'access-control-request-headers': 'authorization,x-user-id,content-type' },
    });

  it('is off by default', async () => {
    ctx = await createTestContext(TARGETS[0]!);
    expect((await preflight(APP, 'POST', '/register')).statusCode).toBe(404);
    const res = await ctx.app.inject({ method: 'GET', url: '/health', headers: { origin: APP } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('lets pages on the listed origins call every route, with credentials in headers, and read errors', async () => {
    ctx = await createTestContext(TARGETS[0]!, { corsOrigins: [APP, 'https://app.example.com'] });
    const alice = await ctx.register('alice');

    const pre = await preflight(APP, 'PUT', `/users/${alice.userId}/following/${alice.userId}`);
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe(APP);
    expect(String(pre.headers['access-control-allow-methods']).split(/,\s*/)).toEqual(expect.arrayContaining(['PUT', 'PATCH', 'DELETE']));
    expect(pre.headers['access-control-allow-headers']).toBe('authorization,x-user-id,content-type');
    expect(pre.headers['access-control-max-age']).toBe('600');

    const feed = await ctx.app.inject({ method: 'GET', url: '/feed?tags=news', headers: { origin: 'https://app.example.com' } });
    expect(feed.statusCode).toBe(200);
    expect(feed.headers['access-control-allow-origin']).toBe('https://app.example.com');
    expect(feed.headers.vary).toContain('Origin');
    expect(feed.headers['access-control-expose-headers']).toContain('retry-after');

    const missing = await ctx.app.inject({ method: 'GET', url: '/content/00000000-0000-0000-0000-000000000000', headers: { origin: APP } });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['access-control-allow-origin']).toBe(APP);

    const other = await ctx.app.inject({ method: 'GET', url: '/feed?tags=news', headers: { origin: 'https://evil.example.com' } });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('lets any origin call it with *', async () => {
    ctx = await createTestContext(TARGETS[0]!, { corsOrigins: '*' });
    const res = await ctx.app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://anywhere.example.com' } });
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});

describe('CORS_ORIGINS', () => {
  const load = (CORS_ORIGINS: string) => loadConfig({}, { ...BASE_ENV, CORS_ORIGINS });

  it('reads origins separated by commas or spaces, without trailing slashes', () => {
    expect(load('http://localhost:5173/, https://app.example.com  https://APP.example.com').corsOrigins).toEqual([APP, 'https://app.example.com']);
    expect(load('https://app.example.com *').corsOrigins).toEqual(['*']);
    expect(loadConfig({}, BASE_ENV).corsOrigins).toEqual([]);
  });

  it('refuses anything but a scheme, host and port', () => {
    for (const bad of ['localhost:5173', 'app.example.com', 'ftp://app.example.com', 'https://app.example.com/path', 'https://app.example.com?x=1']) {
      expect(() => load(bad), bad).toThrow(/is not an origin/);
    }
  });
});
