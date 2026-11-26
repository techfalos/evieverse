import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attest, signingKeys } from '../src/attestation.js';
import type { Attestable, SigningKey } from '../src/attestation.types.js';
import { HOUR } from '../src/time.js';
import { as, createTestContext, requests, TARGETS, type FeedItem, type TestContext, type User } from './helpers.js';

const NOT_TAKEN = "this post's publisher doesn't take comments from you";
const REPLY_NOT_TAKEN = "this comment's author doesn't take replies from you";
const NO_REPOST = "this post's publisher doesn't take reposts from you";
/** Another server, the key it signs the attestations of its posts with, and a post there. */
const OTHER = 'https://other.example';
const [OTHER_KEY] = signingKeys([Buffer.alloc(32, 1).toString('base64')]) as [SigningKey];
const ELSEWHERE = `${OTHER}/content/3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b`;
const NO_FOLLOW = "you can't follow this user";
const UNBLOCK_FIRST = 'you blocked this user: unblock them to follow them';

/** A comment, as far as these tests read it. */
type CommentItem = { commentId: string; parentId: string | null; author: { userId: string; username: string } | null; text: string; replies: number; status?: string };
type Following = { count: number; truncated: boolean; nextCursor: string | null; records: FeedItem[] };

// What a block does beyond messages (src/blocks.ts). What it does to messages, and the list of blocks itself, are in inbox.test.ts.
for (const target of TARGETS) {
  describe(`blocks (${target.name})`, () => {
    let ctx: TestContext;
    afterEach(async () => {
      vi.restoreAllMocks();
      await ctx.close();
    });

    const { post } = requests(() => ctx);
    const req = (u: User | null, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
      ctx.app.inject({ method, url, headers: u ? as(u) : {}, ...(payload && { payload }) });
    const ok = (res: LightMyRequestResponse, status = 200) => {
      expect(res.statusCode, res.body).toBe(status);
      return res.json();
    };
    const refusal = (res: LightMyRequestResponse) => [res.statusCode, res.json().error];
    const block = (u: User, other: User) => req(u, 'PUT', `/users/${u.userId}/blocked/${other.userId}`);
    const unblock = (u: User, other: User) => req(u, 'DELETE', `/users/${u.userId}/blocked/${other.userId}`);
    const follow = (u: User, other: User) => req(u, 'PUT', `/users/${u.userId}/following/${other.userId}`);
    /** The usernames in one of a user's own lists of follows. */
    const names = async (u: User, which: 'following' | 'followers') =>
      (ok(await req(u, 'GET', `/users/${u.userId}/${which}`))[which] as { username: string }[]).map((f) => f.username).sort();
    /** `of`'s following feed, as `reader` (or as nobody) is answered when asking for it. */
    const followingFeed = async (of: User, reader: User | null = of, query = ''): Promise<Following> => ok(await req(reader, 'GET', `/feed/following?userId=${of.userId}${query}`));
    const ids = (f: Following) => f.records.map((r) => r.contentId);
    const comment = (u: User, contentId: string, text: string, parentId?: string) => req(u, 'POST', `/content/${contentId}/comments`, { text, ...(parentId && { parentId }) });
    const edit = (u: User, contentId: string, commentId: string, text: string) => req(u, 'PATCH', `/content/${contentId}/comments/${commentId}`, { text });
    const comments = async (reader: User | null, contentId: string, headers: Record<string, string> = {}): Promise<{ count: number; comments: CommentItem[] }> => {
      const res = await ctx.app.inject({ method: 'GET', url: `/content/${contentId}/comments`, headers: { ...(reader && as(reader)), ...headers } });
      return ok(res);
    };
    const replies = async (reader: User | null, contentId: string, commentId: string): Promise<{ count: number; comments: CommentItem[] }> =>
      ok(await req(reader, 'GET', `/content/${contentId}/comments/${commentId}/replies`));
    /** What a list says of each of its comments: who wrote it, what it says, and its status, if it has one. */
    const shown = (page: { comments: CommentItem[] }) => page.comments.map((c) => [c.author?.username ?? null, c.text, ...(c.status ? [c.status] : [])]);
    /** POST /repost as `u`. */
    const repost = (u: User, payload: Record<string, unknown>) => ctx.app.inject({ method: 'POST', url: '/repost', payload: { ...u, ...payload } });
    /** The reposts of a post, oldest first: who made each, and the hashtags it gave. */
    const reposts = async (contentId: string) =>
      ((ok(await req(null, 'GET', `/content/${contentId}`)).reposts ?? []) as { by: { username: string }; tags: string[] }[]).map((r) => [r.by.username, r.tags]);

    it('ends the follows between the two, either way, and takes none while it stands', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const carol = await ctx.register('carol');
      // Bob follows alice, and she him; carol follows both, and alice her.
      for (const [who, whom] of [[bob, alice], [alice, bob], [carol, alice], [carol, bob], [alice, carol]] as const) ok(await follow(who, whom), 201);
      const fromAlice = await post(alice, 'from alice #news');
      ctx.clock.now += 1000;
      const fromCarol = await post(carol, 'from carol #news');
      await ctx.compact();
      expect(ids(await followingFeed(bob))).toEqual([fromAlice]);
      expect(await names(alice, 'followers')).toEqual(['bob', 'carol']);

      ok(await block(alice, bob), 201);
      // Neither follows the other, in the database and where the following feeds read it; nobody else's follows changed.
      expect(await names(alice, 'followers')).toEqual(['carol']);
      expect(await names(alice, 'following')).toEqual(['carol']);
      expect(await names(bob, 'following')).toEqual([]);
      expect(await names(bob, 'followers')).toEqual(['carol']);
      expect(await ctx.follows.get(bob.userId)).toEqual([]);
      expect(await ctx.follows.get(alice.userId)).toEqual([carol.userId]);
      expect((await ctx.follows.get(carol.userId)).sort()).toEqual([alice.userId, bob.userId].sort());
      // So bob's following feed has nothing of hers, at once, and hers nothing of his.
      expect(ids(await followingFeed(bob))).toEqual([]);
      expect(ids(await followingFeed(alice))).toEqual([fromCarol]);

      // Neither follows the other again: he isn't told why, and she is told the block is hers.
      expect(refusal(await follow(bob, alice))).toEqual([403, NO_FOLLOW]);
      expect(refusal(await follow(alice, bob))).toEqual([403, UNBLOCK_FIRST]);
      expect(await ctx.db.selectFrom('follows').select('follower_id').where('followee_id', 'in', [alice.userId, bob.userId]).where('follower_id', 'in', [alice.userId, bob.userId]).execute()).toEqual([]);
      // Everyone else follows both, and both everyone else.
      ok(await follow(bob, carol), 201);

      // Blocking again changes nothing. Ending the block brings no follow back, and lets them follow again.
      expect(ok(await block(alice, bob))).toMatchObject({ alreadyBlocked: true });
      expect(ok(await unblock(alice, bob))).toMatchObject({ wasBlocked: true });
      expect(await names(alice, 'followers')).toEqual(['carol']);
      expect(await names(bob, 'following')).toEqual(['carol']);
      ok(await follow(bob, alice), 201);
      ok(await follow(alice, bob), 201);
      expect(ids(await followingFeed(bob))).toEqual([fromCarol, fromAlice]);
    });

    it('holds a follow and a block of the same two users sent at once to one order: no follow is left under a block', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      for (let round = 0; round < 5; round++) {
        const [blocked, followed] = await Promise.all([block(alice, bob), follow(bob, alice)]);
        expect(blocked.statusCode, blocked.body).toBe(201);
        // Before the block, which ended it, or after, and refused.
        expect([201, 403]).toContain(followed.statusCode);
        expect(await names(alice, 'followers')).toEqual([]);
        expect(await ctx.follows.get(bob.userId)).toEqual([]);
        ok(await unblock(alice, bob));
      }
    });

    it('says so when the follow lists could not be written after a block, which sending it again repairs', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      ok(await follow(bob, alice), 201);
      const fromAlice = await post(alice, 'from alice #news');
      await ctx.compact();

      // Both users' lists are written, so both writes fail.
      const put = vi.spyOn(ctx.follows, 'put').mockRejectedValue(new Error('redis is down'));
      expect(refusal(await block(alice, bob))).toEqual([503, "you block them, but the following feeds couldn't be updated; send the request again"]);
      put.mockRestore();
      // The block is made, and the follow ended: only what the following feed reads is as it was.
      expect(ok(await req(alice, 'GET', `/users/${alice.userId}/blocked`)).blocked).toMatchObject([{ username: 'bob' }]);
      expect(await names(alice, 'followers')).toEqual([]);
      expect(ids(await followingFeed(bob))).toEqual([fromAlice]);

      expect(ok(await block(alice, bob))).toMatchObject({ alreadyBlocked: true });
      expect(ids(await followingFeed(bob))).toEqual([]);
    });

    it("takes no comment on a user's posts from someone they block, and no edit of the ones that are there", async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const carol = await ctx.register('carol');
      const contentId = await post(alice, 'Say what you think #news', { comments: true });
      const carols = await post(carol, "Carol's own #news", { comments: true });
      const bobs = await post(bob, "Bob's own #news", { comments: true });
      const before = ok(await comment(bob, contentId, 'Before the block'), 201).commentId as string;
      const fromCarol = ok(await comment(carol, contentId, 'From carol'), 201).commentId as string;

      ok(await block(alice, bob), 201);
      // Not on the post, not as a reply to someone else's comment on it, and not by changing what he wrote before.
      expect(refusal(await comment(bob, contentId, 'After the block'))).toEqual([403, NOT_TAKEN]);
      expect(refusal(await comment(bob, contentId, 'To carol', fromCarol))).toEqual([403, NOT_TAKEN]);
      expect(refusal(await edit(bob, contentId, before, 'Changed after the block'))).toEqual([403, NOT_TAKEN]);
      expect(refusal(await edit(bob, contentId, before, 'Before the block'))).toEqual([403, NOT_TAKEN]);
      expect(shown(await comments(null, contentId))).toEqual([['bob', 'Before the block'], ['carol', 'From carol']]);
      // Nothing of a refused comment is kept.
      expect(await ctx.db.selectFrom('pending_writes').select('content_id').execute()).toEqual([]);

      // It is between the two, and one way: everyone else comments on her posts, he on everyone else's, and she on his.
      ok(await comment(carol, contentId, 'Carol again'), 201);
      ok(await comment(bob, carols, "On carol's post"), 201);
      ok(await comment(alice, bobs, "On bob's post"), 201);
      // What he wrote before is still his to delete, and hers.
      expect(ok(await req(bob, 'DELETE', `/content/${contentId}/comments/${before}`))).toMatchObject({ status: 'deleted' });

      ok(await unblock(alice, bob));
      const after = ok(await comment(bob, contentId, 'After it ended'), 201).commentId as string;
      expect(ok(await edit(bob, contentId, after, 'After it ended, edited'))).toMatchObject({ text: 'After it ended, edited' });
    });

    it("takes no reply to a user's comments from someone they block, on anyone's post, and no edit of the replies that are there", async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const carol = await ctx.register('carol');
      // The post is carol's, who blocks nobody: alice only comments on it.
      const contentId = await post(carol, "Carol's own #news", { comments: true });
      const fromAlice = ok(await comment(alice, contentId, 'From alice'), 201).commentId as string;
      const alsoAlice = ok(await comment(alice, contentId, 'Also from alice'), 201).commentId as string;
      const fromCarol = ok(await comment(carol, contentId, 'From carol'), 201).commentId as string;
      const before = ok(await comment(bob, contentId, 'Bob to alice, before the block', fromAlice), 201).commentId as string;
      const underAlso = ok(await comment(bob, contentId, 'Bob to alice again, before the block', alsoAlice), 201).commentId as string;
      const carolToAlice = ok(await comment(carol, contentId, 'Carol to alice', fromAlice), 201).commentId as string;

      ok(await block(alice, bob), 201);
      // Not a reply to her comment, and not by changing the one he made before: sent again as it is, too.
      expect(refusal(await comment(bob, contentId, 'Bob to alice, after the block', fromAlice))).toEqual([403, REPLY_NOT_TAKEN]);
      expect(refusal(await edit(bob, contentId, before, 'Changed after the block'))).toEqual([403, REPLY_NOT_TAKEN]);
      expect(refusal(await edit(bob, contentId, before, 'Bob to alice, before the block'))).toEqual([403, REPLY_NOT_TAKEN]);
      expect(shown(await replies(null, contentId, fromAlice))).toEqual([['bob', 'Bob to alice, before the block'], ['carol', 'Carol to alice']]);
      // Nothing of a refused reply is kept.
      expect(await ctx.db.selectFrom('pending_writes').select('content_id').execute()).toEqual([]);

      // It goes by the comment replied to: he still comments on the post, replies to carol, and to her reply under alice's comment.
      const onPost = ok(await comment(bob, contentId, 'On the post'), 201).commentId as string;
      ok(await comment(bob, contentId, 'Bob to carol', fromCarol), 201);
      ok(await comment(bob, contentId, 'Bob to carol, under alice', carolToAlice), 201);
      expect(ok(await edit(bob, contentId, onPost, 'On the post, edited'))).toMatchObject({ text: 'On the post, edited' });
      // And it is one way, between the two: carol replies to alice, and alice to him.
      ok(await comment(carol, contentId, 'Carol to alice again', fromAlice), 201);
      ok(await comment(alice, contentId, 'Alice to bob', before), 201);

      // What is left of a comment she deleted is nobody's: his reply under it is his to edit again.
      expect(refusal(await edit(bob, contentId, underAlso, 'Changed after the block'))).toEqual([403, REPLY_NOT_TAKEN]);
      expect(ok(await req(alice, 'DELETE', `/content/${contentId}/comments/${alsoAlice}`))).toMatchObject({ status: 'deleted' });
      expect(ok(await edit(bob, contentId, underAlso, 'After she deleted hers'))).toMatchObject({ text: 'After she deleted hers' });
      // What he wrote before the block is still his to delete.
      expect(ok(await req(bob, 'DELETE', `/content/${contentId}/comments/${underAlso}`))).toMatchObject({ status: 'deleted' });

      ok(await unblock(alice, bob));
      ok(await comment(bob, contentId, 'Bob to alice, after it ended', fromAlice), 201);
      expect(ok(await edit(bob, contentId, before, 'Before the block, edited'))).toMatchObject({ text: 'Before the block, edited' });
    });

    it("takes no repost of a user's posts from someone they block", async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const carol = await ctx.register('carol');
      const first = await post(alice, 'First from alice #news');
      const second = await post(alice, 'Second from alice #news');
      const carols = await post(carol, "Carol's own #news");
      const bobs = await post(bob, "Bob's own #news");
      ok(await repost(bob, { contentId: first, tags: 'dunks' }), 201);

      ok(await block(alice, bob), 201);
      expect(refusal(await repost(bob, { contentId: second, tags: 'dunks' }))).toEqual([403, NO_REPOST]);
      // Nothing of a refused repost is kept: the post has no hashtag from it, and is in no index of his.
      expect(await reposts(second)).toEqual([]);
      expect(await ctx.db.selectFrom('reposts').select('content_id').where('content_id', '=', second).execute()).toEqual([]);

      // It is between the two, and one way: everyone else reposts her posts, he everyone else's, and she his.
      ok(await repost(carol, { contentId: second, tags: 'weather' }), 201);
      ok(await repost(bob, { contentId: carols, tags: 'weather' }), 201);
      ok(await repost(alice, { contentId: bobs, tags: 'weather' }), 201);
      expect(await reposts(second)).toEqual([['carol', ['weather']]]);
      // The repost he made before the block stays.
      expect(await reposts(first)).toEqual([['bob', ['dunks']]]);

      ok(await unblock(alice, bob));
      ctx.clock.now += HOUR;
      ok(await repost(bob, { contentId: second, tags: 'dunks' }), 201);
      expect(await reposts(second)).toEqual([['carol', ['weather']], ['bob', ['dunks']]]);
    });

    it("holds a repost by its address to the block too, and leaves a post on another server to whoever reposts it", async () => {
      ctx = await createTestContext(target, {
        publicBaseUrl: 'https://api.example.com',
        reposts: { signingKeys: [Buffer.alloc(32, 3).toString('base64')] },
        keyFetcher: async () => ({ keys: [{ id: OTHER_KEY.id, publicKey: OTHER_KEY.publicKey, algorithm: 'ed25519' }] }),
      });
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const own = await post(alice, 'Written here #news');
      /** What a client sends of the post on the other server: that server's attestation of it, signed just now. */
      const elsewhere = () => ({
        attestation: attest(OTHER_KEY, { url: ELSEWHERE, publisher: { userId: '11111111-1111-4111-8111-111111111111', username: 'dana' }, aiGenerated: false, preview: { kind: 'text', text: 'Flooding closes the coast road.' } } as Attestable, ctx.clock.now),
      });
      // Alice is the first to repost the other server's post, so this server's entry for it is hers.
      const entry = ok(await repost(alice, { origin: elsewhere(), tags: 'coast' }), 201).contentId as string;

      ok(await block(alice, bob), 201);
      // Her post, named by its address and this server's own attestation of it, is the post it is by its id.
      const attestation = ok(await req(null, 'GET', `/content/${own}/attestation`));
      expect(refusal(await repost(bob, { origin: attestation, tags: 'dunks' }))).toEqual([403, NO_REPOST]);
      expect(refusal(await repost(bob, { contentId: own, tags: 'dunks' }))).toEqual([403, NO_REPOST]);
      expect(await reposts(own)).toEqual([]);

      // The entry is her content, but not her post: he reposts the original as anyone does.
      expect(ok(await repost(bob, { origin: elsewhere(), tags: 'floods' }), 201)).toMatchObject({ contentId: entry, tags: ['floods'] });
      expect(await reposts(entry)).toEqual([['bob', ['floods']]]);
    });

    it('lists the comments of a blocked user as placeholders to whoever blocks them, and to nobody else', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const carol = await ctx.register('carol');
      const contentId = await post(alice, 'Say what you think #news', { comments: true });
      const fromBob = ok(await comment(bob, contentId, 'From bob'), 201).commentId as string;
      const fromCarol = ok(await comment(carol, contentId, 'From carol'), 201).commentId as string;
      ok(await comment(carol, contentId, 'Carol to bob', fromBob), 201);
      ok(await comment(bob, contentId, 'Bob to carol', fromCarol), 201);
      const all = [['bob', 'From bob'], ['carol', 'From carol']];
      expect(shown(await comments(carol, contentId))).toEqual(all);

      // Carol blocks bob, on a post that is neither's: what he wrote there is hidden from her.
      ok(await block(carol, bob), 201);
      const hers = await comments(carol, contentId);
      expect(shown(hers)).toEqual([[null, '', 'blocked'], ['carol', 'From carol']]);
      // It keeps its place and its replies, and says nothing else of the comment.
      expect(hers.count).toBe(4);
      expect(hers.comments[0]).toEqual({ ...(await comments(null, contentId)).comments[0], author: null, text: '', media: null, likes: 0, editedAt: null, status: 'blocked' });
      expect(hers.comments[0]).toMatchObject({ commentId: fromBob, replies: 1 });
      expect(shown(await replies(carol, contentId, fromBob))).toEqual([['carol', 'Carol to bob']]);
      expect(shown(await replies(carol, contentId, fromCarol))).toEqual([[null, '', 'blocked']]);

      // To her alone, by her key: not to someone without one, another user, the one she blocks, or a wrong key.
      for (const reader of [null, alice, bob]) expect(shown(await comments(reader, contentId))).toEqual(all);
      expect(shown(await comments(carol, contentId, { authorization: 'Bearer nope' }))).toEqual(all);
      expect(shown(await replies(null, contentId, fromCarol))).toEqual([['bob', 'Bob to carol']]);
      // And in the lists: a comment asked for by its id is given as it is.
      expect(ok(await req(carol, 'GET', `/content/${contentId}/comments/${fromBob}`))).toMatchObject({ author: { username: 'bob' }, text: 'From bob' });

      ok(await unblock(carol, bob));
      expect(shown(await comments(carol, contentId))).toEqual(all);
    });

    it("leaves a blocked user's posts out of the following feed of whoever blocks them, where someone they follow reposted one", async () => {
      ctx = await createTestContext(target);
      const [alice, bob, carol, dave] = (await Promise.all(['alice', 'bob', 'carol', 'dave'].map((name) => ctx.register(name)))) as [User, User, User, User];
      ok(await follow(alice, carol), 201);
      ok(await follow(dave, carol), 201);
      ok(await req(alice, 'PATCH', `/users/${alice.userId}`, { showFollowing: true }));
      const fromBob = await post(bob, 'from bob #news');
      ctx.clock.now += HOUR;
      const fromCarol = await post(carol, 'from carol #news');
      ctx.clock.now += HOUR;
      ok(await ctx.app.inject({ method: 'POST', url: '/repost', payload: { ...carol, contentId: fromBob, tags: 'weather' } }), 201);
      await ctx.compact();
      expect(ids(await followingFeed(alice))).toEqual([fromBob, fromCarol]);

      ok(await block(alice, bob), 201);
      // Carol's repost of bob's post is not in what alice is listed, and not counted.
      expect(await followingFeed(alice)).toMatchObject({ count: 1, truncated: false, nextCursor: null, records: [{ contentId: fromCarol }] });
      // A page is the shorter for it, and the next carries on after it.
      const first = await followingFeed(alice, alice, '&limit=1');
      expect([ids(first), first.truncated]).toEqual([[], true]);
      expect(ids(await followingFeed(alice, alice, `&limit=1&cursor=${first.nextCursor}`))).toEqual([fromCarol]);

      // It is her blocks, by her key. Her feed, which she shows, is whole to everyone else, and to a wrong key.
      for (const reader of [null, carol, bob]) expect(ids(await followingFeed(alice, reader))).toEqual([fromBob, fromCarol]);
      const wrongKey = await ctx.app.inject({ method: 'GET', url: `/feed/following?userId=${alice.userId}`, headers: { ...as(alice), authorization: 'Bearer nope' } });
      expect(ids(ok(wrongKey))).toEqual([fromBob, fromCarol]);
      // And whoever reads is held to their own: dave's feed is whole to him, and without bob to her, if he shows it.
      expect(ids(await followingFeed(dave))).toEqual([fromBob, fromCarol]);
      ok(await req(dave, 'PATCH', `/users/${dave.userId}`, { showFollowing: true }));
      expect(ids(await followingFeed(dave, alice))).toEqual([fromCarol]);
      // The post itself is still read by its id, and is in its hashtags' feeds, which take no key.
      expect(ok(await req(alice, 'GET', `/content/${fromBob}`))).toMatchObject({ publisher: { username: 'bob' } });

      ok(await unblock(alice, bob));
      expect(ids(await followingFeed(alice))).toEqual([fromBob, fromCarol]);
    });
  });
}
