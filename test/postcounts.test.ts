import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { setAdmin } from '../src/moderation/policy.js';
import type { TestPlugin } from '../src/moderation/trust.types.js';
import { as, createTestContext, requests, TARGETS, type TestContext, type User } from './helpers.js';

/** A hashtag as GET /tags lists it. */
type Listed = { tag: string; postCount: number; lastActiveAt: string };

for (const target of TARGETS) {
  describe(`post counts (${target.name})`, () => {
    let ctx: TestContext;
    afterEach(() => ctx.close());

    const { post, storeText } = requests(() => ctx);
    const req = (u: User | null, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
      ctx.app.inject({ method, url, headers: u ? as(u) : {}, ...(payload && { payload }) });
    const ok = (res: LightMyRequestResponse, status = 200) => {
      expect(res.statusCode, res.body).toBe(status);
      return res.json();
    };
    const refusal = async (url: string) => {
      const res = await ctx.app.inject({ method: 'GET', url });
      return [res.statusCode, res.json().error];
    };
    /** A page of GET /tags. */
    const listed = async (query = ''): Promise<{ tags: Listed[]; nextCursor: string | null }> => ok(await req(null, 'GET', `/tags${query}`));
    /** How many posts each hashtag has, by its name. */
    const counts = async () => Object.fromEntries((await listed()).tags.map((t) => [t.tag, t.postCount]));
    /** The hashtags GET /tags lists, in its order, with how many posts each has: "news 2". */
    const order = async (query = '') => (await listed(query)).tags.map((t) => `${t.tag} ${t.postCount}`);
    /** How many posts the server says it has. */
    const total = async (): Promise<number> => ok(await req(null, 'GET', '/rules')).postCount;
    /** Every page of GET /tags, of `limit` each, as a client reads them: the hashtags' names. */
    const pages = async (query: string, limit: number) => {
      const all: string[][] = [];
      for (let cursor: string | null = null, first = true; first || cursor; first = false) {
        const page = await listed(`?${query}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        all.push(page.tags.map((t) => t.tag));
        cursor = page.nextCursor;
      }
      return all;
    };
    const admin = async (name = 'root') => {
      const u = await ctx.register(name);
      await setAdmin(ctx.db, name, true);
      return u;
    };

    it('counts the posts of each hashtag, and of the server, once the compactor has applied them', async () => {
      ctx = await createTestContext(target, { settle: false });
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      // A server with no post says so, and lists no hashtag.
      expect(await total()).toBe(0);
      expect(await listed()).toEqual({ tags: [], nextCursor: null });

      await post(alice, 'Flooding downtown #news #mumbai');
      await post(bob, 'Roads reopen #news');
      await post(bob, 'Harbour closed #harbour');
      // A hashtag is listed from the request that published under it, and no request counts anything.
      expect(await counts()).toEqual({ news: 0, mumbai: 0, harbour: 0 });
      expect(await total()).toBe(0);

      await ctx.compactor.runOnce();
      expect(await counts()).toEqual({ news: 2, mumbai: 1, harbour: 1 });
      // Each with when it was last published under, as before.
      expect((await listed()).tags.find((t) => t.tag === 'news')).toEqual({ tag: 'news', postCount: 2, lastActiveAt: new Date(ctx.clock.now).toISOString() });
      // Each post once for the server, however many hashtags it has; a publisher's own index is no hashtag, and counts nothing.
      expect(await total()).toBe(3);
      expect((await ctx.db.selectFrom('tags').select(['name', 'post_count']).where('name', 'like', '@%').execute()).map((r) => Number(r.post_count))).toEqual([0, 0]);

      // A run with nothing new to write counts nothing again.
      await ctx.compact();
      expect(await counts()).toEqual({ news: 2, mumbai: 1, harbour: 1 });
      expect(await total()).toBe(3);
    });

    it('counts a post for the hashtags an update gives it, and no more for the ones it drops, nor for anything once it is deleted', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const contentId = await post(alice, 'Flooding downtown #news #mumbai');
      const other = await post(bob, 'Roads reopen #news');
      expect(await counts()).toEqual({ news: 2, mumbai: 1 });

      ctx.clock.now += 1000;
      ok(await storeText(alice, 'Sunshine downtown #weather #mumbai #sun', { contentId }));
      expect(await counts()).toEqual({ news: 1, mumbai: 1, weather: 1, sun: 1 });
      expect(await total()).toBe(2);
      // The same, sent again, changes nothing.
      ok(await storeText(alice, 'Sunshine downtown #weather #mumbai #sun', { contentId }));
      await ctx.compact();
      expect(await counts()).toEqual({ news: 1, mumbai: 1, weather: 1, sun: 1 });
      expect(await total()).toBe(2);

      // A post that is set for deletion counts until the compactor deletes it, which is when it leaves the feeds.
      ok(await req(alice, 'DELETE', `/content/${contentId}`), 202);
      expect(await counts()).toEqual({ news: 1, mumbai: 1, weather: 1, sun: 1 });
      expect(await total()).toBe(2);
      await ctx.compact();
      // A hashtag that no post carries any more is still one posts have used.
      expect(await counts()).toEqual({ news: 1, mumbai: 0, weather: 0, sun: 0 });
      expect(await total()).toBe(1);

      // An account that is closed takes its posts with it, and what they counted for.
      await req(bob, 'DELETE', `/users/${bob.userId}`);
      await ctx.compact();
      expect(await counts()).toEqual({ news: 0, mumbai: 0, weather: 0, sun: 0 });
      expect(await total()).toBe(0);
      expect(await ctx.db.selectFrom('content').select('id').where('id', 'in', [contentId, other]).execute()).toEqual([]);
    });

    it('counts no post that waits in the moderation queue, and counts it once an admin lets it through', async () => {
      /** Holds what shouts for an admin to look at. */
      const shouting: TestPlugin = { name: 'shouting', rules: [{ includes: 'FREE', reduce: 30 }] };
      ctx = await createTestContext(target, { trustPlugins: [shouting] });
      const root = await admin();
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      await post(alice, 'Lighthouse open today #news');

      const held = ok(await storeText(bob, 'FREE lighthouse tickets #news #tickets'), 202).contentId;
      await ctx.compact();
      expect(await counts()).toEqual({ news: 1 });
      expect(await total()).toBe(1);

      // Accepting it writes nothing of the post: the compactor's next run counts it, as it puts it in the feeds.
      ok(await req(root, 'POST', `/moderation/queue/${held}/accept`));
      expect(await counts()).toEqual({ news: 1, tickets: 0 });
      await ctx.compact();
      expect(await counts()).toEqual({ news: 2, tickets: 1 });
      expect(await total()).toBe(2);

      // An update of it that is held takes it out of the feeds, and out of the counts, until that is let through too.
      ctx.clock.now += 1000;
      ok(await storeText(bob, 'FREE lighthouse tickets, again #tickets #lighthouse', { contentId: held }), 202);
      await ctx.compact();
      expect(await counts()).toEqual({ news: 1, tickets: 0 });
      expect(await total()).toBe(1);
      ok(await req(root, 'POST', `/moderation/queue/${held}/accept`));
      await ctx.compact();
      expect(await counts()).toEqual({ news: 1, tickets: 1, lighthouse: 1 });
      expect(await total()).toBe(2);

      // One that is rejected was never counted, and takes nothing away.
      const refused = ok(await storeText(bob, 'FREE boat trips #news'), 202).contentId;
      ok(await req(root, 'POST', `/moderation/queue/${refused}/reject`), 202);
      await ctx.compact();
      expect(await counts()).toEqual({ news: 1, tickets: 1, lighthouse: 1 });
      expect(await total()).toBe(2);
    });

    it('counts a post for a hashtag a repost gave it, and no more for one a moderator took off it', async () => {
      ctx = await createTestContext(target);
      const root = await admin();
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const contentId = await post(alice, 'Flooding downtown #news #mumbai');
      await ctx.compact();
      expect(await counts()).toEqual({ news: 1, mumbai: 1 });

      // Each is the compactor's to write, with the post's meta file.
      ctx.clock.now += 1000;
      ok(await req(root, 'DELETE', `/content/${contentId}/tags/news`));
      expect(await counts()).toEqual({ news: 1, mumbai: 1 });
      await ctx.compact();
      expect(await counts()).toEqual({ news: 0, mumbai: 1 });

      ctx.clock.now += 1000;
      ok(await req(null, 'POST', '/repost', { ...bob, contentId, tags: ['weather'] }), 201);
      expect(await counts()).toEqual({ news: 0, mumbai: 1, weather: 0 });
      await ctx.compact();
      expect(await counts()).toEqual({ news: 0, mumbai: 1, weather: 1 });
      // A repost is no post of its own: the server has the one.
      expect(await total()).toBe(1);

      // And no more once the repost is removed.
      ctx.clock.now += 1000;
      expect((await req(root, 'DELETE', `/content/${contentId}/reposts/${bob.userId}`)).statusCode).toBe(200);
      await ctx.compact();
      expect(await counts()).toEqual({ news: 0, mumbai: 1, weather: 0 });
      expect(await total()).toBe(1);

      // A post that is left with no hashtag is still one of the server's.
      ctx.clock.now += 1000;
      ok(await req(root, 'DELETE', `/content/${contentId}/tags/mumbai`));
      await ctx.compact();
      expect(await counts()).toEqual({ news: 0, mumbai: 0, weather: 0 });
      expect(await total()).toBe(1);
      expect(await ctx.db.selectFrom('content').select('counted_tags').where('id', '=', contentId).execute()).toEqual([{ counted_tags: '' }]);
    });

    it('lists the hashtags by how many posts they have, or by when they were last active, a page at a time', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      // In the order they were last published under: cars, boats, bikes, then cats and coast together, then birds.
      for (const text of ['One #cars', 'Two #cars #boats', 'Three #boats #bikes', 'Four #bikes #cats #coast', 'Five #bikes', 'Six #cats #coast', 'Seven #birds']) {
        ctx.clock.now += 1000;
        await post(alice, text);
      }
      await ctx.compact();

      // The most recently active first, unless asked otherwise; two that are level, in the reverse order of their names.
      const recent = ['birds 1', 'coast 2', 'cats 2', 'bikes 3', 'boats 2', 'cars 2'];
      expect(await order()).toEqual(recent);
      expect(await order('?sort=recent')).toEqual(recent);
      const popular = ['bikes 3', 'coast 2', 'cats 2', 'cars 2', 'boats 2', 'birds 1'];
      expect(await order('?sort=popular')).toEqual(popular);
      // Only the ones that start with what was asked for, in either order.
      expect(await order('?sort=popular&prefix=b')).toEqual(['bikes 3', 'boats 2', 'birds 1']);
      expect(await order('?sort=popular&prefix=%23CA')).toEqual(['cats 2', 'cars 2']);
      expect(await order('?prefix=c')).toEqual(['coast 2', 'cats 2', 'cars 2']);
      expect(await order('?sort=popular&prefix=z')).toEqual([]);

      // A page at a time, each hashtag once, the ones that are level too.
      const names = (rows: string[]) => rows.map((row) => row.split(' ')[0]);
      for (const [query, all] of [
        ['sort=popular', popular],
        ['sort=recent', recent],
      ] as const) {
        const paged = await pages(query, 4);
        expect(paged.map((page) => page.length)).toEqual([4, 2]);
        expect(paged.flat()).toEqual(names([...all]));
        expect((await pages(query, 1)).flat()).toEqual(names([...all]));
        // A page that is the last one says so, when it is full too.
        expect((await listed(`?${query}&limit=6`)).nextCursor).toBeNull();
        expect((await listed(`?${query}&limit=5`)).nextCursor).not.toBeNull();
      }
      expect((await pages('sort=popular&prefix=c', 2)).flat()).toEqual(['coast', 'cats', 'cars']);

      // A cursor is of the list it came from, in the order it came in.
      for (const cursor of ['nonsense', Buffer.from('{"a":1}').toString('base64url'), Buffer.from('["popular",1]').toString('base64url'), Buffer.from('["popular","1","cars"]').toString('base64url')]) {
        expect(await refusal(`/tags?sort=popular&cursor=${cursor}`)).toEqual([400, 'invalid cursor']);
      }
      const { nextCursor } = await listed('?sort=popular&limit=1');
      expect(await refusal(`/tags?cursor=${nextCursor}`)).toEqual([400, 'invalid cursor']);
      expect(await refusal(`/tags?sort=recent&cursor=${nextCursor}`)).toEqual([400, 'invalid cursor']);
      for (const query of ['sort=newest', 'limit=0', 'limit=1001', 'prefix=no-dash']) expect((await req(null, 'GET', `/tags?${query}`)).statusCode, query).toBe(400);
      expect((await listed('?sort=popular&limit=1000')).tags).toHaveLength(6);
    });

    it('counts the posts that were there before posts were counted, with a reindex', async () => {
      /** Holds what shouts for an admin to look at. */
      const shouting: TestPlugin = { name: 'shouting', rules: [{ includes: 'FREE', reduce: 30 }] };
      ctx = await createTestContext(target, { trustPlugins: [shouting] });
      const alice = await ctx.register('alice');
      const first = await post(alice, 'Flooding closes the coast road #news');
      await post(alice, 'Coast road reopens #news #traffic');
      await post(alice, 'Harbour closed #harbour');
      ok(await storeText(alice, 'FREE road maps #news'), 202);
      await ctx.compact();
      expect(await counts()).toEqual({ news: 2, traffic: 1, harbour: 1 });
      expect(await total()).toBe(3);

      // As the migration leaves a server that had them: nothing counted.
      const forget = async () => {
        await ctx.db.updateTable('content').set({ counted_tags: null }).execute();
        await ctx.db.updateTable('tags').set({ post_count: 0 }).execute();
        await ctx.db.updateTable('server_counts').set({ post_count: 0 }).execute();
      };
      await forget();
      expect(await counts()).toEqual({ news: 0, traffic: 0, harbour: 0 });
      expect(await total()).toBe(0);

      // Every post that anyone can read, and not the one that waits in the moderation queue.
      expect(await ctx.compactor.reindex()).toEqual({ posts: 4, pending: 0, usernames: 0 });
      expect(await counts()).toEqual({ news: 2, traffic: 1, harbour: 1 });
      expect(await total()).toBe(3);
      // Again, it finds nothing to change.
      expect(await ctx.compactor.reindex()).toEqual({ posts: 4, pending: 0, usernames: 0 });
      expect(await counts()).toEqual({ news: 2, traffic: 1, harbour: 1 });
      expect(await total()).toBe(3);

      // Without one, a post is counted the next time a run writes it, and the others when their turn comes.
      await forget();
      ctx.clock.now += 1000;
      ok(await storeText(alice, 'Flooding closes the coast road again #news #coast', { contentId: first }));
      await ctx.compact();
      expect(await counts()).toEqual({ news: 1, traffic: 0, harbour: 0, coast: 1 });
      expect(await total()).toBe(1);
    });
  });
}
