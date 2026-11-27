import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { setAdmin } from '../src/moderation/policy.js';
import { commentCountingKey, commentCountKey, commentLikesKey } from '../src/storage/commentStore.js';
import { as, createTestContext, requests, TARGETS, type FeedItem, type TestContext, type User } from './helpers.js';

/**
 * How many comments a post has, as a feed record gives it (`commentCount`): a number Redis
 * holds, which the compactor adds to and takes from as it writes the post's comments, and
 * counts from the comment store only where it has to (see CommentStore).
 */
for (const target of TARGETS) {
  describe(`a post's number of comments (${target.name})`, () => {
    let ctx: TestContext;
    afterEach(() => ctx.close());

    const { post, feedItems } = requests(() => ctx);
    const req = (u: User | null, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
      ctx.app.inject({ method, url, headers: u ? as(u) : {}, ...(payload && { payload }) });
    const ok = (res: LightMyRequestResponse, status = 201) => {
      expect(res.statusCode, res.body).toBe(status);
      return res.json();
    };
    const comment = (u: User, contentId: string, text: string, parentId?: string) => req(u, 'POST', `/content/${contentId}/comments`, { text, ...(parentId && { parentId }) });
    const edit = (u: User, contentId: string, commentId: string, text: string) => req(u, 'PATCH', `/content/${contentId}/comments/${commentId}`, { text });
    const remove = (u: User, contentId: string, commentId: string) => req(u, 'DELETE', `/content/${contentId}/comments/${commentId}`);
    /** How many comments the post's list of them says it has: placeholders among them. */
    const listed = async (contentId: string) => ok(await req(null, 'GET', `/content/${contentId}/comments`), 200).count;
    /** The number of comments each post of #news has, as its feed gives it. */
    const inFeed = async () => Object.fromEntries((await feedItems('news')).map((r) => [r.contentId, r.commentCount]));
    /** The number of comments a post of #news has, as its feed gives it. */
    const count = async (contentId: string) => (await inFeed())[contentId];
    /** What Redis holds of a post's number of comments: the number, or null, and whether its writes are said to be under way. */
    const held = async (contentId: string) => {
      const [number, counting] = await ctx.hot.mget([commentCountKey(contentId), commentCountingKey(contentId)]);
      return [number && Number(number.toString('utf8')), counting !== null];
    };
    /** The kinds of the writes that wait for the compactor, in the order they are applied in. */
    const waiting = async () => (await ctx.db.selectFrom('pending_writes').select(['seq', 'kind']).orderBy('seq').orderBy('kind').execute()).map((r) => r.kind);

    it('is given wherever a feed record is: the comments there to read, replies among them, as each is made and removed', async () => {
      ctx = await createTestContext(target);
      const [alice, bob, carol] = [await ctx.register('alice'), await ctx.register('bob'), await ctx.register('carol')];
      ok(await req(bob, 'PUT', `/users/${bob.userId}/following/${alice.userId}`));
      const contentId = await post(alice, 'Flooding downtown #news', { comments: true });
      const closed = await post(alice, 'Nothing to add #news');
      await ctx.compact();
      /** The post's number of comments everywhere a feed record of it is read. */
      const everywhere = async () => {
        const of = (records: FeedItem[]) => records.find((r) => r.contentId === contentId)?.commentCount;
        return [
          of(await feedItems('news')),
          of(ok(await req(bob, 'GET', `/feed/following?userId=${bob.userId}`), 200).records),
          of(ok(await req(null, 'GET', `/users/${alice.userId}/posts`), 200).posts),
          of(ok(await req(null, 'GET', '/search?type=content&q=flooding'), 200).results),
        ];
      };

      // None yet: Redis holds no number, of a post that takes comments as of one that doesn't.
      expect(await inFeed()).toEqual({ [contentId]: 0, [closed]: 0 });
      expect(await held(contentId)).toEqual([null, false]);

      // The first is counted from the store, and the ones after it are added.
      const first = ok(await comment(bob, contentId, 'First'));
      expect(await everywhere()).toEqual([1, 1, 1, 1]);
      const answer = ok(await comment(carol, contentId, 'Is it?', first.commentId));
      const second = ok(await comment(carol, contentId, 'Second'));
      expect(await everywhere()).toEqual([3, 3, 3, 3]);
      expect(await held(contentId)).toEqual([3, false]);
      expect(await inFeed()).toEqual({ [contentId]: 3, [closed]: 0 });

      // An edit and a like are of a comment that is counted already.
      ctx.clock.now += 1000;
      ok(await edit(bob, contentId, first.commentId, 'First!'), 200);
      ok(await req(alice, 'POST', '/like', { contentId, commentId: second.commentId }));
      expect(await count(contentId)).toBe(3);

      // A deleted comment isn't counted, though its place is kept for its reply, which the list of comments counts.
      ok(await remove(bob, contentId, first.commentId), 200);
      expect(await everywhere()).toEqual([2, 2, 2, 2]);
      expect(await listed(contentId)).toBe(3);
      // Nor is it taken off twice.
      expect((await remove(bob, contentId, first.commentId)).statusCode).toBe(404);
      expect(await count(contentId)).toBe(2);
      ok(await remove(carol, contentId, answer.commentId), 200);
      ok(await remove(carol, contentId, second.commentId), 200);
      expect(await everywhere()).toEqual([0, 0, 0, 0]);
      expect(await held(contentId)).toEqual([0, false]);

      // The number goes with the post.
      ok(await comment(bob, contentId, 'Anyone?'));
      expect(await count(contentId)).toBe(1);
      expect((await req(alice, 'DELETE', `/content/${contentId}`)).statusCode).toBeLessThan(300);
      expect((await ctx.compactor.runOnce()).deleted).toEqual([contentId]);
      expect(await held(contentId)).toEqual([null, false]);
      expect(await inFeed()).toEqual({ [closed]: 0 });
    });

    it('leaves out a comment that waits in the moderation queue, until it is accepted', async () => {
      ctx = await createTestContext(target, { trust: { deleteBelow: 0 } });
      const root = await ctx.register('root');
      await setAdmin(ctx.db, 'root', true);
      const [alice, bob, carol] = [await ctx.register('alice'), await ctx.register('bob'), await ctx.register('carol')];
      ok(await req(root, 'POST', '/moderation/blocked-words', { words: ['spam'] }), 200);
      const contentId = await post(alice, 'Talk to me #news', { comments: true });
      await ctx.compact();
      const decide = (commentId: string, what: 'accept' | 'reject') => req(root, 'POST', `/moderation/queue/${contentId}/comments/${commentId}/${what}`);

      // One that is held is no comment to read, and one that isn't is.
      const waits = ok(await comment(bob, contentId, 'Buy spam'), 202);
      expect(await count(contentId)).toBe(0);
      const fine = ok(await comment(carol, contentId, 'Fine'));
      expect(await count(contentId)).toBe(1);
      // Accepted, it is one more.
      ok(await decide(waits.commentId, 'accept'), 200);
      expect(await count(contentId)).toBe(2);

      // Edited into the queue, a published comment is one fewer, though its place is kept: and back, one more.
      ctx.clock.now += 1000;
      ok(await edit(carol, contentId, fine.commentId, 'Fine spam'), 202);
      expect(await count(contentId)).toBe(1);
      expect(await listed(contentId)).toBe(2);
      ok(await decide(fine.commentId, 'accept'), 200);
      expect(await count(contentId)).toBe(2);

      // Rejected, a comment that was taken off as it was held is not taken off again.
      ctx.clock.now += 1000;
      ok(await edit(bob, contentId, waits.commentId, 'More spam'), 202);
      expect(await count(contentId)).toBe(1);
      ok(await decide(waits.commentId, 'reject'), 200);
      expect(await count(contentId)).toBe(1);
      expect(await held(contentId)).toEqual([1, false]);
    });

    it('is counted from the store where Redis has lost it: by the next write of a comment of the post, and by a rebuild', async () => {
      ctx = await createTestContext(target);
      const [alice, bob] = [await ctx.register('alice'), await ctx.register('bob')];
      const contentId = await post(alice, 'Talk to me #news', { comments: true });
      const other = await post(alice, 'And to me #news', { comments: true });
      await ctx.compact();
      const first = ok(await comment(bob, contentId, 'First'));
      ok(await comment(bob, contentId, 'Second'));
      ok(await comment(bob, other, 'Elsewhere'));
      ok(await remove(bob, contentId, ok(await comment(bob, contentId, 'Never mind')).commentId), 200);
      expect(await inFeed()).toEqual({ [contentId]: 2, [other]: 1 });

      // With no number, a feed says the post has no comments: it reads Redis, and nothing else.
      await ctx.hot.del([commentCountKey(contentId), commentCountKey(other)]);
      expect(await inFeed()).toEqual({ [contentId]: 0, [other]: 0 });
      // A comment made then is not the post's first: the number is every comment the store has of it.
      ok(await comment(bob, contentId, 'Third'));
      expect(await inFeed()).toEqual({ [contentId]: 3, [other]: 0 });
      // So is it when one is removed.
      await ctx.hot.del([commentCountKey(contentId)]);
      ok(await remove(bob, contentId, first.commentId), 200);
      expect(await inFeed()).toEqual({ [contentId]: 2, [other]: 0 });

      // A rebuild counts the comments of every post that has any.
      await ctx.hot.del([commentCountKey(contentId)]);
      await ctx.hot.set(commentCountKey(other), '7');
      await ctx.compactor.runOnce({ rebuild: true });
      expect(await inFeed()).toEqual({ [contentId]: 2, [other]: 1 });
      expect(await held(other)).toEqual([1, false]);
    });

    it('is counted from the store after a write that changed the store and not the number, in that run or the next', async () => {
      ctx = await createTestContext(target, { settle: false });
      const [alice, bob] = [await ctx.register('alice'), await ctx.register('bob')];
      const contentId = await post(alice, 'Talk to me #news', { comments: true });
      await ctx.compactor.runOnce();
      const [a, b] = [ok(await comment(bob, contentId, 'A')), ok(await comment(bob, contentId, 'B'))];
      ok(await comment(bob, contentId, 'C'));
      expect(await ctx.apply()).toBe(true);
      expect(await held(contentId)).toEqual([3, false]);
      /** Has the removal of a comment fail once the comment is out of the store, before the number is told. */
      const stopAfterRemoving = (commentId: string) =>
        ctx.compactor.watch('hot.del', {
          before: ({ keys }) => {
            if (keys.includes(commentLikesKey(commentId))) throw new Error('redis unavailable');
          },
        });

      // The removal fails, and is left for the next run. The run counts the post's comments, as one of its writes failed.
      ok(await remove(bob, contentId, a.commentId), 200);
      stopAfterRemoving(a.commentId);
      expect(await ctx.apply()).toBe(true);
      expect(await waiting()).toEqual(['comment_remove']);
      expect(await held(contentId)).toEqual([2, false]);
      expect(await count(contentId)).toBe(2);

      // The same, in a run that can't write the number either: it is left as it was, with what says its writes weren't over.
      ok(await remove(bob, contentId, b.commentId), 200);
      stopAfterRemoving(b.commentId);
      ctx.compactor.watch('hot.set', {
        before: ({ key }) => {
          if (key === commentCountKey(contentId)) throw new Error('redis unavailable');
        },
      });
      expect(await ctx.apply()).toBe(true);
      expect(await waiting()).toEqual(['comment_remove']);
      expect(await held(contentId)).toEqual([2, true]);

      // The next run finds that said, and counts: the removal it makes again has nothing to take off.
      ctx.compactor.unwatch();
      expect(await ctx.apply()).toBe(true);
      expect(await waiting()).toEqual([]);
      expect(await held(contentId)).toEqual([1, false]);
      expect(await count(contentId)).toBe(1);
      // And a run with nothing to write of the post leaves the number alone.
      await ctx.hot.set(commentCountKey(contentId), '5');
      expect(await ctx.apply()).toBe(true);
      expect(await held(contentId)).toEqual([5, false]);
    });
  });
}
