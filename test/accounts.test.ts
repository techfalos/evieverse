import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { setAdmin } from '../src/moderation/policy.js';
import { as, createTestContext, requests, TARGETS, type TestContext, type User } from './helpers.js';

const NO_USER = '00000000-0000-4000-8000-000000000000';
const OWN_ONLY = "you can only delete your own account, unless you're an admin";
const ONLY_ADMIN = 'this is the only admin: make another user an admin first';

for (const target of TARGETS) {
  describe(`account deletion (${target.name})`, () => {
    let ctx: TestContext;
    afterEach(() => ctx.close());

    const { post, feedItems } = requests(() => ctx);
    const req = (u: User | null, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
      ctx.app.inject({ method, url, headers: u ? as(u) : {}, ...(payload && { payload }) });
    const ok = (res: LightMyRequestResponse, status = 200) => {
      expect(res.statusCode, res.body).toBe(status);
      return res.json();
    };
    const refused = async (res: Promise<LightMyRequestResponse>) => {
      const r = await res;
      return [r.statusCode, r.json().error];
    };
    const now = () => new Date(ctx.clock.now).toISOString();
    const admin = async (name = 'root') => {
      const u = await ctx.register(name);
      await setAdmin(ctx.db, name, true);
      return u;
    };
    const remove = (by: User | null, userId: string) => req(by, 'DELETE', `/users/${userId}`);
    const userRow = (userId: string) => ctx.db.selectFrom('users').select(['id', 'deleted_at']).where('id', '=', userId).executeTakeFirst();
    const register = (username: string) => ctx.registration({ username });
    const inbox = async (u: User) => ok(await req(u, 'GET', `/users/${u.userId}/inbox`)).inbox as { kind: string; from?: { userId: string; username: string } | null; text: string }[];

    it('lets a user delete their own account, which is gone at once when it has no posts', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');

      // Only the user's own key, and only for their own account.
      expect((await remove(null, alice.userId)).statusCode).toBe(401);
      expect((await remove({ userId: alice.userId, apiKey: bob.apiKey }, alice.userId)).statusCode).toBe(401);
      expect(await refused(remove(bob, alice.userId))).toEqual([403, OWN_ONLY]);
      expect(await userRow(alice.userId)).toBeDefined();

      expect(ok(await remove(alice, alice.userId), 200)).toEqual({ userId: alice.userId, status: 'deleted' });
      expect(await userRow(alice.userId)).toBeUndefined();
      expect(await ctx.db.selectFrom('api_keys').select('id').where('user_id', '=', alice.userId).execute()).toEqual([]);
      expect((await req(alice, 'GET', '/whoami')).statusCode).toBe(401);
      expect((await remove(alice, alice.userId)).statusCode).toBe(401);
      expect((await req(null, 'GET', `/users/${alice.userId}`)).statusCode).toBe(404);
      // Nothing of her name is left in Redis, where credits are read from.
      expect((await ctx.publishers.getMany([alice.userId])).get(alice.userId)).toEqual({ userId: alice.userId, username: '' });
      // Bob is as he was, and the name is free again.
      expect((await req(bob, 'GET', '/whoami')).statusCode).toBe(200);
      expect(ok(await register('alice'), 201).userId).not.toBe(alice.userId);
    });

    it('closes an account and its posts at once, and has the compactor take the posts out of feeds and delete the account with the last of them', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const first = await post(alice, 'Morning #news', { comments: true });
      const second = await post(alice, 'Evening #news #sports');
      const bobs = await post(bob, 'Bob here #news');
      ok(await req(bob, 'POST', `/content/${first}/comments`, { text: 'Nice' }), 201);
      expect(await ctx.comments.count(first)).toBe(1);
      ok(await req(bob, 'PUT', `/users/${bob.userId}/following/${alice.userId}`), 201);
      ok(await req(alice, 'PUT', `/users/${alice.userId}/following/${bob.userId}`), 201);
      ok(await req(alice, 'POST', '/messages', { to: bob.userId, text: 'Hello Bob' }), 201);
      await ctx.compact();
      expect((await feedItems('news')).map((i) => i.contentId).sort()).toEqual([first, second, bobs].sort());
      expect(await ctx.follows.get(bob.userId)).toEqual([alice.userId]);

      expect(ok(await remove(alice, alice.userId), 202)).toEqual({ userId: alice.userId, status: 'pending_deletion', requestedAt: now() });

      // Gone as far as anyone can tell: her posts are 404, and she is nobody. Feeds hold them until the compactor's next run.
      for (const contentId of [first, second]) expect((await req(null, 'GET', `/content/${contentId}`)).statusCode).toBe(404);
      expect((await req(alice, 'GET', '/whoami')).statusCode).toBe(401);
      expect((await req(null, 'GET', `/users/${alice.userId}`)).statusCode).toBe(404);
      expect(ok(await req(bob, 'GET', `/users/${bob.userId}/following`)).following).toEqual([]);
      expect(await ctx.follows.get(bob.userId)).toEqual([]);
      expect(await ctx.follows.get(alice.userId)).toEqual([]);
      // What others did to her: nothing reaches her, and what she sent has no sender.
      expect(await refused(req(bob, 'POST', '/messages', { to: alice.userId, text: 'Still there?' }))).toEqual([404, 'user not found']);
      expect(await refused(req(bob, 'PUT', `/users/${bob.userId}/following/${alice.userId}`))).toEqual([404, 'user not found']);
      expect((await inbox(bob)).find((m) => m.kind === 'message')?.from).toBeNull();
      // Her row is kept for her posts, and her name with it.
      expect(await userRow(alice.userId)).toMatchObject({ deleted_at: ctx.clock.now });
      expect((await register('alice')).statusCode).toBe(409);

      // Her posts go, and her account with the last of them. Bob's comment went with the post it was on.
      expect((await ctx.compact()).deleted.sort()).toEqual([first, second].sort());
      expect(await userRow(alice.userId)).toBeUndefined();
      expect(await ctx.db.selectFrom('content').select('id').where('user_id', '=', alice.userId).execute()).toEqual([]);
      expect(await ctx.comments.count(first)).toBe(0);
      expect((await feedItems('news')).map((i) => i.contentId)).toEqual([bobs]);
      expect(await feedItems('sports')).toEqual([]);
      ok(await register('alice'), 201);
      // A post that isn't hers is as it was.
      expect(ok(await req(null, 'GET', `/content/${bobs}`)).publisher).toEqual({ userId: bob.userId, username: 'bob' });
    });

    it('lets an admin delete any account, and nobody else, and answers a repeat for one on its way out as it did the first time', async () => {
      ctx = await createTestContext(target);
      const root = await admin();
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const carol = await ctx.register('carol');
      await post(alice, 'Something #news');

      expect(await refused(remove(carol, alice.userId))).toEqual([403, OWN_ONLY]);
      expect((await remove(null, alice.userId)).statusCode).toBe(401);
      expect(await refused(remove(root, NO_USER))).toEqual([404, 'user not found']);

      const first = ok(await remove(root, alice.userId), 202);
      expect(first).toEqual({ userId: alice.userId, status: 'pending_deletion', requestedAt: now() });
      ctx.clock.now += 1000;
      expect(ok(await remove(root, alice.userId), 202)).toEqual(first);
      // No posts, so nothing to wait for.
      expect(ok(await remove(root, bob.userId), 200)).toEqual({ userId: bob.userId, status: 'deleted' });
      expect((await req(bob, 'GET', '/whoami')).statusCode).toBe(401);

      await ctx.compact();
      expect(await refused(remove(root, alice.userId))).toEqual([404, 'user not found']);
      expect((await req(carol, 'GET', '/whoami')).statusCode).toBe(200);
    });

    it('has a repeat that finds the posts deleted and the account not yet delete the account itself: 200, and 404 from then on', async () => {
      ctx = await createTestContext(target);
      const root = await admin();
      const alice = await ctx.register('alice');
      const contentId = await post(alice, 'Something #news');

      const first = ok(await remove(alice, alice.userId), 202);
      expect(first).toEqual({ userId: alice.userId, status: 'pending_deletion', requestedAt: now() });
      expect(ok(await remove(root, alice.userId), 202)).toEqual(first);

      // Where a run of the compactor is between deleting the post's row and settling the accounts (settleAccounts), which a request can come in the middle of.
      await ctx.db.deleteFrom('content').where('id', '=', contentId).execute();
      expect(await userRow(alice.userId)).toBeDefined();

      expect(ok(await remove(root, alice.userId), 200)).toEqual({ userId: alice.userId, status: 'deleted' });
      expect(await userRow(alice.userId)).toBeUndefined();
      expect(await refused(remove(root, alice.userId))).toEqual([404, 'user not found']);
      // Gone for good, so the name is free.
      ok(await register('alice'), 201);
    });

    it('never deletes the only admin, and takes a deleted admin out of the list of admins', async () => {
      ctx = await createTestContext(target);
      const root = await admin('root');
      const second = await admin('second');
      const third = await admin('third');
      await post(second, 'An admin posts #news');
      const admins = async (by: User = root) => (ok(await req(by, 'GET', '/admins')).admins as { username: string }[]).map((a) => a.username);
      expect(await admins()).toEqual(['root', 'second', 'third']);

      // An admin deletes another, or herself, while there is another to stay.
      expect(ok(await remove(root, third.userId), 200)).toEqual({ userId: third.userId, status: 'deleted' });
      expect(ok(await remove(second, second.userId), 202)).toMatchObject({ status: 'pending_deletion' });
      expect(await admins()).toEqual(['root']);
      // Her row is still there, but she is no admin to leave in place: root is the only one.
      expect(await userRow(second.userId)).toBeDefined();
      expect(await refused(remove(root, root.userId))).toEqual([409, ONLY_ADMIN]);
      expect((await req(root, 'GET', '/whoami')).statusCode).toBe(200);

      const fourth = await admin('fourth');
      expect(ok(await remove(root, root.userId), 200)).toEqual({ userId: root.userId, status: 'deleted' });
      expect(await refused(remove(fourth, fourth.userId))).toEqual([409, ONLY_ADMIN]);
      expect(await admins(fourth)).toEqual(['fourth']);
    });

    it('takes a deleted account out of what named it: roles, mutes, blocks and reports', async () => {
      ctx = await createTestContext(target);
      const root = await admin();
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      await post(alice, 'Still here #news');
      const bobs = await post(bob, 'Questionable #news');
      ok(await req(root, 'PUT', `/tags/news/moderators/${alice.userId}`), 201);
      ok(await req(root, 'PUT', `/moderators/${alice.userId}`), 201);
      ok(await req(root, 'PUT', `/tags/sports/muted/${alice.userId}`), 201);
      ok(await req(bob, 'PUT', `/users/${bob.userId}/blocked/${alice.userId}`), 201);
      ok(await req(alice, 'POST', '/report', { contentId: bobs, reason: 'Hmm' }), 201);
      expect(ok(await req(root, 'GET', '/moderation/reports')).queue).toHaveLength(1);

      ok(await remove(alice, alice.userId), 202);

      expect(ok(await req(null, 'GET', '/tags/news/moderators')).moderators).toEqual([]);
      expect(ok(await req(root, 'GET', '/moderators')).moderators).toEqual([]);
      expect(ok(await req(root, 'GET', '/tags/sports/muted')).muted).toEqual([]);
      expect(ok(await req(bob, 'GET', `/users/${bob.userId}/blocked`)).blocked).toEqual([]);
      expect(ok(await req(root, 'GET', '/moderation/reports')).queue).toEqual([]);
      // And nobody can name her: she is not a user to appoint, ban, block or message.
      for (const res of [
        await req(root, 'PUT', `/admins/${alice.userId}`),
        await req(root, 'PUT', `/moderators/${alice.userId}`),
        await req(root, 'PUT', `/tags/news/moderators/${alice.userId}`),
        await req(root, 'PUT', `/banned/${alice.userId}`),
        await req(bob, 'PUT', `/users/${bob.userId}/blocked/${alice.userId}`),
        await req(bob, 'POST', '/messages', { to: alice.userId, text: 'hi' }),
        await req(root, 'GET', `/users/${alice.userId}/followers`),
      ]) {
        expect([res.statusCode, res.json().error]).toEqual([404, 'user not found']);
      }
    });

    it('sets for deletion what an account wrote as it closed, which the compactor finds', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const written = await post(alice, 'Written before #news');
      ok(await remove(alice, alice.userId), 202);

      // A post whose request began before the account closed, and committed after.
      const straggler = randomUUID();
      await ctx.db.insertInto('content').values({ id: straggler, user_id: alice.userId, created_at: ctx.clock.now }).execute();

      // The first run deletes the post that was marked, and marks the straggler: the account waits for it.
      expect((await ctx.compact()).deleted).toEqual([written]);
      expect(await userRow(alice.userId)).toBeDefined();
      expect(await ctx.db.selectFrom('content').select('delete_requested_at').where('id', '=', straggler).executeTakeFirst()).toEqual({ delete_requested_at: expect.any(Number) });

      expect((await ctx.compact()).deleted).toEqual([straggler]);
      expect(await userRow(alice.userId)).toBeUndefined();
    });
  });
}
