import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { authorIndex } from '../src/tagfeed/layout.js';
import { DAY, HOUR } from '../src/time.js';
import { as, BASE_ENV, createTestContext, type Feed, JPEG, listedUnder, multipart, PNG, queued, requests, sha256, TARGETS, type TestContext, type User } from './helpers.js';

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

    const { store: storePost, storeText, like, unlike, feed } = requests(() => ctx);
    const upload = (fields: Record<string, string>, file: { name: string; type: string; data: Buffer }) => {
      const mp = multipart(fields, file);
      return ctx.app.inject({ method: 'POST', url: '/store', payload: mp.payload, headers: mp.headers });
    };
    const getContent = async (contentId: string) => (await ctx.app.inject({ method: 'GET', url: `/content/${contentId}` })).json();
    /** The posts a page lists under `tag`, in the page's order. */
    const ids = (f: Feed, tag: string) => listedUnder(f, tag).map((i) => i.contentId);
    /** A page's posts in its order, and the hashtag each is listed under. */
    const listed = (f: Feed) => f.records.map((i) => [i.contentId, i.listedUnder]);

    it('identifies users by UUID and keeps usernames unique', async () => {
      const a = await ctx.registration({ username: 'alice' });
      expect(a.statusCode).toBe(201);
      expect(a.json()).toEqual({ userId: expect.any(String), username: 'alice', language: 'en', apiKey: expect.stringMatching(/^ev_/), note: expect.any(String) });
      const dup = await ctx.app.inject({ method: 'POST', url: '/register', payload: { username: 'alice' } });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error).toBe('username is already taken');
      const profile = await ctx.app.inject({ method: 'GET', url: `/users/${a.json().userId}` });
      expect(profile.json()).toEqual({
        userId: a.json().userId,
        username: 'alice',
        createdAt: expect.any(String),
        banned: false,
        bio: null,
        links: [],
        avatarUrl: null,
        pinnedContentIds: [],
        admin: false,
        moderator: false,
        moderates: [],
      });

    });

    it('keeps a user under the username they registered with: none is changed', async () => {
      await ctx.register('alice');
      const bob = await ctx.register('bob');
      const patch = (payload: Record<string, unknown>) => ctx.app.inject({ method: 'PATCH', url: `/users/${bob.userId}`, payload: { userId: bob.userId, apiKey: bob.apiKey, ...payload } });
      const FIXED = "a username can't be changed: an account keeps the name it was registered with";
      const named = async () => (await ctx.db.selectFrom('users').select(['username', 'username_folded', 'language', 'messages']).where('id', '=', bob.userId).executeTakeFirstOrThrow());
      const before = await named();

      // A name nobody has, one that is taken, and their own in other letters: a request that sends another name than theirs is refused.
      for (const username of ['robert', 'alice', 'Bob', 'bób']) {
        const refused = await patch({ username });
        expect([refused.statusCode, refused.json()], username).toEqual([400, { error: FIXED }]);
      }
      // All of it: what else it sends, which is theirs to change, isn't changed.
      const mixed = await patch({ username: 'robert', language: 'en', messages: false });
      expect([mixed.statusCode, mixed.json()]).toEqual([400, { error: FIXED }]);
      // What isn't a username is no more one here than when registering.
      for (const username of ['', '   ', 'x'.repeat(65), null, 7]) expect((await patch({ username, messages: false })).statusCode, String(username)).toBe(400);
      expect(await named()).toEqual(before);
      expect(before).toMatchObject({ username: 'bob', username_folded: 'bob' });

      // The name they have is no change, which is what a client sends that sends back what registering gave it: alone, it is nothing to update.
      const same = await patch({ username: 'bob' });
      expect([same.statusCode, same.json().error]).toEqual([400, 'nothing to update: provide language, messages, showFollowing, showFollowers, bio or links']);
      expect((await patch({ username: ' bob ', showFollowing: true })).json()).toMatchObject({ username: 'bob', showFollowing: true });
      // All that registering gave them, sent back with a change, as a client that keeps it sends it.
      expect((await ctx.app.inject({ method: 'PATCH', url: `/users/${bob.userId}`, payload: { ...bob, showFollowers: true } })).json()).toMatchObject({ username: 'bob', showFollowers: true });

      // They are who they were to anyone: by their profile, by their key, by the credit on a post, and to whoever registers.
      const { contentId } = (await storeText(bob, 'hello #news')).json();
      expect((await ctx.app.inject({ method: 'GET', url: `/users/${bob.userId}` })).json()).toMatchObject({ username: 'bob' });
      expect((await ctx.app.inject({ method: 'GET', url: '/whoami', headers: as(bob) })).json()).toMatchObject({ username: 'bob' });
      expect((await getContent(contentId)).publisher).toMatchObject({ userId: bob.userId, username: 'bob' });
      await ctx.compact();
      expect((await feed('tags=news')).records.map((r) => r.publisher)).toEqual([{ userId: bob.userId, username: 'bob' }]);
      expect((await ctx.app.inject({ method: 'POST', url: '/register', payload: { username: 'robert' } })).statusCode).not.toBe(409);
      expect((await ctx.app.inject({ method: 'POST', url: '/register', payload: { username: 'bob' } })).statusCode).toBe(409);

      // What is theirs to change answers with the name they have.
      expect((await patch({ messages: false })).json()).toEqual({ userId: bob.userId, username: 'bob', language: 'en', messages: false, showFollowing: true, showFollowers: true, bio: null, links: [], avatarUrl: null });
    });

    it('lets a user post as soon as they register, and only them change their profile', async () => {
      const bob = await ctx.register('bob');
      expect((await storeText(bob, 'hello #news')).statusCode).toBe(201);
      const other = await ctx.register('mallory');
      const patch = (payload: Record<string, unknown>) => ctx.app.inject({ method: 'PATCH', url: `/users/${bob.userId}`, payload });
      expect((await patch({ ...other, messages: false })).statusCode).toBe(403);
      // Whatever they send: someone else is told the profile isn't theirs before they are told what of it can't be changed.
      expect((await patch({ ...other, username: 'robert' })).statusCode).toBe(403);
      const nothing = await patch({ userId: bob.userId, apiKey: bob.apiKey });
      expect([nothing.statusCode, nothing.json().error]).toEqual([400, 'nothing to update: provide language, messages, showFollowing, showFollowers, bio or links']);
      expect((await ctx.app.inject({ method: 'GET', url: '/whoami', headers: as(bob) })).json()).toMatchObject({ username: 'bob', messages: true });
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

      // One row in the feed queue for each hashtag's index, and one for its publisher's own.
      expect(await queued(ctx)).toEqual([authorIndex(alice.userId), ...tags].map((tag) => `${contentId} ${tag}`).sort());
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

      const record = async (tag: string) => (await feed(`tags=${tag}`)).records[0]!;
      await ctx.compact();
      expect((await record('pics')).preview).toEqual(img.json().preview);
      expect((await record('music')).preview).toEqual(aud.json().preview);
      expect(await record('news')).toMatchObject({ mimeType: 'text/uri-list', preview: lnk.json().preview });
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

    it('writes over a post when it is updated, with the caption the file comes with, and stores nothing for the file and caption it has', async () => {
      const alice = await ctx.register('alice');
      const send = (fields: Record<string, string>) => upload({ ...alice, type: 'image', tags: 'pics', ...fields }, { name: 'pixel.png', type: 'image/png', data: PNG });
      const createdAt = new Date(ctx.clock.now).toISOString();
      const { contentId } = (await send({ text: 'first caption' })).json();
      // The meta file keeps the hash of the file as stored, which is what an update's file is compared by.
      const first = await ctx.content.getMeta(contentId);
      expect(first).toMatchObject({ sha256: sha256(PNG), updatedAt: ctx.clock.now });
      ctx.clock.now += 1000;
      // The file the post has, with the caption it has, changes nothing, and nothing is written.
      const same = await send({ contentId, text: 'first caption' });
      expect(same.statusCode, same.body).toBe(200);
      expect(same.json()).toEqual({ contentId, unchanged: true });
      expect(await ctx.content.getMeta(contentId)).toEqual(first);
      // With another caption, or none, the same file is an update like any other.
      expect((await send({ contentId, text: 'second caption' })).json()).toMatchObject({ contentId, preview: { kind: 'image', text: 'second caption' } });
      ctx.clock.now += 1000;
      const bare = (await send({ contentId })).json();
      expect(bare).not.toHaveProperty('version');
      expect(bare.preview).not.toHaveProperty('text');
      const updatedAt = new Date(ctx.clock.now).toISOString();
      ctx.clock.now += 1000;
      expect((await send({ contentId })).json()).toEqual({ contentId, unchanged: true });
      const body = await getContent(contentId);
      expect(body).not.toHaveProperty('text');
      expect(body).toMatchObject({ createdAt, updatedAt, size: PNG.length });
      await ctx.compact();
      expect((await feed('tags=pics')).records.map((i) => [i.contentId, i.preview.text, i.createdAt, i.updatedAt])).toEqual([
        [contentId, undefined, createdAt, updatedAt],
      ]);
      // One row, and one set of objects: the updates wrote over them.
      expect(await ctx.db.selectFrom('content').select('id').execute()).toEqual([{ id: contentId }]);
      expect((await readdir(join(ctx.dir, 'content', 'content'))).sort()).toEqual([contentId, `${contentId}.meta.json`]);
    });

    it('tells the file a post has by its hash: another file is an update, and so is any file where the post has no hash yet', async () => {
      const alice = await ctx.register('alice');
      const clip = (data: Buffer, fields: Record<string, unknown> = {}) =>
        storePost(alice, { type: 'video', content: data.toString('base64'), contentEncoding: 'base64', contentType: 'video/mp4', tags: ['clips'], ...fields });
      const meta = (contentId: string) => ctx.content.getMeta(contentId);
      const raw = async (contentId: string) => (await ctx.app.inject({ method: 'GET', url: `/content/${contentId}/raw` })).rawPayload;
      const one = Buffer.from('one clip');
      const other = Buffer.from('another clip, of another length');

      const { contentId } = (await clip(one)).json();
      expect(await meta(contentId)).toMatchObject({ sha256: sha256(one), size: one.length });
      expect((await clip(one, { contentId })).json()).toEqual({ contentId, unchanged: true });
      // The same file with other hashtags is an update, which stores it with them.
      expect((await clip(one, { contentId, tags: ['clips', 'travel'] })).json()).toMatchObject({ contentId, tags: ['clips', 'travel'] });
      expect((await clip(one, { contentId, tags: ['travel', 'clips'] })).json()).toEqual({ contentId, unchanged: true });

      ctx.clock.now += 1000;
      const updated = await clip(other, { contentId, tags: ['clips', 'travel'] });
      expect(updated.statusCode, updated.body).toBe(200);
      expect(updated.json()).not.toHaveProperty('unchanged');
      expect((await raw(contentId)).equals(other)).toBe(true);
      expect(await meta(contentId)).toMatchObject({ sha256: sha256(other), size: other.length, updatedAt: ctx.clock.now });
      // The hash is of the file the post has now, not of one it had.
      expect((await clip(other, { contentId, tags: ['clips', 'travel'] })).json()).toEqual({ contentId, unchanged: true });
      expect((await clip(one, { contentId, tags: ['clips', 'travel'] })).json()).not.toHaveProperty('unchanged');
      expect((await raw(contentId)).equals(one)).toBe(true);

      // A meta file written before the server kept hashes has none: the file is stored, and compared from then on.
      const { sha256: _, ...before } = (await meta(contentId))!;
      await ctx.content.putMeta(before);
      ctx.clock.now += 1000;
      expect((await clip(one, { contentId, tags: ['clips', 'travel'] })).json()).not.toHaveProperty('unchanged');
      expect(await meta(contentId)).toMatchObject({ sha256: sha256(one), updatedAt: ctx.clock.now });
      expect((await clip(one, { contentId, tags: ['clips', 'travel'] })).json()).toEqual({ contentId, unchanged: true });

      // A text or a link post is compared by what it says, and keeps no hash.
      const text = (await storeText(alice, 'words #news')).json();
      expect(await meta(text.contentId)).not.toHaveProperty('sha256');
      expect((await storeText(alice, 'words #news', { contentId: text.contentId })).json()).toEqual({ contentId: text.contentId, unchanged: true });
    });

    it("takes only the server's hashtags in server mode, and gives a post the ones its publisher chose of them", async () => {
      await ctx.close();
      ctx = await createTestContext(target, { tagging: { mode: 'server', serverTags: ['Local', '#austin', 'Music'] }, postRateLimitPerMinute: 1 });
      const alice = await ctx.register('alice');
      const refused = (res: Awaited<ReturnType<typeof storeText>>, error: string) => {
        expect(res.statusCode, res.body).toBe(400);
        expect(res.json().error).toBe(error);
      };

      // The post has the hashtags it was sent with, not every one the server allows.
      const res = await storeText(alice, 'Flooding downtown', { tags: ['#Austin'] });
      expect(res.statusCode, res.body).toBe(201);
      const { contentId } = res.json();
      expect(res.json().tags).toEqual(['austin']);
      expect((await getContent(contentId)).tags).toEqual(['austin']);
      expect(await queued(ctx)).toEqual([authorIndex(alice.userId), 'austin'].map((tag) => `${contentId} ${tag}`).sort());
      await ctx.compact();
      expect(ids(await feed('tags=austin'), 'austin')).toEqual([contentId]);
      for (const tag of ['local', 'music']) expect((await feed(`tags=${tag}`)).records).toEqual([]);

      // A hashtag that isn't the server's refuses the post, even beside ones that are: nothing is dropped unsaid.
      // All of it before the limit on posts a minute, which would otherwise refuse a post this soon after the last.
      const notAllowed = (tag: string) => `#${tag} is not one of this server's hashtags, which GET /tagging lists`;
      refused(await storeText(alice, 'Match report', { tags: ['sports'] }), notAllowed('sports'));
      refused(await storeText(alice, 'Match report', { tags: 'local, sports, austin' }), notAllowed('sports'));
      refused(await upload({ ...alice, type: 'image', tags: 'pixel' }, { name: 'pixel.png', type: 'image/png', data: PNG }), notAllowed('pixel'));
      refused(await storeText(alice, 'Flooding downtown', { contentId, tags: ['austin', 'weather'] }), notAllowed('weather'));
      // And a post must choose some, as in user mode.
      const required = "tags is required: choose from this server's hashtags, which GET /tagging lists";
      for (const tags of [undefined, [], '', ' , ']) refused(await storeText(alice, 'Flooding downtown', { tags }), required);
      refused(await upload({ ...alice, type: 'image' }, { name: 'pixel.png', type: 'image/png', data: PNG }), required);
      refused(await storeText(alice, 'Flooding downtown', { contentId }), required);
      expect(await ctx.db.selectFrom('content').select('id').execute()).toEqual([{ id: contentId }]);

      // Updates choose among them like new posts: the same ones change nothing, others move the post.
      expect((await storeText(alice, 'Flooding downtown', { contentId, tags: 'austin' })).json()).toEqual({ contentId, unchanged: true });
      ctx.clock.now += 60_000;
      const moved = await storeText(alice, 'Flooding downtown', { contentId, tags: 'music, LOCAL' });
      expect(moved.statusCode, moved.body).toBe(200);
      expect(moved.json().tags).toEqual(['music', 'local']);
      // Out of the hashtag it left at once, and in the ones it joined after the compactor's next run.
      expect((await feed('tags=austin')).records).toEqual([]);
      await ctx.compact();
      expect((await feed('tags=austin')).records).toEqual([]);
      expect(ids(await feed('tags=local'), 'local')).toEqual([contentId]);
      ctx.clock.now += 60_000;
      const img = await upload({ ...alice, type: 'image', tags: 'local, austin, music' }, { name: 'pixel.png', type: 'image/png', data: PNG });
      expect(img.json()).toMatchObject({ tags: ['local', 'austin', 'music'], preview: { kind: 'image' } });
    });

    it('says how posts are tagged, with every hashtag the server allows, at GET /tagging', async () => {
      const tagging = async () => {
        const res = await ctx.app.inject({ method: 'GET', url: '/tagging' });
        expect(res.statusCode, res.body).toBe(200);
        return res.json();
      };
      // By default publishers choose freely, so there's no list.
      expect(await tagging()).toEqual({ mode: 'user', allowedTags: null, maxTags: 10 });

      await ctx.close();
      // More than a post can have: the limit of 10 is on a post, not on what the server allows.
      const serverTags = ['Local', '#austin', ...Array.from({ length: 12 }, (_, i) => `topic${i}`)];
      ctx = await createTestContext(target, { tagging: { mode: 'server', serverTags } });
      const allowedTags = ['local', 'austin', ...serverTags.slice(2)];
      // Needs no key, and lists them all as configured, before any post has used one.
      expect(await tagging()).toEqual({ mode: 'server', allowedTags, maxTags: 10 });
      expect((await ctx.app.inject({ method: 'GET', url: '/tags' })).json()).toEqual({ tags: [] });

      // Every one of them is accepted on a post, and a post still takes at most 10.
      const alice = await ctx.register('alice');
      for (const tags of [allowedTags.slice(0, 7), allowedTags.slice(7)]) {
        const res = await storeText(alice, `About ${tags[0]}`, { tags });
        expect(res.statusCode, res.body).toBe(201);
        expect(res.json().tags).toEqual(tags);
      }
      const many = await storeText(alice, 'About everything', { tags: allowedTags.slice(0, 11) });
      expect([many.statusCode, many.json().error]).toEqual([400, 'at most 10 hashtags are allowed, got 11']);
    });

    it("doesn't start in server mode without a usable list of hashtags", () => {
      const load = (env: Record<string, string>) => loadConfig({}, { ...BASE_ENV, ...env }).tagging;
      expect(load({})).toMatchObject({ mode: 'user', serverTags: [] });
      expect(load({ TAGGING_MODE: 'server', TAGGING_SERVER_TAGS: 'News, #local sports' })).toMatchObject({ mode: 'server', serverTags: ['news', 'local', 'sports'] });
      expect(load({ TAGGING_MODE: 'server', TAGGING_SERVER_TAGS: Array.from({ length: 40 }, (_, i) => `t${i}`).join(',') }).serverTags).toHaveLength(40);
      expect(() => load({ TAGGING_MODE: 'server' })).toThrow('server tagging needs at least one hashtag in TAGGING_SERVER_TAGS');
      expect(() => load({ TAGGING_MODE: 'server', TAGGING_SERVER_TAGS: 'news, 日本' })).toThrow(/日本.* is not a usable hashtag/);
    });

    it('takes only the types of post that are on, and keeps the posts it has of a type turned off since', async () => {
      await ctx.close();
      // A server of pictures and links, and of one post a minute: a refusal comes before the limit.
      ctx = await createTestContext(target, { postTypes: { text: false, video: false, audio: false }, postRateLimitPerMinute: 1 });
      const alice = await ctx.register('alice');
      const off = (type: string) => [400, `this server doesn't take ${type} posts: the types it takes are image, link`];
      const refusal = (res: Awaited<ReturnType<typeof storeText>>) => [res.statusCode, res.json().error];

      const img = await upload({ ...alice, type: 'image', tags: 'pixel' }, { name: 'pixel.png', type: 'image/png', data: PNG });
      expect(img.statusCode, img.body).toBe(201);
      ctx.clock.now += 60_000;
      const link = await storePost(alice, { type: 'link', url: 'https://news.example/story', tags: ['news'] });
      expect(link.statusCode, link.body).toBe(201);

      // Straight after a post, when one that could be stored would be past the limit.
      expect(refusal(await storeText(alice, 'Some words #news'))).toEqual(off('text'));
      expect(refusal(await upload({ ...alice, type: 'video', tags: 'clips' }, { name: 'clip.mp4', type: 'video/mp4', data: PNG }))).toEqual(off('video'));
      expect(refusal(await storePost(alice, { type: 'audio', content: PNG.toString('base64'), contentEncoding: 'base64', contentType: 'audio/mpeg', tags: ['songs'] }))).toEqual(off('audio'));
      // Whoever sends it, and before its file is looked at: no key is needed to be told.
      expect(refusal(await ctx.app.inject({ method: 'POST', url: '/store', payload: { type: 'text', text: 'Some words', tags: ['news'] } }))).toEqual(off('text'));
      expect(await ctx.db.selectFrom('content').select('id').execute()).toHaveLength(2);

      // A type turned off later, which the server reads when it starts: here, under a running one.
      ctx.config.postTypes.link = false;
      const { contentId } = link.json();
      ctx.clock.now += 60_000;
      const gone = [400, "this server doesn't take link posts: the types it takes are image"];
      expect(refusal(await storePost(alice, { type: 'link', url: 'https://news.example/other', tags: ['news'] }))).toEqual(gone);
      // No update of the post it has, not even one that changes nothing...
      expect(refusal(await storePost(alice, { type: 'link', url: 'https://news.example/story', tags: ['news'], contentId }))).toEqual(gone);
      // ...which stays as it was: read, liked, in feeds, and its publisher's to delete.
      expect(await getContent(contentId)).toMatchObject({ contentId, preview: { kind: 'link', url: 'https://news.example/story' } });
      expect((await like(await ctx.register('bob'), contentId)).statusCode).toBe(201);
      await ctx.compact();
      expect(ids(await feed('tags=news'), 'news')).toEqual([contentId]);
      expect((await ctx.app.inject({ method: 'DELETE', url: `/content/${contentId}`, headers: as(alice) })).statusCode).toBe(202);
    });

    it('takes every type of post unless one is turned off, and does not start with all of them off', () => {
      const load = (env: Record<string, string> = {}) => loadConfig({}, { ...BASE_ENV, ...env }).postTypes;
      const all = { text: true, image: true, video: true, audio: true, link: true };
      expect(load()).toEqual(all);
      expect(load({ POST_TYPE_TEXT: '', POST_TYPE_LINK: 'true' })).toEqual(all);
      expect(load({ POST_TYPE_VIDEO: 'false', POST_TYPE_AUDIO: '0' })).toEqual({ ...all, video: false, audio: false });
      const onlyImages = { POST_TYPE_TEXT: 'false', POST_TYPE_VIDEO: 'false', POST_TYPE_AUDIO: 'false', POST_TYPE_LINK: 'false' };
      expect(load(onlyImages)).toEqual({ text: false, image: true, video: false, audio: false, link: false });
      expect(() => load({ ...onlyImages, POST_TYPE_IMAGE: 'false' })).toThrow(/the server needs a type of post to take/);
    });

    it("normalises the publisher's hashtags, from a list or one form field, and refuses ones it can't use", async () => {
      const alice = await ctx.register('alice');
      const chosen = await storeText(alice, 'Flooding in Mumbai #news', { tags: ['#Weather', 'mumbai', 'weather'] });
      expect(chosen.statusCode, chosen.body).toBe(201);
      expect(chosen.json().tags).toEqual(['weather', 'mumbai']);
      expect((await queued(ctx)).filter((row) => row.endsWith(' news'))).toEqual([]);

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

    it("requires the publisher's hashtags by default, before the limit on posts a minute, and updates the post when they change", async () => {
      await ctx.close();
      ctx = await createTestContext(target, { postRateLimitPerMinute: 1 });
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
      await ctx.compact();
      expect((await feed('tags=news')).records).toEqual([]);
      expect(ids(await feed('tags=weather'), 'weather')).toEqual([contentId]);
    });

    it('only lets the owner update; an update leaves the hashtags it dropped at once, and joins the ones it gave on the next run', async () => {
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      expect((await storeText({ ...alice, apiKey: bob.apiKey }, 'hi #news')).statusCode).toBe(401);

      const { contentId } = (await storeText(alice, 'v1 #news')).json();
      expect((await storeText(bob, 'hijack #news', { contentId })).statusCode).toBe(403);
      expect((await storeText(alice, 'v1 #news', { contentId })).json()).toEqual({ contentId, unchanged: true });
      await ctx.compact();
      expect(ids(await feed('tags=news'), 'news')).toEqual([contentId]);

      ctx.clock.now += 60_000;
      const upd = await storeText(alice, 'v2 #sports', { contentId });
      expect(upd.statusCode).toBe(200);
      expect(upd.json()).toMatchObject({ contentId, tags: ['sports'] });
      expect(upd.json()).not.toHaveProperty('version');
      expect((await getContent(contentId)).tags).toEqual(['sports']);
      // The bytes are written over: there is one version, at one address.
      const raw = await ctx.app.inject({ method: 'GET', url: `/content/${contentId}/raw` });
      expect([raw.body, raw.headers['content-length']]).toEqual(['v2 #sports', '10']);

      // The index of #news still holds the post's entry, but its summary no longer carries the hashtag, so
      // feeds leave it out until the compactor removes it. It isn't in #sports until then either.
      expect((await feed('tags=news')).records).toEqual([]);
      expect((await feed('tags=sports')).records).toEqual([]);
      expect(await queued(ctx)).toEqual([authorIndex(alice.userId), 'news', 'sports'].map((tag) => `${contentId} ${tag}`).sort());
      await ctx.compact();
      expect((await feed('tags=news')).records).toEqual([]);
      const sports = await feed('tags=sports');
      expect(sports.records.map((i) => [i.contentId, i.preview.text])).toEqual([[contentId, 'v2 #sports']]);
      expect(await queued(ctx)).toEqual([]);

      // A hashtag given back shows the post again, once the compactor has run.
      ctx.clock.now += 60_000;
      expect((await storeText(alice, 'v3 #sports #news', { contentId })).json()).toMatchObject({ tags: ['sports', 'news'] });
      expect((await feed('tags=news')).records).toEqual([]);
      // Where it already was, it shows as it now is.
      expect((await feed('tags=sports')).records.map((i) => i.preview.text)).toEqual(['v3 #sports #news']);
      await ctx.compact();
      expect((await feed('tags=news')).records.map((i) => [i.contentId, i.preview.text])).toEqual([[contentId, 'v3 #sports #news']]);
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

      // Neither the posts nor their likes are in the feed until the compactor has run.
      const news = async () => (await feed('tags=news')).records.map((i) => [i.contentId, i.likes]);
      expect(await news()).toEqual([]);

      await ctx.compact();
      expect(await news()).toEqual([[first, 2], [second, 0]]);
      // A like on already-compacted content is picked up by the next run.
      expect((await like(bob, second)).json()).toMatchObject({ likes: 1 });
      expect((await like(carol, second)).json()).toMatchObject({ likes: 2 });
      expect((await like(alice, second)).json()).toMatchObject({ likes: 3 });
      ctx.clock.now += 1000;
      expect((await ctx.compact()).tags).toEqual([authorIndex(alice.userId), 'news']);
      expect(await news()).toEqual([[second, 3], [first, 2]]);
    });

    it('takes a like back once, which the next compactor run writes into the day indexes, and lets it be given again', async () => {
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const carol = await ctx.register('carol');
      const first = (await storeText(alice, 'first #news')).json().contentId;
      ctx.clock.now += 1000;
      const second = (await storeText(alice, 'second #news')).json().contentId;
      for (const u of [bob, carol]) expect((await like(u, first)).statusCode).toBe(201);
      expect((await like(bob, second)).statusCode).toBe(201);
      await ctx.compact();
      const news = async () => (await feed('tags=news')).records.map((i) => [i.contentId, i.likes]);
      const taken = async (res: Awaited<ReturnType<typeof unlike>>) => [res.statusCode, res.json()];
      const likesOf = async (contentId: string) => (await ctx.db.selectFrom('likes').select('user_id').where('content_id', '=', contentId).execute()).map((r) => r.user_id).sort();
      expect(await news()).toEqual([[first, 2], [second, 1]]);

      // A user's own, with their key, of content that is there.
      expect((await unlike(bob, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
      expect((await ctx.app.inject({ method: 'DELETE', url: '/like', payload: { userId: bob.userId, apiKey: 'nope', contentId: first } })).statusCode).toBe(401);
      expect((await ctx.app.inject({ method: 'DELETE', url: '/like', payload: { ...bob } })).statusCode).toBe(400);
      expect((await ctx.app.inject({ method: 'DELETE', url: '/like', headers: as(bob) })).statusCode).toBe(400);
      // A like that isn't there is taken back from nobody: nothing changes.
      expect(await taken(await unlike(alice, first))).toEqual([200, { contentId: first, likes: 2, wasLiked: false }]);
      expect(await likesOf(first)).toEqual([bob.userId, carol.userId].sort());

      // Once: the row goes, and the count with it, at once for whoever reads the post.
      ctx.clock.now += 1000;
      expect(await taken(await unlike(bob, first))).toEqual([200, { contentId: first, likes: 1, wasLiked: true }]);
      expect(await taken(await unlike(bob, first))).toEqual([200, { contentId: first, likes: 1, wasLiked: false }]);
      expect(await likesOf(first)).toEqual([carol.userId]);
      expect(await likesOf(second)).toEqual([bob.userId]);
      expect((await ctx.app.inject({ method: 'GET', url: `/content/${first}` })).json().likes).toBe(1);
      // Feeds have the count they had until the compactor has run, and then the new one, in the order that makes.
      expect(await news()).toEqual([[first, 2], [second, 1]]);
      expect((await ctx.compact()).tags).toEqual([authorIndex(alice.userId), 'news']);
      expect(await news()).toEqual([[second, 1], [first, 1]]);
      // A run after which nothing was liked, or taken back, writes nothing again.
      expect((await ctx.compact()).tags).toEqual([]);

      // Named in the query, with the credentials in the headers; and the same request twice at once takes the like back once.
      const both = await Promise.all([1, 2].map(() => ctx.app.inject({ method: 'DELETE', url: `/like?contentId=${first}`, headers: as(carol) })));
      expect(both.map((res) => [res.statusCode, res.json().likes, res.json().wasLiked]).sort()).toEqual([[200, 0, false], [200, 0, true]]);
      expect(await likesOf(first)).toEqual([]);
      expect((await ctx.db.selectFrom('content').select('like_count').where('id', '=', first).executeTakeFirstOrThrow()).like_count).toBe(0);
      await ctx.compact();
      expect(await news()).toEqual([[second, 1], [first, 0]]);

      // It can be given again, and is a new like.
      expect((await like(carol, first)).json()).toEqual({ contentId: first, likes: 1, alreadyLiked: false });
      expect((await like(bob, first)).json()).toEqual({ contentId: first, likes: 2, alreadyLiked: false });
      await ctx.compact();
      expect(await news()).toEqual([[first, 2], [second, 1]]);

      // Content that is set for deletion is gone to an unlike too: its likes go with it.
      expect((await ctx.app.inject({ method: 'DELETE', url: `/content/${first}`, headers: as(alice) })).statusCode).toBe(202);
      expect(await taken(await unlike(bob, first))).toEqual([404, { error: 'content not found' }]);
      expect(await likesOf(first)).toEqual([bob.userId, carol.userId].sort());
    });

    it('lets only the owner set content for deletion, which refuses reads, updates and likes at once and leaves feeds on the next run', async () => {
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const { contentId } = (await storeText(alice, 'doomed #news')).json();
      await ctx.compact();
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
      expect(ids(await feed('tags=news'), 'news')).toEqual([contentId]);
      expect((await ctx.compactor.runOnce()).deleted).toEqual([contentId]);
      expect((await feed('tags=news')).records).toEqual([]);
    });

    it('refuses an update when its content is set for deletion while the update is under way, and writes nothing of it', async () => {
      const alice = await ctx.register('alice');
      const { contentId } = (await storeText(alice, 'v1 #news')).json();
      await ctx.compact();
      // The deletion commits once the update has read the post, and before the update commits.
      const transaction = ctx.db.transaction.bind(ctx.db);
      vi.spyOn(ctx.db, 'transaction').mockImplementationOnce(
        () =>
          ({
            execute: async (fn: (trx: unknown) => Promise<unknown>) => {
              await ctx.app.inject({ method: 'DELETE', url: `/content/${contentId}`, payload: { ...alice } });
              return transaction().execute(fn);
            },
          }) as never,
      );

      const refused = await storeText(alice, 'v2 #news', { contentId });
      expect([refused.statusCode, refused.json().error]).toEqual([409, 'content is set for deletion']);
      expect(await ctx.db.selectFrom('pending_writes').selectAll().execute()).toEqual([]);
      expect(await ctx.content.getMeta(contentId)).toMatchObject({ text: 'v1 #news' });
      // The next run deletes the post.
      expect((await ctx.compactor.runOnce()).deleted).toEqual([contentId]);
      expect((await feed('tags=news')).records).toEqual([]);
      expect(await ctx.db.selectFrom('content').selectAll().execute()).toEqual([]);
      expect(await ctx.content.getMeta(contentId)).toBeNull();
    });

    it('returns the most liked posts of the window first, as one list whatever their hashtag, and none from before it', async () => {
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const carol = await ctx.register('carol');
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
      // The post under #sports is the most liked of all: 3 likes, then 2 and 1 under #news, and the others none.
      for (const [fan, contentId] of [[bob, popular], [bob, yesterday], [carol, yesterday], [alice, cricket], [bob, cricket], [carol, cricket]] as const) {
        await ctx.app.inject({ method: 'POST', url: '/like', payload: { ...fan, contentId } });
      }
      await ctx.compact();

      const result = await feed('tags=news,sports&hours=48');
      // The window ends at the request: the compactor's run moved the clock on a little.
      expect(result.window).toEqual({ from: new Date(ctx.clock.now - 2 * DAY).toISOString(), to: new Date(ctx.clock.now).toISOString() });
      expect(result.truncated).toBe(false);
      expect(result.nextCursor).toBeNull();
      // One list, by likes over the whole window and over both hashtags: neither has a share of the page, and a post
      // with fewer likes never comes before one with more. The post of three weeks ago is outside the window.
      expect(listed(result)).toEqual([[cricket, 'sports'], [yesterday, 'news'], [popular, 'news'], [quiet, 'news']]);
      expect(result.records.map((i) => i.likes)).toEqual([3, 2, 1, 0]);
      expect(result.count).toBe(4);
      expect(result.records[2]).toEqual({
        contentId: popular,
        publisher: { userId: alice.userId, username: 'alice' },
        mimeType: 'text/plain',
        aiGenerated: false,
        comments: false,
        preview: { kind: 'text', text: 'popular mumbai #news #mumbai' },
        tags: ['news', 'mumbai'],
        likes: 1,
        // Nobody read it with an account's credentials, and the server has dislikes off.
        views: 0,
        dislikes: null,
        moderated: false,
        createdAt: new Date(t0 - 2 * HOUR).toISOString(),
        updatedAt: new Date(t0 - 2 * HOUR).toISOString(),
        // The hashtag of the feed's that it is listed under: it has another, which the feed wasn't asked for.
        listedUnder: 'news',
      });

      // The window alone decides which posts a feed is of. Among those nobody likes, the newest come first.
      const day = await feed('tags=news,sports');
      expect(listed(day)).toEqual([[cricket, 'sports'], [popular, 'news'], [quiet, 'news']]);
      const month = await feed('tags=news,sports&hours=720');
      expect(listed(month)).toEqual([[cricket, 'sports'], [yesterday, 'news'], [popular, 'news'], [quiet, 'news'], [threeWeeks, 'sports']]);
      expect(await feed('tags=news,sports&hours=1')).toMatchObject({ count: 0, truncated: false, nextCursor: null, records: [] });
      // The order the hashtags are asked for in changes nothing.
      expect(listed(await feed('tags=sports,news&hours=48'))).toEqual(listed(result));

      // A page is the most liked of the hashtags together, and the next carries on from there.
      const limited = await feed('tags=news,sports&hours=48&limit=2');
      expect(listed(limited)).toEqual([[cricket, 'sports'], [yesterday, 'news']]);
      expect(limited).toMatchObject({ count: 2, truncated: true });
      const rest = await feed(`tags=news,sports&hours=48&limit=2&cursor=${limited.nextCursor}`);
      expect(listed(rest)).toEqual([[popular, 'news'], [quiet, 'news']]);
      expect(rest).toMatchObject({ count: 2, truncated: false, nextCursor: null });
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
      // Two more, which nobody has liked.
      for (const text of ['post 6 #sports', 'post 7 #news']) {
        posts.push((await storeText(alice, text)).json().contentId);
        ctx.clock.now += 1000;
      }
      await ctx.compact();
      const order = (f: Feed) => ids(f, 'news');
      /** The records as the page has them, which is as a client shows them: under whichever hashtag. */
      const shown = (f: Feed) => f.records.map((i) => i.contentId);
      const [p0, p1, p2, p3, p4, p5, p6, p7] = posts;

      // Popular, which is what a feed is unless it says: by likes and nothing else, the unliked posts last, the newest of them first.
      for (const query of ['tags=news', 'tags=news&algorithm=popular']) {
        expect(order(await feed(query))).toEqual([p0, p1, p2, p3, p4, p7, p5]);
      }
      expect(order(await feed('tags=news&algorithm=chronological'))).toEqual([p7, p5, p4, p3, p2, p1, p0]);

      // The newest of both hashtags, not a share of each.
      const full = await feed('tags=news,sports&algorithm=chronological');
      expect(shown(full)).toEqual([p7, p6, p5, p4, p3, p2, p1, p0]);
      const newest = await feed('tags=news,sports&algorithm=chronological&limit=3');
      expect(shown(newest)).toEqual([p7, p6, p5]);
      expect(ids(newest, 'sports')).toEqual([p6]);

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

      // Each window's posts and no others: a page the window can't fill is left short.
      const within = async (hours: number) => {
        const f = await feed(`tags=news&hours=${hours}`);
        expect([f.count, f.truncated], `hours=${hours}`).toEqual([f.records.length, false]);
        return ids(f, 'news');
      };
      const expected: [hours: number, posts: number][] = [
        [1, 1], [2, 1], [4, 2], [8, 2], [12, 3], [24, 3], [48, 4], [72, 4], [168, 5], [336, 5], [504, 5], [720, 6], [1440, 7], [2160, 8],
      ];
      for (const [hours, count] of expected) expect(await within(hours), `hours=${hours}`).toEqual(posts.slice(0, count));
      expect(ids(await feed('tags=news'), 'news')).toEqual(posts.slice(0, 3));
      // The same posts in order of time.
      for (const [hours, count] of expected) {
        expect(ids(await feed(`tags=news&algorithm=chronological&hours=${hours}`), 'news'), `hours=${hours}`).toEqual(posts.slice(0, count));
      }

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

      const news = async (filter = '') => (await feed(`tags=news${filter}`)).records;
      const newsIds = async (filter = '') => (await news(filter)).map((i) => i.contentId);
      await ctx.compact();
      expect((await news()).map((i) => [i.contentId, i.aiGenerated])).toEqual([
        [ai.contentId, true],
        [human.contentId, false],
      ]);
      expect(await newsIds('&aiGenerated=true')).toEqual([ai.contentId]);
      expect(await newsIds('&aiGenerated=false')).toEqual([human.contentId]);

      // An update that doesn't say keeps the flag; changing only the flag is an update.
      ctx.clock.now += 1000;
      expect((await storeText(alice, 'revised with a model #news #tech', { contentId: ai.contentId })).json()).toMatchObject({ aiGenerated: true });
      const flipped = await storeText(alice, 'written by hand #news', { contentId: human.contentId, aiGenerated: true });
      expect(flipped.json()).toMatchObject({ contentId: human.contentId, aiGenerated: true });
      expect(flipped.json()).not.toHaveProperty('unchanged');
      expect((await storeText(alice, 'written by hand #news', { contentId: human.contentId })).json()).toMatchObject({ unchanged: true });
      expect((await getContent(human.contentId)).aiGenerated).toBe(true);
      // The filter reads the flag from the index, which has it after the compactor's next run.
      await ctx.compactor.runOnce();
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
      expect(ids(first, 'news')).toEqual([ai.contentId]);
      for (const other of ['', '&aiGenerated=false']) {
        expect((await ctx.app.inject({ method: 'GET', url: `/feed?tags=news${other}&cursor=${first.nextCursor}` })).statusCode).toBe(400);
      }
      expect(ids(await feed(`tags=news&aiGenerated=true&cursor=${first.nextCursor}`), 'news')).toEqual([human.contentId]);
    });

    it("returns an engaged feed: its hashtag's most liked posts, led by the newest posts that match what its reader liked and viewed, with the others that match among the rest", async () => {
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const fans: User[] = [];
      for (let i = 0; i < 5; i++) fans.push(await ctx.register(`fan${i}`));
      const post = async (user: User, text: string) => {
        ctx.clock.now += 1000;
        return (await storeText(user, text)).json().contentId as string;
      };
      // Six of alice's posts under #news, the older the more liked: p[i] gets 5 - i likes.
      const p: string[] = [];
      for (let i = 0; i < 6; i++) p.push(await post(alice, `post ${i} #news`));
      for (const [i, contentId] of p.entries()) {
        for (const fan of fans.slice(0, 5 - i)) await like(fan, contentId);
      }
      // Then four nobody has liked: two that are also under #cats, and two of bob's. And one of bob's that isn't under #news.
      const c0 = await post(alice, 'a cat #news #cats');
      const b0 = await post(bob, 'from bob #news');
      const c1 = await post(alice, 'another cat #news #cats');
      const b1 = await post(bob, 'from bob again #news');
      await post(bob, 'from bob, elsewhere #sports');
      await ctx.compact();
      const [p0, p1, p2, p3, p4, p5] = p;
      const news = (f: Feed) => ids(f, 'news');
      const told = (engagement: unknown) => `&engagement=${encodeURIComponent(typeof engagement === 'string' ? engagement : JSON.stringify(engagement))}`;
      const liked = [p0, p1, p2, p3, p4];
      const unliked = [b1, c1, b0, c0, p5];
      const nothings = ['', told({}), told({ likedByTag: {}, viewedByUser: { [bob.userId]: 0 } })];

      // A popular feed is in the order of its likes, and has no fresh slot, whatever the server's settings for them.
      const popular = await feed('tags=news');
      expect(news(popular)).toEqual([...liked, ...unliked]);
      // Told nothing of its reader, an engaged feed of one hashtag is the popular one with fresh slots: its 2nd post is one nobody has liked, and so is its 6th.
      for (const nothing of nothings) {
        const untold = news(await feed(`tags=news&algorithm=engaged${nothing}`));
        expect([unliked.includes(untold[1]!), unliked.includes(untold[5]!)], nothing).toEqual([true, true]);
        expect(untold.filter((contentId) => liked.includes(contentId)), nothing).toEqual(liked);
        expect([...untold].sort(), nothing).toEqual([...news(popular)].sort());
      }
      // With the fresh slots off, which a session's seed orders, it is the popular feed, post for post. So is everything below.
      ctx.config.feed.freshEvery = 0;
      for (const nothing of nothings) expect(news(await feed(`tags=news&algorithm=engaged${nothing}`)), nothing).toEqual(news(popular));

      // The reader views bob's posts, and those under #dogs, which has none, more than those under #cats.
      const engagement = told({ viewedByUser: { [bob.userId]: 10 }, viewedByTag: { '#Cats': 4, dogs: 30 }, likedByTag: { cats: 2 } });
      const engaged = await feed(`tags=news&algorithm=engaged${engagement}`);
      // Its two newest posts that match first, whatever their likes. Then every third is one that matches: bob's before the one under #cats.
      expect(news(engaged)).toEqual([b1, c1, p0, p1, b0, p2, p3, c0, p4, p5]);
      expect(Object.keys(engaged)).toEqual(Object.keys(popular));
      expect(engaged).toMatchObject({ count: 10, truncated: false, nextCursor: null, window: popular.window });
      // No other algorithm reads it.
      expect(news(await feed(`tags=news${engagement}`))).toEqual(news(popular));

      // Page by page: the cursor carries the engagement, so later pages needn't send it, and what one sends changes nothing.
      const first = await feed(`tags=news&algorithm=engaged&limit=4${engagement}`);
      expect(news(first)).toEqual([b1, c1, p0, p1]);
      const second = await feed(`tags=news&algorithm=engaged&limit=4&cursor=${first.nextCursor}`);
      expect(news(second)).toEqual([p2, p3, b0, p4]);
      const other = told({ viewedByTag: { cats: 500 } });
      expect(news(await feed(`tags=news&algorithm=engaged&limit=4${other}&cursor=${first.nextCursor}`))).toEqual(news(second));
      const third = await feed(`tags=news&algorithm=engaged&limit=4&cursor=${second.nextCursor}`);
      expect(news(third)).toEqual([c0, p5]);
      expect(third.nextCursor).toBeNull();
      // Its cursor is an engaged feed's alone.
      const mismatch = await ctx.app.inject({ method: 'GET', url: `/feed?tags=news&limit=4&cursor=${first.nextCursor}` });
      expect(mismatch.statusCode).toBe(400);

      // As RSS it is one list, in the order it was picked, and the next page's address has the cursor and no engagement.
      const rss = await ctx.app.inject({ method: 'GET', url: `/feed?tags=news&algorithm=engaged&limit=4&format=rss${engagement}` });
      expect(rss.statusCode, rss.body).toBe(200);
      expect([...rss.body.matchAll(/<guid isPermaLink="false">([^<]*)<\/guid>/g)].map((m) => m[1])).toEqual([b1, c1, p0, p1]);
      const next = /<atom:link rel="next" type="application\/rss\+xml" href="([^"]*)"\/>/.exec(rss.body)?.[1]?.replace(/&amp;/g, '&');
      expect(next).toMatch(/^\/feed\?tags=news&algorithm=engaged&limit=4&format=rss&cursor=[\w-]+$/);
      const nextPage = await ctx.app.inject({ method: 'GET', url: next! });
      expect([...nextPage.body.matchAll(/<guid isPermaLink="false">([^<]*)<\/guid>/g)].map((m) => m[1])).toEqual([p2, p3, b0, p4]);

      // What isn't an engagement is refused, before anything is read for it.
      for (const bad of ['likes', '[]', { likedByTag: { 'news/india': 1 } }, { viewedByUser: { bob: 1 } }, { likedByTag: { news: -1 } }]) {
        const res = await ctx.app.inject({ method: 'GET', url: `/feed?tags=news&algorithm=engaged${told(bad)}` });
        expect([res.statusCode, res.json().error], JSON.stringify(bad)).toEqual([
          400,
          'engagement must be a JSON object of likedByTag, likedByUser, viewedByTag and viewedByUser: each a count of posts by hashtag, or by user id',
        ]);
      }
    });

    it('returns a feed as RSS where it is asked to: the same records as one list, with where the page after it is read', async () => {
      const alice = await ctx.register('alice');
      const posts: string[] = [];
      for (const text of ['**first** #news', 'second #sports', 'third & <last> #news #sports']) {
        ctx.clock.now += 1000;
        posts.push((await storeText(alice, text)).json().contentId);
      }
      await ctx.compact();
      ctx.config.publicBaseUrl = 'https://api.example';
      const [first, second, third] = posts;
      const guids = (xml: string) => [...xml.matchAll(/<guid isPermaLink="false">([^<]*)<\/guid>/g)].map((m) => m[1]);
      const get = (url: string, headers: Record<string, string> = {}) => ctx.app.inject({ method: 'GET', url, headers });

      const query = 'tags=news,sports&algorithm=chronological&limit=2';
      const json = await feed(query);
      expect([ids(json, 'news'), ids(json, 'sports')]).toEqual([[third], [second]]);
      // Asked for as JSON, or not asked for as anything, it is what it was.
      expect((await feed(`${query}&format=json`)).records).toEqual(json.records);

      const page = await get(`/feed?${query}&format=rss`);
      expect(page.statusCode, page.body).toBe(200);
      expect(page.headers['content-type']).toBe('application/rss+xml; charset=utf-8');
      expect(page.body.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"')).toBe(true);
      expect(page.body).toContain('<title>#news, #sports</title>');
      expect(page.body).toContain('<description>Posts under #news, #sports</description>');
      expect(page.body).toContain('<link>https://api.example/feed?tags=news%2Csports&amp;algorithm=chronological&amp;limit=2&amp;format=rss</link>');
      // The newest of both hashtags, as one list.
      expect(guids(page.body)).toEqual([third, second]);
      expect(page.body).toContain(`<link>https://api.example/content/${third}</link>`);
      expect(page.body).toContain('<title>third &amp; &lt;last&gt; #news #sports</title>');
      expect(page.body).toContain('<category>news</category><category>sports</category>');
      expect(page.body).toContain('<dc:creator>alice</dc:creator>');

      // The page after it is read where the document says, and is the last.
      const next = /<atom:link rel="next" type="application\/rss\+xml" href="([^"]*)"\/>/.exec(page.body)?.[1]?.replace(/&amp;/g, '&');
      expect(next?.startsWith('https://api.example/feed?')).toBe(true);
      const rest = await get(next!.slice('https://api.example'.length));
      expect(rest.statusCode, rest.body).toBe(200);
      expect(guids(rest.body)).toEqual([first]);
      expect(rest.body).toContain('&lt;p&gt;&lt;strong&gt;first&lt;/strong&gt; #news&lt;/p&gt;');
      expect(rest.body).not.toContain('rel="next"');
      // The same cursor reads the same page as JSON.
      const cursor = new URLSearchParams(next!.slice(next!.indexOf('?'))).get('cursor');
      expect(ids(await feed(`${query}&cursor=${cursor}`), 'news')).toEqual([first]);

      // It goes out compressed, as the JSON does.
      const compressed = await get(`/feed?${query}&format=rss`, { 'accept-encoding': 'gzip' });
      expect(compressed.headers['content-encoding']).toBe('gzip');
      // All but the cursor, which holds a seed of its session's own.
      const cursorless = (xml: string) => xml.replace(/cursor=[\w-]+/, 'cursor=');
      expect(cursorless(gunzipSync(compressed.rawPayload).toString('utf8'))).toBe(cursorless(page.body));

      // A feed with no post is a channel with no item, and what a feed isn't written as is refused.
      const empty = await get('/feed?tags=empty&format=rss');
      expect([empty.statusCode, guids(empty.body)]).toEqual([200, []]);
      for (const format of ['atom', 'xml', '']) expect((await get(`/feed?tags=news&format=${format}`)).statusCode, format).toBe(400);
      // An error is the JSON it always is.
      expect((await get('/feed?tags=news/india&format=rss')).json()).toMatchObject({ error: 'tags must be one or more hashtags (letters, digits, _)' });
    });

    it('serves hashtag feeds without touching the database', async () => {
      const alice = await ctx.register('alice');
      const a = (await storeText(alice, 'compacted #news')).json().contentId;
      await ctx.compact();
      ctx.clock.now += 1000;
      const b = (await storeText(alice, 'compacted next #news')).json().contentId;
      await ctx.compactor.runOnce();

      // The feed routes alone, as a function serves them, given no database to use.
      const { db: _, app: __, ...stores } = ctx;
      const app = await buildApp({ ...stores, now: () => ctx.clock.now }, { logger: false }, ['feed']);
      try {
        const res = await app.inject({ method: 'GET', url: '/feed?tags=news' });
        expect(res.statusCode, res.body).toBe(200);
        expect(ids(res.json(), 'news')).toEqual([b, a]);
        // An engaged feed reads its reader's users from their own indexes, which are in Redis too, and RSS is the same page written another way.
        const engagement = encodeURIComponent(JSON.stringify({ viewedByUser: { [alice.userId]: 3 }, likedByTag: { news: 1 } }));
        const engaged = await app.inject({ method: 'GET', url: `/feed?tags=news&algorithm=engaged&engagement=${engagement}` });
        expect(engaged.statusCode, engaged.body).toBe(200);
        expect(ids(engaged.json(), 'news')).toEqual([b, a]);
        const rss = await app.inject({ method: 'GET', url: '/feed?tags=news&format=rss' });
        expect([rss.statusCode, rss.headers['content-type']]).toEqual([200, 'application/rss+xml; charset=utf-8']);
        // The following feed isn't among them: it asks the database who may read it.
        expect((await app.inject({ method: 'GET', url: `/feed/following?userId=${alice.userId}`, headers: as(alice) })).statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });
  });
}
