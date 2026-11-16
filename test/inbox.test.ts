import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { excerptOf, MAX_MESSAGE_CHARS } from '../src/inbox.js';
import { loadLanguages } from '../src/language.js';
import { setAdmin } from '../src/moderation/policy.js';
import { as, createTestContext, requests, TARGETS, type TestContext, type User } from './helpers.js';

const NO_USER = '00000000-0000-4000-8000-000000000000';
const NOT_TAKEN = "this user doesn't take messages from you";
const OWN_INBOX = 'you can only read and change your own inbox';

type Item = {
  messageId: string;
  kind: string;
  from?: { userId: string; username: string } | null;
  text: string;
  contentId?: string;
  tag?: string;
  excerpt?: string;
  sentAt: string;
  readAt: string | null;
};
type Inbox = { userId: string; unread: number; inbox: Item[]; nextCursor: string | null };

describe('inbox settings', () => {
  it('come from the environment', () => {
    const load = (env: Record<string, string> = {}) => loadConfig({}, { EVIEVERSE_CONFIG: '/nonexistent.json', ...env }).inbox;
    expect(load()).toEqual({ messagesPerMinute: 10, retentionDays: 90 });
    expect(load({ INBOX_MESSAGES_PER_MINUTE: '0', INBOX_RETENTION_DAYS: '7' })).toEqual({ messagesPerMinute: 0, retentionDays: 7 });
    expect(() => load({ INBOX_MESSAGES_PER_MINUTE: '-1' })).toThrow();
  });
});

describe('the excerpt of a post in a notice', () => {
  it('is the start of its text or caption, or its link, on one line', () => {
    expect(excerptOf({ preview: { kind: 'text', text: '  Hello\n\n  there  #news ' } })).toBe('Hello there #news');
    expect(excerptOf({ preview: { kind: 'link', url: 'https://example.com/a' } })).toBe('https://example.com/a');
    expect(excerptOf({ preview: { kind: 'image', url: 'https://example.com/a.png' } })).toBeNull();
    expect(excerptOf({ preview: { kind: 'image', url: 'https://example.com/a.png', text: 'A caption' } })).toBe('A caption');
    expect(excerptOf(null)).toBeNull();
    // Cut by character, not by half of one.
    const long = excerptOf({ preview: { kind: 'text', text: '😀'.repeat(300) } })!;
    expect([...long]).toHaveLength(200);
    expect(long).toBe(`${'😀'.repeat(199)}…`);
    expect(excerptOf({ preview: { kind: 'text', text: 'a'.repeat(200) } })).toBe('a'.repeat(200));
  });
});

for (const target of TARGETS) {
  describe(`inbox (${target.name})`, () => {
    let ctx: TestContext;
    let dir: string | undefined;
    afterEach(async () => {
      await ctx.close();
      if (dir) await rm(dir, { recursive: true, force: true });
      dir = undefined;
    });

    const { storeText: store } = requests(() => ctx);
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
    const admin = async (name = 'root') => {
      const u = await ctx.register(name);
      await setAdmin(ctx.db, name, true);
      return u;
    };
    /** Sends a message a second after whatever came before, so the inbox's order is the order sent. */
    const send = (from: User | null, to: User, text: string) => {
      ctx.clock.now += 1000;
      return req(from, 'POST', '/messages', { to: to.userId, text });
    };
    const inbox = async (u: User, query = ''): Promise<Inbox> => ok(await req(u, 'GET', `/users/${u.userId}/inbox${query}`));
    const texts = async (u: User, query = '') => (await inbox(u, query)).inbox.map((m) => m.text);
    /** A user's notices, oldest first, without their ids and times. */
    const notices = async (u: User) =>
      (await inbox(u)).inbox
        .filter((m) => m.kind !== 'message')
        .map(({ messageId: _id, sentAt: _sent, readAt: _read, ...notice }) => notice)
        .reverse();
    const setMessages = (u: User, messages: boolean) => req(u, 'PATCH', `/users/${u.userId}`, { messages });
    const block = (u: User, other: User | string) => req(u, 'PUT', `/users/${u.userId}/blocked/${typeof other === 'string' ? other : other.userId}`);
    const unblock = (u: User, other: User) => req(u, 'DELETE', `/users/${u.userId}/blocked/${other.userId}`);

    it('delivers a message from one user to another, who reads their inbox newest first', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      expect(await inbox(bob)).toEqual({ userId: bob.userId, unread: 0, inbox: [], nextCursor: null });

      const first = ok(await send(alice, bob, '  Hello Bob  '), 201);
      const firstAt = now();
      expect(first).toEqual({ messageId: expect.any(String), to: { userId: bob.userId, username: 'bob' }, sentAt: firstAt });
      const second = ok(await send(alice, bob, 'Are you there?'), 201);
      const secondAt = now();

      expect(await inbox(bob)).toEqual({
        userId: bob.userId,
        unread: 2,
        inbox: [
          { messageId: second.messageId, kind: 'message', from: { userId: alice.userId, username: 'alice' }, text: 'Are you there?', sentAt: secondAt, readAt: null },
          { messageId: first.messageId, kind: 'message', from: { userId: alice.userId, username: 'alice' }, text: 'Hello Bob', sentAt: firstAt, readAt: null },
        ],
        nextCursor: null,
      });
      // What a user sent isn't in their own inbox, and a reply is a message the other way.
      expect((await inbox(alice)).inbox).toEqual([]);
      ok(await send(bob, alice, 'Here!'), 201);
      expect(await texts(alice)).toEqual(['Here!']);
      // The sender is shown by the name they have now.
      ok(await req(alice, 'PATCH', `/users/${alice.userId}`, { username: 'alicia' }));
      expect((await inbox(bob)).inbox[0]!.from).toEqual({ userId: alice.userId, username: 'alicia' });
    });

    it('takes a message only from a user with a key, for a user there is, with a text of a size', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      expect((await send(null, bob, 'hi')).statusCode).toBe(401);
      expect((await send({ userId: alice.userId, apiKey: bob.apiKey }, bob, 'hi')).statusCode).toBe(401);
      expect(await refused(send(alice, alice, 'hi'))).toEqual([400, "you can't send yourself a message"]);
      expect(await refused(send(alice, { userId: NO_USER, apiKey: '' }, 'hi'))).toEqual([404, 'user not found']);
      expect((await send(alice, bob, '   ')).statusCode).toBe(400);
      expect((await send(alice, bob, 'a'.repeat(MAX_MESSAGE_CHARS + 1))).statusCode).toBe(400);
      expect((await req(alice, 'POST', '/messages', { to: 'bob', text: 'hi' })).statusCode).toBe(400);
      expect((await req(alice, 'POST', '/messages', { to: bob.userId })).statusCode).toBe(400);
      expect(await texts(bob)).toEqual([]);

      const longest = 'é'.repeat(MAX_MESSAGE_CHARS);
      ok(await send(alice, bob, longest), 201);
      expect(await texts(bob)).toEqual([longest]);
    });

    it("keeps an inbox its owner's: only they read it, mark it read and delete from it", async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const root = await admin();
      const { messageId } = ok(await send(alice, bob, 'Just for Bob'), 201);
      const url = `/users/${bob.userId}/inbox`;

      for (const u of [alice, root]) {
        expect(await refused(req(u, 'GET', url))).toEqual([403, OWN_INBOX]);
        expect(await refused(req(u, 'POST', `${url}/read`))).toEqual([403, OWN_INBOX]);
        expect(await refused(req(u, 'DELETE', `${url}/${messageId}`))).toEqual([403, OWN_INBOX]);
      }
      expect((await req(null, 'GET', url)).statusCode).toBe(401);
      expect((await req(null, 'POST', `${url}/read`)).statusCode).toBe(401);
      expect((await req(null, 'DELETE', `${url}/${messageId}`)).statusCode).toBe(401);
      // Nor does a user reach it through their own inbox.
      expect(ok(await req(alice, 'DELETE', `/users/${alice.userId}/inbox/${messageId}`))).toMatchObject({ wasThere: false });
      expect(ok(await req(alice, 'POST', `/users/${alice.userId}/inbox/read`, { messageIds: [messageId] }))).toMatchObject({ read: 0 });
      expect(await inbox(bob)).toMatchObject({ unread: 1, inbox: [{ messageId, text: 'Just for Bob', readAt: null }] });
    });

    it('marks messages as read, the ones named or all of them, and lists the unread or the read alone', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const ids: string[] = [];
      for (const text of ['one', 'two', 'three', 'four']) ids.push(ok(await send(alice, bob, text), 201).messageId);
      const url = `/users/${bob.userId}/inbox`;

      // Reading the list marks nothing.
      expect((await inbox(bob)).unread).toBe(4);
      expect((await inbox(bob)).unread).toBe(4);

      ctx.clock.now += 5000;
      const readAt = now();
      expect(ok(await req(bob, 'POST', `${url}/read`, { messageIds: [ids[0], ids[2], NO_USER] }))).toEqual({ userId: bob.userId, read: 2, unread: 2 });
      expect((await inbox(bob)).inbox.map((m) => [m.text, m.readAt])).toEqual([
        ['four', null],
        ['three', readAt],
        ['two', null],
        ['one', readAt],
      ]);
      expect(await texts(bob, '?unread=true')).toEqual(['four', 'two']);
      expect(await texts(bob, '?unread=false')).toEqual(['three', 'one']);
      // The count is of the whole inbox, whichever part is listed.
      expect((await inbox(bob, '?unread=false')).unread).toBe(2);
      expect((await req(bob, 'GET', `${url}?unread=maybe`)).statusCode).toBe(400);

      // What was read keeps the time it was read at.
      ctx.clock.now += 5000;
      expect(ok(await req(bob, 'POST', `${url}/read`, { messageIds: [ids[0]] }))).toEqual({ userId: bob.userId, read: 0, unread: 2 });
      expect(ok(await req(bob, 'POST', `${url}/read`))).toEqual({ userId: bob.userId, read: 2, unread: 0 });
      expect((await inbox(bob)).inbox.map((m) => m.readAt)).toEqual([now(), readAt, now(), readAt]);
      expect(await texts(bob, '?unread=true')).toEqual([]);
      expect((await req(bob, 'POST', `${url}/read`, { messageIds: [] })).statusCode).toBe(400);
      expect((await req(bob, 'POST', `${url}/read`, { messageIds: ['one'] })).statusCode).toBe(400);
    });

    it('deletes a message from the inbox, and pages through a long one', async () => {
      ctx = await createTestContext(target, { inbox: { messagesPerMinute: 0 } });
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const ids: string[] = [];
      for (let i = 1; i <= 5; i++) ids.push(ok(await send(alice, bob, `message ${i}`), 201).messageId);
      // Two sent in the same millisecond are still each on one page.
      ctx.clock.now += 1000;
      for (const text of ['twin a', 'twin b']) ok(await req(alice, 'POST', '/messages', { to: bob.userId, text }), 201);

      const url = `/users/${bob.userId}/inbox`;
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: Inbox = await inbox(bob, `?limit=3${cursor ? `&cursor=${cursor}` : ''}`);
        expect(page.unread).toBe(7);
        seen.push(...page.inbox.map((m) => m.text));
        cursor = page.nextCursor;
        pages++;
      } while (cursor);
      expect(pages).toBe(3);
      expect(seen.slice(0, 2).sort()).toEqual(['twin a', 'twin b']);
      expect(seen.slice(2)).toEqual(['message 5', 'message 4', 'message 3', 'message 2', 'message 1']);
      expect((await req(bob, 'GET', `${url}?limit=101`)).statusCode).toBe(400);
      expect((await req(bob, 'GET', `${url}?cursor=nonsense`)).statusCode).toBe(400);

      expect(ok(await req(bob, 'DELETE', `${url}/${ids[2]}`))).toEqual({ userId: bob.userId, messageId: ids[2], wasThere: true });
      expect(ok(await req(bob, 'DELETE', `${url}/${ids[2]}`))).toEqual({ userId: bob.userId, messageId: ids[2], wasThere: false });
      expect((await req(bob, 'DELETE', `${url}/not-an-id`)).statusCode).toBe(400);
      const left = await inbox(bob);
      expect(left.unread).toBe(6);
      expect(left.inbox.map((m) => m.text)).not.toContain('message 3');
      expect(left.inbox).toHaveLength(6);
    });

    it('lets a user turn messages off: they are sent none and send none, and still get notices', async () => {
      ctx = await createTestContext(target);
      const root = await admin();
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const whoami = async (u: User) => ok(await req(u, 'GET', '/whoami'));
      expect(await whoami(bob)).toMatchObject({ messages: true });
      ok(await send(alice, bob, 'before'), 201);

      expect(ok(await setMessages(bob, false))).toEqual({ userId: bob.userId, username: 'bob', language: 'en', messages: false, showFollowing: false, showFollowers: false });
      expect(await whoami(bob)).toMatchObject({ messages: false });
      expect(await whoami(alice)).toMatchObject({ messages: true });
      // It is theirs alone to change, and nobody else's to see.
      expect((await req(alice, 'PATCH', `/users/${bob.userId}`, { messages: true })).statusCode).toBe(403);
      expect((await req(bob, 'PATCH', `/users/${bob.userId}`, { messages: 'sometimes' })).statusCode).toBe(400);
      expect(ok(await req(null, 'GET', `/users/${bob.userId}`))).not.toHaveProperty('messages');

      expect(await refused(send(alice, bob, 'during'))).toEqual([403, NOT_TAKEN]);
      expect(await refused(send(root, bob, 'from an admin'))).toEqual([403, NOT_TAKEN]);
      expect(await refused(send(bob, alice, 'from bob'))).toEqual([403, 'you turned messages off: turn them on to send one']);
      // What was already there stays, and stays theirs to read.
      expect(await texts(bob)).toEqual(['before']);
      expect(await texts(alice)).toEqual([]);

      // Notices aren't messages between users.
      ok(await req(root, 'PUT', `/tags/news/muted/${bob.userId}`), 201);
      expect(await notices(bob)).toMatchObject([{ kind: 'tag_muted', tag: 'news' }]);

      // Changing something else leaves the setting as it is; turning it on again is all it takes.
      expect(ok(await req(bob, 'PATCH', `/users/${bob.userId}`, { username: 'robert' }))).toMatchObject({ username: 'robert', messages: false });
      expect(ok(await setMessages(bob, false))).toMatchObject({ messages: false });
      expect(ok(await setMessages(bob, true))).toMatchObject({ messages: true });
      ok(await send(alice, bob, 'after'), 201);
      ok(await send(bob, alice, 'back'), 201);
      expect((await texts(bob)).filter((t) => t === 'after' || t === 'before')).toEqual(['after', 'before']);
      expect(await texts(alice)).toEqual(['back']);
    });

    it('lets a user block another: no message goes between the two, and the blocked one is not told why', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const carol = await ctx.register('carol');
      ok(await send(alice, bob, 'before'), 201);

      const blockedAt = now();
      expect(ok(await block(bob, alice), 201)).toEqual({ userId: bob.userId, blockedId: alice.userId, blockedAt, alreadyBlocked: false });
      ctx.clock.now += 1000;
      expect(ok(await block(bob, alice))).toEqual({ userId: bob.userId, blockedId: alice.userId, blockedAt, alreadyBlocked: true });

      // Alice is told what she would be had Bob turned messages off; Bob, that the block is his.
      expect(await refused(send(alice, bob, 'during'))).toEqual([403, NOT_TAKEN]);
      expect(await refused(send(bob, alice, 'during'))).toEqual([403, 'you blocked this user: unblock them to send them a message']);
      ok(await setMessages(bob, false));
      expect(await refused(send(alice, bob, 'during'))).toEqual([403, NOT_TAKEN]);
      ok(await setMessages(bob, true));
      // Only the two of them: everyone else still writes to both, and both to everyone else.
      ok(await send(carol, bob, 'from carol'), 201);
      ok(await send(alice, carol, 'to carol'), 201);
      ok(await send(bob, carol, 'also to carol'), 201);
      // What was sent before the block stays.
      expect(await texts(bob)).toEqual(['from carol', 'before']);
      expect(await texts(alice)).toEqual([]);

      // A block each way takes both being ended.
      ok(await block(alice, bob), 201);
      expect(ok(await unblock(bob, alice))).toEqual({ userId: bob.userId, blockedId: alice.userId, wasBlocked: true });
      expect(ok(await unblock(bob, alice))).toEqual({ userId: bob.userId, blockedId: alice.userId, wasBlocked: false });
      expect(await refused(send(bob, alice, 'still not'))).toEqual([403, NOT_TAKEN]);
      expect((await send(alice, bob, 'still not')).statusCode).toBe(403);
      ok(await unblock(alice, bob));
      ok(await send(alice, bob, 'after'), 201);
      ok(await send(bob, alice, 'after too'), 201);
      expect(await texts(alice)).toEqual(['after too']);
    });

    it("keeps a block list its owner's, who reads it most recently blocked first", async () => {
      ctx = await createTestContext(target);
      const root = await admin();
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const carol = await ctx.register('carol');
      const url = `/users/${bob.userId}/blocked`;
      const OWN = 'you can only see and change whom you block yourself';

      expect(await refused(block(bob, bob))).toEqual([400, "you can't block yourself"]);
      expect(await refused(block(bob, NO_USER))).toEqual([404, 'user not found']);
      expect((await block(bob, 'alice')).statusCode).toBe(400);
      for (const u of [alice, root]) {
        expect(await refused(req(u, 'PUT', `${url}/${carol.userId}`))).toEqual([403, OWN]);
        expect(await refused(req(u, 'DELETE', `${url}/${carol.userId}`))).toEqual([403, OWN]);
        expect(await refused(req(u, 'GET', url))).toEqual([403, OWN]);
      }
      expect((await req(null, 'PUT', `${url}/${carol.userId}`)).statusCode).toBe(401);
      expect((await req(null, 'GET', url)).statusCode).toBe(401);
      expect(ok(await req(bob, 'GET', url))).toEqual({ userId: bob.userId, blocked: [], nextCursor: null });

      const aliceAt = now();
      ok(await block(bob, alice), 201);
      ctx.clock.now += 1000;
      const carolAt = now();
      ok(await block(bob, carol), 201);
      // An admin can be blocked like anyone, and blocking stops their messages, not their notices.
      ctx.clock.now += 1000;
      ok(await block(bob, root), 201);
      expect(ok(await req(bob, 'GET', url))).toEqual({
        userId: bob.userId,
        blocked: [
          { userId: root.userId, username: 'root', blockedAt: now() },
          { userId: carol.userId, username: 'carol', blockedAt: carolAt },
          { userId: alice.userId, username: 'alice', blockedAt: aliceAt },
        ],
        nextCursor: null,
      });
      const page = ok(await req(bob, 'GET', `${url}?limit=2`));
      expect(page.blocked.map((b: { username: string }) => b.username)).toEqual(['root', 'carol']);
      const rest = ok(await req(bob, 'GET', `${url}?limit=2&cursor=${page.nextCursor}`));
      expect([rest.blocked.map((b: { username: string }) => b.username), rest.nextCursor]).toEqual([['alice'], null]);
      // Whom Bob blocks is not whom they block.
      expect(ok(await req(alice, 'GET', `/users/${alice.userId}/blocked`)).blocked).toEqual([]);

      expect(await refused(send(root, bob, 'from an admin'))).toEqual([403, NOT_TAKEN]);
      ok(await req(root, 'PUT', `/tags/news/muted/${bob.userId}`), 201);
      expect(await notices(bob)).toMatchObject([{ kind: 'tag_muted', tag: 'news' }]);
    });

    it('limits how many messages a user sends a minute, counting only the ones that were sent', async () => {
      ctx = await createTestContext(target, { inbox: { messagesPerMinute: 2 } });
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const carol = await ctx.register('carol');
      ok(await block(carol, alice), 201);
      const say = (from: User, to: User, text: string) => req(from, 'POST', '/messages', { to: to.userId, text });

      // Refused messages don't count.
      for (let i = 0; i < 3; i++) expect((await say(alice, carol, 'refused')).statusCode).toBe(403);
      ok(await say(alice, bob, 'one'), 201);
      ok(await say(alice, bob, 'two'), 201);
      const limited = await say(alice, bob, 'three');
      expect([limited.statusCode, limited.json(), limited.headers['retry-after']]).toEqual([
        429,
        { error: 'too many messages; try again in 60 seconds', retryAfterSeconds: 60 },
        '60',
      ]);
      // Each user has their own count.
      ok(await say(bob, alice, 'reply'), 201);

      ctx.clock.now += 59_000;
      expect(await refused(say(alice, bob, 'three'))).toEqual([429, 'too many messages; try again in 1 second']);
      ctx.clock.now += 1001;
      ok(await say(alice, bob, 'three'), 201);
      expect((await texts(bob)).sort()).toEqual(['one', 'three', 'two']);
    });

    it('tells a user when they are muted on a hashtag, and when the mute ends: once each', async () => {
      ctx = await createTestContext(target);
      const root = await admin();
      const mod = await ctx.register('mod');
      const bob = await ctx.register('bob');
      ok(await req(root, 'PUT', `/tags/news/moderators/${mod.userId}`), 201);
      const muted = "A moderator muted you on #news: your new posts and updates don't get that hashtag.";

      ok(await req(mod, 'PUT', `/tags/news/muted/${bob.userId}`), 201);
      const mutedAt = now();
      expect(await inbox(bob)).toEqual({
        userId: bob.userId,
        unread: 1,
        inbox: [{ messageId: expect.any(String), kind: 'tag_muted', tag: 'news', text: muted, sentAt: mutedAt, readAt: null }],
        nextCursor: null,
      });
      // Muted again, they aren't told again; nor is a user told of a mute that wasn't there to end.
      ctx.clock.now += 1000;
      ok(await req(root, 'PUT', `/tags/news/muted/${bob.userId}`));
      expect(ok(await req(root, 'DELETE', `/tags/sports/muted/${bob.userId}`))).toMatchObject({ wasMuted: false });
      expect(await notices(bob)).toHaveLength(1);

      ctx.clock.now += 1000;
      expect(ok(await req(root, 'DELETE', `/tags/news/muted/${bob.userId}`))).toMatchObject({ wasMuted: true });
      expect(ok(await req(root, 'DELETE', `/tags/news/muted/${bob.userId}`))).toMatchObject({ wasMuted: false });
      expect(await notices(bob)).toEqual([
        { kind: 'tag_muted', tag: 'news', text: muted },
        { kind: 'tag_unmuted', tag: 'news', text: 'You are no longer muted on #news.' },
      ]);

      // Notices are read and deleted as messages are, and nobody is told of what they did themselves.
      const url = `/users/${bob.userId}/inbox`;
      expect(ok(await req(bob, 'POST', `${url}/read`))).toMatchObject({ read: 2, unread: 0 });
      const [latest] = (await inbox(bob)).inbox;
      expect(ok(await req(bob, 'DELETE', `${url}/${latest!.messageId}`))).toMatchObject({ wasThere: true });
      expect(await notices(bob)).toMatchObject([{ kind: 'tag_muted' }]);
      ok(await req(mod, 'PUT', `/tags/news/muted/${mod.userId}`), 201);
      ok(await req(mod, 'DELETE', `/tags/news/muted/${mod.userId}`));
      expect(await notices(mod)).toEqual([]);
      expect(await notices(root)).toEqual([]);
    });

    it('tells a publisher when a moderator removes a hashtag from their post, and of the mute or deletion it brings', async () => {
      ctx = await createTestContext(target);
      const root = await admin();
      const mod = await ctx.register('mod');
      const alice = await ctx.register('alice');
      ok(await req(root, 'PUT', `/tags/news/moderators/${mod.userId}`), 201);
      const removed = "A moderator removed #news from your post. Updates of the post don't get it back.";

      const two = 'Two   hashtags\n here #news #sports';
      const { contentId } = ok(await store(alice, two), 201);
      // An approval isn't something to report.
      ok(await req(mod, 'PUT', `/content/${contentId}/tags/news`), 201);
      expect(await notices(alice)).toEqual([]);

      ok(await req(mod, 'DELETE', `/content/${contentId}/tags/news`));
      expect(await notices(alice)).toEqual([{ kind: 'tag_removed', contentId, tag: 'news', excerpt: 'Two hashtags here #news #sports', text: removed }]);

      // The last hashtag takes the post out of hashtag feeds, and with `mute` the publisher is told of that too.
      ctx.clock.now += 1000;
      ok(await req(root, 'DELETE', `/content/${contentId}/tags/sports`, { mute: true }), 200);
      // The two are of the same moment, so in either order.
      const byKind = (a: { kind: string }, b: { kind: string }) => a.kind.localeCompare(b.kind);
      expect((await notices(alice)).slice(1).sort(byKind)).toEqual([
        {
          kind: 'last_tag_removed',
          contentId,
          tag: 'sports',
          excerpt: 'Two hashtags here #news #sports',
          text: "A moderator removed #sports from your post. It was the post's last hashtag, so the post is in no hashtag's feed any more. It can still be read, and those who follow you still see it.",
        },
        { kind: 'tag_muted', tag: 'sports', text: "A moderator muted you on #sports: your new posts and updates don't get that hashtag." },
      ]);
      expect((await inbox(alice)).unread).toBe(3);

      // Already muted, a removal with `mute` tells them of the removal alone.
      ctx.clock.now += 1000;
      const other = ok(await store(alice, 'Another #news #tech'), 201).contentId;
      ok(await req(root, 'PUT', `/tags/tech/muted/${alice.userId}`), 201);
      const before = (await notices(alice)).length;
      ctx.clock.now += 1000;
      ok(await req(root, 'DELETE', `/content/${other}/tags/tech`, { mute: true }));
      expect((await notices(alice)).slice(before)).toMatchObject([{ kind: 'tag_removed', contentId: other, tag: 'tech' }]);

      // A moderator who takes a hashtag off their own post tells nobody.
      const own = ok(await store(mod, 'My own #news #sports'), 201).contentId;
      ok(await req(mod, 'DELETE', `/content/${own}/tags/news`));
      expect(await notices(mod)).toEqual([]);

      // The post is still there, with no hashtag, and its publisher can delete it. The notices outlast it.
      await ctx.compact();
      expect(ok(await req(null, 'GET', `/content/${contentId}`), 200).tags).toEqual([]);
      ok(await req(alice, 'DELETE', `/content/${contentId}`), 202);
      for (let i = 0; i < 3; i++) await ctx.compact();
      expect((await req(null, 'GET', `/content/${contentId}`)).statusCode).toBe(404);
      expect(await notices(alice)).toContainEqual(expect.objectContaining({ kind: 'last_tag_removed', contentId, excerpt: 'Two hashtags here #news #sports' }));
    });

    it('tells a publisher what became of their post in the moderation queue', async () => {
      ctx = await createTestContext(target, { trust: { deleteBelow: 0 } });
      const root = await admin();
      const alice = await ctx.register('alice');
      ok(await req(root, 'POST', '/moderation/blocked-words', { words: ['spam'] }));

      const accepted = ok(await store(alice, 'Good spam #news'), 202).contentId;
      const rejected = ok(await store(alice, 'Bad spam #news'), 202).contentId;
      // A post held for review is answered so, not reported.
      expect(await notices(alice)).toEqual([]);

      ok(await req(root, 'POST', `/moderation/queue/${accepted}/accept`));
      ctx.clock.now += 1000;
      ok(await req(root, 'POST', `/moderation/queue/${rejected}/reject`), 202);
      expect(await notices(alice)).toEqual([
        { kind: 'post_accepted', contentId: accepted, excerpt: 'Good spam #news', text: 'Your post was accepted from the moderation queue, and is published.' },
        { kind: 'post_rejected', contentId: rejected, excerpt: 'Bad spam #news', text: 'Your post was rejected from the moderation queue, and deleted.' },
      ]);
      // A decision that can't be made twice isn't reported twice.
      expect((await req(root, 'POST', `/moderation/queue/${accepted}/accept`)).statusCode).not.toBe(200);
      expect((await req(root, 'POST', `/moderation/queue/${rejected}/reject`)).statusCode).not.toBe(202);
      expect(await notices(alice)).toHaveLength(2);

      // An admin's own held post, accepted by themselves, is no news to them.
      const own = ok(await store(root, 'My spam #news'), 202).contentId;
      ok(await req(root, 'POST', `/moderation/queue/${own}/accept`));
      expect(await notices(root)).toEqual([]);
    });

    it('tells a publisher when an admin deletes their post, not when they delete it themselves', async () => {
      ctx = await createTestContext(target);
      const root = await admin();
      const alice = await ctx.register('alice');
      const mine = ok(await store(alice, 'Deleted by me #news'), 201).contentId;
      const theirs = ok(await store(alice, 'Deleted by an admin #news'), 201).contentId;
      const link = ok(await ctx.app.inject({ method: 'POST', url: '/store', payload: { ...alice, type: 'link', url: 'https://example.com/story', tags: ['news'] } }), 201).contentId;

      ok(await req(alice, 'DELETE', `/content/${mine}`), 202);
      expect(await notices(alice)).toEqual([]);

      ok(await req(root, 'DELETE', `/content/${theirs}`), 202);
      const deleted = { kind: 'post_deleted', contentId: theirs, excerpt: 'Deleted by an admin #news', text: 'An admin deleted your post.' };
      expect(await notices(alice)).toEqual([deleted]);
      // Deleting what is already set for deletion reports nothing more, whoever asks.
      ok(await req(root, 'DELETE', `/content/${theirs}`), 202);
      ok(await req(root, 'DELETE', `/content/${mine}`), 202);
      expect(await notices(alice)).toEqual([deleted]);

      // A link is quoted by its URL.
      ctx.clock.now += 1000;
      ok(await req(root, 'DELETE', `/content/${link}`), 202);
      expect((await notices(alice))[1]).toMatchObject({ kind: 'post_deleted', contentId: link, excerpt: 'https://example.com/story' });
    });

    it("says a notice in its reader's language, whichever it was when the notice was left", async () => {
      dir = await mkdtemp(join(tmpdir(), 'evieverse-languages-'));
      await copyFile(fileURLToPath(new URL('../languages/en.json', import.meta.url)), join(dir, 'en.json'));
      const spanish = { name: 'Español', messages: { 'notice.tag_muted': 'Un moderador te silenció en #{tag}.', 'inbox.own_only': 'solo puedes leer tu propio buzón' } };
      await writeFile(join(dir, 'es.json'), JSON.stringify(spanish));
      ctx = await createTestContext(target, { languages: loadLanguages('en', dir) });
      const root = await admin();
      const ana = await ctx.register('ana');
      ok(await req(root, 'PUT', `/tags/news/muted/${ana.userId}`), 201);
      ctx.clock.now += 1000;
      ok(await req(root, 'DELETE', `/tags/news/muted/${ana.userId}`));
      expect((await notices(ana)).map((n) => n.text)).toEqual([expect.stringMatching(/^A moderator muted you on #news/), 'You are no longer muted on #news.']);

      ok(await req(ana, 'PATCH', `/users/${ana.userId}`, { language: 'es' }));
      // What the language doesn't have is said in the server's.
      expect((await notices(ana)).map((n) => n.text)).toEqual(['Un moderador te silenció en #news.', 'You are no longer muted on #news.']);
      expect(await refused(req(ana, 'GET', `/users/${root.userId}/inbox`))).toEqual([403, 'solo puedes leer tu propio buzón']);
    });

    it('deletes what has been in an inbox past its retention, once a day, read or not', async () => {
      ctx = await createTestContext(target, { inbox: { retentionDays: 3 } });
      const root = await admin();
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const DAY = 86_400_000;

      ok(await send(alice, bob, 'old'), 201);
      ok(await req(root, 'PUT', `/tags/news/muted/${bob.userId}`), 201);
      ok(await req(bob, 'POST', `/users/${bob.userId}/inbox/read`));
      ctx.clock.now += 2 * DAY;
      ok(await send(alice, bob, 'newer'), 201);
      await ctx.compact();
      expect((await inbox(bob)).inbox).toHaveLength(3);

      // Past three days for the first two, not for the third.
      ctx.clock.now += 1.5 * DAY;
      await ctx.compact();
      expect(await inbox(bob)).toMatchObject({ unread: 1, inbox: [{ text: 'newer' }] });

      ctx.clock.now += 2 * DAY;
      await ctx.compact();
      expect(await inbox(bob)).toEqual({ userId: bob.userId, unread: 0, inbox: [], nextCursor: null });
    });
  });
}
