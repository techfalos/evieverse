import type { FastifyRequest, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { issueApiKey, reissueApiKey, reissueApiKeyFor } from '../src/auth/apiKey.js';
import type { HttpError } from '../src/http/errors.js';
import { setAdmin } from '../src/moderation/policy.js';
import { as, createTestContext, post, readAudit, TARGETS, type TestContext, type User } from './helpers.js';

for (const target of TARGETS) {
  describe(`replacing an API key (${target.name})`, () => {
    let ctx: TestContext;
    afterEach(() => ctx.close());

    /** POST /users/:userId/key as `u`, for their own account unless `userId` names another. */
    const replace = (u: User | null, userId = u?.userId) => ctx.app.inject({ method: 'POST', url: `/users/${userId}/key`, headers: u ? as(u) : {} });
    const whoami = async (u: User) => (await ctx.app.inject({ method: 'GET', url: '/whoami', headers: as(u) })).statusCode;
    const ok = (res: LightMyRequestResponse) => {
      expect(res.statusCode, res.body).toBe(201);
      return res.json() as User & { note: string };
    };
    /** When each of a user's keys was revoked, oldest key first: null for one that works. */
    const revocations = async (u: User) =>
      (await ctx.db.selectFrom('api_keys').select(['revoked_at', 'created_at']).where('user_id', '=', u.userId).execute())
        .sort((a, b) => Number(a.created_at) - Number(b.created_at) || Number(b.revoked_at !== null) - Number(a.revoked_at !== null))
        .map((k) => (k.revoked_at === null ? null : Number(k.revoked_at)));

    it('gives the user a new key and revokes the one they had, at once', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const contentId = await post(ctx, alice, 'before the key leaked #news');
      ctx.clock.now += 1000;

      const replaced = ok(await replace(alice));
      expect(replaced).toEqual({
        userId: alice.userId,
        apiKey: expect.stringMatching(/^tu_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/),
        note: 'Store this apiKey now; it cannot be retrieved again. The key it replaces no longer works.',
      });
      expect(replaced.apiKey).not.toBe(alice.apiKey);
      const fresh = { userId: alice.userId, apiKey: replaced.apiKey };

      // The old key does nothing from here on, the new one everything the account could: it is the same account.
      expect([await whoami(alice), await whoami(fresh)]).toEqual([401, 200]);
      expect((await ctx.app.inject({ method: 'POST', url: '/store', payload: { ...alice, type: 'text', text: 'with the old key #news', tags: ['news'] } })).statusCode).toBe(401);
      expect((await ctx.app.inject({ method: 'DELETE', url: `/content/${contentId}`, headers: as(alice) })).statusCode).toBe(401);
      await post(ctx, fresh, 'with the new key #news');
      expect((await ctx.app.inject({ method: 'DELETE', url: `/content/${contentId}`, headers: as(fresh) })).statusCode).toBe(202);
      expect(await revocations(alice)).toEqual([ctx.clock.now, null]);

      // A replaced key can't be replaced again, and trying leaves the key in use alone.
      expect((await replace(alice)).statusCode).toBe(401);
      expect(await whoami(fresh)).toBe(200);
      // The new key can be: a key is replaced as often as its owner likes.
      const again = { userId: alice.userId, apiKey: ok(await replace(fresh)).apiKey };
      expect([await whoami(alice), await whoami(fresh), await whoami(again)]).toEqual([401, 401, 200]);
    });

    it('takes the credentials in the body too', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const res = await ctx.app.inject({ method: 'POST', url: `/users/${alice.userId}/key`, payload: alice });
      expect([await whoami(alice), await whoami({ userId: alice.userId, apiKey: ok(res).apiKey })]).toEqual([401, 200]);
    });

    it("replaces only the caller's own key, and only for a key that works", async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const wrong = `tu_${'0'.repeat(12)}_${'A'.repeat(43)}`;

      expect((await replace(null, alice.userId)).json()).toEqual({ error: 'userId and apiKey are required' });
      for (const [who, userId] of [
        [null, alice.userId],
        [{ userId: alice.userId, apiKey: wrong }, alice.userId],
        [{ userId: alice.userId, apiKey: 'not a key' }, alice.userId],
        // Bob's key with alice's id, on either account.
        [{ userId: alice.userId, apiKey: bob.apiKey }, alice.userId],
        [{ userId: alice.userId, apiKey: bob.apiKey }, bob.userId],
      ] as const) {
        expect((await replace(who, userId)).statusCode, JSON.stringify(who)).toBe(401);
      }
      // Bob, as himself, asking for alice's.
      const other = await replace(bob, alice.userId);
      expect([other.statusCode, other.json()]).toEqual([403, { error: "you can only replace your own API key, unless you're an admin" }]);
      expect((await replace(alice, 'not-a-user-id')).statusCode).toBe(400);

      expect([await whoami(alice), await whoami(bob)]).toEqual([200, 200]);
      expect([await revocations(alice), await revocations(bob)]).toEqual([[null], [null]]);
    });

    it('leaves the account one key, whatever others it had', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      // A second key, which no endpoint gives an account: one set up by hand, say.
      const spare = { userId: alice.userId, apiKey: await issueApiKey(ctx.db, alice.userId, ctx.clock.now) };
      expect([await whoami(alice), await whoami(spare)]).toEqual([200, 200]);
      ctx.clock.now += 1000;

      const fresh = { userId: alice.userId, apiKey: ok(await replace(spare)).apiKey };
      expect([await whoami(alice), await whoami(spare), await whoami(fresh)]).toEqual([401, 401, 200]);
      expect(await revocations(alice)).toEqual([ctx.clock.now, ctx.clock.now, null]);
      // Nobody else's key is touched.
      expect(await whoami(bob)).toBe(200);
    });

    it('gives one new key when the same key is replaced several times at once', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');

      const answers = await Promise.all([replace(alice), replace(alice), replace(alice)]);
      expect(answers.map((res) => res.statusCode).sort()).toEqual([201, 401, 401]);
      const fresh = { userId: alice.userId, apiKey: ok(answers.find((res) => res.statusCode === 201)!).apiKey };
      expect([await whoami(alice), await whoami(fresh)]).toEqual([401, 200]);
      expect(await revocations(alice)).toEqual([ctx.clock.now, null]);

      // The same without the route's check of the key before it, which can turn the later ones away
      // first: here every one of them gets as far as revoking the key, and one does.
      const request = { headers: {} } as FastifyRequest;
      const keys = await Promise.allSettled(Array.from({ length: 4 }, () => reissueApiKey(ctx.db, target.dialect, request, fresh, ctx.clock.now)));
      expect(keys.map((k) => (k.status === 'fulfilled' ? 'a key' : (k.reason as HttpError).statusCode)).sort()).toEqual([401, 401, 401, 'a key']);
      const last = { userId: alice.userId, apiKey: (keys.find((k) => k.status === 'fulfilled') as PromiseFulfilledResult<string>).value };
      expect([await whoami(fresh), await whoami(last)]).toEqual([401, 200]);
      expect((await revocations(alice)).filter((at) => at === null)).toHaveLength(1);
    });
  });

  describe(`replacing a user's API key as an admin (${target.name})`, () => {
    let ctx: TestContext;
    afterEach(() => ctx.close());

    const replace = (u: User, userId: string) => ctx.app.inject({ method: 'POST', url: `/users/${userId}/key`, headers: as(u) });
    const whoami = (u: User) => ctx.app.inject({ method: 'GET', url: '/whoami', headers: as(u) });
    const works = async (u: User) => (await whoami(u)).statusCode === 200;
    /** The key an admin was given for `userId`, as that user's credentials. */
    const given = (res: LightMyRequestResponse, userId: string): User => {
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json()).toEqual({
        userId,
        apiKey: expect.stringMatching(/^tu_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/),
        note: 'Pass this apiKey on to the user now; it cannot be retrieved again. Every key they had no longer works.',
      });
      return { userId, apiKey: res.json().apiKey };
    };
    /** How many of a user's keys work, and how many were revoked. */
    const keys = async (u: User) => {
      const rows = await ctx.db.selectFrom('api_keys').select('revoked_at').where('user_id', '=', u.userId).execute();
      return { live: rows.filter((k) => k.revoked_at === null).length, revoked: rows.filter((k) => k.revoked_at !== null).length };
    };
    /** A registered user who is an admin. */
    async function admin(username: string): Promise<User> {
      const user = await ctx.register(username);
      await setAdmin(ctx.db, username, true);
      return user;
    }

    it('gives the admin a new key for the user, revokes every key the user had, and leaves the admin theirs', async () => {
      ctx = await createTestContext(target, { audit: true });
      const root = await admin('root');
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const contentId = await post(ctx, alice, 'before the key was lost #news');
      const spare = { userId: alice.userId, apiKey: await issueApiKey(ctx.db, alice.userId, ctx.clock.now) };
      ctx.clock.now += 1000;

      const fresh = given(await replace(root, alice.userId), alice.userId);
      expect(fresh.apiKey).not.toBe(root.apiKey);
      expect([await works(alice), await works(spare), await works(fresh)]).toEqual([false, false, true]);
      expect(await keys(alice)).toEqual({ live: 1, revoked: 2 });
      // It is alice's account the new key is of, as it was: not the admin's, and with nothing of the admin's role.
      expect((await whoami(fresh)).json()).toMatchObject({ userId: alice.userId, username: 'alice', admin: false });
      expect((await ctx.app.inject({ method: 'DELETE', url: `/content/${contentId}`, headers: as(fresh) })).statusCode).toBe(202);
      // Nobody else's key is touched, the admin's least of all.
      expect([await works(root), await works(bob)]).toEqual([true, true]);
      expect([await keys(root), await keys(bob)]).toEqual([{ live: 1, revoked: 0 }, { live: 1, revoked: 0 }]);

      // The key is alice's to replace from here on, and the admin's to replace again: with the credentials in the body, too.
      ctx.clock.now += 1000;
      const hers = { userId: alice.userId, apiKey: (await replace(fresh, alice.userId)).json().apiKey };
      expect([await works(fresh), await works(hers)]).toEqual([false, true]);
      ctx.clock.now += 1000;
      const again = given(await ctx.app.inject({ method: 'POST', url: `/users/${alice.userId}/key`, payload: root }), alice.userId);
      expect([await works(hers), await works(again), await works(root)]).toEqual([false, true, true]);

      // The audit log says who replaced whose key, and holds none of the keys.
      const records = (await readAudit(ctx)).filter((r) => r.route === '/users/:userId/key');
      expect(records.map((r) => [r.userId, r.params, r.result])).toEqual([
        [root.userId, { userId: alice.userId }, { userId: alice.userId }],
        [alice.userId, { userId: alice.userId }, { userId: alice.userId }],
        [root.userId, { userId: alice.userId }, { userId: alice.userId }],
      ]);
      const text = JSON.stringify(records);
      for (const key of [root, fresh, hers, again]) expect(text).not.toContain(key.apiKey);
    });

    it("replaces another admin's key as it does anyone's, and they stay an admin", async () => {
      ctx = await createTestContext(target);
      const root = await admin('root');
      const second = await admin('second');

      const fresh = given(await replace(root, second.userId), second.userId);
      expect([await works(second), await works(fresh), await works(root)]).toEqual([false, true, true]);
      expect((await whoami(fresh)).json()).toMatchObject({ userId: second.userId, username: 'second', admin: true });
      // Which goes both ways: the other admin can replace the first one's, with the key they were given.
      const roots = given(await replace(fresh, root.userId), root.userId);
      expect([await works(root), await works(roots), await works(fresh)]).toEqual([false, true, true]);
      // A key that was replaced replaces nobody's.
      expect((await replace(root, second.userId)).statusCode).toBe(401);
      expect(await works(fresh)).toBe(true);
    });

    it('is an admin’s alone to do, for a user who is there', async () => {
      ctx = await createTestContext(target);
      const root = await admin('root');
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const carol = await ctx.register('carol');
      const former = await admin('former');
      // The roles that aren't an admin's don't do it: a server moderator, and a hashtag's.
      expect((await ctx.app.inject({ method: 'PUT', url: `/moderators/${bob.userId}`, headers: as(root) })).statusCode).toBe(201);
      expect((await ctx.app.inject({ method: 'PUT', url: `/tags/news/moderators/${carol.userId}`, headers: as(root) })).statusCode).toBe(201);
      expect((await ctx.app.inject({ method: 'DELETE', url: `/admins/${former.userId}`, headers: as(root) })).json()).toEqual({ userId: former.userId, wasAdmin: true });

      for (const who of [bob, carol, former]) {
        const res = await replace(who, alice.userId);
        expect([res.statusCode, res.json()]).toEqual([403, { error: "you can only replace your own API key, unless you're an admin" }]);
        // Nor an admin's.
        expect((await replace(who, root.userId)).statusCode).toBe(403);
      }
      // An admin's id with a key that isn't theirs, or with none.
      expect((await replace({ userId: root.userId, apiKey: alice.apiKey }, alice.userId)).statusCode).toBe(401);
      expect((await ctx.app.inject({ method: 'POST', url: `/users/${alice.userId}/key`, headers: { 'x-user-id': root.userId } })).statusCode).toBe(401);
      expect([await works(alice), await works(root)]).toEqual([true, true]);
      expect([await keys(alice), await keys(root)]).toEqual([{ live: 1, revoked: 0 }, { live: 1, revoked: 0 }]);

      // A user who never was, and one whose account was deleted, though its row is there until its posts are gone.
      const nobody = await replace(root, '00000000-0000-4000-8000-000000000000');
      expect([nobody.statusCode, nobody.json()]).toEqual([404, { error: 'user not found' }]);
      await post(ctx, alice, 'what keeps the row #news');
      expect((await ctx.app.inject({ method: 'DELETE', url: `/users/${alice.userId}`, headers: as(root) })).statusCode).toBe(202);
      expect((await replace(root, alice.userId)).statusCode).toBe(404);
      expect(await keys(alice)).toEqual({ live: 0, revoked: 1 });
      expect((await replace(root, 'not-a-user-id')).statusCode).toBe(400);
    });

    it('checks the admin again once it is their turn, so a key or a role that ended meanwhile replaces nothing', async () => {
      ctx = await createTestContext(target);
      const root = await admin('root');
      const second = await admin('second');
      const alice = await ctx.register('alice');
      // What the route does after its own check of the caller, which a request under way has passed already.
      const request = { headers: {} } as FastifyRequest;
      const forUser = (caller: User, userId: string) => reissueApiKeyFor(ctx.db, target.dialect, request, userId, caller, ctx.clock.now);
      const refusal = (attempt: Promise<string>) => attempt.then(() => 'a key', (err: HttpError) => err.statusCode);

      // The admin replaced their own key, as one does when it leaked: the old one takes nobody's account, an admin's or not.
      const roots = { userId: root.userId, apiKey: (await replace(root, root.userId)).json().apiKey as string };
      expect([await refusal(forUser(root, alice.userId)), await refusal(forUser(root, second.userId))]).toEqual([401, 401]);
      // The admin is one no more.
      expect((await ctx.app.inject({ method: 'DELETE', url: `/admins/${second.userId}`, headers: as(roots) })).statusCode).toBe(200);
      expect([await refusal(forUser(second, alice.userId)), await refusal(forUser(second, root.userId))]).toEqual([403, 403]);
      // Nor is it for a user to do for themselves, here.
      expect(await refusal(forUser(alice, alice.userId))).toBe(403);
      expect([await works(alice), await works(second), await works(roots)]).toEqual([true, true, true]);
      expect([await keys(alice), await keys(second)]).toEqual([{ live: 1, revoked: 0 }, { live: 1, revoked: 0 }]);

      // Sent at once with the admin replacing their own key, whichever comes first: each account ends with one key that works.
      const [own, ...others] = await Promise.all([
        replace(roots, root.userId),
        ...Array.from({ length: 3 }, () => refusal(forUser(roots, alice.userId))),
      ]);
      expect(own.statusCode, own.body).toBe(201);
      expect(others.every((o) => o === 'a key' || o === 401), JSON.stringify(others)).toBe(true);
      expect([(await keys(alice)).live, (await keys(root)).live]).toEqual([1, 1]);
      expect(await works(roots)).toBe(false);
    });

    it('leaves the user one key when several admins replace it at once', async () => {
      ctx = await createTestContext(target);
      const admins = [await admin('root'), await admin('second'), await admin('third')];
      const alice = await ctx.register('alice');

      const answers = await Promise.all([...admins, ...admins].map((a) => replace(a, alice.userId)));
      const handed = answers.map((res) => given(res, alice.userId));
      expect(new Set(handed.map((k) => k.apiKey)).size).toBe(handed.length);
      // Each replaced the one before it: the last to go through is the one that works.
      expect(await keys(alice)).toEqual({ live: 1, revoked: handed.length });
      expect((await Promise.all(handed.map(works))).filter(Boolean)).toHaveLength(1);
      expect(await works(alice)).toBe(false);
      expect(await Promise.all(admins.map(works))).toEqual([true, true, true]);

      // Two admins replacing each other's at once: both rows are locked in the same order, so neither waits for the other for ever.
      const [root, second] = admins as [User, User, User];
      const crossed = await Promise.all([replace(root, second.userId), replace(second, root.userId)]);
      // Whichever went first revoked the key the other was sent with, which the other finds when its turn comes.
      expect(crossed.map((res) => res.statusCode).sort()).toEqual([201, 401]);
      expect([(await keys(root)).live, (await keys(second)).live]).toEqual([1, 1]);
    });
  });
}
