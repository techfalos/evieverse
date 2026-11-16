import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAdmin } from '../src/moderation/policy.js';
import { normalizeWord, WordScanner } from '../src/moderation/words.js';
import { touchTags } from '../src/tags.js';
import { as, createTestContext, multipart, PNG, requests, tailLines, TARGETS, type TestContext, type User } from './helpers.js';

const NO_USER = '00000000-0000-4000-8000-000000000000';
const REFUSED = "the post contains a word or phrase this server doesn't allow, so it wasn't published";
const NO_TAGS_LEFT = "none of the post's hashtags is allowed on it, and a post needs one, so it wasn't published";

describe('blocked words', () => {
  it('normalises words and phrases as hashtags are, and refuses what has no words or is too long', () => {
    expect(normalizeWord('  Café ')).toBe('cafe');
    expect(normalizeWord('Buy   NOW!!')).toBe('buy now');
    expect(normalizeWord("don't")).toBe('don t');
    expect(normalizeWord('नमस्ते')).toBe('नमस्ते');
    expect(normalizeWord('!!!')).toBeNull();
    expect(normalizeWord('one two three four five six seven eight')).toBe('one two three four five six seven eight');
    expect(normalizeWord('one two three four five six seven eight nine')).toBeNull();
    expect(normalizeWord('x'.repeat(100))).toBe('x'.repeat(100));
    expect(normalizeWord('x'.repeat(101))).toBeNull();
  });

  it('matches whole words and phrases, whatever their case, accents or chunks', () => {
    const matched = (texts: string[][]) => {
      const scanner = new WordScanner(new Map(Object.entries({ '*': ['spam'], news: ['buy now'], cafes: ['cafe'] })));
      for (const chunks of texts) {
        for (const chunk of chunks) scanner.feed(chunk);
        scanner.end();
      }
      return [...scanner.matched].sort();
    };
    expect(matched([['This is SPAM!']])).toEqual(['*']);
    expect(matched([['spammers, spammy, antispam']])).toEqual([]);
    expect(matched([['Meet at the Café']])).toEqual(['cafes']);
    expect(matched([['Buy... now']])).toEqual(['news']);
    expect(matched([['Buy spam now']])).toEqual(['*']);
    // Chunks cut anywhere read as one text, but separate texts don't run into each other.
    expect(matched([['please b', 'uy', '  n', 'ow']])).toEqual(['news']);
    expect(matched([['sp', 'am']])).toEqual(['*']);
    expect(matched([['buy'], ['now']])).toEqual([]);
    // A word longer than any entry matches none, however long it runs on.
    expect(matched([['spam'.repeat(100), 'spam']])).toEqual([]);
    expect(matched([['x'.repeat(10_000), ' spam']])).toEqual(['*']);
  });
});

for (const target of TARGETS) {
  describe(`moderation (${target.name})`, () => {
    let ctx: TestContext;
    afterEach(async () => {
      vi.restoreAllMocks();
      await ctx.close();
    });

    const { storeText: store, feedItems: feedOf } = requests(() => ctx);
    const req = (u: User | null, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
      ctx.app.inject({ method, url, headers: u ? as(u) : {}, ...(payload && { payload }) });
    const ok = (res: LightMyRequestResponse, status = 201) => {
      expect(res.statusCode, res.body).toBe(status);
      return res.json();
    };
    const post = async (u: User, text: string, extra: Record<string, unknown> = {}) => ok(await store(u, text, extra));
    const profile = async (u: User) => ok(await req(null, 'GET', `/users/${u.userId}`), 200);
    const now = () => new Date(ctx.clock.now).toISOString();
    /** Registers a user and makes them an admin, as `npm run admin -- grant` does. */
    const admin = async (name = 'admin') => {
      const u = await ctx.register(name);
      await setAdmin(ctx.db, name, true);
      return u;
    };
    const appoint = async (by: User, tag: string, u: User) => ok(await req(by, 'PUT', `/tags/${tag}/moderators/${u.userId}`));

    it('lets admins appoint tag moderators and delete any content, and shows roles on profiles', async () => {
      ctx = await createTestContext(target);
      const root = await admin('root');
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const carol = await ctx.register('carol');

      expect((await req(bob, 'PUT', `/tags/news/moderators/${bob.userId}`)).statusCode).toBe(403);
      const bobSince = now();
      expect(await appoint(root, '%23News', bob)).toEqual({ tag: 'news', userId: bob.userId, since: bobSince, alreadyModerator: false });
      ctx.clock.now += 1000;
      expect(ok(await req(root, 'PUT', `/tags/news/moderators/${bob.userId}`), 200)).toMatchObject({ since: bobSince, alreadyModerator: true });
      expect((await req(root, 'PUT', `/tags/news/moderators/${NO_USER}`)).statusCode).toBe(404);
      expect((await req(root, 'PUT', `/tags/not-a-tag/moderators/${bob.userId}`)).statusCode).toBe(400);
      await appoint(root, 'news', carol);
      await appoint(root, 'sports', carol);

      expect(ok(await req(null, 'GET', '/tags/news/moderators'), 200)).toEqual({
        tag: 'news',
        moderators: [
          { userId: bob.userId, username: 'bob', since: bobSince },
          { userId: carol.userId, username: 'carol', since: now() },
        ],
      });
      expect(await profile(carol)).toMatchObject({ admin: false, moderates: ['news', 'sports'] });
      expect(await profile(root)).toMatchObject({ admin: true, moderates: [] });

      // Moderators can't appoint others, or delete content that isn't theirs; admins can delete anyone's.
      expect((await req(bob, 'PUT', `/tags/news/moderators/${alice.userId}`)).statusCode).toBe(403);
      const { contentId } = await post(alice, 'hello #news');
      expect((await req(bob, 'DELETE', `/content/${contentId}`)).statusCode).toBe(403);
      expect(ok(await req(root, 'DELETE', `/content/${contentId}`), 202)).toEqual({ contentId, status: 'pending_deletion', requestedAt: now() });
      expect(await feedOf('news')).toEqual([]);
      expect((await ctx.compact()).deleted).toEqual([contentId]);

      expect((await req(bob, 'DELETE', `/tags/sports/moderators/${carol.userId}`)).statusCode).toBe(403);
      expect(ok(await req(root, 'DELETE', `/tags/sports/moderators/${carol.userId}`), 200)).toEqual({ tag: 'sports', userId: carol.userId, wasModerator: true });
      expect(ok(await req(root, 'DELETE', `/tags/sports/moderators/${carol.userId}`), 200)).toMatchObject({ wasModerator: false });
      expect((await profile(carol)).moderates).toEqual(['news']);

      // Admins are named by userId or username, and can be revoked.
      expect(await setAdmin(ctx.db, alice.userId, true)).toEqual({ userId: alice.userId, username: 'alice' });
      expect(await setAdmin(ctx.db, 'nobody', true)).toBeNull();
      await setAdmin(ctx.db, 'root', false);
      expect((await req(root, 'PUT', `/tags/news/moderators/${alice.userId}`)).statusCode).toBe(403);
      expect((await req(alice, 'PUT', `/tags/news/moderators/${root.userId}`)).statusCode).toBe(201);
    });

    it("refuses posts containing the server's blocked words before any challenge, storing nothing", async () => {
      ctx = await createTestContext(target, { challenge: { postWindowSeconds: 60 } });
      const root = await admin();
      const alice = await ctx.register('alice');
      const words = (u: User | null, method: 'GET' | 'POST' | 'DELETE', list?: string[]) => req(u, method, '/moderation/blocked-words', list && { words: list });

      expect((await words(alice, 'POST', ['spam'])).statusCode).toBe(403);
      expect((await words(alice, 'GET')).statusCode).toBe(403);
      expect((await words(null, 'GET')).statusCode).toBe(401);
      expect(ok(await words(root, 'POST', ['Spam', 'BUY  now!', 'Café']), 200)).toEqual({ words: ['buy now', 'cafe', 'spam'] });
      expect(ok(await words(root, 'POST', ['spam', 'scam']), 200)).toEqual({ words: ['buy now', 'cafe', 'scam', 'spam'] });
      expect((await words(root, 'POST', ['!!!'])).statusCode).toBe(400);
      expect(ok(await words(root, 'DELETE', ['SCAM']), 200)).toEqual({ words: ['buy now', 'cafe', 'spam'] });
      expect(ok(await words(root, 'GET'), 200)).toEqual({ words: ['buy now', 'cafe', 'spam'] });

      const { contentId } = await post(alice, 'An honest post about spammers #news');
      const refusals: [string, Record<string, unknown>][] = [
        ['This is SPAM #news', {}],
        ['Buy, now! #news', {}],
        ['Meet me #cafe', {}],
        ['Hello #news', { tags: ['news', 'spam'] }],
        // Past what the preview reads: the whole text is checked.
        [`${'word '.repeat(7_000)}spam`, { tags: ['news'] }],
        // An update too.
        ['An honest post about spam #news', { contentId }],
      ];
      for (const [text, extra] of refusals) {
        const res = await store(alice, text, extra);
        expect(res.statusCode, text.slice(0, 40)).toBe(422);
        expect(res.json().error).toBe(REFUSED);
      }
      // A file's name, a caption and a link are checked too.
      for (const [name, fields] of [['cafe.png', {}], ['pixel.png', { text: 'Free spam inside' }]] as const) {
        const mp = multipart({ ...alice, type: 'image', tags: 'pics', ...fields }, { name, type: 'image/png', data: PNG });
        expect((await ctx.app.inject({ method: 'POST', url: '/store', payload: mp.payload, headers: mp.headers })).json().error).toBe(REFUSED);
      }
      expect((await store(alice, '', { type: 'link', text: undefined, url: 'https://spam.example/deals', tags: ['news'] })).json().error).toBe(REFUSED);

      expect(await ctx.db.selectFrom('content').select('id').execute()).toEqual([{ id: contentId }]);
      expect(ok(await req(null, 'GET', `/content/${contentId}`), 200)).toMatchObject({ text: 'An honest post about spammers #news' });
      expect(await tailLines(ctx.hot, 'news')).toHaveLength(1);
      // None of them was a post, so the run's challenge is still the first.
      const next = await store(alice, 'A second post #news');
      expect(next.statusCode).toBe(428);
      expect(next.json().challenge).toMatchObject({ step: 1, steps: 1 });
    });

    it("drops a hashtag from posts containing its blocked words, and from posts by users muted on it; a post left with none isn't published", async () => {
      ctx = await createTestContext(target);
      const root = await admin();
      const mod = await ctx.register('mod');
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const carol = await ctx.register('carol');
      await appoint(root, 'news', mod);
      const words = (u: User, method: 'GET' | 'POST' | 'DELETE', list?: string[]) => req(u, method, '/tags/news/blocked-words', list && { words: list });

      expect((await words(alice, 'POST', ['rumour'])).statusCode).toBe(403);
      expect((await req(mod, 'POST', '/tags/sports/blocked-words', { words: ['doping'] })).statusCode).toBe(403);
      expect(ok(await words(mod, 'POST', ['Rumour', 'unconfirmed reports']), 200)).toEqual({ tag: 'news', words: ['rumour', 'unconfirmed reports'] });
      expect(ok(await words(mod, 'GET'), 200)).toEqual({ tag: 'news', words: ['rumour', 'unconfirmed reports'] });
      // Admins moderate every hashtag.
      expect(ok(await req(root, 'POST', '/tags/sports/blocked-words', { words: ['doping'] }), 200)).toEqual({ tag: 'sports', words: ['doping'] });

      const both = await post(alice, 'A rumour about the match #news #sports');
      expect(both).toMatchObject({ tags: ['sports'], removedTags: [{ tag: 'news', reason: 'blocked_word' }] });
      expect(await feedOf('news')).toEqual([]);
      expect((await feedOf('sports')).map((i) => [i.contentId, i.tags])).toEqual([[both.contentId, ['sports']]]);
      expect(await post(alice, `${'word '.repeat(7_000)}unconfirmed, reports #news #sports`)).toMatchObject({ tags: ['sports'] });
      expect(await post(alice, 'Unconfirmed: doping reports #news #sports')).toMatchObject({ tags: ['news'], removedTags: [{ tag: 'sports', reason: 'blocked_word' }] });
      const refused = await store(alice, 'Just a rumour #news');
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toEqual({ error: NO_TAGS_LEFT, removedTags: [{ tag: 'news', reason: 'blocked_word' }] });

      // Mutes.
      expect((await req(alice, 'PUT', `/tags/news/muted/${bob.userId}`)).statusCode).toBe(403);
      const bobMutedAt = now();
      expect(ok(await req(mod, 'PUT', `/tags/news/muted/${bob.userId}`))).toEqual({ tag: 'news', userId: bob.userId, mutedAt: bobMutedAt, alreadyMuted: false });
      expect(ok(await req(mod, 'PUT', `/tags/news/muted/${bob.userId}`), 200)).toMatchObject({ alreadyMuted: true });
      expect((await req(mod, 'PUT', `/tags/news/muted/${NO_USER}`)).statusCode).toBe(404);
      expect(await post(bob, 'Results are in #news #sports')).toMatchObject({ tags: ['sports'], removedTags: [{ tag: 'news', reason: 'muted' }] });
      expect((await store(bob, 'Breaking #news')).json()).toEqual({ error: NO_TAGS_LEFT, removedTags: [{ tag: 'news', reason: 'muted' }] });
      const fine = await post(alice, 'Breaking #news');
      expect(fine).toMatchObject({ tags: ['news'] });
      expect(fine).not.toHaveProperty('removedTags');

      ctx.clock.now += 1000;
      await req(mod, 'PUT', `/tags/news/muted/${carol.userId}`);
      const page1 = ok(await req(mod, 'GET', '/tags/news/muted?limit=1'), 200);
      expect(page1.muted).toEqual([{ userId: carol.userId, username: 'carol', mutedAt: now() }]);
      const page2 = ok(await req(mod, 'GET', `/tags/news/muted?limit=1&cursor=${page1.nextCursor}`), 200);
      expect(page2).toEqual({ tag: 'news', muted: [{ userId: bob.userId, username: 'bob', mutedAt: bobMutedAt }], nextCursor: null });
      expect((await req(alice, 'GET', '/tags/news/muted')).statusCode).toBe(403);

      expect(ok(await req(mod, 'DELETE', `/tags/news/muted/${bob.userId}`), 200)).toEqual({ tag: 'news', userId: bob.userId, wasMuted: true });
      expect(ok(await req(mod, 'DELETE', `/tags/news/muted/${bob.userId}`), 200)).toMatchObject({ wasMuted: false });
      expect(await post(bob, 'Breaking #news')).toMatchObject({ tags: ['news'] });
      expect(ok(await words(mod, 'DELETE', ['rumour']), 200)).toEqual({ tag: 'news', words: ['unconfirmed reports'] });
      expect(await post(alice, 'Another rumour #news')).toMatchObject({ tags: ['news'] });
    });

    it('removes a hashtag from a post, which leaves its feeds at once and loses the hashtag for good once the compactor has run', async () => {
      ctx = await createTestContext(target);
      const root = await admin();
      const mod = await ctx.register('mod');
      const alice = await ctx.register('alice');
      await appoint(root, 'news', mod);
      const posted = now();
      const { contentId } = await post(alice, 'Flooding in Mumbai #news #mumbai');
      await ctx.compact();
      ctx.clock.now += 1000;
      const remove = (u: User, tag: string, id = contentId, payload?: Record<string, unknown>) => req(u, 'DELETE', `/content/${id}/tags/${tag}`, payload);
      const decisions = () => ctx.db.selectFrom('tag_moderation').select(['content_id', 'tag', 'decision', 'moderator_id', 'applied_at']).execute();

      expect((await remove(alice, 'news')).statusCode).toBe(403);
      expect((await remove(mod, 'mumbai')).statusCode).toBe(403);
      expect((await remove(root, 'weather')).json().error).toBe("the content isn't tagged #weather");
      expect((await req(root, 'DELETE', `/content/${NO_USER}/tags/news`)).statusCode).toBe(404);

      // The removal is recorded, and hides the post from the hashtag's feeds at once. The post itself is as it was.
      expect(ok(await remove(mod, 'news'), 200)).toEqual({ contentId, tag: 'news', tags: ['mumbai'], muted: false });
      expect(await decisions()).toEqual([{ content_id: contentId, tag: 'news', decision: 'removed', moderator_id: mod.userId, applied_at: null }]);
      expect(await feedOf('news')).toEqual([]);
      expect((await feedOf('mumbai')).map((i) => [i.contentId, i.tags, i.updatedAt])).toEqual([[contentId, ['news', 'mumbai'], posted]]);
      expect(ok(await req(null, 'GET', `/content/${contentId}`), 200)).toMatchObject({ tags: ['news', 'mumbai'], updatedAt: posted });
      // It no longer has the hashtag to remove.
      expect((await remove(mod, 'news')).json().error).toBe("the content isn't tagged #news");
      expect((await req(mod, 'PUT', `/content/${contentId}/tags/news`)).json().error).toBe("the content isn't tagged #news");

      // The compactor takes the hashtag off the post, and the post out of the hashtag's index.
      await ctx.compact();
      expect(await decisions()).toEqual([{ content_id: contentId, tag: 'news', decision: 'removed', moderator_id: mod.userId, applied_at: ctx.clock.now }]);
      expect(await feedOf('news')).toEqual([]);
      expect((await feedOf('mumbai')).map((i) => [i.contentId, i.tags, i.updatedAt])).toEqual([[contentId, ['mumbai'], now()]]);
      expect(ok(await req(null, 'GET', `/content/${contentId}`), 200)).toMatchObject({ tags: ['mumbai'], updatedAt: now() });
      expect((await req(null, 'GET', `/content/${contentId}/raw`)).body).toBe('Flooding in Mumbai #news #mumbai');
      expect(await ctx.db.selectFrom('pending_appends').selectAll().execute()).toEqual([]);
      // Nothing is left for the next run to do.
      ctx.clock.now += 1000;
      expect((await ctx.compactor.runOnce()).tags).toEqual([]);

      // The removal stays: its publisher's updates don't get the hashtag back, but can use their other hashtags.
      expect(ok(await store(alice, 'Flooding in Mumbai #news #mumbai', { contentId }), 200)).toEqual({
        contentId,
        unchanged: true,
        removedTags: [{ tag: 'news', reason: 'removed' }],
      });
      expect(ok(await store(alice, 'Flooding in Mumbai, update #news #mumbai #weather', { contentId }), 200)).toMatchObject({
        tags: ['mumbai', 'weather'],
        removedTags: [{ tag: 'news', reason: 'removed' }],
      });
      expect(await feedOf('news')).toEqual([]);
      await ctx.compact();
      expect(await feedOf('news')).toEqual([]);
      expect((await feedOf('weather')).map((i) => i.contentId)).toEqual([contentId]);
      // Other content of theirs still gets the hashtag, unless the removal muted them on it.
      const second = await post(alice, 'The water recedes #news #mumbai');
      expect(second).toMatchObject({ tags: ['news', 'mumbai'] });
      expect(ok(await remove(mod, 'news', second.contentId, { mute: true }), 200)).toEqual({ contentId: second.contentId, tag: 'news', tags: ['mumbai'], muted: true });
      expect(ok(await req(mod, 'GET', '/tags/news/muted'), 200).muted.map((u: { username: string }) => u.username)).toEqual(['alice']);
      expect(await post(alice, 'The roads reopen #news #mumbai')).toMatchObject({ tags: ['mumbai'], removedTags: [{ tag: 'news', reason: 'muted' }] });
      expect(await feedOf('news')).toEqual([]);
    });

    it("applies a removal again when a write that was under way gave the hashtag back, and deletes a post two removals leave with no hashtag", async () => {
      ctx = await createTestContext(target);
      const root = await admin();
      const alice = await ctx.register('alice');
      const { contentId } = await post(alice, 'Flooding in Mumbai #news #mumbai');
      const applied = async () => (await ctx.db.selectFrom('tag_moderation').select('applied_at').where('content_id', '=', contentId).where('tag', '=', 'news').executeTakeFirstOrThrow()).applied_at;
      const tagsOf = async (id: string) => (await ctx.content.getMeta(id))!.tags;

      const before = (await ctx.content.getMeta(contentId))!;
      ok(await req(root, 'DELETE', `/content/${contentId}/tags/news`), 200);
      await ctx.compact();
      expect(await tagsOf(contentId)).toEqual(['mumbai']);
      expect(await applied()).toBe(ctx.clock.now);

      // An update that passed moderation before the removal, and wrote the post and its entry after the compactor ran.
      await ctx.content.putMeta({ ...before, updatedAt: ctx.clock.now });
      await touchTags(ctx.db, ctx.config.db.dialect, ['news'], ctx.clock.now);
      await ctx.appender.append('news', { contentId, createdAt: before.updatedAt, updatedAt: ctx.clock.now, likes: 0, aiGenerated: false, moderated: false });
      // The run that merges the entry leaves it out of the index, and has the next one take the hashtag off again.
      await ctx.compact();
      expect(await feedOf('news')).toEqual([]);
      expect(await applied()).toBeNull();
      ctx.clock.now += 1000;
      await ctx.compactor.runOnce();
      expect(await tagsOf(contentId)).toEqual(['mumbai']);
      expect(await applied()).toBe(ctx.clock.now);
      expect((await feedOf('mumbai')).map((i) => i.tags)).toEqual([['mumbai']]);

      // Two moderators each remove one of a post's last two hashtags at once: each sees the other still there.
      const both = await post(alice, 'Rain again #news #mumbai');
      ok(await req(root, 'DELETE', `/content/${both.contentId}/tags/news`), 200);
      await ctx.db
        .insertInto('tag_moderation')
        .values({ content_id: both.contentId, tag: 'mumbai', decision: 'removed', moderator_id: root.userId, decided_at: ctx.clock.now, applied_at: null })
        .execute();
      await ctx.compact();
      expect((await req(null, 'GET', `/content/${both.contentId}`)).statusCode).toBe(404);
      expect(await feedOf('mumbai')).toHaveLength(1);
      expect((await ctx.compact()).deleted).toEqual([both.contentId]);
    });

    it("leaves a file's bytes as they are, and takes a post down when its last hashtag is removed", async () => {
      ctx = await createTestContext(target);
      const root = await admin();
      const alice = await ctx.register('alice');
      const mp = multipart({ ...alice, type: 'image', text: 'One pixel', tags: 'pics, news' }, { name: 'pixel.png', type: 'image/png', data: PNG });
      const { contentId } = ok(await ctx.app.inject({ method: 'POST', url: '/store', payload: mp.payload, headers: mp.headers }));
      const link = await post(alice, '', { type: 'link', text: undefined, url: 'https://news.example/a', tags: ['links', 'news'] });

      const putFile = vi.spyOn(ctx.content, 'putFile');
      expect(ok(await req(root, 'DELETE', `/content/${contentId}/tags/news`), 200)).toMatchObject({ tags: ['pics'] });
      expect(ok(await req(root, 'DELETE', `/content/${link.contentId}/tags/news`), 200)).toMatchObject({ tags: ['links'] });
      expect(await feedOf('news')).toEqual([]);
      await ctx.compact();
      expect(putFile).not.toHaveBeenCalled();
      expect((await ctx.app.inject({ method: 'GET', url: `/content/${contentId}/raw` })).rawPayload).toEqual(PNG);
      const preview = { kind: 'image', url: `/content/${contentId}/raw`, text: 'One pixel' };
      expect((await feedOf('pics'))[0]).toMatchObject({ preview, tags: ['pics'] });
      expect(await feedOf('news')).toEqual([]);
      expect(ok(await req(null, 'GET', `/content/${contentId}`), 200)).toMatchObject({ preview, text: 'One pixel', tags: ['pics'], size: PNG.length });
      expect((await feedOf('links'))[0]).toMatchObject({ tags: ['links'], preview: { kind: 'link', url: 'https://news.example/a' } });

      const last = await req(root, 'DELETE', `/content/${contentId}/tags/pics`);
      expect(ok(last, 202)).toEqual({ contentId, tag: 'pics', tags: [], status: 'pending_deletion', requestedAt: now(), muted: false });
      expect(await feedOf('pics')).toEqual([]);
      expect((await req(null, 'GET', `/content/${contentId}`)).statusCode).toBe(404);
      expect((await ctx.compact()).deleted).toEqual([contentId]);
      expect(await ctx.content.getMeta(contentId)).toBeNull();
    });
  });
}
