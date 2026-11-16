import type { FastifyRequest, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { issueApiKey, reissueApiKey } from '../src/auth/apiKey.js';
import type { HttpError } from '../src/http/errors.js';
import { as, createTestContext, post, TARGETS, type TestContext, type User } from './helpers.js';

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
      expect([other.statusCode, other.json()]).toEqual([403, { error: 'you can only replace your own API key' }]);
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
}
