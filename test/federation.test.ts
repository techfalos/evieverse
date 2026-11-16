import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, hashtags, multipart, TARGETS, type TestContext } from './helpers.js';

// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const ORIGIN = 'https://a.example/api';

type User = { userId: string; apiKey: string };
type Item = {
  contentId: string;
  version: number;
  origin?: { server: string; contentId: string; version: number };
  preview: { kind: string; text?: string; url?: string };
  tags: string[];
  likes: number;
  createdAt: string;
};
type Feed = { days: { tags: Record<string, Item[]> }[] };

for (const target of TARGETS) {
  describe(`federation (${target.name})`, () => {
    // Content is stored on a, which federates it to b; b listens on a port, since a sends real requests.
    let a: TestContext;
    let b: TestContext;
    let bUrl: string;
    beforeEach(async () => {
      a = await createTestContext(TARGETS[0]!, { publicBaseUrl: ORIGIN });
      b = await createTestContext(target);
      bUrl = await b.app.listen({ host: '127.0.0.1', port: 0 });
    });
    afterEach(async () => {
      await a.close();
      await b.close();
    });

    const tick = (ms: number) => {
      a.clock.now += ms;
      b.clock.now = a.clock.now;
    };
    const store = (user: User, text: string, extra: Record<string, unknown> = {}) =>
      a.app.inject({ method: 'POST', url: '/store', payload: { ...user, type: 'text', text, tags: hashtags(text), ...extra } });
    const items = async (ctx: TestContext, tag: string) => {
      const res = await ctx.app.inject({ method: 'GET', url: `/feed?tags=${tag}` });
      expect(res.statusCode, res.body).toBe(200);
      return (res.json() as Feed).days.flatMap((d) => d.tags[tag] ?? []);
    };
    const federated = (body: Record<string, unknown>) => b.app.inject({ method: 'POST', url: '/federated', payload: body });
    const bytesOnB = (contentId: string, version: number) => existsSync(join(b.dir, 'content', 'content', contentId, String(version)));

    it('sends the feed record but not the bytes, and the server indexes it under the user there, linked to the origin', async () => {
      const alice = await a.register('alice');
      const bAlice = await b.register('alice_b', 'https://alice.b.example');
      const servers = [{ serverAddress: `${bUrl}/`, serverUser: 'alice_b', serverKey: bAlice.apiKey }];
      const res = await store(alice, 'Flooding closes roads in central Mumbai. #news #mumbai', { aiGenerated: true, federated_servers: servers });
      expect(res.statusCode, res.body).toBe(201);
      const stored = res.json();
      expect(stored.federated).toEqual([{ serverAddress: bUrl, ok: true, status: 201, contentId: expect.any(String), version: 1 }]);
      const copy = stored.federated[0].contentId as string;
      expect(copy).not.toBe(stored.contentId);

      const origin = { server: ORIGIN, contentId: stored.contentId, version: 1 };
      const expected = {
        contentId: copy,
        version: 1,
        publisher: { userId: bAlice.userId, username: 'alice_b', publisherUrl: 'https://alice.b.example' },
        origin,
        mimeType: 'text/plain',
        aiGenerated: true,
        preview: stored.preview,
        tags: ['news', 'mumbai'],
        likes: 0,
        createdAt: new Date(a.clock.now).toISOString(),
        updatedAt: new Date(b.clock.now).toISOString(),
      };
      expect(await items(b, 'news')).toEqual([expected]);
      expect(await items(b, 'mumbai')).toEqual([expected]);
      expect((await items(a, 'news')).map((i) => [i.contentId, i.origin])).toEqual([[stored.contentId, undefined]]);

      expect(bytesOnB(copy, 1)).toBe(false);
      expect(await b.content.getMeta(copy, 1)).toMatchObject({ origin, size: 0, tags: ['news', 'mumbai'] });
      const meta = (await b.app.inject({ method: 'GET', url: `/content/${copy}` })).json();
      expect(meta).toMatchObject({ contentId: copy, version: 1, origin, preview: stored.preview, tags: ['news', 'mumbai'], aiGenerated: true });
      const raw = await b.app.inject({ method: 'GET', url: `/content/${copy}/raw` });
      expect(raw.statusCode).toBe(302);
      expect(raw.headers.location).toBe(`${ORIGIN}/content/${stored.contentId}/raw?version=1`);

      // Likes are the server's own, and an entry the compactor rebuilds from the meta file keeps its origin.
      const reader = await b.register('reader');
      expect((await b.app.inject({ method: 'POST', url: '/like', payload: { ...reader, contentId: copy } })).statusCode).toBe(201);
      await b.compact();
      expect(await items(b, 'news')).toEqual([{ ...expected, likes: 1 }]);
      expect((await items(a, 'news'))[0]!.likes).toBe(0);
      await b.hot.clear();
      await b.compactor.runOnce({ rebuild: true });
      expect(await items(b, 'mumbai')).toEqual([{ ...expected, likes: 1 }]);
    });

    it('federates later versions as updates, ignores the same version again, and refuses older ones', async () => {
      const alice = await a.register('alice');
      const bAlice = await b.register('alice');
      const servers = { serverAddress: bUrl, serverUser: 'alice', serverKey: bAlice.apiKey };
      const v1 = (await store(alice, 'first draft #news', { federated_servers: servers })).json();
      const copy = v1.federated[0].contentId as string;

      tick(60_000);
      const v2 = await store(alice, 'second draft #sports', { contentId: v1.contentId, federated_servers: servers });
      expect(v2.json()).toMatchObject({ version: 2, federated: [{ ok: true, status: 200, contentId: copy, version: 2 }] });
      expect(await items(b, 'news')).toEqual([]);
      expect((await items(b, 'sports')).map((i) => [i.contentId, i.version, i.origin])).toEqual([
        [copy, 2, { server: ORIGIN, contentId: v1.contentId, version: 2 }],
      ]);

      // Storing the same bytes again federates the current version, which the server already has.
      tick(1000);
      const again = await store(alice, 'second draft #sports', { contentId: v1.contentId, federated_servers: servers });
      expect(again.json()).toMatchObject({ unchanged: true, federated: [{ ok: true, status: 200, contentId: copy, version: 2 }] });

      const entry = (await items(a, 'sports'))[0]!;
      const send = (version: number) => federated({ username: 'alice', apiKey: bAlice.apiKey, origin: ORIGIN, entry: { ...entry, version } });
      expect((await send(2)).json()).toEqual({ contentId: copy, version: 2, unchanged: true });
      const stale = await send(1);
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error).toBe('version 2 of this content is already federated');
      const local = await b.app.inject({ method: 'POST', url: '/store', payload: { ...bAlice, contentId: copy, type: 'text', text: 'edited here #sports', tags: ['sports'] } });
      expect(local.statusCode).toBe(409);
      expect(local.json().error).toBe('federated content is updated on its origin server, which federates the new version');

      await b.compact();
      expect(await b.content.getMeta(copy, 1)).toBeNull();
      expect(await b.db.selectFrom('superseded_versions').selectAll().execute()).toEqual([]);

      // Deleting the copy removes it from the server like local content; the origin keeps its own.
      expect((await b.app.inject({ method: 'DELETE', url: `/content/${copy}`, payload: { ...bAlice } })).statusCode).toBe(202);
      expect(await items(b, 'sports')).toEqual([]);
      await b.compact();
      expect(await b.db.selectFrom('content').selectAll().execute()).toEqual([]);
      expect(await b.content.getMeta(copy, 2)).toBeNull();
      expect((await items(a, 'sports')).map((i) => i.contentId)).toEqual([v1.contentId]);
    });

    it('links images to the bytes on the origin, with their caption, from a multipart upload', async () => {
      const alice = await a.register('alice');
      const bAlice = await b.register('alice');
      const servers = JSON.stringify([{ serverAddress: bUrl, serverUser: bAlice.userId, serverKey: bAlice.apiKey }]);
      const mp = multipart({ ...alice, type: 'image', text: 'One pixel', federated_servers: servers, tags: 'image' }, { name: 'pixel.png', type: 'image/png', data: PNG });
      const res = await a.app.inject({ method: 'POST', url: '/store', payload: mp.payload, headers: mp.headers });
      expect(res.statusCode, res.body).toBe(201);
      const { contentId, preview, federated: results } = res.json();
      expect(preview).toEqual({ kind: 'image', url: `${ORIGIN}/content/${contentId}/raw?version=1`, text: 'One pixel' });
      expect(results).toMatchObject([{ ok: true, status: 201 }]);
      const [item] = await items(b, 'image');
      expect(item).toMatchObject({ contentId: results[0].contentId, mimeType: 'image/png', preview });
      expect(bytesOnB(results[0].contentId, 1)).toBe(false);
    });

    it('federates links, and reads records from servers older than post types', async () => {
      const alice = await a.register('alice');
      const bAlice = await b.register('alice');
      const servers = [{ serverAddress: bUrl, serverUser: 'alice', serverKey: bAlice.apiKey }];
      const res = await a.app.inject({ method: 'POST', url: '/store', payload: { ...alice, type: 'link', url: 'https://news.example/a', tags: ['news'], federated_servers: servers } });
      expect(res.json().federated).toMatchObject([{ ok: true, status: 201 }]);
      expect(await items(b, 'news')).toMatchObject([{ mimeType: 'text/uri-list', preview: { kind: 'link', url: 'https://news.example/a' } }]);

      const entry = (contentId: string, mimeType: string, preview: object) => ({
        contentId,
        version: 1,
        mimeType,
        preview,
        tags: ['old'],
        createdAt: new Date(b.clock.now).toISOString(),
      });
      const send = (e: object) => federated({ username: 'alice', apiKey: bAlice.apiKey, origin: ORIGIN, entry: e });
      const bytes = (id: string) => `${ORIGIN}/content/${id}/raw?version=1`;
      const sent = {
        '00000000-0000-4000-8000-000000000001': ['image/png', { kind: 'media', url: 'https://elsewhere.example/x' }, { kind: 'image' }],
        '00000000-0000-4000-8000-000000000002': ['application/pdf', { kind: 'media' }, { kind: 'link' }],
        '00000000-0000-4000-8000-000000000003': ['text/html', { kind: 'text', text: 'A page' }, { kind: 'link' }],
      } as const;
      for (const [id, [mimeType, preview]] of Object.entries(sent)) expect((await send(entry(id, mimeType, preview))).statusCode).toBe(201);
      const got = Object.fromEntries((await items(b, 'old')).map((i) => [i.origin!.contentId, i.preview]));
      expect(got).toEqual(Object.fromEntries(Object.entries(sent).map(([id, [, , read]]) => [id, { ...read, url: bytes(id) }])));
    });

    it('reports each server that refuses the record or cannot be reached, and stores the content anyway', async () => {
      const alice = await a.register('alice');
      const bAlice = await b.register('alice');
      const res = await store(alice, 'hello #news', {
        federated_servers: [
          { serverAddress: bUrl, serverUser: 'alice', serverKey: 'nope' },
          { serverAddress: bUrl, serverUser: 'nobody', serverKey: bAlice.apiKey },
          { serverAddress: 'http://127.0.0.1:1', serverUser: 'alice', serverKey: bAlice.apiKey },
          { serverAddress: bUrl, serverUser: 'alice', serverKey: bAlice.apiKey },
        ],
      });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().federated).toEqual([
        { serverAddress: bUrl, ok: false, status: 401, error: 'Invalid userId or apiKey' },
        { serverAddress: bUrl, ok: false, status: 401, error: 'Invalid userId or apiKey' },
        { serverAddress: 'http://127.0.0.1:1', ok: false, error: 'could not reach the server' },
        { serverAddress: bUrl, ok: true, status: 201, contentId: expect.any(String), version: 1 },
      ]);
      expect(await a.db.selectFrom('content').select('id').execute()).toEqual([{ id: res.json().contentId }]);
      expect(await items(b, 'news')).toHaveLength(1);
    });

    it('refuses to federate without an absolute PUBLIC_BASE_URL, or with a malformed list, storing nothing', async () => {
      const alice = await a.register('alice');
      const bAlice = await b.register('alice');
      const servers = [{ serverAddress: bUrl, serverUser: 'alice', serverKey: bAlice.apiKey }];
      const refused = async (federated_servers: unknown) => {
        const res = await store(alice, 'hello #news', { federated_servers });
        expect(res.statusCode, res.body).toBe(400);
        return res.json().error as string;
      };

      a.config.publicBaseUrl = '';
      expect(await refused(servers)).toBe("federation needs PUBLIC_BASE_URL set to this server's absolute URL, which other servers link back to");
      a.config.publicBaseUrl = ORIGIN;
      for (const bad of ['{not json', [{ serverAddress: 'ftp://b.example', serverUser: 'alice', serverKey: 'k' }], [], { serverAddress: bUrl }]) {
        expect(await refused(bad)).toBe('Invalid request');
      }
      expect(await a.db.selectFrom('content').select('id').execute()).toEqual([]);
      expect(await items(b, 'news')).toEqual([]);

      expect((await store(alice, 'hello #news', { federated_servers: servers })).json().federated).toMatchObject([{ ok: true }]);
    });

    it('passes a challenge from a server back to the client, and the solution on to the server', async () => {
      b.config.challenge.postWindowSeconds = 60;
      const alice = await a.register('alice');
      const bAlice = await b.register('alice');
      const servers = [{ serverAddress: bUrl, serverUser: 'alice', serverKey: bAlice.apiKey }];
      expect((await store(alice, 'first #news', { federated_servers: servers })).json().federated).toMatchObject([{ ok: true, status: 201 }]);

      // This server lets the second post through, but the other wants a challenge solved first.
      tick(1000);
      const second = await store(alice, 'second #news', { federated_servers: servers });
      expect(second.statusCode).toBe(201);
      const [refused] = second.json().federated;
      expect(refused).toEqual({
        serverAddress: bUrl,
        ok: false,
        status: 428,
        error: 'you posted or were challenged less than 60 seconds ago; solve the challenge to post',
        challenge: expect.objectContaining({ id: expect.any(String), image: expect.stringMatching(/^data:image\/png;base64,/), step: 1, steps: 1 }),
      });
      expect(await items(b, 'news')).toHaveLength(1);

      const solution = await b.solve(refused.challenge);
      a.clock.now = b.clock.now;
      const retry = await store(alice, 'second #news', { contentId: second.json().contentId, federated_servers: [{ ...servers[0], ...solution }] });
      expect(retry.json()).toMatchObject({ unchanged: true, federated: [{ ok: true, status: 201 }] });
      expect(await items(b, 'news')).toHaveLength(2);
    });

    it("replaces the record's hashtags with the server's own in server tagging mode", async () => {
      b.config.tagging = { mode: 'server', serverTags: ['local'] };
      const alice = await a.register('alice');
      const bAlice = await b.register('alice');
      const servers = [{ serverAddress: bUrl, serverUser: 'alice', serverKey: bAlice.apiKey }];
      const res = await store(alice, 'Flooding in Mumbai #news', { federated_servers: servers });
      expect(res.json()).toMatchObject({ tags: ['news'], federated: [{ ok: true, status: 201 }] });
      expect(await items(b, 'news')).toEqual([]);
      expect((await items(b, 'local')).map((i) => [i.contentId, i.tags])).toEqual([[res.json().federated[0].contentId, ['local']]]);
    });

    it('validates what /federated receives', async () => {
      const bAlice = await b.register('alice');
      const noUrl = await b.register('bob', null);
      const entry = {
        contentId: '5c06badf-f69d-4900-8cab-256a1b626b10',
        version: 1,
        mimeType: 'text/plain',
        aiGenerated: false,
        preview: { kind: 'text', text: 'hello' },
        // Servers on releases with an AI send its summary too, which isn't kept.
        related: 'Related: hello',
        tags: ['news'],
        createdAt: new Date(b.clock.now).toISOString(),
      };
      const send = (body: Record<string, unknown>) => federated({ username: 'alice', apiKey: bAlice.apiKey, origin: ORIGIN, entry, ...body });
      expect((await send({ entry: { ...entry, tags: ['!!!'] } })).json().error).toBe('the entry has no usable hashtags');
      expect((await send({ origin: 'javascript:alert(1)' })).statusCode).toBe(400);
      expect((await send({ entry: { ...entry, contentId: 'c-1' } })).statusCode).toBe(400);
      for (const preview of [{ kind: 'link', url: 'javascript:alert(1)' }, { kind: 'image', text: 'x'.repeat(10_001) }, { kind: 'file' }]) {
        expect((await send({ entry: { ...entry, preview } })).statusCode).toBe(400);
      }
      expect((await send({ apiKey: 'nope' })).statusCode).toBe(401);
      expect((await federated({ username: 'bob', apiKey: noUrl.apiKey, origin: ORIGIN, entry })).statusCode).toBe(400);

      // A clock ahead of this server's can't date the content in the future; the userId works as well as the username.
      const res = await send({ username: undefined, userId: bAlice.userId, entry: { ...entry, createdAt: new Date(b.clock.now + 3_600_000).toISOString() } });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json()).toMatchObject({ version: 1, origin: { server: ORIGIN, contentId: entry.contentId, version: 1 }, tags: ['news'] });
      expect((await items(b, 'news')).map((i) => [i.contentId, i.createdAt])).toEqual([
        [res.json().contentId, new Date(b.clock.now).toISOString()],
      ]);
      expect((await items(b, 'news'))[0]).not.toHaveProperty('related');
      expect(await b.content.getMeta(res.json().contentId, 1)).not.toHaveProperty('related');
    });
  });
}
