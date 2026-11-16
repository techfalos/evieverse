import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAdmin } from '../src/moderation/policy.js';
import { MAX_LIST_PATTERNS, normalizeWord, PATTERN_BUDGET_MS, scanTexts, WordScanner } from '../src/moderation/words.js';
import { touchTags } from '../src/tags.js';
import { as, createTestContext, multipart, PNG, queued, requests, TARGETS, type TestContext, type User } from './helpers.js';

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

  it('takes an entry between slashes for a pattern, and refuses one that is not a regular expression or matches everything', () => {
    expect(normalizeWord('  /垃圾|广告/ ')).toBe('/垃圾|广告/');
    expect(normalizeWord('/Buy\\s+NOW!/')).toBe('/Buy\\s+NOW!/');
    expect(normalizeWord('/a\\/b/')).toBe('/a\\/b/');
    // Stored composed, however it was typed.
    expect(normalizeWord('/cafe\u0301/')).toBe('/caf\u00e9/');
    // Not closed by a slash: flags aren't taken, and it isn't the phrase "spam i" either.
    expect(normalizeWord('/spam/i')).toBeNull();
    expect(normalizeWord('/spam')).toBeNull();
    expect(normalizeWord('//')).toBeNull();
    for (const broken of ['/(/', '/[a-/', '/a{2,1}/', '/\\ｄ/', '/spam\\/']) expect(normalizeWord(broken), broken).toBeNull();
    // What matches empty text matches every post.
    for (const empty of ['/a*/', '/(spam)?/', '/^/', '/spam|/', '/何?/']) expect(normalizeWord(empty), empty).toBeNull();
    expect(normalizeWord('/何？/')).toBe('/何？/');
    expect(normalizeWord(`/${'x'.repeat(98)}/`)).toBe(`/${'x'.repeat(98)}/`);
    expect(normalizeWord(`/${'x'.repeat(99)}/`)).toBeNull();
  });

  it('matches patterns anywhere in a text, whatever its case, accents or width, and words as before', () => {
    const lists = {
      '*': ['/垃圾|广告/'],
      // A word only matches a whole run of a script written without spaces, which is what patterns are for.
      whole: ['垃圾'],
      news: ['rumour', '/scam\\w*/', '/^promo/'],
      cafes: ['/Café/'],
      wide: ['/ｓｐａｍ/'],
      // A full-width question mark is one to find, not a quantifier.
      jp: ['/すごい？/', '/[がぎ]り/', '/ｶﾞｰﾄﾞ/'],
      phrase: ['/buy.*now/'],
      digits: ['/\\d{3}-\\d{4}/'],
    };
    const matched = (...texts: string[]) => [...scanTexts(new Map(Object.entries(lists)), texts)].sort();
    expect(matched('这是垃圾邮件')).toEqual(['*']);
    expect(matched('垃圾')).toEqual(['*', 'whole']);
    expect(matched('Beware of SCAMMERS')).toEqual(['news']);
    expect(matched('A rumour, and no rumours')).toEqual(['news']);
    expect(matched('Promo codes')).toEqual(['news']);
    expect(matched('A promo code')).toEqual([]);
    expect(matched('Meet at the CAFÉ')).toEqual(['cafes']);
    expect(matched('ｃａｆｅ')).toEqual(['cafes']);
    expect(matched('Free SPAM', 'ｓｐａｍ')).toEqual(['wide']);
    expect(matched('すごい？')).toEqual(['jp']);
    expect(matched('すごい?')).toEqual(['jp']);
    expect(matched('すごい')).toEqual([]);
    // One letter of the text is one of the pattern's, however either was typed.
    expect(matched('ぎりぎり')).toEqual(['jp']);
    expect(matched('き\u3099り')).toEqual(['jp']);
    expect(matched('ガード')).toEqual(['jp']);
    expect(matched('call 555-1234')).toEqual(['digits']);
    // Each text is read on its own.
    expect(matched('buy it\nnow')).toEqual([]);
    expect(matched('buy', 'now')).toEqual([]);
    expect(matched('Buy it now')).toEqual(['phrase']);
  });

  it('counts a list as matched when its patterns take too long, and tells the log which one', () => {
    const warn = vi.fn();
    const lists = new Map(Object.entries({ slow: ['/quick/', '/(a+)+$/'], fine: ['/lazy/'], word: ['aaa', '/(a+)+$/'] }));
    const text = `${'a'.repeat(60)}!`;
    const started = performance.now();
    expect([...scanTexts(lists, [text, 'aaa'], { warn })].sort()).toEqual(['slow', 'word']);
    // The list's time is all it took, and a list whose word matched ran no pattern.
    expect(performance.now() - started).toBeLessThan(PATTERN_BUDGET_MS * 3);
    expect(warn.mock.calls).toEqual([[{ list: 'slow', pattern: '/(a+)+$/', budgetMs: PATTERN_BUDGET_MS }, expect.stringContaining('took too long')]]);
    // What comes after is read as ever.
    expect([...scanTexts(lists, ['the lazy dog'], { warn })]).toEqual(['fine']);
    expect(warn).toHaveBeenCalledTimes(1);
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
      expect(await queued(ctx)).toEqual([`${contentId} @${alice.userId}`, `${contentId} news`]);
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
      await ctx.compactor.runOnce();
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

    it("lets a server moderator do whatever a hashtag's moderator can, on every hashtag, with no row for any", async () => {
      ctx = await createTestContext(target);
      const root = await admin();
      const mod = await ctx.register('mod');
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const TAGS = ['news', 'sports'];
      const decisions = () => ctx.db.selectFrom('tag_moderation').select(['content_id', 'tag', 'decision', 'moderator_id']).orderBy('decided_at').orderBy('decision').execute();
      /** Everything a hashtag's moderator can ask for, on `tag` and on content under it. */
      const theirs = (tag: string, contentId: string): [method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>][] => [
        ['GET', `/tags/${tag}/blocked-words`],
        ['POST', `/tags/${tag}/blocked-words`, { words: ['rumour'] }],
        ['DELETE', `/tags/${tag}/blocked-words`, { words: ['rumour'] }],
        ['GET', `/tags/${tag}/muted`],
        ['PUT', `/tags/${tag}/muted/${bob.userId}`],
        ['DELETE', `/tags/${tag}/muted/${bob.userId}`],
        ['PUT', `/content/${contentId}/tags/${tag}`],
        ['DELETE', `/content/${contentId}/tags/${tag}`],
      ];
      /** Whether all of that is refused `u`, with the reason: nothing of it was done. */
      const refused = async (u: User, tag: string, contentId: string) => {
        for (const [method, url, payload] of theirs(tag, contentId)) {
          const res = await req(u, method, url, payload);
          expect([res.statusCode, res.json().error], `${method} ${url}`).toEqual([403, `only an admin, a server moderator or a moderator of #${tag} can do this`]);
        }
      };

      // With no role, none of it is theirs.
      const untouched = Object.fromEntries(await Promise.all(TAGS.map(async (tag) => [tag, (await post(alice, `Left alone #${tag}`)).contentId] as const)));
      for (const tag of TAGS) await refused(mod, tag, untouched[tag]!);

      // A server moderator: all of it, under whatever hashtag, and no hashtag lists them as its moderator.
      ok(await req(root, 'PUT', `/moderators/${mod.userId}`));
      expect(await profile(mod)).toMatchObject({ admin: false, moderator: true, moderates: [] });
      const approved: Record<string, string> = {};
      for (const tag of TAGS) {
        expect(ok(await req(null, 'GET', `/tags/${tag}/moderators`), 200)).toEqual({ tag, moderators: [] });
        const first = (await post(alice, `To approve #${tag}`)).contentId;
        const second = (await post(alice, `To remove #${tag}`)).contentId;
        approved[tag] = first;

        // Its blocked words.
        expect(ok(await req(mod, 'POST', `/tags/${tag}/blocked-words`, { words: ['Rumour'] }), 200)).toEqual({ tag, words: ['rumour'] });
        expect(ok(await req(mod, 'GET', `/tags/${tag}/blocked-words`), 200)).toEqual({ tag, words: ['rumour'] });
        expect(await post(alice, `A rumour #${tag} #elsewhere`)).toMatchObject({ tags: ['elsewhere'], removedTags: [{ tag, reason: 'blocked_word' }] });
        expect(ok(await req(mod, 'DELETE', `/tags/${tag}/blocked-words`, { words: ['rumour'] }), 200)).toEqual({ tag, words: [] });

        // Its mutes.
        expect(ok(await req(mod, 'PUT', `/tags/${tag}/muted/${bob.userId}`))).toEqual({ tag, userId: bob.userId, mutedAt: now(), alreadyMuted: false });
        expect(ok(await req(mod, 'GET', `/tags/${tag}/muted`), 200)).toEqual({ tag, muted: [{ userId: bob.userId, username: 'bob', mutedAt: now() }], nextCursor: null });
        expect((await store(bob, `Breaking #${tag}`)).json()).toEqual({ error: NO_TAGS_LEFT, removedTags: [{ tag, reason: 'muted' }] });
        expect(ok(await req(mod, 'DELETE', `/tags/${tag}/muted/${bob.userId}`), 200)).toEqual({ tag, userId: bob.userId, wasMuted: true });

        // Its queue: approving content under it, and removing it from content, with a mute of the publisher.
        expect(ok(await req(mod, 'PUT', `/content/${first}/tags/${tag}`))).toEqual({ contentId: first, tag, moderated: true, alreadyApproved: false });
        expect(ok(await req(mod, 'DELETE', `/content/${second}/tags/${tag}`, { mute: true }), 200)).toEqual({ contentId: second, tag, tags: [], muted: true });
        expect(ok(await req(mod, 'GET', `/tags/${tag}/muted`), 200).muted.map((u: { username: string }) => u.username)).toEqual(['alice']);
        ok(await req(mod, 'DELETE', `/tags/${tag}/muted/${alice.userId}`), 200);
        ctx.clock.now += 1000;
      }
      // The decisions are theirs, and the compactor applies them as it does any moderator's.
      expect((await decisions()).map((d) => [d.tag, d.decision, d.moderator_id])).toEqual(TAGS.flatMap((tag) => [[tag, 'approved', mod.userId], [tag, 'removed', mod.userId]]));
      await ctx.compact();
      for (const tag of TAGS) {
        expect(Object.fromEntries((await feedOf(tag)).map((i) => [i.contentId, i.moderated]))).toEqual({ [untouched[tag]!]: false, [approved[tag]!]: true });
      }

      // What takes an admin still does: the server's blocked words, who moderates a hashtag, and content that isn't theirs.
      const notTheirs: [method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>][] = [
        ['GET', '/moderation/blocked-words'],
        ['POST', '/moderation/blocked-words', { words: ['rumour'] }],
        ['PUT', `/tags/news/moderators/${bob.userId}`],
        ['DELETE', `/tags/news/moderators/${bob.userId}`],
        ['DELETE', `/content/${untouched.news}`],
      ];
      for (const [method, url, payload] of notTheirs) expect((await req(mod, method, url, payload)).statusCode, `${method} ${url}`).toBe(403);

      // No longer one: every hashtag is closed to them at once, and what they decided stays decided.
      ok(await req(root, 'DELETE', `/moderators/${mod.userId}`), 200);
      for (const tag of TAGS) await refused(mod, tag, untouched[tag]!);
      expect(await decisions()).toHaveLength(4);
      // Unless they moderate the hashtag itself, which is that hashtag's alone.
      await appoint(root, 'news', mod);
      expect(ok(await req(mod, 'PUT', `/content/${untouched.news}/tags/news`))).toMatchObject({ alreadyApproved: false });
      await refused(mod, 'sports', untouched.sports!);
    });

    it('blocks what a pattern matches, for the server and for a hashtag, and keeps patterns beside the words', async () => {
      ctx = await createTestContext(target);
      const root = await admin();
      const alice = await ctx.register('alice');
      const words = (method: 'GET' | 'POST' | 'DELETE', list?: string[], url = '/moderation/blocked-words') => req(root, method, url, list && { words: list });

      expect(ok(await words('POST', ['Spam', ' /垃圾|广告/ ', '/Scam\\w*/']), 200)).toEqual({ words: ['/Scam\\w*/', '/垃圾|广告/', 'spam'] });
      expect(ok(await words('POST', ['/垃圾|广告/']), 200)).toEqual({ words: ['/Scam\\w*/', '/垃圾|广告/', 'spam'] });
      for (const bad of ['/spam/i', '/(/', '/a*/']) {
        const res = await words('POST', [bad]);
        expect([res.statusCode, res.json().error]).toEqual([
          400,
          `"${bad}" can't be blocked: an entry that starts with a slash is a pattern, which is a regular expression between two slashes, with nothing after the second (/spam+/); it can't match empty text, and has at most 100 characters`,
        ]);
      }

      for (const text of ['这是垃圾邮件 #news', 'Beware of scammers #news', 'Hello #news #scam_alerts']) {
        const res = await store(alice, text);
        expect([res.statusCode, res.json().error], text).toEqual([422, REFUSED]);
      }
      const comment = await post(alice, 'An honest post #news', { comments: true });
      const refused = await req(alice, 'POST', `/content/${comment.contentId}/comments`, { text: '垃圾！' });
      expect([refused.statusCode, refused.json().error]).toEqual([422, "the comment contains a word or phrase this server doesn't allow, so it wasn't published"]);

      expect(ok(await words('DELETE', ['/Scam\\w*/']), 200)).toEqual({ words: ['/垃圾|广告/', 'spam'] });
      await post(alice, 'Beware of scammers #news');

      // A hashtag's patterns drop the hashtag, as its words do.
      expect(ok(await words('POST', ['/rumou?r/'], '/tags/news/blocked-words'), 200)).toEqual({ tag: 'news', words: ['/rumou?r/'] });
      expect(await post(alice, 'Rumors about the match #news #sports')).toMatchObject({ tags: ['sports'], removedTags: [{ tag: 'news', reason: 'blocked_word' }] });

      // A list holds fewer patterns than words.
      const many = Array.from({ length: MAX_LIST_PATTERNS }, (_, i) => `/pattern ${i}/`);
      const full = await words('POST', many);
      expect([full.statusCode, full.json()]).toEqual([409, { error: `a list can hold at most ${MAX_LIST_PATTERNS} patterns` }]);
      expect(ok(await words('POST', [...many.slice(1), 'more', 'words']), 200).words).toHaveLength(MAX_LIST_PATTERNS + 3);
      expect((await words('POST', ['/one more/'])).statusCode).toBe(409);
      expect(ok(await words('POST', ['a word']), 200).words).toHaveLength(MAX_LIST_PATTERNS + 4);
    });

    it('removes a hashtag from a post, which leaves its feeds and loses the hashtag for good once the compactor has run', async () => {
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

      // The removal is recorded. Until the compactor's next run the post is as it was, in the hashtag's feeds too.
      expect(ok(await remove(mod, 'news'), 200)).toEqual({ contentId, tag: 'news', tags: ['mumbai'], muted: false });
      expect(await decisions()).toEqual([{ content_id: contentId, tag: 'news', decision: 'removed', moderator_id: mod.userId, applied_at: null }]);
      expect((await feedOf('news')).map((i) => i.contentId)).toEqual([contentId]);
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
      expect(await queued(ctx)).toEqual([]);
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

    it("applies a removal again when a write that was under way gave the hashtag back, and keeps a post two removals leave with no hashtag", async () => {
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

      // An update that passed moderation before the removal, and wrote the post and queued it after the compactor ran.
      await ctx.content.putMeta({ ...before, updatedAt: ctx.clock.now });
      await touchTags(ctx.db, ctx.config.db.dialect, ['news'], ctx.clock.now);
      await ctx.db.insertInto('feed_queue').values({ content_id: contentId, tag: 'news', token: randomUUID(), committed: 1, created_at: ctx.clock.now }).execute();
      // The run that takes the row leaves the post out of the index, and has the next one take the hashtag off again.
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
      // The run takes both off. The post stays, with no hashtag: it is in no hashtag's feed.
      expect((await ctx.compact()).deleted).toEqual([]);
      expect(ok(await req(null, 'GET', `/content/${both.contentId}`), 200)).toMatchObject({ tags: [], text: 'Rain again #news #mumbai' });
      expect(await feedOf('news')).toEqual([]);
      expect(await feedOf('mumbai')).toHaveLength(1);
    });

    it("leaves a file's bytes as they are, and keeps a post whose last hashtag is removed, out of every hashtag's feed", async () => {
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

      // The last hashtag goes like any other, and the post stays: with no hashtag, it is in no hashtag's feed.
      const bob = await ctx.register('bob');
      ok(await req(bob, 'PUT', `/users/${bob.userId}/following/${alice.userId}`), 201);
      const last = await req(root, 'DELETE', `/content/${contentId}/tags/pics`);
      expect(ok(last, 200)).toEqual({ contentId, tag: 'pics', tags: [], muted: false });
      expect((await ctx.compact()).deleted).toEqual([]);
      expect(await feedOf('pics')).toEqual([]);
      expect(ok(await req(null, 'GET', `/content/${contentId}`), 200)).toMatchObject({ preview, text: 'One pixel', tags: [], size: PNG.length });
      expect((await ctx.app.inject({ method: 'GET', url: `/content/${contentId}/raw` })).rawPayload).toEqual(PNG);
      expect(await ctx.db.selectFrom('content').select('delete_requested_at').where('id', '=', contentId).executeTakeFirst()).toEqual({ delete_requested_at: null });
      // It is still its publisher's: those who follow them see it, with no hashtags.
      const following = ok(await req(bob, 'GET', `/feed/following?userId=${bob.userId}`), 200).records as { contentId: string; tags: string[] }[];
      expect(following.find((r) => r.contentId === contentId)).toMatchObject({ tags: [], preview });

      // And still theirs to update, with no hashtag, or with others. The ones removed don't come back.
      const update = (tags: string) => {
        const again = multipart({ ...alice, contentId, type: 'image', text: 'One pixel, again', tags }, { name: 'pixel.png', type: 'image/png', data: PNG });
        return ctx.app.inject({ method: 'POST', url: '/store', payload: again.payload, headers: again.headers });
      };
      expect(ok(await update(''), 200)).toMatchObject({ contentId, tags: [] });
      expect(ok(await update('pics'), 200)).toEqual({ contentId, unchanged: true, removedTags: [{ tag: 'pics', reason: 'removed' }] });
      expect(ok(await update('pics, art'), 200)).toMatchObject({ contentId, tags: ['art'], removedTags: [{ tag: 'pics', reason: 'removed' }] });
      await ctx.compact();
      expect((await feedOf('art')).map((i) => [i.contentId, i.tags])).toEqual([[contentId, ['art']]]);
      expect(await feedOf('pics')).toEqual([]);
      // A post that has hashtags still has to say them when it is updated, and a new post still needs one.
      const required = 'tags is required: on this server, publishers choose the hashtags of their posts';
      for (const tags of [[], undefined]) {
        const none = await store(alice, 'Nothing', { contentId: link.contentId, type: 'link', text: undefined, url: 'https://news.example/b', tags });
        expect([none.statusCode, none.json().error]).toEqual([400, required]);
      }
      expect((await store(alice, 'No hashtags', { tags: [] })).json().error).toBe(required);
      expect((await feedOf('links')).map((i) => i.contentId)).toEqual([link.contentId]);
      expect((await store(alice, 'No hashtags', { contentId: link.contentId, type: 'link', text: undefined, url: 'https://news.example/a', tags: undefined })).statusCode).toBe(400);
    });
  });
}
