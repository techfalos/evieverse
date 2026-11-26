import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAdmin } from '../src/moderation/policy.js';
import { authorIndex, compareRecent } from '../src/tagfeed/layout.js';
import { DAY } from '../src/time.js';
import { as, createTestContext, requests, TARGETS, type FeedItem, type TestContext, type User } from './helpers.js';

type FollowingFeed = { count: number; truncated: boolean; nextCursor: string | null; records: FeedItem[] };
type UserList = { userId: string; nextCursor: string | null } & Record<'following' | 'followers', { userId: string; username: string; followedAt: string }[]>;

for (const target of TARGETS) {
  describe(`follows and following feeds (${target.name})`, () => {
    let ctx: TestContext;
    afterEach(async () => {
      vi.restoreAllMocks();
      await ctx.close();
    });

    const follow = (u: User, followeeId: string) => ctx.app.inject({ method: 'PUT', url: `/users/${u.userId}/following/${followeeId}`, headers: as(u) });
    const unfollow = (u: User, followeeId: string) => ctx.app.inject({ method: 'DELETE', url: `/users/${u.userId}/following/${followeeId}`, headers: as(u) });
    /** A list of `userId`'s, as `reader` (or as nobody) is answered when asking for it. */
    const read = (userId: string, which: 'following' | 'followers', reader?: User, query = '') =>
      ctx.app.inject({ method: 'GET', url: `/users/${userId}/${which}${query}`, headers: reader ? as(reader) : {} });
    /** A user's own list, which they can read whether or not they show it. */
    const list = async (u: User, which: 'following' | 'followers', query = '') => {
      const res = await read(u.userId, which, u, query);
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as UserList;
    };
    const update = (u: User, payload: Record<string, unknown>, userId = u.userId) => ctx.app.inject({ method: 'PATCH', url: `/users/${userId}`, headers: as(u), payload });
    const whoami = async (u: User) => (await ctx.app.inject({ method: 'GET', url: '/whoami', headers: as(u) })).json();
    const { post } = requests(() => ctx);
    /** `userId`'s following feed, as `reader` (or as nobody) is answered when asking for it. */
    const readFeed = (userId: string, reader?: User, query = '') =>
      ctx.app.inject({ method: 'GET', url: `/feed/following?userId=${userId}${query}`, headers: reader ? as(reader) : {} });
    /** A user's own following feed, which they can read whether or not they show whom they follow. */
    const feed = async (u: User, query = ''): Promise<FollowingFeed> => {
      const res = await readFeed(u.userId, u, query);
      expect(res.statusCode, res.body).toBe(200);
      return res.json();
    };
    const ids = (f: FollowingFeed) => f.records.map((r) => r.contentId);

    it('lets users follow and unfollow others, only as themselves, and lists both sides of every follow', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const carol = await ctx.register('carol');

      const first = await follow(bob, alice.userId);
      expect(first.statusCode, first.body).toBe(201);
      const followedAt = new Date(ctx.clock.now).toISOString();
      expect(first.json()).toEqual({ userId: bob.userId, followeeId: alice.userId, followedAt, alreadyFollowing: false });
      ctx.clock.now += 1000;
      const again = await follow(bob, alice.userId);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual({ userId: bob.userId, followeeId: alice.userId, followedAt, alreadyFollowing: true });

      const path = `/users/${bob.userId}/following/${alice.userId}`;
      expect((await ctx.app.inject({ method: 'PUT', url: path, headers: as(carol) })).statusCode).toBe(403);
      expect((await ctx.app.inject({ method: 'PUT', url: path, headers: { ...as(bob), authorization: 'Bearer nope' } })).statusCode).toBe(401);
      expect((await ctx.app.inject({ method: 'PUT', url: path, payload: bob })).statusCode).toBe(200);
      expect((await follow(bob, bob.userId)).statusCode).toBe(400);
      expect((await follow(bob, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
      expect((await ctx.app.inject({ method: 'PUT', url: `/users/${bob.userId}/following/alice`, headers: as(bob) })).statusCode).toBe(400);

      expect((await follow(carol, alice.userId)).statusCode).toBe(201);
      expect((await follow(carol, bob.userId)).statusCode).toBe(201);
      const followers = await list(alice, 'followers');
      expect(followers.followers.map((u) => [u.username, u.followedAt])).toEqual([
        ['carol', new Date(ctx.clock.now).toISOString()],
        ['bob', followedAt],
      ]);
      expect(followers.nextCursor).toBeNull();
      expect((await list(carol, 'following')).following.map((u) => u.username).sort()).toEqual(['alice', 'bob']);
      expect((await list(alice, 'following')).following).toEqual([]);

      // One page at a time.
      const page1 = await list(alice, 'followers', '?limit=1');
      expect(page1.followers.map((u) => u.username)).toEqual(['carol']);
      const page2 = await list(alice, 'followers', `?limit=1&cursor=${page1.nextCursor}`);
      expect(page2.followers.map((u) => u.username)).toEqual(['bob']);
      expect(page2.nextCursor).toBeNull();
      expect((await ctx.app.inject({ method: 'GET', url: `/users/${alice.userId}/followers?cursor=nope` })).statusCode).toBe(400);
      expect((await ctx.app.inject({ method: 'GET', url: '/users/00000000-0000-4000-8000-000000000000/following' })).statusCode).toBe(404);

      expect((await unfollow(bob, alice.userId)).json()).toEqual({ userId: bob.userId, followeeId: alice.userId, wasFollowing: true });
      expect((await unfollow(bob, alice.userId)).json()).toEqual({ userId: bob.userId, followeeId: alice.userId, wasFollowing: false });
      expect((await ctx.app.inject({ method: 'DELETE', url: `/users/${carol.userId}/following/${alice.userId}`, headers: as(bob) })).statusCode).toBe(403);
      expect((await list(alice, 'followers')).followers.map((u) => u.username)).toEqual(['carol']);
      expect(await ctx.follows.get(bob.userId)).toEqual([]);
      expect((await ctx.follows.get(carol.userId)).sort()).toEqual([alice.userId, bob.userId].sort());
    });

    it('hides whom a user follows, and who follows them, from everyone else until the user shows either list', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const carol = await ctx.register('carol');
      expect((await follow(alice, bob.userId)).statusCode).toBe(201);
      expect((await follow(carol, alice.userId)).statusCode).toBe(201);
      const refused = async (which: 'following' | 'followers', reader?: User) => {
        const res = await read(alice.userId, which, reader);
        return [res.statusCode, res.json().error];
      };
      const names = async (which: 'following' | 'followers', reader?: User) => {
        const res = await read(alice.userId, which, reader);
        expect(res.statusCode, res.body).toBe(200);
        return (res.json() as UserList)[which].map((u) => u.username);
      };

      // Neither list is shown to begin with: not to someone without a key, nor to another user, one in the list included.
      expect(await whoami(alice)).toMatchObject({ showFollowing: false, showFollowers: false });
      for (const reader of [undefined, bob, carol]) {
        expect(await refused('following', reader)).toEqual([403, "this user doesn't show whom they follow"]);
        expect(await refused('followers', reader)).toEqual([403, "this user doesn't show who follows them"]);
      }
      // They are still the user's own to read, by their key and no other.
      expect(await names('following', alice)).toEqual(['bob']);
      expect(await names('followers', alice)).toEqual(['carol']);
      const wrongKey = await ctx.app.inject({ method: 'GET', url: `/users/${alice.userId}/following`, headers: { ...as(alice), authorization: 'Bearer nope' } });
      expect(wrongKey.statusCode).toBe(401);
      // A user who isn't there is answered before what they show.
      expect((await read('00000000-0000-4000-8000-000000000000', 'followers', alice)).statusCode).toBe(404);

      // Each list is shown on its own.
      const shown = await update(alice, { showFollowing: true });
      expect([shown.statusCode, shown.json()]).toEqual([200, { userId: alice.userId, username: 'alice', language: 'en', messages: true, showFollowing: true, showFollowers: false, bio: null, links: [], avatarUrl: null }]);
      expect(await whoami(alice)).toMatchObject({ showFollowing: true, showFollowers: false });
      expect(await names('following')).toEqual(['bob']);
      expect(await names('following', carol)).toEqual(['bob']);
      expect(await refused('followers')).toEqual([403, "this user doesn't show who follows them"]);
      // A shown list looks no key up, so a wrong one doesn't matter.
      expect((await ctx.app.inject({ method: 'GET', url: `/users/${alice.userId}/following`, headers: { ...as(alice), authorization: 'Bearer nope' } })).statusCode).toBe(200);
      // It is alice's setting, and nobody else's lists are shown for it.
      expect((await read(bob.userId, 'followers')).statusCode).toBe(403);
      expect((await read(carol.userId, 'following')).statusCode).toBe(403);

      expect((await update(alice, { showFollowers: true })).json()).toMatchObject({ showFollowing: true, showFollowers: true });
      expect(await names('followers')).toEqual(['carol']);
      expect(await names('followers', bob)).toEqual(['carol']);

      // And hidden again on its own, with the other left as it was. A form sends its flags as strings.
      expect((await update(alice, { showFollowing: 'false' })).json()).toMatchObject({ showFollowing: false, showFollowers: true });
      expect(await refused('following', bob)).toEqual([403, "this user doesn't show whom they follow"]);
      expect(await names('followers')).toEqual(['carol']);
      expect(await names('following', alice)).toEqual(['bob']);
      // Changing something else changes neither.
      expect((await update(alice, { messages: false })).json()).toMatchObject({ messages: false, showFollowing: false, showFollowers: true });

      // Only the user sets what they show.
      expect((await update(bob, { showFollowing: true }, alice.userId)).statusCode).toBe(403);
      expect((await update(alice, { showFollowers: 'sometimes' })).statusCode).toBe(400);
      expect(await whoami(alice)).toMatchObject({ showFollowing: false, showFollowers: true });
    });

    it("keeps a user's following feed, which names whom they follow, to them unless they show whom they follow", async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const carol = await ctx.register('carol');
      expect((await follow(alice, bob.userId)).statusCode).toBe(201);
      expect((await follow(carol, alice.userId)).statusCode).toBe(201);
      const fromBob = await post(bob, 'bob on the news #news');
      await ctx.compact();
      const answer = async (reader?: User, headers: Record<string, string> = {}) => {
        const res = await ctx.app.inject({ method: 'GET', url: `/feed/following?userId=${alice.userId}`, headers: { ...(reader && as(reader)), ...headers } });
        return res.statusCode === 200 ? [200, ids(res.json())] : [res.statusCode, res.json().error];
      };
      const hidden = [403, "this user doesn't show whom they follow"];

      // Hidden to begin with, as the list of whom she follows is: from someone without a key, and from
      // another user, be it one she follows or one who follows her.
      for (const reader of [undefined, bob, carol]) expect(await answer(reader)).toEqual(hidden);
      // An admin is another user too.
      const root = await ctx.register('root');
      await setAdmin(ctx.db, 'root', true);
      expect(await answer(root)).toEqual(hidden);
      // It is hers to read, by her key and no other, and both parts of it.
      expect(await answer(alice)).toEqual([200, [fromBob]]);
      expect((await answer(alice, { authorization: 'Bearer nope' }))[0]).toBe(401);
      expect((await answer(undefined, { authorization: `Bearer ${alice.apiKey}` }))[0]).toBe(403);
      // A user who isn't there is answered before what they show, and has no feed.
      expect((await readFeed('00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);

      // Showing who follows her doesn't show it: showing whom she follows does, to anyone.
      expect((await update(alice, { showFollowers: true })).statusCode).toBe(200);
      expect(await answer()).toEqual(hidden);
      expect((await update(alice, { showFollowing: true })).statusCode).toBe(200);
      for (const reader of [undefined, bob, carol, alice]) expect(await answer(reader)).toEqual([200, [fromBob]]);
      // What is shown looks no key up, so a wrong one doesn't matter.
      expect(await answer(alice, { authorization: 'Bearer nope' })).toEqual([200, [fromBob]]);
      // It is alice's setting, and nobody else's feed is shown for it.
      expect((await readFeed(carol.userId)).statusCode).toBe(403);
      expect((await readFeed(carol.userId, alice)).statusCode).toBe(403);

      // And hidden again, at once.
      expect((await update(alice, { showFollowing: false })).statusCode).toBe(200);
      expect(await answer(bob)).toEqual(hidden);
      expect(await answer(alice)).toEqual([200, [fromBob]]);
    });

    it('limits how many users one user can follow, even when they follow several at once', async () => {
      ctx = await createTestContext(target, { maxFollowing: 2 });
      const reader = await ctx.register('reader');
      const others: User[] = [];
      for (const name of ['a', 'b', 'c']) others.push(await ctx.register(name));

      const results = await Promise.all(others.map((u) => follow(reader, u.userId)));
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 201, 409]);
      expect(results.find((r) => r.statusCode === 409)!.json().error).toBe('you can follow at most 2 users');
      expect((await list(reader, 'following')).following).toHaveLength(2);

      const refused = others[results.findIndex((r) => r.statusCode === 409)]!;
      const followed = others.find((u) => u !== refused)!;
      expect((await follow(reader, followed.userId)).statusCode).toBe(200);
      expect((await unfollow(reader, followed.userId)).statusCode).toBe(200);
      expect((await follow(reader, refused.userId)).statusCode).toBe(201);
    });

    it('returns the posts of followed users only, newest first, whatever their hashtags', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const carol = await ctx.register('carol');
      const dave = await ctx.register('dave');
      await follow(dave, alice.userId);
      await follow(dave, bob.userId);

      const a1 = await post(alice, 'alice on the news #news');
      ctx.clock.now += 1000;
      const b1 = await post(bob, 'bob on sports #sports', { aiGenerated: true });
      ctx.clock.now += 1000;
      const c1 = await post(carol, 'carol on the news #news');
      await post(dave, 'dave on his own #news');
      await ctx.compact();
      const a2 = await post(alice, 'alice again #weather');
      ctx.clock.now += 1000;
      // Not there until the compactor has put it in alice's own index.
      expect(ids(await feed(dave))).toEqual([b1, a1]);
      await ctx.compactor.runOnce();

      const f = await feed(dave);
      expect(ids(f)).toEqual([a2, b1, a1]);
      expect(f).toMatchObject({ count: 3, truncated: false, nextCursor: null });
      // The same records as hashtag feeds return, but for the hashtag one is listed under there and `moderated`, which is its standing under it.
      const news = (await ctx.app.inject({ method: 'GET', url: '/feed?tags=news' })).json();
      const { moderated, listedUnder, ...record } = news.records.find((r: FeedItem) => r.contentId === a1);
      expect([moderated, listedUnder]).toEqual([false, 'news']);
      expect(f.records[2]).toEqual(record);
      expect(f.records[1]).toMatchObject({ publisher: { userId: bob.userId, username: 'bob' }, tags: ['sports'], aiGenerated: true });
      expect(ids(await feed(dave, '&aiGenerated=true'))).toEqual([b1]);
      expect(ids(await feed(dave, '&aiGenerated=false'))).toEqual([a2, a1]);
      expect(ids(await feed(dave, '&limit=2'))).toEqual([a2, b1]);

      // Changes to whom dave follows show at once.
      await unfollow(dave, bob.userId);
      await follow(dave, carol.userId);
      expect(ids(await feed(dave))).toEqual([a2, c1, a1]);
      expect(await feed(carol)).toEqual({ count: 0, truncated: false, nextCursor: null, records: [] });
      expect((await readFeed('00000000-0000-4000-8000-000000000000', dave)).statusCode).toBe(404);
      expect((await readFeed('dave', dave)).statusCode).toBe(400);
      expect((await readFeed(dave.userId, dave, '&limit=101')).statusCode).toBe(400);

      // Publishers' own indexes aren't hashtags.
      const tags = (await ctx.app.inject({ method: 'GET', url: '/tags' })).json().tags.map((t: { tag: string }) => t.tag);
      expect(tags.sort()).toEqual(['news', 'sports', 'weather']);
    });

    it("shows every post of a followed user, newest first, whatever a hashtag's index keeps by likes", async () => {
      ctx = await createTestContext(target, { feed: { tagDayMaxPosts: 2, tagDayMinPosts: 1, authorDayMaxPosts: 4 } });
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      await follow(bob, alice.userId);
      const posts: string[] = [];
      for (let i = 0; i < 5; i++) {
        posts.push(await post(alice, `post ${i} #news`));
        ctx.clock.now += 1000;
      }
      for (const contentId of posts.slice(0, 2)) await ctx.app.inject({ method: 'POST', url: '/like', payload: { ...bob, contentId } });
      await ctx.compact();

      const news = (await ctx.app.inject({ method: 'GET', url: '/feed?tags=news' })).json();
      expect(news.records.map((r: FeedItem) => r.contentId).sort()).toEqual(posts.slice(0, 2).sort());
      // FEED_AUTHOR_DAY_MAX_POSTS keeps the newest 4.
      const f = await feed(bob);
      expect(ids(f)).toEqual([...posts].reverse().slice(0, 4));
      expect(f.records.map((r) => r.likes)).toEqual([0, 0, 0, 1]);
    });

    it('pages a following feed with a cursor, never repeating or skipping a post, while posts arrive and the compactor runs', async () => {
      ctx = await createTestContext(target, { feed: { pageSize: 3 } });
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const reader = await ctx.register('reader');
      await follow(reader, alice.userId);
      await follow(reader, bob.userId);
      // Several posts a second, so whole-second creation times tie.
      const posted: { contentId: string; createdAt: number }[] = [];
      for (let i = 0; i < 16; i++) {
        posted.push({ contentId: await post(i % 2 ? alice : bob, `post ${i} #news`), createdAt: ctx.clock.now });
        ctx.clock.now += 400;
        if (i === 7) await ctx.compact();
      }
      await ctx.compact();

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page++) {
        const f: FollowingFeed = await feed(reader, cursor ? `&cursor=${cursor}` : '');
        seen.push(...ids(f));
        if (page === 1) {
          // Posted after the first page, so newer than every post on it; the run that indexes it rebuilds the days the session reads.
          await post(alice, 'late #news');
          await ctx.compact();
        }
        cursor = f.nextCursor;
        if (!cursor) break;
      }
      expect(seen).toEqual([...posted].sort(compareRecent).map((p) => p.contentId));
      expect((await readFeed(reader.userId, reader, '&cursor=nope')).statusCode).toBe(400);
      const tagCursor = (await ctx.app.inject({ method: 'GET', url: '/feed?tags=news&limit=1' })).json().nextCursor;
      expect((await readFeed(reader.userId, reader, `&cursor=${tagCursor}`)).statusCode).toBe(400);
    });

    it('shows updated posts as they now are at once, and deletions and like counts after compaction', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      await follow(bob, alice.userId);
      const p1 = await post(alice, 'first #news');
      ctx.clock.now += 1000;
      const p2 = await post(alice, 'second #news');
      ctx.clock.now += 1000;
      const p3 = await post(alice, 'third #news');
      await ctx.compact();

      const upd = await ctx.app.inject({ method: 'POST', url: '/store', payload: { ...alice, contentId: p2, type: 'text', text: 'second, edited #sports', tags: ['sports'] } });
      expect(upd.statusCode, upd.body).toBe(200);
      expect((await feed(bob)).records.map((r) => [r.contentId, r.preview.text])).toEqual([[p3, 'third #news'], [p2, 'second, edited #sports'], [p1, 'first #news']]);
      expect((await ctx.app.inject({ method: 'DELETE', url: `/content/${p1}`, headers: as(alice) })).statusCode).toBe(202);
      expect(ids(await feed(bob))).toEqual([p3, p2, p1]);

      await ctx.app.inject({ method: 'POST', url: '/like', payload: { ...bob, contentId: p3 } });
      const run = await ctx.compact();
      expect(run.tags).toEqual([authorIndex(alice.userId), 'news', 'sports']);
      expect(run.deleted).toEqual([p1]);
      expect((await feed(bob)).records.map((r) => [r.contentId, r.preview.text, r.likes])).toEqual([[p3, 'third #news', 1], [p2, 'second, edited #sports', 0]]);
    });

    it('reaches back across days, loading only the day indexes a page needs', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const reader = await ctx.register('reader');
      await follow(reader, alice.userId);
      await follow(reader, bob.userId);
      const t0 = ctx.clock.now;
      const at = async (u: User, ageDays: number) => {
        ctx.clock.now = t0 - ageDays * DAY;
        return post(u, `${ageDays} days ago #news`);
      };
      const order = [await at(alice, 0), await at(bob, 1), await at(alice, 2), await at(bob, 3), await at(alice, 5), await at(alice, 10)];
      ctx.clock.now = t0;
      await ctx.compact();

      const mget = vi.spyOn(ctx.hot, 'mget');
      const dayKeys = () => mget.mock.calls.flat(2).filter((k) => k.startsWith(`day:@`));
      const first = await feed(reader, '&limit=1');
      expect(ids(first)).toEqual(order.slice(0, 1));
      // Enough to know whether a second record follows the first.
      expect(dayKeys()).toHaveLength(2);

      const paged: string[] = [...ids(first)];
      let cursor = first.nextCursor;
      while (cursor) {
        const f = await feed(reader, `&limit=2&cursor=${cursor}`);
        paged.push(...ids(f));
        cursor = f.nextCursor;
      }
      expect(paged).toEqual(order);
      expect(ids(await feed(reader))).toEqual(order);
    });

    it('keeps follows in Redis in step with the database: the next compactor run repairs a follow, a repeated request an unfollow, and --rebuild everything', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const reader = await ctx.register('reader');
      const fromAlice = await post(alice, 'from alice #news');
      ctx.clock.now += 1000;
      const fromBob = await post(bob, 'from bob #news');
      await follow(reader, alice.userId);
      await ctx.compact();

      // The Redis write fails: the follow is made, but feeds can't see it yet.
      vi.spyOn(ctx.follows, 'put').mockRejectedValueOnce(new Error('redis is down'));
      expect((await follow(reader, bob.userId)).statusCode).toBe(201);
      expect(ids(await feed(reader))).toEqual([fromAlice]);
      await ctx.compact();
      expect(ids(await feed(reader))).toEqual([fromBob, fromAlice]);

      // Nothing is left of an unfollow for the compactor to find, so one whose Redis write fails says so.
      vi.spyOn(ctx.follows, 'put').mockRejectedValueOnce(new Error('redis is down'));
      const failed = await unfollow(reader, alice.userId);
      expect(failed.statusCode).toBe(503);
      expect(failed.json().error).toBe("you no longer follow them, but your following feed couldn't be updated; send the request again");
      expect(ids(await feed(reader))).toEqual([fromBob, fromAlice]);
      expect((await unfollow(reader, alice.userId)).json()).toMatchObject({ wasFollowing: false });
      expect(ids(await feed(reader))).toEqual([fromBob]);

      // Redis loses everything, including the publishers' own indexes.
      await follow(reader, alice.userId);
      await ctx.hot.clear();
      expect(ids(await feed(reader))).toEqual([]);
      ctx.clock.now += 1000;
      await ctx.compactor.runOnce({ rebuild: true });
      expect(ids(await feed(reader))).toEqual([fromBob, fromAlice]);
    });
  });
}
