import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { setAdmin } from '../src/moderation/policy.js';
import { as, createTestContext, requests, TARGETS, type TestContext, type User } from './helpers.js';

const NO_USER = '00000000-0000-4000-8000-000000000000';
const BANNED = "your account is banned: you can't post, comment, like or send messages";
const STAFF_ONLY = 'only an admin or a server moderator can do this';

type Banned = { userId: string; username: string; bannedAt: string; reason: string | null; bannedBy: { userId: string; username: string } | null };

for (const target of TARGETS) {
  describe(`bans (${target.name})`, () => {
    let ctx: TestContext;
    afterEach(() => ctx.close());

    const { storeText, post } = requests(() => ctx);
    const req = (u: User | null, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
      ctx.app.inject({ method, url, headers: u ? as(u) : {}, ...(payload && { payload }) });
    const ok = (res: LightMyRequestResponse, status = 200) => {
      expect(res.statusCode, res.body).toBe(status);
      return res.json();
    };
    /** What a refused request was told. */
    const refused = async (res: Promise<LightMyRequestResponse>) => {
      const r = await res;
      return [r.statusCode, r.json().error];
    };
    const now = () => new Date(ctx.clock.now).toISOString();
    const id = (u: User | string) => (typeof u === 'string' ? u : u.userId);
    /** The users to ban with: an admin, a server moderator, and two others. */
    const setup = async () => {
      ctx = await createTestContext(target);
      const root = await ctx.register('root');
      await setAdmin(ctx.db, 'root', true);
      const mod = await ctx.register('mod');
      ok(await req(root, 'PUT', `/moderators/${mod.userId}`), 201);
      return { root, mod, alice: await ctx.register('alice'), bob: await ctx.register('bob') };
    };
    const ban = (by: User | null, who: User | string, reason?: string) => req(by, 'PUT', `/banned/${id(who)}`, reason === undefined ? undefined : { reason });
    const unban = (by: User | null, who: User | string) => req(by, 'DELETE', `/banned/${id(who)}`);
    const banned = async (by: User, query = '') => ok(await req(by, 'GET', `/banned${query}`)) as { banned: Banned[]; nextCursor: string | null };
    const send = (from: User, to: User, text: string) => req(from, 'POST', '/messages', { to: to.userId, text });
    const inbox = async (u: User) => ok(await req(u, 'GET', `/users/${u.userId}/inbox`)).inbox as { kind: string; text: string }[];

    it('has an admin or a server moderator ban a user, who is told of it once', async () => {
      const { root, mod, alice, bob } = await setup();
      expect(await refused(ban(bob, alice, 'Spam'))).toEqual([403, STAFF_ONLY]);
      expect((await ban(null, alice)).statusCode).toBe(401);
      expect(ok(await req(alice, 'GET', '/whoami'))).toMatchObject({ banned: false });
      expect((await banned(mod)).banned).toEqual([]);

      const bannedAt = now();
      expect(ok(await ban(mod, alice, '  Spamming  '), 201)).toEqual({ userId: alice.userId, username: 'alice', bannedAt, reason: 'Spamming', alreadyBanned: false });
      // Banning again changes nothing: the first ban's time and reason stay, and nobody is told again.
      ctx.clock.now += 1000;
      expect(ok(await ban(root, alice, 'Another reason'), 200)).toEqual({ userId: alice.userId, username: 'alice', bannedAt, reason: 'Spamming', alreadyBanned: true });
      expect(ok(await req(alice, 'GET', '/whoami'))).toMatchObject({ banned: true });
      expect((await inbox(alice)).map((m) => m.kind)).toEqual(['user_banned']);
      expect((await inbox(alice))[0]!.text).toMatch(/banned your account/);
      // Nobody else is told, and a ban needs no reason.
      expect(await inbox(bob)).toEqual([]);
      ok(await ban(root, bob), 201);
      expect(ok(await req(root, 'GET', '/whoami'))).toMatchObject({ banned: false });

      // The list: the latest first, with who banned and why. For moderators and admins.
      expect((await banned(root)).banned).toEqual([
        { userId: bob.userId, username: 'bob', bannedAt: now(), reason: null, bannedBy: { userId: root.userId, username: 'root' } },
        { userId: alice.userId, username: 'alice', bannedAt, reason: 'Spamming', bannedBy: { userId: mod.userId, username: 'mod' } },
      ]);
      expect(await refused(req(alice, 'GET', '/banned'))).toEqual([403, STAFF_ONLY]);
      expect((await req(null, 'GET', '/banned')).statusCode).toBe(401);
    });

    it('refuses a banned user what posts, comments, likes and sends, and nothing else', async () => {
      const { mod, alice, bob } = await setup();
      const first = await post(alice, 'Before the ban #news', { comments: true });
      const bobs = await post(bob, 'Open to comments #news', { comments: true });
      const { commentId } = ok(await req(bob, 'POST', `/content/${bobs}/comments`, { text: 'First' }), 201);
      const like = (u: User, contentId: string, comment?: string) => req(u, 'POST', '/like', { contentId, ...(comment && { commentId: comment }) });
      ok(await like(alice, bobs), 201);
      ok(await ban(mod, alice, 'Spam'), 201);
      const refusal = [403, BANNED];

      // A new post, an update of one of her own, a comment, a message, a link to upload with.
      expect(await refused(storeText(alice, 'After the ban #news'))).toEqual(refusal);
      expect(await refused(storeText(alice, 'Edited after the ban #news', { contentId: first }))).toEqual(refusal);
      expect(await refused(req(alice, 'POST', `/content/${bobs}/comments`, { text: 'Hello' }))).toEqual(refusal);
      expect(await refused(send(alice, bob, 'Hello'))).toEqual(refusal);
      expect(await refused(req(alice, 'POST', '/uploads', { type: 'image', contentType: 'image/png', size: 100 }))).toEqual(refusal);
      // A like of a post or of a comment, and of what isn't there. The like she made before the ban stays, and is refused like any other.
      expect(await refused(like(alice, first))).toEqual(refusal);
      expect(await refused(like(alice, bobs, commentId))).toEqual(refusal);
      expect(await refused(like(alice, NO_USER))).toEqual(refusal);
      expect(await refused(like(alice, bobs))).toEqual(refusal);
      expect(ok(await req(null, 'GET', `/content/${bobs}`))).toMatchObject({ likes: 1 });
      expect(ok(await req(null, 'GET', `/content/${bobs}/comments`)).comments).toMatchObject([{ commentId, likes: 0 }]);

      // Her post is as it was, and she can read, be written to, and take her posts and her account away.
      expect(ok(await req(null, 'GET', `/content/${first}`))).toMatchObject({ contentId: first });
      expect(ok(await req(alice, 'GET', '/whoami'))).toMatchObject({ username: 'alice', banned: true });
      ok(await send(bob, alice, 'Are you alright?'), 201);
      expect((await inbox(alice)).map((m) => m.text)).toContain('Are you alright?');
      ok(await req(alice, 'PATCH', `/users/${alice.userId}`, { messages: false }));
      ok(await req(alice, 'DELETE', `/content/${first}`), 202);
      // The refusal is hers alone.
      ok(await req(bob, 'POST', `/content/${bobs}/comments`, { text: 'Bob can' }), 201);
      ok(await like(bob, bobs), 201);
      ok(await like(bob, bobs, commentId), 201);
    });

    it('lets a user who is no longer banned do it all again, and tells them', async () => {
      const { root, mod, alice, bob } = await setup();
      const bobs = await post(bob, 'Open to comments #news', { comments: true });
      ok(await ban(mod, alice), 201);
      expect(await refused(storeText(alice, 'Not yet #news'))).toEqual([403, BANNED]);
      expect(await refused(unban(bob, alice))).toEqual([403, STAFF_ONLY]);
      expect(await refused(storeText(alice, 'Still not #news'))).toEqual([403, BANNED]);

      ctx.clock.now += 1000;
      expect(ok(await unban(root, alice))).toEqual({ userId: alice.userId, wasBanned: true });
      expect(ok(await req(alice, 'GET', '/whoami'))).toMatchObject({ banned: false });
      ok(await storeText(alice, 'Back again #news'), 201);
      const { commentId } = ok(await req(alice, 'POST', `/content/${bobs}/comments`, { text: 'Hello' }), 201);
      ok(await send(alice, bob, 'Hello'), 201);
      ok(await req(alice, 'POST', '/like', { contentId: bobs }), 201);
      ok(await req(alice, 'POST', '/like', { contentId: bobs, commentId }), 201);
      expect((await banned(mod)).banned).toEqual([]);
      expect((await inbox(alice)).map((m) => m.kind)).toEqual(['user_unbanned', 'user_banned']);

      // Nobody is told of a ban that wasn't there, and an unknown user isn't one to unban.
      expect(ok(await unban(root, alice))).toEqual({ userId: alice.userId, wasBanned: false });
      expect((await inbox(alice)).map((m) => m.kind)).toEqual(['user_unbanned', 'user_banned']);
      expect(ok(await unban(mod, NO_USER))).toEqual({ userId: NO_USER, wasBanned: false });
      // The same ban can be given again, with another reason this time.
      expect(ok(await ban(mod, alice, 'Again'), 201)).toMatchObject({ reason: 'Again', alreadyBanned: false });
    });

    it('bans neither oneself, nor an admin, nor a server moderator, nor a user who is not there', async () => {
      const { root, mod, alice } = await setup();
      expect(await refused(ban(mod, mod))).toEqual([400, "you can't ban yourself"]);
      expect(await refused(ban(root, root))).toEqual([400, "you can't ban yourself"]);
      const staff = "admins and server moderators can't be banned: end their role first";
      expect(await refused(ban(mod, root))).toEqual([403, staff]);
      expect(await refused(ban(root, mod))).toEqual([403, staff]);
      expect(await refused(ban(mod, NO_USER))).toEqual([404, 'user not found']);
      expect((await ban(mod, 'alice')).statusCode).toBe(400);
      expect((await banned(root)).banned).toEqual([]);

      // Once the role has ended, it can be.
      ok(await req(root, 'DELETE', `/moderators/${mod.userId}`));
      ok(await ban(root, mod), 201);
      expect(await refused(req(mod, 'GET', '/banned'))).toEqual([403, STAFF_ONLY]);
      expect((await banned(root)).banned.map((b) => b.username)).toEqual(['mod']);
      // A user who is banned can be made a moderator, but then holds a role that stops the ban being given again: the ban stays.
      ok(await ban(root, alice), 201);
      ok(await req(root, 'PUT', `/moderators/${alice.userId}`), 201);
      expect(await refused(ban(root, alice))).toEqual([403, staff]);
      expect((await banned(root)).banned.map((b) => b.username).sort()).toEqual(['alice', 'mod']);
    });

    it('pages the list of the banned', async () => {
      const { root, mod } = await setup();
      const users = [await ctx.register('carol'), await ctx.register('dave'), await ctx.register('erin')];
      for (const user of users) {
        ctx.clock.now += 1000;
        ok(await ban(mod, user), 201);
      }
      const first = await banned(root, '?limit=2');
      expect(first.banned.map((b) => b.username)).toEqual(['erin', 'dave']);
      expect(first.nextCursor).not.toBeNull();
      const second = await banned(root, `?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`);
      expect(second.banned.map((b) => b.username)).toEqual(['carol']);
      expect(second.nextCursor).toBeNull();
    });

    it('leaves a banned user able to delete their account, which takes them off the list, and does not hold it against whoever banned them', async () => {
      const { root, mod, alice, bob } = await setup();
      ok(await ban(mod, alice, 'Spam'), 201);
      ok(await ban(mod, bob, 'Spam'), 201);

      ok(await req(alice, 'DELETE', `/users/${alice.userId}`), 200);
      expect((await banned(root)).banned.map((b) => b.username)).toEqual(['bob']);
      expect(ok(await unban(root, alice))).toEqual({ userId: alice.userId, wasBanned: false });
      expect(await refused(ban(root, alice))).toEqual([404, 'user not found']);

      // Whoever banned bob goes, and the ban stays, with nobody to name.
      ok(await req(root, 'DELETE', `/moderators/${mod.userId}`));
      ok(await req(mod, 'DELETE', `/users/${mod.userId}`), 200);
      expect((await banned(root)).banned).toEqual([{ userId: bob.userId, username: 'bob', bannedAt: now(), reason: 'Spam', bannedBy: null }]);
      expect(ok(await req(bob, 'GET', '/whoami'))).toMatchObject({ banned: true });
    });

    it('keeps a banned user banned through a change of name, and still takes their name', async () => {
      const { mod, alice } = await setup();
      ok(await ban(mod, alice), 201);
      ok(await req(alice, 'PATCH', `/users/${alice.userId}`, { username: 'alicia' }));
      expect((await banned(mod)).banned.map((b) => b.username)).toEqual(['alicia']);
      expect((await req(null, 'POST', '/register', { username: 'alicia' })).statusCode).toBe(409);
    });
  });
}
