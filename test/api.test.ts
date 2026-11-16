import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Db } from '../src/db/index.js';
import { DAY, HOUR } from '../src/feed/plan.js';
import { authorIndex } from '../src/tagfeed/layout.js';
import { createTestContext, hashtags, multipart, tailLines, TARGETS, type TestContext } from './helpers.js';

// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

type User = { userId: string; apiKey: string };
type Item = {
  contentId: string;
  version: number;
  likes: number;
  aiGenerated: boolean;
  tags: string[];
  preview: { kind: string; text?: string; url?: string };
  publisher: Record<string, unknown>;
};
type Feed = {
  truncated: boolean;
  nextCursor: string | null;
  count: number;
  days: { extended: boolean; count: number; tags: Record<string, Item[]> }[];
};

for (const target of TARGETS) {
  describe(`API (${target.name})`, () => {
    let ctx: TestContext;
    beforeEach(async () => {
      ctx = await createTestContext(target);
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await ctx.close();
    });

    const storeText = (user: User, text: string, extra: Record<string, unknown> = {}) =>
      ctx.app.inject({ method: 'POST', url: '/store', payload: { ...user, type: 'text', text, tags: hashtags(text), ...extra } });
    const storePost = (user: User, payload: Record<string, unknown>) => ctx.app.inject({ method: 'POST', url: '/store', payload: { ...user, ...payload } });
    const upload = (fields: Record<string, string>, file: { name: string; type: string; data: Buffer }) => {
      const mp = multipart(fields, file);
      return ctx.app.inject({ method: 'POST', url: '/store', payload: mp.payload, headers: mp.headers });
    };
    const getContent = async (contentId: string) => (await ctx.app.inject({ method: 'GET', url: `/content/${contentId}` })).json();
    const feed = async (query: string): Promise<Feed> => {
      const res = await ctx.app.inject({ method: 'GET', url: `/feed?${query}` });
      expect(res.statusCode, res.body).toBe(200);
      return res.json();
    };
    const ids = (day: Feed['days'][number] | undefined, tag: string) => (day?.tags[tag] ?? []).map((i) => i.contentId);

    it('identifies users by UUID and keeps usernames unique', async () => {
      const a = await ctx.app.inject({ method: 'POST', url: '/register', payload: { username: 'alice', publisherUrl: 'https://a.example' } });
      expect(a.statusCode).toBe(201);
      expect(a.json().apiKey).toMatch(/^tu_/);
      const dup = await ctx.app.inject({ method: 'POST', url: '/register', payload: { username: 'alice' } });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error).toBe('username is already taken');
      const profile = await ctx.app.inject({ method: 'GET', url: `/users/${a.json().userId}` });
      expect(profile.json()).toEqual({
        userId: a.json().userId,
        username: 'alice',
        publisherUrl: 'https://a.example',
        createdAt: expect.any(String),
        admin: false,
        moderates: [],
      });

      const bob = await ctx.register('bob');
      const rename = (username: string) => ctx.app.inject({ method: 'PATCH', url: `/users/${bob.userId}`, payload: { ...bob, username } });
      expect((await rename('alice')).statusCode).toBe(409);
      expect((await rename('bob')).statusCode).toBe(200);
      expect((await rename('robert')).json()).toMatchObject({ username: 'robert' });
    });

    it('requires a publisherUrl on the user before storing, settable via PATCH /users/:userId', async () => {
      const bob = await ctx.register('bob', null);
      expect((await storeText(bob, 'hello #news')).statusCode).toBe(400);
      const other = await ctx.register('mallory');
      const forbidden = await ctx.app.inject({ method: 'PATCH', url: `/users/${bob.userId}`, payload: { ...other, publisherUrl: 'https://evil.example' } });
      expect(forbidden.statusCode).toBe(403);
      const patch = await ctx.app.inject({ method: 'PATCH', url: `/users/${bob.userId}`, payload: { ...bob, publisherUrl: 'https://bob.example' } });
      expect(patch.json()).toMatchObject({ publisherUrl: 'https://bob.example' });
      expect((await storeText(bob, 'hello #news')).statusCode).toBe(201);
    });

    it('stores content synchronously at content/<id>/1, its summary once, and one index entry per hashtag', async () => {
      const alice = await ctx.register('alice');
      const res = await storeText(alice, 'Flooding closes roads in central Mumbai. #News #mumbai #monsoon');
      expect(res.statusCode).toBe(201);
      const { contentId, tags, preview } = res.json();
      expect(res.json()).toEqual({
        contentId: expect.any(String),
        version: 1,
        tags: ['news', 'mumbai', 'monsoon'],
        preview: { kind: 'text', text: 'Flooding closes roads in central Mumbai. #News #mumbai #monsoon' },
        aiGenerated: false,
      });

      const body = await getContent(contentId);
      expect(Object.keys(body)[0]).toBe('publisher');
      expect(body).toMatchObject({
        publisher: { userId: alice.userId, username: 'alice', publisherUrl: 'https://alice.example.com' },
        contentId,
        version: 1,
        preview,
        tags: ['news', 'mumbai', 'monsoon'],
        likes: 0,
        aiGenerated: false,
      });
      expect(body).not.toHaveProperty('related');
      const raw = await ctx.app.inject({ method: 'GET', url: `/content/${contentId}/raw` });
      expect(raw.body).toContain('Flooding');

      for (const tag of tags) {
        expect(await tailLines(ctx.hot, tag)).toEqual([
          { contentId, version: 1, createdAt: ctx.clock.now, updatedAt: ctx.clock.now, likes: 0, size: expect.any(Number), aiGenerated: false },
        ]);
      }
      const [summary] = await ctx.summaries.getMany([{ contentId, version: 1, createdAt: ctx.clock.now }]);
      expect(summary).toEqual({
        contentId,
        version: 1,
        createdAt: ctx.clock.now,
        updatedAt: ctx.clock.now,
        userId: alice.userId,
        mimeType: 'text/plain',
        aiGenerated: false,
        tags,
        preview,
      });
      const tagList = (await ctx.app.inject({ method: 'GET', url: '/tags?prefix=mum' })).json();
      expect(tagList.tags.map((t: { tag: string }) => t.tag)).toEqual(['mumbai']);
    });

    it('previews text as its first 100 words, at most 1,000 characters of them, and an image as a link to it', async () => {
      await ctx.close();
      ctx = await createTestContext(target, { publicBaseUrl: 'https://api.example.com' });
      const alice = await ctx.register('alice');
      const words = Array.from({ length: 150 }, (_, i) => `w${i}`).join(' ');
      const text = (await storeText(alice, `${words} #long`)).json();
      expect(text.preview.text.split(' ')).toHaveLength(101);
      expect(text.preview.text).toMatch(/^w0 w1 .* w99 …$/);
      expect((await getContent(text.contentId)).text).toBe(`${words} #long`);
      // Text without spaces reads as one word.
      expect((await storeText(alice, `${'字'.repeat(5000)} #long`)).json().preview.text).toBe(`${'字'.repeat(1000)} …`);
      expect((await storeText(alice, `a${'😀'.repeat(600)} #long`)).json().preview.text).toBe(`a${'😀'.repeat(499)} …`);

      const img = await upload({ ...alice, type: 'image', tags: 'pixel' }, { name: 'pixel.png', type: 'image/png', data: PNG });
      expect(img.statusCode).toBe(201);
      const { contentId } = img.json();
      expect(img.json().preview).toEqual({ kind: 'image', url: `https://api.example.com/content/${contentId}/raw?version=1` });
      const raw = await ctx.app.inject({ method: 'GET', url: `/content/${contentId}/raw?version=1` });
      expect(Buffer.from(raw.rawPayload).equals(PNG)).toBe(true);
      expect(raw.headers['content-type']).toBe('image/png');
    });

    it('stores images, videos and audio with an optional caption, text, and links', async () => {
      await ctx.close();
      ctx = await createTestContext(target, { publicBaseUrl: 'https://api.example.com' });
      const alice = await ctx.register('alice');
      const raw = (id: string) => `https://api.example.com/content/${id}/raw?version=1`;

      const caption = `Sunset over the bay. ${Array.from({ length: 120 }, (_, i) => `c${i}`).join(' ')}`;
      const img = await upload({ ...alice, type: 'image', text: `  ${caption}\n`, tags: 'pics' }, { name: 'sunset.png', type: 'image/png', data: PNG });
      expect(img.statusCode, img.body).toBe(201);
      const image = img.json().contentId;
      expect(img.json().preview).toEqual({ kind: 'image', url: raw(image), text: expect.stringMatching(/^Sunset over the bay\. c0 .* c95 …$/) });
      expect(await getContent(image)).toMatchObject({ mimeType: 'image/png', preview: img.json().preview, text: caption });

      // Inline in JSON, and typed by the file's extension.
      const vid = await storePost(alice, { type: 'video', content: PNG.toString('base64'), contentEncoding: 'base64', contentType: 'video/mp4', tags: ['clips'] });
      expect(vid.statusCode, vid.body).toBe(201);
      expect(vid.json().preview).toEqual({ kind: 'video', url: raw(vid.json().contentId) });
      expect(await getContent(vid.json().contentId)).not.toHaveProperty('text');
      const aud = await upload({ ...alice, type: 'audio', text: 'Live at the Roundhouse', tags: 'music' }, { name: 'set.mp3', type: 'application/octet-stream', data: PNG });
      expect(aud.statusCode, aud.body).toBe(201);
      expect(aud.json().preview).toEqual({ kind: 'audio', url: raw(aud.json().contentId), text: 'Live at the Roundhouse' });
      expect((await getContent(aud.json().contentId)).mimeType).toBe('audio/mpeg');

      const lnk = await storePost(alice, { type: 'link', url: 'https://News.example/story?id=1', tags: ['news'] });
      expect(lnk.statusCode, lnk.body).toBe(201);
      const link = lnk.json().contentId;
      expect(lnk.json().preview).toEqual({ kind: 'link', url: 'https://news.example/story?id=1' });
      expect(await getContent(link)).toMatchObject({ mimeType: 'text/uri-list', preview: lnk.json().preview });
      expect((await ctx.app.inject({ method: 'GET', url: `/content/${link}/raw` })).body).toBe('https://news.example/story?id=1');

      const record = async (tag: string) => (await feed(`tags=${tag}`)).days[0]!.tags[tag]![0]!;
      for (const compacted of [false, true]) {
        if (compacted) await ctx.compact();
        expect((await record('pics')).preview).toEqual(img.json().preview);
        expect((await record('music')).preview).toEqual(aud.json().preview);
        expect(await record('news')).toMatchObject({ mimeType: 'text/uri-list', preview: lnk.json().preview });
      }
    });

    it("refuses a post that isn't what its type says", async () => {
      const alice = await ctx.register('alice');
      const refused = async (res: Awaited<ReturnType<typeof storePost>>, error?: string) => {
        expect(res.statusCode, res.body).toBe(400);
        if (error) expect(res.json().error).toBe(error);
      };
      const tags = ['news'];
      await refused(await storePost(alice, { text: 'no type', tags }));
      await refused(await storePost(alice, { type: 'file', text: 'no such type', tags }));
      await refused(await storePost(alice, { type: 'text', tags }), 'text is required');
      await refused(await storePost(alice, { type: 'text', text: ' \n ', tags }), 'text is required');
      await refused(await storePost(alice, { type: 'text', text: 'x'.repeat(40_001), tags }));
      await refused(await storePost(alice, { type: 'text', text: 'hi', url: 'https://a.example', tags }), 'url is only for link posts');
      await refused(await storePost(alice, { type: 'text', content: 'hi', tags }), 'a text post has no file');
      await refused(await storePost(alice, { type: 'link', tags }), 'url is required');
      await refused(await storePost(alice, { type: 'link', url: 'https://a.example', text: 'about it', tags }), 'a link post is just its url');
      for (const url of ['ftp://a.example/f', 'javascript:alert(1)', 'not a url', `https://a.example/${'x'.repeat(2048)}`]) {
        await refused(await storePost(alice, { type: 'link', url, tags }));
      }
      await refused(await storePost(alice, { type: 'image', text: 'a caption', tags }), 'content is required: the image file');
      await refused(await upload({ ...alice, type: 'image', tags: 'news' }, { name: 'report.pdf', type: 'application/pdf', data: PNG }), 'image posts take image/* files, got application/pdf; post other files as a link');
      await refused(await upload({ ...alice, type: 'video', tags: 'news' }, { name: 'pixel.png', type: 'image/png', data: PNG }), 'video posts take video/* files, got image/png; post other files as a link');
      await refused(await upload({ ...alice, type: 'link', url: 'https://a.example', tags: 'news' }, { name: 'pixel.png', type: 'image/png', data: PNG }), 'a link post has no file');
      expect(await ctx.db.selectFrom('content').selectAll().execute()).toEqual([]);
    });

    it('makes a new version when only the caption changes', async () => {
      const alice = await ctx.register('alice');
      const send = (fields: Record<string, string>) => upload({ ...alice, type: 'image', tags: 'pics', ...fields }, { name: 'pixel.png', type: 'image/png', data: PNG });
      const { contentId } = (await send({ text: 'first caption' })).json();
      expect((await send({ contentId, text: 'first caption' })).json()).toMatchObject({ version: 1, unchanged: true });
      ctx.clock.now += 1000;
      expect((await send({ contentId, text: 'second caption' })).json()).toMatchObject({ version: 2, preview: { kind: 'image', text: 'second caption' } });
      ctx.clock.now += 1000;
      const bare = (await send({ contentId })).json();
      expect(bare).toMatchObject({ version: 3 });
      expect(bare.preview).not.toHaveProperty('text');
      expect(await getContent(contentId)).not.toHaveProperty('text');
      expect((await feed('tags=pics')).days[0]!.tags.pics!.map((i) => [i.version, i.preview.text])).toEqual([[3, undefined]]);
    });

    it('reads content stored before post types: files as their type, plain text as text, other files as links to their bytes', async () => {
      const alice = await ctx.register('alice');
      const img = (await upload({ ...alice, type: 'image', tags: 'pics' }, { name: 'pixel.png', type: 'image/png', data: PNG })).json().contentId;
      const doc = (await storeText(alice, 'Annual report #news')).json().contentId;
      const old = (await storeText(alice, 'Plain words #news')).json().contentId;
      const legacy = async (contentId: string, mimeType: string, preview: object) => {
        const meta = (await ctx.content.getMeta(contentId, 1))!;
        await ctx.content.putMeta({ ...meta, mimeType, preview: preview as never, text: undefined });
        await ctx.db.updateTable('content').set({ mime_type: mimeType }).where('id', '=', contentId).execute();
        await ctx.summaries.remove([{ contentId, version: 1, createdAt: ctx.clock.now }]);
      };
      await legacy(img, 'image/png', { kind: 'media', url: '/elsewhere' });
      await legacy(doc, 'application/pdf', { kind: 'text', text: 'Annual report' });
      await legacy(old, 'text/plain', { kind: 'text', text: 'Plain words' });

      const expected = {
        [img]: { kind: 'image', url: `/content/${img}/raw?version=1` },
        [doc]: { kind: 'link', url: `/content/${doc}/raw?version=1` },
        [old]: { kind: 'text', text: 'Plain words' },
      };
      for (const [id, preview] of Object.entries(expected)) expect((await getContent(id)).preview).toEqual(preview);
      // Their summaries rebuilt from the meta files.
      await ctx.hot.clear();
      await ctx.compactor.runOnce({ rebuild: true });
      const records = (await feed('tags=news,pics')).days.flatMap((d) => Object.values(d.tags).flat());
      expect(Object.fromEntries(records.map((r) => [r.contentId, r.preview]))).toEqual(expected);
    });

    it("gives every post the server's hashtags in server mode, whatever the publisher sends", async () => {
      await ctx.close();
      ctx = await createTestContext(target, { tagging: { mode: 'server', serverTags: ['Local', '#austin'] } });
      const alice = await ctx.register('alice');
      const res = await storeText(alice, 'Flooding in Mumbai #news', { tags: ['sports'] });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().tags).toEqual(['local', 'austin']);
      expect(await tailLines(ctx.hot, 'news')).toEqual([]);
      expect(await tailLines(ctx.hot, 'sports')).toEqual([]);
      expect(ids((await feed('tags=austin')).days[0], 'austin')).toEqual([res.json().contentId]);

      const img = await upload({ ...alice, type: 'image' }, { name: 'pixel.png', type: 'image/png', data: PNG });
      expect(img.json()).toMatchObject({ tags: ['local', 'austin'], preview: { kind: 'image' } });
    });

    it("normalises the publisher's hashtags, from a list or one form field, and refuses ones it can't use", async () => {
      const alice = await ctx.register('alice');
      const chosen = await storeText(alice, 'Flooding in Mumbai #news', { tags: ['#Weather', 'mumbai', 'weather'] });
      expect(chosen.statusCode, chosen.body).toBe(201);
      expect(chosen.json().tags).toEqual(['weather', 'mumbai']);
      expect(await tailLines(ctx.hot, 'news')).toEqual([]);

      // A form field holds them in one string.
      const img = await upload({ ...alice, type: 'image', tags: 'art, #Pixel' }, { name: 'pixel.png', type: 'image/png', data: PNG });
      expect(img.json().tags).toEqual(['art', 'pixel']);

      const unusable = await storeText(alice, 'Tokyo #news', { tags: ['news', '日本'] });
      expect(unusable.statusCode).toBe(400);
      expect(unusable.json().error).toBe('"日本" is not a usable hashtag: hashtags are letters, digits and underscores');
      const many = await storeText(alice, 'So many #news', { tags: Array.from({ length: 11 }, (_, i) => `t${i}`) });
      expect(many.statusCode).toBe(400);
      expect(many.json().error).toBe('at most 10 hashtags are allowed, got 11');
    });

    it("requires the publisher's hashtags by default, before any challenge, and makes a new version when they change", async () => {
      await ctx.close();
      ctx = await createTestContext(target, { challenge: { postWindowSeconds: 60 } });
      expect(ctx.config.tagging.mode).toBe('user');
      const alice = await ctx.register('alice');
      const refused = (res: Awaited<ReturnType<typeof storeText>>) => {
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe('tags is required: on this server, publishers choose the hashtags of their posts');
      };
      for (const tags of [undefined, [], '', ' , ']) refused(await storeText(alice, 'Flooding in Mumbai #news', { tags }));
      refused(await upload({ ...alice, type: 'image' }, { name: 'pixel.png', type: 'image/png', data: PNG }));
      expect(await ctx.db.selectFrom('content').selectAll().execute()).toEqual([]);

      const v1 = await storeText(alice, 'Flooding in Mumbai', { tags: 'news mumbai' });
      expect(v1.statusCode, v1.body).toBe(201);
      const { contentId } = v1.json();
      expect(v1.json()).toMatchObject({ version: 1, tags: ['news', 'mumbai'], preview: { kind: 'text', text: 'Flooding in Mumbai' } });
      refused(await storeText(alice, 'Another post'));
      // Updates need them too, even with the same bytes.
      refused(await storeText(alice, 'Flooding in Mumbai', { contentId }));
      refused(await storeText(alice, 'Flooding in Mumbai, again', { contentId }));

      // The same bytes and hashtags, in any order, change nothing; other hashtags are a new version.
      expect((await storeText(alice, 'Flooding in Mumbai', { contentId, tags: ['mumbai', 'news'] })).json()).toMatchObject({ version: 1, unchanged: true });
      ctx.clock.now += 60_000;
      const v2 = await storeText(alice, 'Flooding in Mumbai', { contentId, tags: ['weather'] });
      expect(v2.statusCode, v2.body).toBe(200);
      expect(v2.json()).toMatchObject({ version: 2, tags: ['weather'] });
      expect((await feed('tags=news')).days).toEqual([]);
      expect(ids((await feed('tags=weather')).days[0], 'weather')).toEqual([contentId]);
    });

    it('only lets the owner update; a new version replaces the old one in feeds at once, and the compactor erases it', async () => {
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      expect((await storeText({ ...alice, apiKey: bob.apiKey }, 'hi #news')).statusCode).toBe(401);

      const { contentId } = (await storeText(alice, 'v1 #news')).json();
      expect((await storeText(bob, 'hijack #news', { contentId })).statusCode).toBe(403);
      expect((await storeText(alice, 'v1 #news', { contentId })).json()).toMatchObject({ version: 1, unchanged: true });

      ctx.clock.now += 60_000;
      const upd = await storeText(alice, 'v2 #sports', { contentId });
      expect(upd.statusCode).toBe(200);
      expect(upd.json()).toMatchObject({ version: 2, tags: ['sports'] });
      expect((await getContent(contentId)).tags).toEqual(['sports']);
      expect((await ctx.app.inject({ method: 'GET', url: `/content/${contentId}/raw?version=1` })).statusCode).toBe(404);
      expect((await ctx.app.inject({ method: 'GET', url: `/content/${contentId}/raw` })).body).toBe('v2 #sports');

      const sports = await feed('tags=sports');
      expect(sports.days[0]!.tags.sports!.map((i) => [i.contentId, i.version])).toEqual([[contentId, 2]]);
      // The news tail still holds v1, but a tombstone hides it until the compactor removes it.
      expect((await feed('tags=news')).days).toEqual([]);
      expect(await ctx.content.getMeta(contentId, 1)).not.toBeNull();
      await ctx.compact();
      expect((await feed('tags=news')).days).toEqual([]);
      expect(ids((await feed('tags=sports')).days[0], 'sports')).toEqual([contentId]);
      expect(await ctx.content.getMeta(contentId, 1)).toBeNull();
      expect(await ctx.db.selectFrom('superseded_versions').selectAll().execute()).toEqual([]);
    });

    it('requires new versions to keep the original type and content type', async () => {
      const alice = await ctx.register('alice');
      const { contentId } = (await storeText(alice, 'words #news')).json();
      const res = await upload({ ...alice, type: 'image', contentId, tags: 'news' }, { name: 'pixel.png', type: 'image/png', data: PNG });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('a new version must have the same content type as the original (text/plain), got image/png');
      const link = await storePost(alice, { type: 'link', contentId, url: 'https://news.example/a', tags: ['news'] });
      expect(link.json().error).toBe('a new version must have the same content type as the original (text/plain), got text/uri-list');
      const img = (await upload({ ...alice, type: 'image', tags: 'pics' }, { name: 'pixel.png', type: 'image/png', data: PNG })).json().contentId;
      const jpeg = await upload({ ...alice, type: 'image', contentId: img, tags: 'pics' }, { name: 'pixel.jpg', type: 'image/jpeg', data: PNG });
      expect(jpeg.json().error).toBe('a new version must have the same content type as the original (image/png), got image/jpeg');
      expect((await getContent(contentId)).version).toBe(1);
      expect((await storeText(alice, 'more words #news', { contentId })).json()).toMatchObject({ version: 2 });
    });

    it('shows a changed username or publisherUrl on every record at once, without rewriting the index', async () => {
      const alice = await ctx.register('alice');
      const compacted = (await storeText(alice, 'old post #news #mumbai')).json().contentId;
      await ctx.compact();
      ctx.clock.now += 1000;
      const fresh = (await storeText(alice, 'new post #news')).json().contentId;

      const patch = await ctx.app.inject({
        method: 'PATCH',
        url: `/users/${alice.userId}`,
        payload: { ...alice, username: 'alicia', publisherUrl: 'https://alicia.example' },
      });
      expect(patch.statusCode).toBe(200);

      const publisher = { userId: alice.userId, username: 'alicia', publisherUrl: 'https://alicia.example' };
      const news = (await feed('tags=news')).days[0]!.tags.news!;
      expect(news.map((i) => i.contentId)).toEqual([fresh, compacted]);
      for (const item of news) expect(item.publisher).toEqual(publisher);
      expect((await feed('tags=mumbai')).days[0]!.tags.mumbai![0]!.publisher).toEqual(publisher);
      ctx.clock.now += 1000;
      expect((await ctx.compact()).tags).toEqual([authorIndex(alice.userId), 'news']);
      expect((await feed('tags=mumbai')).days[0]!.tags.mumbai![0]!.publisher).toEqual(publisher);
    });

    it('records likes once per user; the compactor writes them into the day indexes', async () => {
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const carol = await ctx.register('carol');
      const first = (await storeText(alice, 'first #news')).json().contentId;
      ctx.clock.now += 1000;
      const second = (await storeText(alice, 'second #news')).json().contentId;

      const like = (u: User, contentId: string) => ctx.app.inject({ method: 'POST', url: '/like', payload: { ...u, contentId } });
      expect((await like(bob, first)).json()).toMatchObject({ likes: 1, alreadyLiked: false });
      expect((await like(bob, first)).json()).toMatchObject({ likes: 1, alreadyLiked: true });
      expect((await like(carol, first)).json()).toMatchObject({ likes: 2, alreadyLiked: false });
      expect((await ctx.app.inject({ method: 'POST', url: '/like', payload: { ...bob, contentId: '00000000-0000-4000-8000-000000000000' } })).statusCode).toBe(404);
      expect((await ctx.app.inject({ method: 'POST', url: '/like', payload: { userId: bob.userId, apiKey: 'nope', contentId: first } })).statusCode).toBe(401);

      // Before compaction the feed shows newest first with the likes recorded at store time.
      let day = (await feed('tags=news')).days[0]!;
      expect(day.tags.news!.map((i) => [i.contentId, i.likes])).toEqual([[second, 0], [first, 0]]);

      await ctx.compact();
      day = (await feed('tags=news')).days[0]!;
      expect(day.tags.news!.map((i) => [i.contentId, i.likes])).toEqual([[first, 2], [second, 0]]);

      // A like on already-compacted content is picked up by the next run.
      expect((await like(bob, second)).json()).toMatchObject({ likes: 1 });
      expect((await like(carol, second)).json()).toMatchObject({ likes: 2 });
      expect((await like(alice, second)).json()).toMatchObject({ likes: 3 });
      ctx.clock.now += 1000;
      expect((await ctx.compact()).tags).toEqual([authorIndex(alice.userId), 'news']);
      day = (await feed('tags=news')).days[0]!;
      expect(day.tags.news!.map((i) => [i.contentId, i.likes])).toEqual([[second, 3], [first, 2]]);
    });

    it('lets only the owner set content for deletion, which hides it at once and refuses new versions and likes', async () => {
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const { contentId } = (await storeText(alice, 'doomed #news')).json();
      const del = (headers: Record<string, string>, id = contentId) => ctx.app.inject({ method: 'DELETE', url: `/content/${id}`, headers });
      const as = (u: User) => ({ authorization: `Bearer ${u.apiKey}`, 'x-user-id': u.userId });

      expect((await del(as(bob))).statusCode).toBe(403);
      expect((await del({ ...as(alice), authorization: 'Bearer nope' })).statusCode).toBe(401);
      expect((await del(as(alice), '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);

      const requestedAt = new Date(ctx.clock.now).toISOString();
      const res = await del(as(alice));
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ contentId, status: 'pending_deletion', requestedAt });
      ctx.clock.now += 1000;
      const again = await ctx.app.inject({ method: 'DELETE', url: `/content/${contentId}`, payload: { ...alice } });
      expect(again.json()).toEqual({ contentId, status: 'pending_deletion', requestedAt });

      const upd = await storeText(alice, 'edited #news', { contentId });
      expect(upd.statusCode).toBe(409);
      expect(upd.json().error).toBe('content is set for deletion');
      expect((await ctx.app.inject({ method: 'POST', url: '/like', payload: { ...bob, contentId } })).statusCode).toBe(404);
      expect((await ctx.app.inject({ method: 'GET', url: `/content/${contentId}` })).statusCode).toBe(404);
      expect((await ctx.app.inject({ method: 'GET', url: `/content/${contentId}/raw` })).statusCode).toBe(404);
      expect((await feed('tags=news')).days).toEqual([]);
    });

    it('refuses a new version when its content is set for deletion while the version is being written', async () => {
      const alice = await ctx.register('alice');
      const { contentId } = (await storeText(alice, 'v1 #news')).json();
      const putFile = ctx.content.putFile.bind(ctx.content);
      vi.spyOn(ctx.content, 'putFile').mockImplementationOnce(async (...args) => {
        await ctx.app.inject({ method: 'DELETE', url: `/content/${contentId}`, payload: { ...alice } });
        return putFile(...args);
      });

      expect((await storeText(alice, 'v2 #news', { contentId })).statusCode).toBe(409);
      expect(await ctx.db.selectFrom('content').select('version').where('id', '=', contentId).executeTakeFirst()).toEqual({ version: 1 });
      expect(await ctx.db.selectFrom('superseded_versions').selectAll().execute()).toEqual([]);
      expect(await ctx.content.getMeta(contentId, 2)).toBeNull();
    });

    it('returns a feed by day, then equal share per tag, then likes, extending past the window', async () => {
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const t0 = ctx.clock.now;
      const post = async (text: string, ageMs: number) => {
        ctx.clock.now = t0 - ageMs;
        return (await storeText(alice, text)).json().contentId as string;
      };
      const popular = await post('popular mumbai #news #mumbai', 2 * HOUR);
      const quiet = await post('quiet news #news', 1 * HOUR);
      const cricket = await post('cricket #sports #cricket', 3 * HOUR);
      const yesterday = await post('yesterday #news', DAY + HOUR);
      const threeWeeks = await post('three weeks ago #sports', 21 * DAY);
      await post('unrelated #food', HOUR);
      ctx.clock.now = t0;
      await ctx.app.inject({ method: 'POST', url: '/like', payload: { ...bob, contentId: popular } });
      await ctx.compact();

      const result = await feed('tags=news,sports&hours=48');
      expect(result.truncated).toBe(false);
      expect(result.days).toHaveLength(3);
      const [today, dayBefore, extended] = result.days;
      expect(ids(today, 'news')).toEqual([popular, quiet]);
      expect(today!.tags.news![0]).toEqual({
        contentId: popular,
        version: 1,
        publisher: { userId: alice.userId, username: 'alice', publisherUrl: 'https://alice.example.com' },
        mimeType: 'text/plain',
        aiGenerated: false,
        preview: { kind: 'text', text: 'popular mumbai #news #mumbai' },
        tags: ['news', 'mumbai'],
        likes: 1,
        createdAt: new Date(t0 - 2 * HOUR).toISOString(),
        updatedAt: new Date(t0 - 2 * HOUR).toISOString(),
      });
      expect(ids(today, 'sports')).toEqual([cricket]);
      expect(ids(dayBefore, 'news')).toEqual([yesterday]);
      expect(extended!.extended).toBe(true);
      expect(ids(extended, 'sports')).toEqual([threeWeeks]);
      expect(result.count).toBe(5);
      expect(result.days.map((d) => d.count)).toEqual([3, 1, 1]);

      // Half of a two-post page goes to the newest day.
      const limited = await feed('tags=news,sports&hours=48&limit=2');
      expect(limited.days.flatMap((d) => ids(d, 'news'))).toEqual([popular, yesterday]);
      expect(limited.count).toBe(2);
      expect(limited.nextCursor).toBeTruthy();
      for (const limit of [0, 101]) {
        expect((await ctx.app.inject({ method: 'GET', url: `/feed?tags=news&limit=${limit}` })).statusCode).toBe(400);
      }

      expect((await ctx.app.inject({ method: 'GET', url: '/feed?tags=news&hours=500' })).statusCode).toBe(400);
      expect((await ctx.app.inject({ method: 'GET', url: '/feed?tags=news/india' })).statusCode).toBe(400);
    });

    it('balances a feed between the most liked, middle and least liked thirds, across cursor pages', async () => {
      const alice = await ctx.register('alice');
      const fans: User[] = [];
      for (let i = 0; i < 5; i++) fans.push(await ctx.register(`fan${i}`));
      const posts: string[] = [];
      for (let i = 0; i < 6; i++) {
        posts.push((await storeText(alice, `post ${i} #news`)).json().contentId);
        ctx.clock.now += 1000;
      }
      // posts[i] gets 5 - i likes.
      for (const [i, contentId] of posts.entries()) {
        for (const fan of fans.slice(0, 5 - i)) await ctx.app.inject({ method: 'POST', url: '/like', payload: { ...fan, contentId } });
      }
      await ctx.compact();
      const order = (f: Feed) => f.days.flatMap((d) => ids(d, 'news'));
      const [p0, p1, p2, p3, p4, p5] = posts;

      // Popular: by likes, with the unliked post in the fresh slot.
      expect(order(await feed('tags=news'))).toEqual([p0, p5, p1, p2, p3, p4]);
      const full = await feed('tags=news&mode=balanced');
      expect(order(full)).toEqual([p0, p2, p4, p1, p3, p5]);

      ctx.config.feed.pageSize = 2;
      const paged: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const f: Feed = await feed(`tags=news&mode=balanced${cursor ? `&cursor=${cursor}` : ''}`);
        paged.push(...order(f));
        cursor = f.nextCursor;
        if (!cursor) break;
      }
      expect(paged).toEqual(order(full));

      const first = await feed('tags=news&mode=balanced');
      expect(first.nextCursor).toBeTruthy();
      expect((await ctx.app.inject({ method: 'GET', url: `/feed?tags=news&cursor=${first.nextCursor}` })).statusCode).toBe(400);
      expect((await ctx.app.inject({ method: 'GET', url: '/feed?tags=news&mode=random' })).statusCode).toBe(400);
    });

    it('records whether the publisher created content with AI, keeps it across updates, and filters feeds by it', async () => {
      const alice = await ctx.register('alice');
      const human = (await storeText(alice, 'written by hand #news')).json();
      expect(human).toMatchObject({ version: 1, aiGenerated: false });
      ctx.clock.now += 1000;
      const ai = (await storeText(alice, 'written with a model #news #tech', { aiGenerated: true })).json();
      expect(ai).toMatchObject({ version: 1, aiGenerated: true });
      const img = await upload({ ...alice, type: 'image', aiGenerated: 'true', tags: 'pixel' }, { name: 'pixel.png', type: 'image/png', data: PNG });
      expect(img.json()).toMatchObject({ aiGenerated: true });
      expect((await storeText(alice, 'unsure #news', { aiGenerated: 'maybe' })).statusCode).toBe(400);
      expect((await ctx.app.inject({ method: 'GET', url: '/feed?tags=news&aiGenerated=maybe' })).statusCode).toBe(400);

      expect((await getContent(ai.contentId)).aiGenerated).toBe(true);
      expect((await getContent(human.contentId)).aiGenerated).toBe(false);
      expect(await ctx.content.getMeta(ai.contentId, 1)).toMatchObject({ aiGenerated: true });

      const news = async (filter = '') => (await feed(`tags=news${filter}`)).days.flatMap((d) => d.tags.news ?? []);
      const newsIds = async (filter = '') => (await news(filter)).map((i) => i.contentId);
      for (const compacted of [false, true]) {
        if (compacted) await ctx.compact();
        expect((await news()).map((i) => [i.contentId, i.aiGenerated])).toEqual([
          [ai.contentId, true],
          [human.contentId, false],
        ]);
        expect(await newsIds('&aiGenerated=true')).toEqual([ai.contentId]);
        expect(await newsIds('&aiGenerated=false')).toEqual([human.contentId]);
      }

      // An update that doesn't say keeps the flag; changing only the flag makes a new version.
      ctx.clock.now += 1000;
      expect((await storeText(alice, 'revised with a model #news #tech', { contentId: ai.contentId })).json()).toMatchObject({ version: 2, aiGenerated: true });
      const flipped = await storeText(alice, 'written by hand #news', { contentId: human.contentId, aiGenerated: true });
      expect(flipped.json()).toMatchObject({ version: 2, aiGenerated: true });
      expect((await storeText(alice, 'written by hand #news', { contentId: human.contentId })).json()).toMatchObject({ unchanged: true });
      expect((await getContent(human.contentId)).aiGenerated).toBe(true);
      expect(await newsIds('&aiGenerated=false')).toEqual([]);
      expect((await news('&aiGenerated=true')).map((i) => [i.contentId, i.version])).toEqual([
        [ai.contentId, 2],
        [human.contentId, 2],
      ]);

      // Rebuilt from the database after Redis lost everything.
      await ctx.hot.clear();
      await ctx.compactor.runOnce({ rebuild: true });
      expect((await news('&aiGenerated=true')).map((i) => [i.contentId, i.aiGenerated])).toEqual([
        [ai.contentId, true],
        [human.contentId, true],
      ]);
      expect(await newsIds('&aiGenerated=false')).toEqual([]);

      // Cursor pages keep the filter they started with.
      ctx.config.feed.pageSize = 1;
      const first = await feed('tags=news&aiGenerated=true');
      expect(ids(first.days[0], 'news')).toEqual([ai.contentId]);
      for (const other of ['', '&aiGenerated=false']) {
        expect((await ctx.app.inject({ method: 'GET', url: `/feed?tags=news${other}&cursor=${first.nextCursor}` })).statusCode).toBe(400);
      }
      expect(ids((await feed(`tags=news&aiGenerated=true&cursor=${first.nextCursor}`)).days[0], 'news')).toEqual([human.contentId]);
    });

    it('serves feeds, by hashtag and of whom a user follows, without touching the database', async () => {
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const follow = await ctx.app.inject({ method: 'PUT', url: `/users/${bob.userId}/following/${alice.userId}`, payload: bob });
      expect(follow.statusCode, follow.body).toBe(201);
      const a = (await storeText(alice, 'compacted #news')).json().contentId;
      await ctx.compact();
      ctx.clock.now += 1000;
      const b = (await storeText(alice, 'in a tail #news')).json().contentId;

      const noDb = new Proxy({} as Db, {
        get() {
          throw new Error('the feed must not use the database');
        },
      });
      const app = await buildApp(
        {
          config: ctx.config,
          db: noDb,
          content: ctx.content,
          hot: ctx.hot,
          summaries: ctx.summaries,
          publishers: ctx.publishers,
          follows: ctx.follows,
          appender: ctx.appender,
          feedReader: ctx.feedReader,
          authorReader: ctx.authorReader,
          now: () => ctx.clock.now,
        },
        { logger: false },
      );
      try {
        const res = await app.inject({ method: 'GET', url: '/feed?tags=news' });
        expect(res.statusCode, res.body).toBe(200);
        expect(ids(res.json().days[0], 'news')).toEqual([b, a]);
        const following = await app.inject({ method: 'GET', url: `/feed/following?userId=${bob.userId}` });
        expect(following.statusCode, following.body).toBe(200);
        expect(following.json().records.map((r: Item) => r.contentId)).toEqual([b, a]);
      } finally {
        await app.close();
      }
    });
  });
}
