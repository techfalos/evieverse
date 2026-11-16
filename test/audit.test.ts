import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { as, createTestContext, multipart, PNG, readAudit, store, storeText, TARGETS, type TestContext } from './helpers.js';

for (const target of TARGETS) {
  describe(`audit log (${target.name})`, () => {
    let ctx: TestContext;
    afterEach(async () => {
      await ctx.close();
    });

    it('writes down a post with everything the request said, and who sent it', async () => {
      ctx = await createTestContext(target, { audit: true });
      const user = await ctx.register('alice');
      const res = await store(ctx, user, { type: 'text', text: 'hello #audit', tags: ['audit'] });
      expect(res.statusCode, res.body).toBe(201);

      const records = (await readAudit(ctx)).filter((r) => r.route === '/store');
      expect(records).toHaveLength(1);
      const [record] = records;
      expect(record).toMatchObject({
        version: 1,
        method: 'POST',
        url: '/store',
        status: 201,
        userId: user.userId,
        time: new Date(ctx.clock.now).toISOString(),
        body: { type: 'text', text: 'hello #audit', tags: ['audit'], userId: user.userId },
        result: { contentId: res.json().contentId },
      });
      // One gzipped object per record, under its UTC hour.
      expect(record!.key).toMatch(/\/audit\/2026\/11\/06\/12\/\d+-[0-9a-f-]{36}\.json\.gz$/);
    });

    it('never writes down an API key', async () => {
      ctx = await createTestContext(target, { audit: true });
      const user = await ctx.register('alice');
      await storeText(ctx, user, 'with a key in the body #audit');
      const registered = await ctx.app.inject({ method: 'POST', url: '/register', payload: { username: 'bob' } });
      expect(registered.statusCode, registered.body).toBe(201);
      const replaced = await ctx.app.inject({ method: 'POST', url: `/users/${user.userId}/key`, headers: as(user), payload: {} });
      expect(replaced.statusCode, replaced.body).toBe(201);

      const records = await readAudit(ctx);
      expect(records.length).toBeGreaterThanOrEqual(3);
      const text = JSON.stringify(records);
      expect(text).not.toContain(user.apiKey);
      expect(text).not.toContain(registered.json().apiKey);
      expect(text).not.toContain(replaced.json().apiKey);
      const post = records.find((r) => r.route === '/store');
      expect((post!.body as { apiKey: string }).apiKey).toBe('[redacted]');
      // A new user's id is in the response only, so it is kept from there; the credentials of the response are not.
      expect(records.find((r) => r.route === '/register' && (r.body as { username: string }).username === 'bob')).toMatchObject({ userId: null, result: { userId: registered.json().userId } });
    });

    it('writes down updates and deletes, whatever their method', async () => {
      ctx = await createTestContext(target, { audit: true });
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const posted = await storeText(ctx, alice, 'to be deleted #audit');
      const { contentId } = posted.json();

      const calls = [
        { method: 'PATCH', url: `/users/${alice.userId}`, headers: as(alice), payload: { messages: false } },
        { method: 'PUT', url: `/users/${alice.userId}/following/${bob.userId}`, headers: as(alice) },
        { method: 'DELETE', url: `/users/${alice.userId}/following/${bob.userId}`, headers: as(alice) },
        { method: 'POST', url: '/like', payload: { ...bob, contentId } },
        { method: 'DELETE', url: `/content/${contentId}`, headers: as(alice) },
      ] as const;
      for (const call of calls) {
        const res = await ctx.app.inject(call);
        expect(res.statusCode, `${call.method} ${call.url}: ${res.body}`).toBeLessThan(300);
      }

      const records = await readAudit(ctx);
      for (const call of calls) {
        expect(records.some((r) => r.method === call.method && r.url === call.url), `${call.method} ${call.url}`).toBe(true);
      }
      expect(records.find((r) => r.method === 'PATCH')).toMatchObject({ userId: alice.userId, body: { messages: false } });
      expect(records.find((r) => r.method === 'DELETE' && r.route === '/content/:contentId')).toMatchObject({ userId: alice.userId, params: { contentId }, status: 202 });
    });

    it('does not write down reads', async () => {
      ctx = await createTestContext(target, { audit: true });
      const user = await ctx.register('alice');
      const res = await storeText(ctx, user, 'something to read #audit');
      const { contentId } = res.json();
      const before = await readAudit(ctx);

      const reads = [
        { method: 'GET', url: '/feed?tags=audit' },
        { method: 'GET', url: '/feed/following?userId=' + user.userId, headers: as(user) },
        { method: 'GET', url: `/content/${contentId}` },
        { method: 'GET', url: `/content/${contentId}/raw` },
        { method: 'GET', url: `/content/${contentId}/comments` },
        { method: 'GET', url: '/whoami', headers: as(user) },
        { method: 'GET', url: `/users/${user.userId}/inbox`, headers: as(user) },
        { method: 'GET', url: '/tags' },
        { method: 'GET', url: '/health' },
        { method: 'HEAD', url: '/health' },
        { method: 'OPTIONS', url: '/store' },
      ] as const;
      for (const read of reads) await ctx.app.inject(read);

      expect(await readAudit(ctx)).toHaveLength(before.length);
    });

    it('does not write down a request that changed nothing', async () => {
      ctx = await createTestContext(target, { audit: true });
      const user = await ctx.register('alice');
      const before = await readAudit(ctx);

      const refused = [
        { method: 'POST', url: '/store', payload: { ...user, type: 'text', text: 'no hashtags' } },
        { method: 'POST', url: '/store', headers: as({ userId: user.userId, apiKey: 'tu_000000000000_' + 'a'.repeat(43) }), payload: { type: 'text', text: 'x #audit' } },
        { method: 'POST', url: '/like', payload: { userId: user.userId, apiKey: user.apiKey, contentId: 'not-a-post' } },
        { method: 'POST', url: '/nowhere', payload: {} },
      ] as const;
      for (const call of refused) {
        const res = await ctx.app.inject(call);
        expect(res.statusCode, `${call.url}: ${res.body}`).toBeGreaterThanOrEqual(400);
      }

      expect(await readAudit(ctx)).toHaveLength(before.length);
    });

    it('writes down a multipart post with its fields and a description of its file, not the file', async () => {
      ctx = await createTestContext(target, { audit: true });
      const user = await ctx.register('alice');
      const mp = multipart({ ...user, type: 'image', tags: 'pics', text: 'a caption' }, { name: 'dot.png', type: 'image/png', data: PNG });
      const res = await ctx.app.inject({ method: 'POST', url: '/store', payload: mp.payload, headers: mp.headers });
      expect(res.statusCode, res.body).toBe(201);

      const [record] = (await readAudit(ctx)).filter((r) => r.route === '/store');
      expect(record).toMatchObject({
        userId: user.userId,
        result: { contentId: res.json().contentId },
        body: {
          multipart: true,
          fields: { type: 'image', tags: 'pics', text: 'a caption', userId: user.userId, apiKey: '[redacted]' },
          file: { filename: 'dot.png', mimeType: 'image/png', size: PNG.length },
        },
      });
      expect(JSON.stringify(record)).not.toContain(PNG.toString('base64'));
    });

    it('keeps a request body whole, however long', async () => {
      ctx = await createTestContext(target, { audit: true });
      const user = await ctx.register('alice');
      const text = `${'a long post, as text, '.repeat(1_700)} #audit`;
      const res = await storeText(ctx, user, text, { tags: ['audit'] });
      expect(res.statusCode, res.body).toBe(201);
      const [record] = (await readAudit(ctx)).filter((r) => r.route === '/store');
      expect((record!.body as { text: string }).text).toBe(text);
    });

    it('writes nothing, and changes nothing else, where no audit log is configured', async () => {
      ctx = await createTestContext(target);
      const user = await ctx.register('alice');
      const res = await storeText(ctx, user, 'no log for this #audit');
      expect(res.statusCode, res.body).toBe(201);
      expect(await readAudit(ctx)).toEqual([]);
    });

    it('answers a request that went through even if its record could not be written', async () => {
      ctx = await createTestContext(target);
      const user = await ctx.register('alice');
      const lost: string[] = [];
      const app = await buildApp(ctx, {
        logger: false,
        cli: null,
        audit: {
          write: async (record) => {
            lost.push(record.route ?? '');
            throw new Error('the bucket is gone');
          },
        },
      });
      try {
        const res = await app.inject({ method: 'POST', url: '/store', payload: { ...user, type: 'text', text: 'still posted #audit', tags: ['audit'] } });
        expect(res.statusCode, res.body).toBe(201);
        expect(lost).toEqual(['/store']);
        expect((await ctx.app.inject({ method: 'GET', url: `/content/${res.json().contentId}` })).statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });
  });
}
