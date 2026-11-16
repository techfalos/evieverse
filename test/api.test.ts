import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Db } from '../src/db/index.js';
import { DAY, HOUR } from '../src/feed/plan.js';
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
  estimatedTokens: number;
  days: { extended: boolean; tags: Record<string, Item[]> }[];
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

    const storeText = (user: User, content: string, extra: Record<string, unknown> = {}) =>
      ctx.app.inject({ method: 'POST', url: '/store', payload: { ...user, content, tags: hashtags(content), ...extra } });
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
      expect(profile.json()).toEqual({ userId: a.json().userId, username: 'alice', publisherUrl: 'https://a.example', createdAt: expect.any(String) });

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

    it('previews text as its first 100 words and media as a link', async () => {
      await ctx.close();
      ctx = await createTestContext(target, { publicBaseUrl: 'https://api.example.com' });
      const alice = await ctx.register('alice');
      const words = Array.from({ length: 150 }, (_, i) => `w${i}`).join(' ');
      const text = (await storeText(alice, `${words} #long`)).json();
      expect(text.preview.text.split(' ')).toHaveLength(101);
      expect(text.preview.text).toMatch(/^w0 w1 .* w99 …$/);

      const mp = multipart({ ...alice, tags: 'pixel' }, { name: 'pixel.png', type: 'image/png', data: PNG });
      const img = await ctx.app.inject({ method: 'POST', url: '/store', payload: mp.payload, headers: mp.headers });
      expect(img.statusCode).toBe(201);
      const { contentId } = img.json();
      expect(img.json().preview).toEqual({ kind: 'media', url: `https://api.example.com/content/${contentId}/raw?version=1` });
      const raw = await ctx.app.inject({ method: 'GET', url: `/content/${contentId}/raw?version=1` });
      expect(Buffer.from(raw.rawPayload).equals(PNG)).toBe(true);
      expect(raw.headers['content-type']).toBe('image/png');
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

      const mp = multipart({ ...alice }, { name: 'pixel.png', type: 'image/png', data: PNG });
      const img = await ctx.app.inject({ method: 'POST', url: '/store', payload: mp.payload, headers: mp.headers });
      expect(img.json()).toMatchObject({ tags: ['local', 'austin'], preview: { kind: 'media' } });
    });

    it("normalises the publisher's hashtags, from a list or one form field, and refuses ones it can't use", async () => {
      const alice = await ctx.register('alice');
      const chosen = await storeText(alice, 'Flooding in Mumbai #news', { tags: ['#Weather', 'mumbai', 'weather'] });
      expect(chosen.statusCode, chosen.body).toBe(201);
      expect(chosen.json().tags).toEqual(['weather', 'mumbai']);
      expect(await tailLines(ctx.hot, 'news')).toEqual([]);

      // A form field holds them in one string.
      const mp = multipart({ ...alice, tags: 'art, #Pixel' }, { name: 'pixel.png', type: 'image/png', data: PNG });
      const img = await ctx.app.inject({ method: 'POST', url: '/store', payload: mp.payload, headers: mp.headers });
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
      const mp = multipart({ ...alice }, { name: 'pixel.png', type: 'image/png', data: PNG });
      refused(await ctx.app.inject({ method: 'POST', url: '/store', payload: mp.payload, headers: mp.headers }));
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

    it('requires new versions to keep the original content type', async () => {
      const alice = await ctx.register('alice');
      const { contentId } = (await storeText(alice, 'words #news')).json();
      const mp = multipart({ ...alice, contentId, tags: 'news' }, { name: 'pixel.png', type: 'image/png', data: PNG });
      const res = await ctx.app.inject({ method: 'POST', url: '/store', payload: mp.payload, headers: mp.headers });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('a new version must have the same content type as the original (text/plain), got image/png');
      expect((await storeText(alice, 'html now #news', { contentId, contentType: 'text/html' })).statusCode).toBe(400);
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
      expect((await ctx.compact()).tags).toEqual(['news']);
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
      expect((await ctx.compact()).tags).toEqual(['news']);
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
      expect(result.estimatedTokens).toBeGreaterThan(0);

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

      ctx.config.feed.maxTokens = Math.floor((full.estimatedTokens / 6) * 2.5);
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
      const mp = multipart({ ...alice, aiGenerated: 'true', tags: 'pixel' }, { name: 'pixel.png', type: 'image/png', data: PNG });
      const img = await ctx.app.inject({ method: 'POST', url: '/store', payload: mp.payload, headers: mp.headers });
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
      ctx.config.feed.maxTokens = Math.ceil((await feed('tags=news&aiGenerated=true')).estimatedTokens * 0.6);
      const first = await feed('tags=news&aiGenerated=true');
      expect(ids(first.days[0], 'news')).toEqual([ai.contentId]);
      for (const other of ['', '&aiGenerated=false']) {
        expect((await ctx.app.inject({ method: 'GET', url: `/feed?tags=news${other}&cursor=${first.nextCursor}` })).statusCode).toBe(400);
      }
      expect(ids((await feed(`tags=news&aiGenerated=true&cursor=${first.nextCursor}`)).days[0], 'news')).toEqual([human.contentId]);
    });

    it('serves the feed without touching the database', async () => {
      const alice = await ctx.register('alice');
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
          appender: ctx.appender,
          feedReader: ctx.feedReader,
          now: () => ctx.clock.now,
        },
        { logger: false },
      );
      try {
        const res = await app.inject({ method: 'GET', url: '/feed?tags=news' });
        expect(res.statusCode, res.body).toBe(200);
        expect(ids(res.json().days[0], 'news')).toEqual([b, a]);
      } finally {
        await app.close();
      }
    });
  });
}
