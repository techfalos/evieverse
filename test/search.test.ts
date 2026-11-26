import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { setAdmin } from '../src/moderation/policy.js';
import type { TestPlugin } from '../src/moderation/trust.types.js';
import { foldUsername, queryTerms } from '../src/search/keywords.js';
import { DAY } from '../src/time.js';
import { as, createTestContext, multipart, PNG, requests, TARGETS, type FeedItem, type TestContext, type User } from './helpers.js';

const NO_WORDS = 'q has nothing to search for: give at least one word, hashtag, or the start of a username';

/** What a search goes by, as far as the API reads it: the words of a query, and a username. What a post is found by is the compactor's (compactor/crates/core/src/search.rs). */
describe('search keywords', () => {
  it('are what a query is read into: its words as a post has them, and its hashtags', () => {
    expect(queryTerms('  Mumbai   FLOODING ')).toEqual(['mumbai', 'flooding']);
    expect(queryTerms('café Café')).toEqual(['cafe']);
    expect(queryTerms("mumbai's")).toEqual(['mumbai']);
    // A hashtag is read as hashtags are, and comes first.
    expect(queryTerms('road #Central-Mumbai ＃News')).toEqual(['centralmumbai', 'news', 'road']);
    // The words that say nothing are left out, unless there is nothing else to look for.
    expect(queryTerms('the road to the coast')).toEqual(['road', 'coast']);
    expect(queryTerms('The')).toEqual(['the']);
    expect(queryTerms('the #news')).toEqual(['news']);
    expect(queryTerms('!!! ... #')).toEqual([]);
    expect(queryTerms('a')).toEqual([]);
    expect(queryTerms(Array.from({ length: 20 }, (_, i) => `word${i}`).join(' '))).toHaveLength(8);
  });

  it('fold a username to what a search compares', () => {
    expect(foldUsername('José')).toBe('jose');
    expect(foldUsername('ÅSA_99')).toBe('asa_99');
    // A character that stands for several is written out, and the name still fits its column.
    expect(foldUsername('\ufdfa'.repeat(64)).length).toBe(255);
  });
});

for (const target of TARGETS) {
  describe(`search (${target.name})`, () => {
    let ctx: TestContext;
    afterEach(() => ctx.close());

    const { post, store, storeText, like } = requests(() => ctx);
    const req = (u: User | null, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
      ctx.app.inject({ method, url, headers: u ? as(u) : {}, ...(payload && { payload }) });
    const ok = (res: LightMyRequestResponse, status = 200) => {
      expect(res.statusCode, res.body).toBe(status);
      return res.json();
    };
    const search = (type: string, q: string, more = '') => ctx.app.inject({ method: 'GET', url: `/search?type=${type}&q=${encodeURIComponent(q)}${more}` });
    const refusal = async (url: string) => {
      const res = await ctx.app.inject({ method: 'GET', url });
      return [res.statusCode, res.json().error];
    };
    /** A page of a search of users. */
    const users = async (q: string, more = ''): Promise<{ users: { userId: string; username: string }[]; nextCursor: string | null }> => ok(await search('users', q, more));
    /** The usernames a search of users finds, in its order. */
    const names = async (q: string) => (await users(q)).users.map((u) => u.username);
    /** A page of a search of posts. */
    const posts = async (q: string, more = ''): Promise<{ results: FeedItem[]; nextCursor: string | null }> => ok(await search('content', q, more));
    /** The ids of the posts a search finds, in its order. */
    const found = async (q: string) => (await posts(q)).results.map((r) => r.contentId);
    /** Every page of a search, of `limit` each, as a client reads them: the ids, or the usernames. */
    const pages = async (type: 'users' | 'content', q: string, limit: number) => {
      const all: string[][] = [];
      for (let cursor: string | null = null, first = true; first || cursor; first = false) {
        const page = ok(await search(type, q, `&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
        all.push(type === 'users' ? page.users.map((u: { username: string }) => u.username) : page.results.map((r: FeedItem) => r.contentId));
        cursor = page.nextCursor;
      }
      return all;
    };
    /** The terms a post has rows for, sorted. */
    const terms = async (contentId: string) => (await ctx.db.selectFrom('search_terms').select('term').where('content_id', '=', contentId).execute()).map((r) => r.term).sort();
    const admin = async (name = 'root') => {
      const u = await ctx.register(name);
      await setAdmin(ctx.db, name, true);
      return u;
    };

    it('finds users by the start of their username, whatever its case and accents', async () => {
      ctx = await createTestContext(target);
      const registered: Record<string, User> = {};
      for (const name of ['Alice', 'alicia', 'ALBERT', 'José', 'Josephine', 'bob', 'al_ice', 'al%pha']) registered[name] = await ctx.register(name);

      // Each as it is written, in the order of the names as they are compared.
      expect(await users('alic')).toEqual({
        users: [
          { userId: registered.Alice!.userId, username: 'Alice' },
          { userId: registered.alicia!.userId, username: 'alicia' },
        ],
        nextCursor: null,
      });
      expect(await names('ALB')).toEqual(['ALBERT']);
      expect(await names('  bob ')).toEqual(['bob']);
      expect(await names('jos')).toEqual(['José', 'Josephine']);
      expect(await names('JOSÉ')).toEqual(['José', 'Josephine']);
      expect(await names('Joseph')).toEqual(['Josephine']);
      expect((await names('al')).sort()).toEqual(['ALBERT', 'Alice', 'al%pha', 'al_ice', 'alicia']);
      // The start of the name, not a part of it, and not a pattern: its characters are themselves.
      expect(await names('lice')).toEqual([]);
      expect(await names('al_')).toEqual(['al_ice']);
      expect(await names('al%')).toEqual(['al%pha']);
      expect(await names('%')).toEqual([]);
      expect(await names('!')).toEqual([]);
      expect(await names('zed')).toEqual([]);

      // A page at a time, each user once.
      const paged = await pages('users', 'al', 2);
      expect(paged.map((page) => page.length)).toEqual([2, 2, 1]);
      expect(paged.flat()).toEqual(await names('al'));

      // By the new name once they are renamed, and by none once their account is closed.
      ok(await req(registered.bob!, 'PATCH', `/users/${registered.bob!.userId}`, { username: 'Élodie' }));
      expect(await names('bob')).toEqual([]);
      expect(await names('elo')).toEqual(['Élodie']);
      ok(await req(registered.alicia!, 'DELETE', `/users/${registered.alicia!.userId}`));
      expect(await names('alic')).toEqual(['Alice']);
    });

    it('refuses a search that says nothing to search for, or asks for a page that is not one', async () => {
      ctx = await createTestContext(target);
      await ctx.register('alice');
      expect((await ctx.app.inject({ method: 'GET', url: '/search?q=alice' })).statusCode).toBe(400);
      expect((await ctx.app.inject({ method: 'GET', url: '/search?type=users' })).statusCode).toBe(400);
      expect((await ctx.app.inject({ method: 'GET', url: '/search?type=tags&q=alice' })).statusCode).toBe(400);
      expect((await ctx.app.inject({ method: 'GET', url: '/search?type=users&q=%20%20' })).statusCode).toBe(400);
      expect((await ctx.app.inject({ method: 'GET', url: `/search?type=users&q=${'a'.repeat(201)}` })).statusCode).toBe(400);
      expect((await ctx.app.inject({ method: 'GET', url: `/search?type=users&q=${'a'.repeat(200)}` })).statusCode).toBe(200);
      expect((await ctx.app.inject({ method: 'GET', url: '/search?type=users&q=al&limit=51' })).statusCode).toBe(400);
      expect((await ctx.app.inject({ method: 'GET', url: '/search?type=users&q=al&limit=0' })).statusCode).toBe(400);
      expect((await ctx.app.inject({ method: 'GET', url: '/search?type=users&q=al%00ice' })).statusCode).toBe(400);
      // Nothing a name is compared by, and no word.
      expect(await refusal(`/search?type=users&q=${encodeURIComponent('\u0301')}`)).toEqual([400, NO_WORDS]);
      expect(await refusal(`/search?type=content&q=${encodeURIComponent('!!! ?')}`)).toEqual([400, NO_WORDS]);
      expect(await refusal('/search?type=content&q=%23')).toEqual([400, NO_WORDS]);
      // A cursor is of the search it came from.
      for (const cursor of ['nonsense', Buffer.from('{"a":1}').toString('base64url'), Buffer.from('[1]').toString('base64url')]) {
        expect(await refusal(`/search?type=users&q=al&cursor=${cursor}`)).toEqual([400, 'invalid cursor']);
        expect(await refusal(`/search?type=content&q=al&cursor=${cursor}`)).toEqual([400, 'invalid cursor']);
      }
      for (const name of ['alba', 'albert', 'alfred']) await ctx.register(name);
      const { nextCursor } = await users('al', '&limit=1');
      expect(await refusal(`/search?type=content&q=al&cursor=${nextCursor}`)).toEqual([400, 'invalid cursor']);
    });

    it('finds posts that have every word asked for, newest first, as soon as they are written', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const flooding = await post(alice, 'Flooding closes the coast road in Mumbai #news');
      ctx.clock.now += 1000;
      const repairs = await post(bob, 'Road repairs begin in MUMBAI, and the road reopens #traffic');
      ctx.clock.now += 1000;
      const cafe = await post(alice, "A new café opens on Mumbai's seafront #food");
      ok(await like(bob, flooding), 201);

      expect(await found('mumbai')).toEqual([cafe, repairs, flooding]);
      expect(await found('mumbai road')).toEqual([repairs, flooding]);
      expect(await found('ROAD  Mumbai')).toEqual([repairs, flooding]);
      expect(await found('the road to mumbai')).toEqual([repairs, flooding]);
      expect(await found('coast mumbai road')).toEqual([flooding]);
      expect(await found('coast repairs')).toEqual([]);
      expect(await found('Cafe')).toEqual([cafe]);
      expect(await found('seafront café')).toEqual([cafe]);
      // By a hashtag, with the # or as a word, and with other words.
      expect(await found('#news')).toEqual([flooding]);
      expect(await found('news')).toEqual([flooding]);
      expect(await found('#Traffic road')).toEqual([repairs]);
      expect(await found('#food road')).toEqual([]);
      // Whole words: not the start of one, and not a word that says nothing.
      expect(await found('flood')).toEqual([]);
      expect(await found('the')).toEqual([]);
      expect(await found('zebra')).toEqual([]);

      // Each as a feed gives it, with the likes it has.
      const { results, nextCursor } = await posts('coast');
      expect(nextCursor).toBeNull();
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        contentId: flooding,
        publisher: { userId: alice.userId, username: 'alice' },
        preview: { kind: 'text', text: 'Flooding closes the coast road in Mumbai #news' },
        tags: ['news'],
        likes: 1,
        aiGenerated: false,
      });
      expect(results[0]!.repost).toBeUndefined();

      // The same once feeds have them.
      await ctx.compact();
      expect(await found('mumbai')).toEqual([cafe, repairs, flooding]);
      expect(await terms(flooding)).toEqual(['closes', 'coast', 'flooding', 'mumbai', 'news', 'road']);
    });

    it('gives the posts a page at a time, each once, those of one moment too', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const ids: string[] = [];
      for (let i = 0; i < 7; i++) {
        // Three of them at the same moment.
        if (i < 3 || i > 4) ctx.clock.now += 1000;
        ids.push(await post(alice, `Harbour report number ${i} #news`));
        if (i % 2) await post(alice, `Nothing to see ${i} #news`);
      }
      const all = await found('harbour');
      expect([...all].sort()).toEqual([...ids].sort());
      expect([all[0], all[1], all[5], all[6]]).toEqual([ids[6], ids[5], ids[1], ids[0]]);
      const paged = await pages('content', 'harbour report', 3);
      expect(paged.map((page) => page.length)).toEqual([3, 3, 1]);
      expect(paged.flat()).toEqual(all);
      expect((await pages('content', 'harbour', 1)).flat()).toEqual(all);
      // A page that is the last one says so, when it is full too.
      expect((await posts('harbour', '&limit=7')).nextCursor).toBeNull();
      expect((await posts('harbour', '&limit=6')).nextCursor).not.toBeNull();
    });

    it('finds a post by what an update made it, and by its caption if it is a file', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const contentId = await post(alice, 'Flooding in Mumbai #news');
      expect(await terms(contentId)).toEqual(['flooding', 'mumbai', 'news']);
      ok(await storeText(alice, 'Sunshine in Mumbai #weather', { contentId }));
      expect(await terms(contentId)).toEqual(['mumbai', 'sunshine', 'weather']);
      expect(await found('flooding')).toEqual([]);
      expect(await found('#news')).toEqual([]);
      expect(await found('sunshine mumbai #weather')).toEqual([contentId]);

      const body = multipart({ ...alice, type: 'image', text: 'Lighthouse at dusk', tags: 'pics' }, { name: 'a.png', type: 'image/png', data: PNG });
      const image = ok(await ctx.app.inject({ method: 'POST', url: '/store', ...body }), 201).contentId;
      expect(await found('lighthouse')).toEqual([image]);
      expect((await posts('lighthouse dusk')).results[0]).toMatchObject({ contentId: image, preview: { kind: 'image', url: `/content/${image}/raw`, text: 'Lighthouse at dusk' } });

      // A link is found by its hashtags, not by its address.
      const link = ok(await store(alice, { type: 'link', url: 'https://news.example/lighthouse-story', tags: ['reading'] }), 201).contentId;
      expect(await found('lighthouse')).toEqual([image]);
      expect(await found('#reading')).toEqual([link]);
    });

    it('keeps no more words of a post than the most it is found by, and all of its hashtags', async () => {
      ctx = await createTestContext(target, { search: { maxKeywords: 2 } });
      const alice = await ctx.register('alice');
      const contentId = await post(alice, 'tides tides tides harbour harbour lighthouse #news #coast');
      expect(await terms(contentId)).toEqual(['coast', 'harbour', 'news', 'tides']);
      expect(await found('tides harbour')).toEqual([contentId]);
      expect(await found('lighthouse')).toEqual([]);
    });

    it('finds no post that is set for deletion, held for review, gone from its own server, or of a closed account', async () => {
      /** Holds what shouts for an admin to look at. */
      const shouting: TestPlugin = { name: 'shouting', rules: [{ includes: 'FREE', reduce: 30 }] };
      ctx = await createTestContext(target, { trustPlugins: [shouting] });
      const root = await admin();
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const kept = await post(alice, 'Lighthouse open today #news');
      ctx.clock.now += 1000;

      // Held: found once an admin lets it through.
      const held = ok(await storeText(bob, 'FREE lighthouse tickets #news'), 202).contentId;
      expect(await found('lighthouse')).toEqual([kept]);
      ok(await req(root, 'POST', `/moderation/queue/${held}/accept`));
      expect(await found('lighthouse')).toEqual([held, kept]);

      // An entry whose original is gone from its own server, for as long as it is.
      await ctx.db.updateTable('content').set({ origin_gone_at: ctx.clock.now }).where('id', '=', held).execute();
      expect(await found('lighthouse')).toEqual([kept]);
      await ctx.db.updateTable('content').set({ origin_gone_at: null }).where('id', '=', held).execute();
      expect(await found('lighthouse')).toEqual([held, kept]);

      // Set for deletion: gone at once, and its terms with its row when the compactor deletes it.
      ok(await req(bob, 'DELETE', `/content/${held}`), 202);
      expect(await found('lighthouse')).toEqual([kept]);
      expect(await terms(held)).not.toEqual([]);
      await ctx.compact();
      expect(await terms(held)).toEqual([]);
      expect(await found('lighthouse')).toEqual([kept]);

      // An account that is closed takes its posts with it.
      await req(alice, 'DELETE', `/users/${alice.userId}`);
      expect(await found('lighthouse')).toEqual([]);
      await ctx.compact();
      expect(await terms(kept)).toEqual([]);
    });

    it('stops finding a post by a hashtag its moderators took off it, and finds it by one a repost gave it', async () => {
      ctx = await createTestContext(target);
      const root = await admin();
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const contentId = await post(alice, 'Flooding downtown #news #mumbai');
      await ctx.compact();
      ctx.clock.now += 1000;

      // Each is the compactor's to write, with the post's meta file.
      ok(await req(root, 'DELETE', `/content/${contentId}/tags/news`));
      expect(await found('#news')).toEqual([contentId]);
      await ctx.compact();
      expect(await found('#news')).toEqual([]);
      expect(await found('#mumbai flooding')).toEqual([contentId]);

      ctx.clock.now += 1000;
      ok(await ctx.app.inject({ method: 'POST', url: '/repost', payload: { ...bob, contentId, tags: ['weather'] } }), 201);
      expect(await found('#weather')).toEqual([]);
      await ctx.compact();
      expect(await found('#weather')).toEqual([contentId]);
      expect(await terms(contentId)).toEqual(['downtown', 'flooding', 'mumbai', 'weather']);
      // The post itself, once, where it is by its own time: not the repost.
      const [record] = (await posts('flooding')).results;
      expect(record).toMatchObject({ contentId, publisher: { username: 'alice' }, tags: ['mumbai', 'weather'] });
      expect(record!.repost).toBeUndefined();
    });

    it('shows a post that is older than feeds keep summaries, from its meta file', async () => {
      ctx = await createTestContext(target, { feed: { tagRetentionDays: 3 } });
      const alice = await ctx.register('alice');
      const postedAt = ctx.clock.now;
      const old = await post(alice, 'An old lighthouse story #news');
      await ctx.compact();
      ctx.clock.now += 30 * DAY;
      const fresh = await post(alice, 'A fresh lighthouse story #news');
      await ctx.compact();
      expect(await ctx.summaries.getMany([{ contentId: old, createdAt: postedAt }])).toEqual([null]);

      const { results } = await posts('lighthouse story');
      expect(results.map((r) => r.contentId)).toEqual([fresh, old]);
      expect(results[1]).toMatchObject({
        contentId: old,
        publisher: { userId: alice.userId, username: 'alice' },
        preview: { kind: 'text', text: 'An old lighthouse story #news' },
        tags: ['news'],
        likes: 0,
        createdAt: new Date(postedAt).toISOString(),
      });
    });

    it('finds a post only once the compactor has applied it', async () => {
      ctx = await createTestContext(target, { settle: false });
      const alice = await ctx.register('alice');
      const contentId = await post(alice, 'Lighthouse open today #news');
      expect(await found('lighthouse')).toEqual([]);
      expect(await terms(contentId)).toEqual([]);
      // A reindex leaves it to the compactor, which has its meta file to write.
      expect(await ctx.compactor.reindex()).toEqual({ posts: 0, pending: 1, usernames: 0 });
      expect(await terms(contentId)).toEqual([]);
      await ctx.compactor.runOnce();
      expect(await found('lighthouse')).toEqual([contentId]);
    });

    it('is limited by address', async () => {
      ctx = await createTestContext(target, { search: { rateLimitPerMinute: 2 } });
      await ctx.register('alice');
      expect((await search('users', 'al')).statusCode).toBe(200);
      expect((await search('content', 'al')).statusCode).toBe(200);
      expect((await search('users', 'al')).statusCode).toBe(429);
    });

    it('reindexes the posts and the users that were there before search was', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const jose = await ctx.register('José');
      const first = await post(alice, 'Flooding closes the coast road #news');
      ctx.clock.now += 1000;
      const second = await post(jose, 'Coast road reopens #news #traffic');
      await ctx.compact();
      // As the migration leaves a server that had them: no terms, and names in lower case as the database has it.
      await ctx.db.deleteFrom('search_terms').execute();
      await ctx.db.updateTable('users').set({ username_folded: 'josé' }).where('id', '=', jose.userId).execute();
      expect(await found('coast')).toEqual([]);
      expect(await names('jose')).toEqual([]);

      const progress: number[] = [];
      expect(await ctx.compactor.reindex(({ posts: n }) => progress.push(n))).toEqual({ posts: 2, pending: 0, usernames: 1 });
      expect(progress.at(-1)).toBe(2);
      expect(await found('coast road')).toEqual([second, first]);
      expect(await found('#traffic')).toEqual([second]);
      expect(await terms(first)).toEqual(['closes', 'coast', 'flooding', 'news', 'road']);
      expect(await names('jose')).toEqual(['José']);

      // Again, it finds nothing to change; and it waits its turn while a compactor's run is under way.
      const before = await ctx.db.selectFrom('search_terms').selectAll().orderBy('content_id').orderBy('term').execute();
      expect(await ctx.compactor.reindex()).toEqual({ posts: 2, pending: 0, usernames: 0 });
      expect(await ctx.db.selectFrom('search_terms').selectAll().orderBy('content_id').orderBy('term').execute()).toEqual(before);
      // The lease is free once it is done: the compactor's next run isn't skipped.
      expect((await ctx.compactor.runOnce()).skipped).toBe(false);
    });
  });
}
