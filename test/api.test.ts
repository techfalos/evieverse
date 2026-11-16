import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { authorIndex } from '../src/tagfeed/layout.js';
import { DAY, HOUR } from '../src/time.js';
import { as, createTestContext, JPEG, multipart, PNG, requests, tailLines, TARGETS, type Feed, type FeedItem, type TestContext, type User } from './helpers.js';

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

    const { store: storePost, storeText, like, feed } = requests(() => ctx);
    const upload = (fields: Record<string, string>, file: { name: string; type: string; data: Buffer }) => {
      const mp = multipart(fields, file);
      return ctx.app.inject({ method: 'POST', url: '/store', payload: mp.payload, headers: mp.headers });
    };
    const getContent = async (contentId: string) => (await ctx.app.inject({ method: 'GET', url: `/content/${contentId}` })).json();
    const ids = (day: Feed['days'][number] | undefined, tag: string) => (day?.tags[tag] ?? []).map((i) => i.contentId);

    it('identifies users by UUID and keeps usernames unique', async () => {
      const a = await ctx.app.inject({ method: 'POST', url: '/register', payload: { username: 'alice' } });
      expect(a.statusCode).toBe(201);
      expect(a.json()).toEqual({ userId: expect.any(String), username: 'alice', language: 'en', apiKey: expect.stringMatching(/^tu_/), note: expect.any(String) });
      const dup = await ctx.app.inject({ method: 'POST', url: '/register', payload: { username: 'alice' } });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error).toBe('username is already taken');
      const profile = await ctx.app.inject({ method: 'GET', url: `/users/${a.json().userId}` });
      expect(profile.json()).toEqual({
        userId: a.json().userId,
        username: 'alice',
        createdAt: expect.any(String),
        admin: false,
        moderator: false,
        moderates: [],
      });

      const bob = await ctx.register('bob');
      const rename = (username: string) => ctx.app.inject({ method: 'PATCH', url: `/users/${bob.userId}`, payload: { ...bob, username } });
      expect((await rename('alice')).statusCode).toBe(409);
      expect((await rename('bob')).statusCode).toBe(200);
      expect((await rename('robert')).json()).toEqual({ userId: bob.userId, username: 'robert', language: 'en', messages: true });
    });

    it('lets a user post as soon as they register, and only them change their profile', async () => {
      const bob = await ctx.register('bob');
      expect((await storeText(bob, 'hello #news')).statusCode).toBe(201);
      const other = await ctx.register('mallory');
      const patch = (payload: Record<string, unknown>) => ctx.app.inject({ method: 'PATCH', url: `/users/${bob.userId}`, payload });
      expect((await patch({ ...other, username: 'robert' })).statusCode).toBe(403);
      const nothing = await patch({ userId: bob.userId, apiKey: bob.apiKey });
      expect([nothing.statusCode, nothing.json().error]).toEqual([400, 'nothing to update: provide username, language or messages']);
      expect((await ctx.app.inject({ method: 'GET', url: `/users/${bob.userId}` })).json()).toMatchObject({ username: 'bob' });
    });

    it('stores content synchronously at content/<id>, its summary once, and one index entry per hashtag', async () => {
      const alice = await ctx.register('alice');
      const res = await storeText(alice, 'Flooding closes roads in central Mumbai. #News #mumbai #monsoon');
      expect(res.statusCode).toBe(201);
      const { contentId, tags, preview } = res.json();
      expect(res.json()).toEqual({
        contentId: expect.any(String),
        tags: ['news', 'mumbai', 'monsoon'],
        preview: { kind: 'text', text: 'Flooding closes roads in central Mumbai. #News #mumbai #monsoon' },
        aiGenerated: false,
        comments: false,
      });

      const body = await getContent(contentId);
      expect(Object.keys(body)[0]).toBe('publisher');
      expect(body).toMatchObject({
        contentId,
        preview,
        tags: ['news', 'mumbai', 'monsoon'],
        likes: 0,
        aiGenerated: false,
        // Read from the meta file beside the bytes, not from the database.
        mimeType: 'text/plain',
        size: Buffer.byteLength('Flooding closes roads in central Mumbai. #News #mumbai #monsoon'),
        createdAt: new Date(ctx.clock.now).toISOString(),
        updatedAt: new Date(ctx.clock.now).toISOString(),
      });
      expect(body).not.toHaveProperty('version');
      expect(body).not.toHaveProperty('filename');
      // The credit is the publisher's id and username, and nothing else.
      expect(body.publisher).toEqual({ userId: alice.userId, username: 'alice' });
      expect(body).not.toHaveProperty('related');
      const raw = await ctx.app.inject({ method: 'GET', url: `/content/${contentId}/raw` });
      expect(raw.body).toContain('Flooding');
      expect(raw.headers).not.toHaveProperty('x-publisher-url');

      for (const tag of tags) {
        expect(await tailLines(ctx.hot, tag)).toEqual([
          { contentId, createdAt: ctx.clock.now, updatedAt: ctx.clock.now, likes: 0, aiGenerated: false, moderated: false },
        ]);
      }
      const [summary] = await ctx.summaries.getMany([{ contentId, createdAt: ctx.clock.now }]);
      expect(summary).toEqual({
        contentId,
        createdAt: ctx.clock.now,
        updatedAt: ctx.clock.now,
        userId: alice.userId,
        mimeType: 'text/plain',
        aiGenerated: false,
        comments: false,
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
      expect(img.json().preview).toEqual({ kind: 'image', url: `https://api.example.com/content/${contentId}/raw` });
      const raw = await ctx.app.inject({ method: 'GET', url: `/content/${contentId}/raw` });
      expect(Buffer.from(raw.rawPayload).equals(PNG)).toBe(true);
      expect(raw.headers['content-type']).toBe('image/png');
      expect(raw.headers['content-length']).toBe(String(PNG.length));
      expect(raw.headers).not.toHaveProperty('content-disposition');
    });

    it('stores images, videos and audio with an optional caption, text, and links', async () => {
      await ctx.close();
      ctx = await createTestContext(target, { publicBaseUrl: 'https://api.example.com' });
      const alice = await ctx.register('alice');
      const raw = (id: string) => `https://api.example.com/content/${id}/raw`;

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

    it('writes over a post when it is updated: a file whenever it is sent, with the caption it comes with', async () => {
      const alice = await ctx.register('alice');
      const send = (fields: Record<string, string>) => upload({ ...alice, type: 'image', tags: 'pics', ...fields }, { name: 'pixel.png', type: 'image/png', data: PNG });
      const createdAt = new Date(ctx.clock.now).toISOString();
      const { contentId } = (await send({ text: 'first caption' })).json();
      ctx.clock.now += 1000;
      // A file isn't compared with the one stored, so the same one is an update like any other.
      const same = await send({ contentId, text: 'first caption' });
      expect(same.statusCode, same.body).toBe(200);
      expect(same.json()).not.toHaveProperty('unchanged');
      ctx.clock.now += 1000;
      expect((await send({ contentId, text: 'second caption' })).json()).toMatchObject({ contentId, preview: { kind: 'image', text: 'second caption' } });
      ctx.clock.now += 1000;
      const bare = (await send({ contentId })).json();
      expect(bare).not.toHaveProperty('version');
      expect(bare.preview).not.toHaveProperty('text');
      const updatedAt = new Date(ctx.clock.now).toISOString();
      const body = await getContent(contentId);
      expect(body).not.toHaveProperty('text');
      expect(body).toMatchObject({ createdAt, updatedAt, size: PNG.length });
      expect((await feed('tags=pics')).days[0]!.tags.pics!.map((i) => [i.contentId, i.preview.text, i.createdAt, i.updatedAt])).toEqual([
        [contentId, undefined, createdAt, updatedAt],
      ]);
      // One row, and one set of objects: the updates wrote over them.
      expect(await ctx.db.selectFrom('content').select('id').execute()).toEqual([{ id: contentId }]);
      expect((await readdir(join(ctx.dir, 'content', 'content'))).sort()).toEqual([contentId, `${contentId}.meta.json`]);
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

    it("requires the publisher's hashtags by default, before any challenge, and updates the post when they change", async () => {
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
      expect(v1.json()).toMatchObject({ tags: ['news', 'mumbai'], preview: { kind: 'text', text: 'Flooding in Mumbai' } });
      refused(await storeText(alice, 'Another post'));
      // Updates need them too, even with the same text.
      refused(await storeText(alice, 'Flooding in Mumbai', { contentId }));
      refused(await storeText(alice, 'Flooding in Mumbai, again', { contentId }));

      // The same text and hashtags, in any order, change nothing; other hashtags are an update.
      expect((await storeText(alice, 'Flooding in Mumbai', { contentId, tags: ['mumbai', 'news'] })).json()).toEqual({ contentId, unchanged: true });
      ctx.clock.now += 60_000;
      const v2 = await storeText(alice, 'Flooding in Mumbai', { contentId, tags: ['weather'] });
      expect(v2.statusCode, v2.body).toBe(200);
      expect(v2.json()).toMatchObject({ contentId, tags: ['weather'] });
      expect((await feed('tags=news')).days).toEqual([]);
      expect(ids((await feed('tags=weather')).days[0], 'weather')).toEqual([contentId]);
    });

    it('only lets the owner update; an update shows in feeds at once, and hides the post from the hashtags it dropped', async () => {
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      expect((await storeText({ ...alice, apiKey: bob.apiKey }, 'hi #news')).statusCode).toBe(401);

      const { contentId } = (await storeText(alice, 'v1 #news')).json();
      expect((await storeText(bob, 'hijack #news', { contentId })).statusCode).toBe(403);
      const createdAt = ctx.clock.now;
      expect((await storeText(alice, 'v1 #news', { contentId })).json()).toEqual({ contentId, unchanged: true });

      ctx.clock.now += 60_000;
      const upd = await storeText(alice, 'v2 #sports', { contentId });
      expect(upd.statusCode).toBe(200);
      expect(upd.json()).toMatchObject({ contentId, tags: ['sports'] });
      expect(upd.json()).not.toHaveProperty('version');
      expect((await getContent(contentId)).tags).toEqual(['sports']);
      // The bytes are written over: there is one version, at one address.
      const raw = await ctx.app.inject({ method: 'GET', url: `/content/${contentId}/raw` });
      expect([raw.body, raw.headers['content-length']]).toEqual(['v2 #sports', '10']);

      const sports = await feed('tags=sports');
      expect(sports.days[0]!.tags.sports!.map((i) => [i.contentId, i.preview.text])).toEqual([[contentId, 'v2 #sports']]);
      // The news tail still holds the post's entry, but a tombstone hides it until the compactor removes it.
      expect(await tailLines(ctx.hot, 'news')).toEqual([
        { contentId, createdAt, updatedAt: createdAt, likes: 0, aiGenerated: false, moderated: false },
        { tombstone: true, contentId, before: ctx.clock.now, createdAt },
      ]);
      expect((await feed('tags=news')).days).toEqual([]);
      await ctx.compact();
      expect((await feed('tags=news')).days).toEqual([]);
      expect(ids((await feed('tags=sports')).days[0], 'sports')).toEqual([contentId]);
      expect(await ctx.db.selectFrom('pending_appends').selectAll().execute()).toEqual([]);

      // A hashtag given back shows the post again, in the tail and once that is merged.
      ctx.clock.now += 60_000;
      expect((await storeText(alice, 'v3 #sports #news', { contentId })).json()).toMatchObject({ tags: ['sports', 'news'] });
      for (const compacted of [false, true]) {
        if (compacted) await ctx.compact();
        expect((await feed('tags=news')).days[0]!.tags.news!.map((i) => [i.contentId, i.preview.text])).toEqual([[contentId, 'v3 #sports #news']]);
      }
    });

    it('requires updates to keep the original type and content type', async () => {
      const alice = await ctx.register('alice');
      const { contentId } = (await storeText(alice, 'words #news')).json();
      const res = await upload({ ...alice, type: 'image', contentId, tags: 'news' }, { name: 'pixel.png', type: 'image/png', data: PNG });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('an update must have the same content type as the original (text/plain), got image/png');
      const link = await storePost(alice, { type: 'link', contentId, url: 'https://news.example/a', tags: ['news'] });
      expect(link.json().error).toBe('an update must have the same content type as the original (text/plain), got text/uri-list');
      const img = (await upload({ ...alice, type: 'image', tags: 'pics' }, { name: 'pixel.png', type: 'image/png', data: PNG })).json().contentId;
      const jpeg = await upload({ ...alice, type: 'image', contentId: img, tags: 'pics' }, { name: 'pixel.jpg', type: 'image/jpeg', data: JPEG });
      expect(jpeg.json().error).toBe('an update must have the same content type as the original (image/png), got image/jpeg');
      expect((await getContent(contentId)).text).toBe('words #news');
      expect((await storeText(alice, 'more words #news', { contentId })).statusCode).toBe(200);
      expect((await getContent(contentId)).text).toBe('more words #news');
    });

    it('shows a changed username on every record at once, without rewriting the index', async () => {
      const alice = await ctx.register('alice');
      const compacted = (await storeText(alice, 'old post #news #mumbai')).json().contentId;
      await ctx.compact();
      ctx.clock.now += 1000;
      const fresh = (await storeText(alice, 'new post #news')).json().contentId;

      const patch = await ctx.app.inject({
        method: 'PATCH',
        url: `/users/${alice.userId}`,
        payload: { ...alice, username: 'alicia' },
      });
      expect(patch.statusCode).toBe(200);

      const publisher = { userId: alice.userId, username: 'alicia' };
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

    it('lets only the owner set content for deletion, which hides it at once and refuses updates and likes', async () => {
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const { contentId } = (await storeText(alice, 'doomed #news')).json();
      const del = (headers: Record<string, string>, id = contentId) => ctx.app.inject({ method: 'DELETE', url: `/content/${id}`, headers });

      expect((await del(as(bob))).statusCode).toBe(403);
      expect((await del({ ...as(alice), authorization: 'Bearer nope' })).statusCode).toBe(401);
      // A gateway that signs in with its own Authorization header passes the client's on as X-Forwarded-Authorization.
      expect((await del({ ...as(bob), authorization: 'Bearer the-gateways-own-token', 'x-forwarded-authorization': `Bearer ${bob.apiKey}` })).statusCode).toBe(403);
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

    it('refuses an update when its content is set for deletion while the update is being written', async () => {
      const alice = await ctx.register('alice');
      const { contentId } = (await storeText(alice, 'v1 #news')).json();
      const createdAt = ctx.clock.now;
      const putFile = ctx.content.putFile.bind(ctx.content);
      vi.spyOn(ctx.content, 'putFile').mockImplementationOnce(async (...args) => {
        await ctx.app.inject({ method: 'DELETE', url: `/content/${contentId}`, payload: { ...alice } });
        return putFile(...args);
      });

      const refused = await storeText(alice, 'v2 #news', { contentId });
      expect([refused.statusCode, refused.json().error]).toEqual([409, 'content is set for deletion']);
      // Nothing was pushed for the update: the tail holds the post's entry and the deletion's tombstone.
      expect(await tailLines(ctx.hot, 'news')).toEqual([
        { contentId, createdAt, updatedAt: createdAt, likes: 0, aiGenerated: false, moderated: false },
        { tombstone: true, contentId, before: null, createdAt },
      ]);
      expect((await feed('tags=news')).days).toEqual([]);
      expect((await ctx.compact()).deleted).toEqual([contentId]);
      expect(await ctx.db.selectFrom('content').selectAll().execute()).toEqual([]);
      expect(await ctx.content.getMeta(contentId)).toBeNull();
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
        publisher: { userId: alice.userId, username: 'alice' },
        mimeType: 'text/plain',
        aiGenerated: false,
        comments: false,
        preview: { kind: 'text', text: 'popular mumbai #news #mumbai' },
        tags: ['news', 'mumbai'],
        likes: 1,
        moderated: false,
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

      expect((await ctx.app.inject({ method: 'GET', url: '/feed?tags=news/india' })).statusCode).toBe(400);
    });

    it('returns a chronological feed newest first, whatever the likes or the hashtag, across cursor pages', async () => {
      const alice = await ctx.register('alice');
      const fans: User[] = [];
      for (let i = 0; i < 5; i++) fans.push(await ctx.register(`fan${i}`));
      const posts: string[] = [];
      for (let i = 0; i < 6; i++) {
        posts.push((await storeText(alice, `post ${i} #news`)).json().contentId);
        ctx.clock.now += 1000;
      }
      // posts[i] gets 5 - i likes: the older the post, the more it has.
      for (const [i, contentId] of posts.entries()) {
        for (const fan of fans.slice(0, 5 - i)) await ctx.app.inject({ method: 'POST', url: '/like', payload: { ...fan, contentId } });
      }
      await ctx.compact();
      // Two more, which are only in the tail.
      for (const text of ['post 6 #sports', 'post 7 #news']) {
        posts.push((await storeText(alice, text)).json().contentId);
        ctx.clock.now += 1000;
      }
      const order = (f: Feed) => f.days.flatMap((d) => ids(d, 'news'));
      /** The records as a client shows them: each day's, under whichever hashtag, newest first. */
      const shown = (f: Feed) =>
        f.days.flatMap((d) =>
          Object.values(d.tags)
            .flat()
            .sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1))
            .map((i) => i.contentId),
        );
      const [p0, p1, p2, p3, p4, p5, p6, p7] = posts;

      // Popular, which is what a feed is unless it says: by likes, with an unliked post in the fresh slot.
      for (const query of ['tags=news', 'tags=news&algorithm=popular']) {
        const popular = order(await feed(query));
        expect(popular).toHaveLength(7);
        expect(popular.filter((id) => id !== p5 && id !== p7)).toEqual([p0, p1, p2, p3, p4]);
      }
      expect(order(await feed('tags=news&algorithm=chronological'))).toEqual([p7, p5, p4, p3, p2, p1, p0]);

      // The newest of both hashtags, not a share of each.
      const full = await feed('tags=news,sports&algorithm=chronological');
      expect(shown(full)).toEqual([p7, p6, p5, p4, p3, p2, p1, p0]);
      const newest = await feed('tags=news,sports&algorithm=chronological&limit=3');
      expect(shown(newest)).toEqual([p7, p6, p5]);
      expect(ids(newest.days[0], 'sports')).toEqual([p6]);

      ctx.config.feed.pageSize = 3;
      const paged: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const f: Feed = await feed(`tags=news,sports&algorithm=chronological${cursor ? `&cursor=${cursor}` : ''}`);
        paged.push(...shown(f));
        cursor = f.nextCursor;
        if (!cursor) break;
      }
      expect(paged).toEqual(shown(full));

      // A cursor carries on the feed it was given for.
      const first = await feed('tags=news&algorithm=chronological');
      expect(first.nextCursor).toBeTruthy();
      const other = await ctx.app.inject({ method: 'GET', url: `/feed?tags=news&cursor=${first.nextCursor}` });
      expect([other.statusCode, other.json().error]).toEqual([400, 'cursor does not match the requested tags/hours/algorithm/addRelated/aiGenerated/moderated']);
      for (const algorithm of ['balanced', 'random', '']) {
        expect((await ctx.app.inject({ method: 'GET', url: `/feed?tags=news&algorithm=${algorithm}` })).statusCode).toBe(400);
      }
    });

    it('returns the posts of the past 1 hour to 90 days, of the windows a feed can be asked for', async () => {
      const alice = await ctx.register('alice');
      const t0 = ctx.clock.now;
      const ages = [30 * 60_000, 3 * HOUR, 10 * HOUR, 36 * HOUR, 5 * DAY, 25 * DAY, 45 * DAY, 80 * DAY];
      const posts: string[] = [];
      for (const [i, age] of ages.entries()) {
        ctx.clock.now = t0 - age;
        posts.push((await storeText(alice, `post ${i} #news`)).json().contentId);
      }
      ctx.clock.now = t0;
      await ctx.compact();

      // Posts older than the window only fill a page the window left room on, and are marked as that.
      const within = async (hours: number) => (await feed(`tags=news&hours=${hours}`)).days.filter((d) => !d.extended).flatMap((d) => ids(d, 'news'));
      const expected: [hours: number, posts: number][] = [
        [1, 1], [2, 1], [4, 2], [8, 2], [12, 3], [24, 3], [48, 4], [72, 4], [168, 5], [336, 5], [504, 5], [720, 6], [1440, 7], [2160, 8],
      ];
      for (const [hours, count] of expected) expect(await within(hours), `hours=${hours}`).toEqual(posts.slice(0, count));
      expect((await feed('tags=news')).days.filter((d) => !d.extended).flatMap((d) => ids(d, 'news'))).toEqual(posts.slice(0, 3));
      expect((await feed('tags=news&hours=1')).count).toBe(8);

      for (const hours of [0, 3, 6, 1.5, 500, 2161, 4320, 'day']) {
        expect((await ctx.app.inject({ method: 'GET', url: `/feed?tags=news&hours=${hours}` })).statusCode, `hours=${hours}`).toBe(400);
      }
    });

    it('records whether the publisher created content with AI, keeps it across updates, and filters feeds by it', async () => {
      const alice = await ctx.register('alice');
      const human = (await storeText(alice, 'written by hand #news')).json();
      expect(human).toMatchObject({ aiGenerated: false });
      ctx.clock.now += 1000;
      const ai = (await storeText(alice, 'written with a model #news #tech', { aiGenerated: true })).json();
      expect(ai).toMatchObject({ aiGenerated: true });
      const img = await upload({ ...alice, type: 'image', aiGenerated: 'true', tags: 'pixel' }, { name: 'pixel.png', type: 'image/png', data: PNG });
      expect(img.json()).toMatchObject({ aiGenerated: true });
      expect((await storeText(alice, 'unsure #news', { aiGenerated: 'maybe' })).statusCode).toBe(400);
      expect((await ctx.app.inject({ method: 'GET', url: '/feed?tags=news&aiGenerated=maybe' })).statusCode).toBe(400);

      expect((await getContent(ai.contentId)).aiGenerated).toBe(true);
      expect((await getContent(human.contentId)).aiGenerated).toBe(false);
      expect(await ctx.content.getMeta(ai.contentId)).toMatchObject({ aiGenerated: true });

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

      // An update that doesn't say keeps the flag; changing only the flag is an update.
      ctx.clock.now += 1000;
      expect((await storeText(alice, 'revised with a model #news #tech', { contentId: ai.contentId })).json()).toMatchObject({ aiGenerated: true });
      const flipped = await storeText(alice, 'written by hand #news', { contentId: human.contentId, aiGenerated: true });
      expect(flipped.json()).toMatchObject({ contentId: human.contentId, aiGenerated: true });
      expect(flipped.json()).not.toHaveProperty('unchanged');
      expect((await storeText(alice, 'written by hand #news', { contentId: human.contentId })).json()).toMatchObject({ unchanged: true });
      expect((await getContent(human.contentId)).aiGenerated).toBe(true);
      expect(await newsIds('&aiGenerated=false')).toEqual([]);
      expect((await news('&aiGenerated=true')).map((i) => [i.contentId, i.preview.text])).toEqual([
        [ai.contentId, 'revised with a model #news #tech'],
        [human.contentId, 'written by hand #news'],
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

      // The feed routes alone, as a function serves them, given no database to use.
      const { db: _, app: __, ...stores } = ctx;
      const app = await buildApp({ ...stores, now: () => ctx.clock.now }, { logger: false }, ['feed']);
      try {
        const res = await app.inject({ method: 'GET', url: '/feed?tags=news' });
        expect(res.statusCode, res.body).toBe(200);
        expect(ids(res.json().days[0], 'news')).toEqual([b, a]);
        const following = await app.inject({ method: 'GET', url: `/feed/following?userId=${bob.userId}` });
        expect(following.statusCode, following.body).toBe(200);
        expect(following.json().records.map((r: FeedItem) => r.contentId)).toEqual([b, a]);
      } finally {
        await app.close();
      }
    });
  });
}
