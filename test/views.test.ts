import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TestPlugin } from '../src/moderation/trust.types.js';
import { authorIndex } from '../src/tagfeed/layout.js';
import { HOUR } from '../src/time.js';
import { as, createTestContext, type FeedItem, requests, TARGETS, type TestContext, type User } from './helpers.js';

/** A trust plugin that holds whatever says "held" for the moderation queue, and lets the rest through. */
const holdsHeld: TestPlugin = { name: 'holds-held', rules: [{ includes: 'held', ignoreCase: true, set: 50 }] };

for (const target of TARGETS) {
  describe(`views (${target.name})`, () => {
    let ctx: TestContext;
    afterEach(async () => {
      vi.restoreAllMocks();
      await ctx.close();
    });

    const { post, storeText, read, like, feed, feedItems } = requests(() => ctx);
    const req = (u: User | null, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
      ctx.app.inject({ method, url, headers: u ? as(u) : {}, ...(payload && { payload }) });
    const ok = (res: LightMyRequestResponse, status = 200) => {
      expect(res.statusCode, res.body).toBe(status);
      return res.json();
    };
    /** What the post's row has of its views: how many, and when the last was. */
    const counted = async (contentId: string) => {
      const row = await ctx.db.selectFrom('content').select(['view_count', 'viewed_at']).where('id', '=', contentId).executeTakeFirstOrThrow();
      return [Number(row.view_count), row.viewed_at === null ? null : Number(row.viewed_at)];
    };
    /** The views a read of the post says it has: as `user`, which is a view, or with no credentials, which is none. */
    const views = async (contentId: string, user?: User) => ok(await read(contentId, user)).views as number;
    /** Each record of a hashtag's feed, with its views. */
    const shown = async (tag: string) => (await feedItems(tag)).map((r) => [r.contentId, r.views]);

    it('counts a view each time a user account reads a post, and none for a read without one', async () => {
      ctx = await createTestContext(target);
      const [alice, bob, carol] = [await ctx.register('alice'), await ctx.register('bob'), await ctx.register('carol')];
      const contentId = await post(alice, 'Flooding downtown #news');
      const other = await post(alice, 'Sunny all week #news');

      // A post starts with none, and a read that carries no credentials leaves it so.
      expect(await counted(contentId)).toEqual([0, null]);
      expect(ok(await read(contentId))).toMatchObject({ contentId, likes: 0, views: 0, dislikes: null });
      expect(await counted(contentId)).toEqual([0, null]);

      // A user's read is a view, which the answer already counts. Views, not viewers: the same user again is another.
      expect(await views(contentId, bob)).toBe(1);
      ctx.clock.now += 1000;
      expect(await views(contentId, bob)).toBe(2);
      expect(await views(contentId, carol)).toBe(3);
      // The publisher is a user account like any other.
      ctx.clock.now += 1000;
      const last = ctx.clock.now;
      expect(await views(contentId, alice)).toBe(4);
      expect(await counted(contentId)).toEqual([4, last]);

      // Credentials that are nobody's are answered as a read with none is, and count nothing.
      ctx.clock.now += 1000;
      expect(ok(await req({ userId: bob.userId, apiKey: 'nope' }, 'GET', `/content/${contentId}`)).views).toBe(4);
      expect(ok(await req({ userId: carol.userId, apiKey: bob.apiKey }, 'GET', `/content/${contentId}`)).views).toBe(4);
      expect(await views(contentId)).toBe(4);
      // Nor does anything but the read of the post itself: its bytes, a feed it is in, a search that finds it, its publisher's profile.
      expect((await req(bob, 'GET', `/content/${contentId}/raw`)).body).toBe('Flooding downtown #news');
      await ctx.compact();
      ok(await req(bob, 'GET', '/feed?tags=news'));
      ok(await req(bob, 'GET', '/search?type=content&q=flooding'));
      ok(await req(bob, 'GET', `/users/${alice.userId}/posts`));
      expect(await counted(contentId)).toEqual([4, last]);
      // A view is the one post's.
      expect(await counted(other)).toEqual([0, null]);

      // A like is no view, and a view no like.
      ok(await like(bob, contentId), 201);
      expect(ok(await read(contentId))).toMatchObject({ likes: 1, views: 4 });
    });

    it("shows a post's views in feeds once the compactor has run, which writes again only the indexes of what was viewed", async () => {
      ctx = await createTestContext(target);
      const [alice, bob, carol] = [await ctx.register('alice'), await ctx.register('bob'), await ctx.register('carol')];
      ok(await req(carol, 'PUT', `/users/${carol.userId}/following/${alice.userId}`), 201);
      const first = await post(alice, 'Flooding downtown #news');
      ctx.clock.now += 1000;
      const second = await post(alice, 'Final score #news #sports');
      const following = async () => (ok(await req(carol, 'GET', `/feed/following?userId=${carol.userId}`)).records as FeedItem[]).map((r) => [r.contentId, r.views]);

      // Viewed before it was ever in a feed: its first entry has the count.
      expect(await views(second, bob)).toBe(1);
      await ctx.compact();
      expect(await shown('news')).toEqual([[second, 1], [first, 0]]);
      expect(await shown('sports')).toEqual([[second, 1]]);
      expect(await following()).toEqual([[second, 1], [first, 0]]);

      // Feeds have the count they had until the compactor has run, and then the new one. Views order nothing.
      expect(await views(first, bob)).toBe(1);
      expect(await views(first, bob)).toBe(2);
      expect(await views(first, carol)).toBe(3);
      expect(await shown('news')).toEqual([[second, 1], [first, 0]]);
      expect((await ctx.compact()).tags).toEqual([authorIndex(alice.userId), 'news']);
      expect(await shown('news')).toEqual([[second, 1], [first, 3]]);
      expect(await shown('sports')).toEqual([[second, 1]]);
      expect(await following()).toEqual([[second, 1], [first, 3]]);
      // A feed of several hashtags, and every page of one, has them too.
      const both = await feed('tags=news,sports');
      expect(both.records.map((r) => [r.contentId, r.views]).sort()).toEqual([[first, 3], [second, 1]].sort());
      const page = await feed('tags=news&limit=1');
      expect(page.records.map((r) => [r.contentId, r.views])).toEqual([[second, 1]]);
      const rest = await feed(`tags=news&limit=1&cursor=${page.nextCursor}`);
      expect(rest.records.map((r) => [r.contentId, r.views])).toEqual([[first, 3]]);

      // A run after which nothing was viewed writes nothing again.
      expect((await ctx.compact()).tags).toEqual([]);
      // One with no credentials is no view, so there is nothing to write for it either.
      expect(await views(first)).toBe(3);
      expect((await ctx.compact()).tags).toEqual([]);

      // What reads a post from the database has its views as they are now, with no run in between.
      expect(await views(second, carol)).toBe(2);
      const posts = ok(await req(null, 'GET', `/users/${alice.userId}/posts`)).posts as FeedItem[];
      expect(posts.map((r) => [r.contentId, r.views, r.dislikes])).toEqual([[second, 2, null], [first, 3, null]]);
      const found = ok(await req(null, 'GET', '/search?type=content&q=score')).results as FeedItem[];
      expect(found.map((r) => [r.contentId, r.views, r.dislikes])).toEqual([[second, 2, null]]);
      expect(await shown('sports')).toEqual([[second, 1]]);
    });

    it("gives a repost's record the post's views, all of them, where its likes are those since the repost", async () => {
      ctx = await createTestContext(target);
      const [alice, bob, carol] = [await ctx.register('alice'), await ctx.register('bob'), await ctx.register('carol')];
      const contentId = await post(alice, 'Flooding downtown #news');
      ok(await like(carol, contentId), 201);
      expect(await views(contentId, carol)).toBe(1);
      await ctx.compact();

      ctx.clock.now += HOUR;
      ok(await req(null, 'POST', '/repost', { ...bob, contentId, tags: ['weather'] }), 201);
      expect(await views(contentId, bob)).toBe(2);
      await ctx.compact();
      const record = async (tag: string) => (await feedItems(tag)).map((r) => [r.contentId, r.likes, r.views, r.repost !== undefined]);
      expect(await record('weather')).toEqual([[contentId, 0, 2, true]]);
      expect(await record('news')).toEqual([[contentId, 1, 2, false]]);

      // A view since is the post's, under every hashtag it is read under.
      expect(await views(contentId, alice)).toBe(3);
      await ctx.compact();
      expect(await record('weather')).toEqual([[contentId, 0, 3, true]]);
      expect(await record('news')).toEqual([[contentId, 1, 3, false]]);
    });

    it('counts no view of content that is withheld from readers, or set for deletion', async () => {
      ctx = await createTestContext(target, { trustPlugins: [holdsHeld] });
      const [alice, bob] = [await ctx.register('alice'), await ctx.register('bob')];
      const held = ok(await storeText(alice, 'Held for review #news'), 202).contentId as string;

      // Its publisher reads it while it waits, which is no view: nobody else can.
      expect(ok(await read(held, alice))).toMatchObject({ status: 'pending_review', views: 0 });
      expect((await read(held, bob)).statusCode).toBe(404);
      expect(await counted(held)).toEqual([0, null]);

      // A post that is set for deletion is gone to a read, and its count is as it was.
      const doomed = await post(alice, 'Doomed #news');
      expect(await views(doomed, bob)).toBe(1);
      const viewedAt = ctx.clock.now;
      ctx.clock.now += 1000;
      ok(await req(alice, 'DELETE', `/content/${doomed}`), 202);
      expect((await read(doomed, bob)).statusCode).toBe(404);
      expect(await counted(doomed)).toEqual([1, viewedAt]);
    });

    it('counts every one of the views that reach it at once', async () => {
      ctx = await createTestContext(target);
      const [alice, bob, carol] = [await ctx.register('alice'), await ctx.register('bob'), await ctx.register('carol')];
      const contentId = await post(alice, 'Flooding downtown #news');
      const answers = await Promise.all([bob, carol, bob, carol, alice, bob, carol, alice].map((u) => read(contentId, u)));
      expect(answers.map((res) => res.statusCode)).toEqual(answers.map(() => 200));
      // Each answer counts its own view, and may be read before another's is written.
      for (const res of answers) expect(res.json().views).toBeGreaterThanOrEqual(1);
      expect((await counted(contentId))[0]).toBe(8);
      expect(await views(contentId)).toBe(8);
    });

    it("answers a read whose view can't be counted, without the view", async () => {
      ctx = await createTestContext(target);
      const [alice, bob] = [await ctx.register('alice'), await ctx.register('bob')];
      const contentId = await post(alice, 'Flooding downtown #news');
      expect(await views(contentId, bob)).toBe(1);

      const update = vi.spyOn(ctx.db, 'updateTable').mockImplementation(() => {
        throw new Error('database unavailable');
      });
      expect(ok(await read(contentId, bob))).toMatchObject({ contentId, text: 'Flooding downtown #news', views: 1 });
      expect(update).toHaveBeenCalledWith('content');
      update.mockRestore();
      expect(await views(contentId, bob)).toBe(2);
    });
  });
}
