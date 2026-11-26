import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { setAdmin } from '../src/moderation/policy.js';
import type { TestPlugin } from '../src/moderation/trust.types.js';
import { authorIndex } from '../src/tagfeed/layout.js';
import { as, BASE_ENV, createTestContext, type FeedItem, requests, TARGETS, type TestContext, type User } from './helpers.js';

/** A trust plugin that holds whatever says "held" for the moderation queue, and lets the rest through. */
const holdsHeld: TestPlugin = { name: 'holds-held', rules: [{ includes: 'held', ignoreCase: true, set: 50 }] };

const NO_CONTENT = '00000000-0000-4000-8000-000000000000';
const OFF = "this server doesn't take dislikes";
const POSTS_ONLY = 'only posts can be disliked, not comments: leave commentId out';

describe('the dislikes setting', () => {
  it('comes from the environment, and is off unless it says so', () => {
    const load = (env: Record<string, string> = {}) => loadConfig({}, { ...BASE_ENV, ...env }).dislikes;
    expect(load()).toBe(false);
    for (const on of ['true', 'TRUE', '1', 'yes']) expect(load({ DISLIKES: on })).toBe(true);
    for (const off of ['false', '0', 'no']) expect(load({ DISLIKES: off })).toBe(false);
    expect(loadConfig({ dislikes: true }, BASE_ENV).dislikes).toBe(true);
  });
});

for (const target of TARGETS) {
  describe(`dislikes (${target.name})`, () => {
    let ctx: TestContext;
    afterEach(() => ctx.close());

    const { post, storeText, read, like, unlike, dislike, undislike, feedItems } = requests(() => ctx);
    const req = (u: User | null, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
      ctx.app.inject({ method, url, headers: u ? as(u) : {}, ...(payload && { payload }) });
    const ok = (res: LightMyRequestResponse, status = 200) => {
      expect(res.statusCode, res.body).toBe(status);
      return res.json();
    };
    /** What a request was answered: its status, and its body. */
    const answer = async (res: Promise<LightMyRequestResponse>) => {
      const r = await res;
      return [r.statusCode, r.json()];
    };
    /** What a refused request was answered: its status, and what it says. */
    const refused = async (res: Promise<LightMyRequestResponse>) => {
      const r = await res;
      return [r.statusCode, r.json().error];
    };
    /** Who has a dislike of the post, by the rows, and the count its own row has. */
    const kept = async (contentId: string) => {
      const rows = await ctx.db.selectFrom('dislikes').select('user_id').where('content_id', '=', contentId).execute();
      const { dislike_count } = await ctx.db.selectFrom('content').select('dislike_count').where('id', '=', contentId).executeTakeFirstOrThrow();
      return [rows.map((r) => r.user_id).sort(), dislike_count];
    };
    /** Each record of the feed of #news: the post, its likes and its dislikes. */
    const news = async () => (await feedItems('news')).map((r) => [r.contentId, r.likes, r.dislikes]);
    /** Everywhere else a post is read: by its id, in a following feed, on its publisher's profile, in a search. The `dislikes` each gives; undefined where the post isn't. */
    const elsewhere = async (reader: User, publisher: User, contentId: string, word: string) => {
      const of = (records: FeedItem[]) => records.find((r) => r.contentId === contentId)?.dislikes;
      return {
        content: ok(await read(contentId)).dislikes,
        following: of(ok(await req(reader, 'GET', `/feed/following?userId=${reader.userId}`)).records),
        profile: of(ok(await req(null, 'GET', `/users/${publisher.userId}/posts`)).posts),
        search: of(ok(await req(null, 'GET', `/search?type=content&q=${word}`)).results),
      };
    };

    it('has no dislikes unless the server turns them on: none is taken, and a post says null wherever it is read', async () => {
      ctx = await createTestContext(target);
      const [alice, bob] = [await ctx.register('alice'), await ctx.register('bob')];
      ok(await req(bob, 'PUT', `/users/${bob.userId}/following/${alice.userId}`), 201);
      const contentId = await post(alice, 'Flooding downtown #news');
      await ctx.compact();

      // Refused, before anything is looked up: whoever asks, and whatever of.
      expect(await refused(dislike(bob, contentId))).toEqual([400, OFF]);
      expect(await refused(dislike({ userId: bob.userId, apiKey: 'nope' }, contentId))).toEqual([400, OFF]);
      expect(await refused(dislike(bob, NO_CONTENT))).toEqual([400, OFF]);
      expect(await kept(contentId)).toEqual([[], 0]);

      // Null, and not 0: a client shows no dislikes at all.
      expect(await news()).toEqual([[contentId, 0, null]]);
      expect(await elsewhere(bob, alice, contentId, 'flooding')).toEqual({ content: null, following: null, profile: null, search: null });
      expect(ok(await read(contentId, bob))).toMatchObject({ likes: 0, views: 1, dislikes: null });

      // There is none to take back, which is what the answer says.
      expect(await answer(undislike(bob, contentId))).toEqual([200, { contentId, dislikes: null, wasDisliked: false }]);
    });

    it("counts a post's dislikes from 0, one for each user who gives one, beside its likes", async () => {
      ctx = await createTestContext(target, { dislikes: true });
      const [alice, bob, carol, dave] = [await ctx.register('alice'), await ctx.register('bob'), await ctx.register('carol'), await ctx.register('dave')];
      ok(await req(bob, 'PUT', `/users/${bob.userId}/following/${alice.userId}`), 201);
      const first = await post(alice, 'Flooding downtown #news');
      ctx.clock.now += 1000;
      const second = await post(alice, 'Final score #news');

      // From 0, and not null: the server has dislikes, and the post none yet.
      expect(ok(await read(first))).toMatchObject({ likes: 0, dislikes: 0 });
      expect(await elsewhere(bob, alice, first, 'flooding')).toEqual({ content: 0, following: undefined, profile: 0, search: 0 });

      // Once for each user: a second one changes nothing, and says so.
      expect(await answer(dislike(bob, second))).toEqual([201, { contentId: second, dislikes: 1, alreadyDisliked: false }]);
      expect(await answer(dislike(bob, second))).toEqual([200, { contentId: second, dislikes: 1, alreadyDisliked: true }]);
      expect(await answer(dislike(carol, second))).toEqual([201, { contentId: second, dislikes: 2, alreadyDisliked: false }]);
      expect(await kept(second)).toEqual([[bob.userId, carol.userId].sort(), 2]);
      expect(await kept(first)).toEqual([[], 0]);

      // A user's own, with their key, of a post that is there, and of a post: comments aren't disliked.
      expect((await dislike(bob, NO_CONTENT)).statusCode).toBe(404);
      expect((await dislike({ userId: dave.userId, apiKey: 'nope' }, second)).statusCode).toBe(401);
      expect((await req(null, 'POST', '/dislike', { ...dave })).statusCode).toBe(400);
      expect(await refused(req(null, 'POST', '/dislike', { ...dave, contentId: second, commentId: NO_CONTENT }))).toEqual([400, POSTS_ONLY]);
      expect(await kept(second)).toEqual([[bob.userId, carol.userId].sort(), 2]);

      // Read by its id, the post has them at once. Neither it nor they are in a feed until the compactor has run.
      expect(ok(await read(second))).toMatchObject({ likes: 0, dislikes: 2 });
      expect(await news()).toEqual([]);
      await ctx.compact();
      // Dislikes order nothing: the newer post is first, as it would be with none.
      expect(await news()).toEqual([[second, 0, 2], [first, 0, 0]]);
      expect(await elsewhere(bob, alice, second, 'score')).toEqual({ content: 2, following: 2, profile: 2, search: 2 });
      expect(await elsewhere(bob, alice, first, 'flooding')).toEqual({ content: 0, following: 0, profile: 0, search: 0 });

      // A dislike of a post that feeds have is in them after the next run, which writes only the indexes the post is in.
      const dislikedAt = ctx.clock.now;
      expect(await answer(dislike(dave, first))).toEqual([201, { contentId: first, dislikes: 1, alreadyDisliked: false }]);
      expect(Number((await ctx.db.selectFrom('content').select('disliked_at').where('id', '=', first).executeTakeFirstOrThrow()).disliked_at)).toBe(dislikedAt);
      expect(await news()).toEqual([[second, 0, 2], [first, 0, 0]]);
      expect((await ctx.compact()).tags).toEqual([authorIndex(alice.userId), 'news']);
      expect(await news()).toEqual([[second, 0, 2], [first, 0, 1]]);
      expect((await ctx.compact()).tags).toEqual([]);

      // Likes are a count of their own: a user may give both, and neither takes from the other.
      expect(ok(await like(bob, second), 201)).toEqual({ contentId: second, likes: 1, alreadyLiked: false });
      expect(ok(await read(second))).toMatchObject({ likes: 1, dislikes: 2 });
      expect(ok(await unlike(bob, second))).toEqual({ contentId: second, likes: 0, wasLiked: true });
      expect(ok(await read(second))).toMatchObject({ likes: 0, dislikes: 2 });
      expect(await kept(second)).toEqual([[bob.userId, carol.userId].sort(), 2]);
      // And likes alone order a feed: the post with one is first, whatever its dislikes.
      ok(await like(dave, first), 201);
      ok(await dislike(carol, first), 201);
      await ctx.compact();
      expect(await news()).toEqual([[first, 1, 2], [second, 0, 2]]);
    });

    it('takes a dislike back once, which the next compactor run writes into the indexes, and lets it be given again', async () => {
      ctx = await createTestContext(target, { dislikes: true });
      const [alice, bob, carol, dave] = [await ctx.register('alice'), await ctx.register('bob'), await ctx.register('carol'), await ctx.register('dave')];
      const first = await post(alice, 'Flooding downtown #news');
      ctx.clock.now += 1000;
      const second = await post(alice, 'Final score #news');
      for (const u of [bob, carol]) ok(await dislike(u, first), 201);
      ok(await dislike(bob, second), 201);
      await ctx.compact();
      expect(await news()).toEqual([[second, 0, 1], [first, 0, 2]]);

      // A user's own, with their key, of a post that is there, and of a post.
      expect((await undislike(bob, NO_CONTENT)).statusCode).toBe(404);
      expect((await undislike({ userId: bob.userId, apiKey: 'nope' }, first)).statusCode).toBe(401);
      expect((await req(null, 'DELETE', '/dislike', { ...bob })).statusCode).toBe(400);
      expect((await req(bob, 'DELETE', '/dislike')).statusCode).toBe(400);
      expect(await refused(req(null, 'DELETE', '/dislike', { ...bob, contentId: first, commentId: NO_CONTENT }))).toEqual([400, POSTS_ONLY]);
      expect(await refused(req(bob, 'DELETE', `/dislike?contentId=${first}&commentId=${NO_CONTENT}`))).toEqual([400, POSTS_ONLY]);
      // One that isn't there is taken back from nobody: nothing changes.
      expect(await answer(undislike(dave, first))).toEqual([200, { contentId: first, dislikes: 2, wasDisliked: false }]);
      expect(await kept(first)).toEqual([[bob.userId, carol.userId].sort(), 2]);

      // Once: the row goes, and the count with it, at once for whoever reads the post.
      ctx.clock.now += 1000;
      expect(await answer(undislike(bob, first))).toEqual([200, { contentId: first, dislikes: 1, wasDisliked: true }]);
      expect(await answer(undislike(bob, first))).toEqual([200, { contentId: first, dislikes: 1, wasDisliked: false }]);
      expect(await kept(first)).toEqual([[carol.userId], 1]);
      expect(await kept(second)).toEqual([[bob.userId], 1]);
      expect(ok(await read(first)).dislikes).toBe(1);
      // Feeds have the count they had until the compactor has run, and then the new one.
      expect(await news()).toEqual([[second, 0, 1], [first, 0, 2]]);
      expect((await ctx.compact()).tags).toEqual([authorIndex(alice.userId), 'news']);
      expect(await news()).toEqual([[second, 0, 1], [first, 0, 1]]);
      expect((await ctx.compact()).tags).toEqual([]);

      // Named in the query, with the credentials in the headers; and the same request twice at once takes the dislike back once.
      const both = await Promise.all([1, 2].map(() => req(carol, 'DELETE', `/dislike?contentId=${first}`)));
      expect(both.map((res) => [res.statusCode, res.json().dislikes, res.json().wasDisliked]).sort()).toEqual([[200, 0, false], [200, 0, true]]);
      expect(await kept(first)).toEqual([[], 0]);
      await ctx.compact();
      expect(await news()).toEqual([[second, 0, 1], [first, 0, 0]]);

      // It can be given again, and is a new dislike.
      expect(await answer(dislike(carol, first))).toEqual([201, { contentId: first, dislikes: 1, alreadyDisliked: false }]);
      // The count is never taken below 0, whatever it was made to say.
      await ctx.db.updateTable('content').set({ dislike_count: 0 }).where('id', '=', first).execute();
      expect(await answer(undislike(carol, first))).toEqual([200, { contentId: first, dislikes: 0, wasDisliked: true }]);
      expect(await kept(first)).toEqual([[], 0]);

      // A post that is set for deletion is gone to this too, and its dislikes go with it when the compactor deletes it.
      ok(await req(alice, 'DELETE', `/content/${second}`), 202);
      expect(await answer(undislike(bob, second))).toEqual([404, { error: 'content not found' }]);
      expect(await answer(dislike(carol, second))).toEqual([404, { error: 'content not found' }]);
      expect((await ctx.compact()).deleted).toEqual([second]);
      expect(await ctx.db.selectFrom('dislikes').selectAll().execute()).toEqual([]);
    });

    it('keeps the counts while dislikes are off, when a user can still take theirs back, and shows them again once they are on', async () => {
      ctx = await createTestContext(target, { dislikes: true });
      const [alice, bob, carol] = [await ctx.register('alice'), await ctx.register('bob'), await ctx.register('carol')];
      ok(await req(bob, 'PUT', `/users/${bob.userId}/following/${alice.userId}`), 201);
      const contentId = await post(alice, 'Flooding downtown #news');
      for (const u of [bob, carol]) ok(await dislike(u, contentId), 201);
      await ctx.compact();
      expect(await news()).toEqual([[contentId, 0, 2]]);

      // Off: the index is as it was, and what is read from it says null. So does everything else.
      ctx.config.dislikes = false;
      expect(await news()).toEqual([[contentId, 0, null]]);
      expect(await elsewhere(bob, alice, contentId, 'flooding')).toEqual({ content: null, following: null, profile: null, search: null });
      expect(await refused(dislike(alice, contentId))).toEqual([400, OFF]);
      // A dislike given while they were on is the user's to take back, and the answer says no more of the count than a read does.
      expect(await answer(undislike(bob, contentId))).toEqual([200, { contentId, dislikes: null, wasDisliked: true }]);
      expect(await kept(contentId)).toEqual([[carol.userId], 1]);
      await ctx.compact();
      expect(await news()).toEqual([[contentId, 0, null]]);

      // On again: the counts are there, as they now are.
      ctx.config.dislikes = true;
      expect(await news()).toEqual([[contentId, 0, 1]]);
      expect(await elsewhere(bob, alice, contentId, 'flooding')).toEqual({ content: 1, following: 1, profile: 1, search: 1 });
    });

    it("refuses a banned user's dislike, and a dislike of content that is withheld from readers", async () => {
      ctx = await createTestContext(target, { dislikes: true, trustPlugins: [holdsHeld] });
      const root = await ctx.register('root');
      await setAdmin(ctx.db, 'root', true);
      const [alice, bob] = [await ctx.register('alice'), await ctx.register('bob')];
      const contentId = await post(alice, 'Flooding downtown #news');
      const other = await post(alice, 'Final score #news');
      ok(await dislike(bob, contentId), 201);

      // Banned: no new dislike, and the one they gave is still theirs to take back.
      ok(await req(root, 'PUT', `/banned/${bob.userId}`), 201);
      expect((await dislike(bob, other)).statusCode).toBe(403);
      expect(await kept(other)).toEqual([[], 0]);
      expect(await answer(undislike(bob, contentId))).toEqual([200, { contentId, dislikes: 0, wasDisliked: true }]);

      // Content that waits in the moderation queue isn't there to dislike, for its publisher either.
      const held = ok(await storeText(alice, 'Held for review #news'), 202).contentId as string;
      for (const u of [alice, root]) expect(await answer(dislike(u, held))).toEqual([404, { error: 'content not found' }]);
      expect(await answer(undislike(alice, held))).toEqual([404, { error: 'content not found' }]);
      expect(await kept(held)).toEqual([[], 0]);
    });

    it("gives a user the dislikes they gave in the export of their data, and nobody else's", async () => {
      ctx = await createTestContext(target, { dislikes: true });
      await ctx.comments.indexAuthors();
      const [alice, bob, carol] = [await ctx.register('alice'), await ctx.register('bob'), await ctx.register('carol')];
      const first = await post(alice, 'Flooding downtown #news');
      const second = await post(alice, 'Final score #news');
      ctx.clock.now += 1000;
      const dislikedAt = new Date(ctx.clock.now).toISOString();
      ok(await dislike(bob, first), 201);
      ok(await like(bob, second), 201);
      ok(await dislike(carol, second), 201);
      const records = async (u: User) => ok(await req(u, 'GET', `/users/${u.userId}/export`)).records as { type: string; [field: string]: unknown }[];

      const bobs = await records(bob);
      expect(bobs.filter((r) => r.type === 'dislike')).toEqual([{ type: 'dislike', contentId: first, dislikedAt }]);
      // After the posts they liked.
      expect(bobs.map((r) => r.type)).toEqual(['account', 'apiKey', 'like', 'dislike']);
      // A post's record has its counts, as a read of it does.
      expect((await records(alice)).filter((r) => r.type === 'post').map((r) => [r.contentId, r.likes, r.dislikes]).sort()).toEqual([[first, 0, 1], [second, 1, 1]].sort());

      // Theirs while the server has dislikes off too, when a post's own count isn't shown.
      ctx.config.dislikes = false;
      expect((await records(bob)).filter((r) => r.type === 'dislike')).toEqual([{ type: 'dislike', contentId: first, dislikedAt }]);
      expect((await records(alice)).filter((r) => r.type === 'post').map((r) => r.dislikes)).toEqual([null, null]);
      // One that is taken back is no longer the user's.
      ok(await undislike(bob, first));
      expect((await records(bob)).map((r) => r.type)).toEqual(['account', 'apiKey', 'like']);
    });
  });
}
