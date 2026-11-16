import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { setAdmin } from '../src/moderation/policy.js';
import { routeOf } from '../src/moderation/trust.js';
import { as, createTestContext, queued, requests, TARGETS, type Feed, type TestContext, type User } from './helpers.js';

const NO_CONTENT = '00000000-0000-4000-8000-000000000000';
const REFUSED = "the post contains a word or phrase this server doesn't allow, so it wasn't published";
const NOT_QUEUED = 'the content is not in the moderation queue';

describe('trust scores', () => {
  it('send a post by the thresholds', () => {
    const defaults = { deleteBelow: 25, allowFrom: 75 };
    expect([0, 24, 25, 74, 75, 100].map((score) => routeOf(score, defaults))).toEqual(['delete', 'delete', 'queue', 'queue', 'allow', 'allow']);
    // Nothing is deleted on arrival; everything waits; nothing waits.
    expect(routeOf(0, { deleteBelow: 0, allowFrom: 75 })).toBe('queue');
    expect(routeOf(100, { deleteBelow: 0, allowFrom: 101 })).toBe('queue');
    expect(routeOf(0, { deleteBelow: 0, allowFrom: 0 })).toBe('allow');
    expect([49, 50].map((score) => routeOf(score, { deleteBelow: 50, allowFrom: 50 }))).toEqual(['delete', 'allow']);
  });

  it('take their thresholds from the environment, which must leave them in order', () => {
    const load = (env: Record<string, string> = {}) => loadConfig({}, { EVIEVERSE_CONFIG: '/nonexistent.json', ...env }).trust;
    expect(load()).toEqual({ deleteBelow: 25, allowFrom: 75 });
    expect(load({ TRUST_SCORE_DELETE_BELOW: '0', TRUST_SCORE_ALLOW_FROM: '101' })).toEqual({ deleteBelow: 0, allowFrom: 101 });
    expect(load({ TRUST_SCORE_DELETE_BELOW: '75' })).toEqual({ deleteBelow: 75, allowFrom: 75 });
    expect(() => load({ TRUST_SCORE_DELETE_BELOW: '76' })).toThrow(/TRUST_SCORE_DELETE_BELOW can be at most TRUST_SCORE_ALLOW_FROM/);
    expect(() => load({ TRUST_SCORE_ALLOW_FROM: '102' })).toThrow();
    expect(() => load({ TRUST_SCORE_DELETE_BELOW: '-1' })).toThrow();
  });
});

for (const target of TARGETS) {
  describe(`moderation queues (${target.name})`, () => {
    let ctx: TestContext;
    afterEach(() => ctx.close());

    const { storeText: store, feed, feedItems: feedOf, like } = requests(() => ctx);
    const req = (u: User | null, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
      ctx.app.inject({ method, url, headers: u ? as(u) : {}, ...(payload && { payload }) });
    const ok = (res: LightMyRequestResponse, status = 201) => {
      expect(res.statusCode, res.body).toBe(status);
      return res.json();
    };
    const now = () => new Date(ctx.clock.now).toISOString();
    const admin = async (name = 'admin') => {
      const u = await ctx.register(name);
      await setAdmin(ctx.db, name, true);
      return u;
    };
    const ids = (items: { contentId: string }[]) => items.map((i) => i.contentId);
    const records = (f: Feed, tag: string) => f.tags[tag] ?? [];
    /** The server's moderation queue, as an admin reads it. */
    const queue = async (u: User, query = '') => ok(await req(u, 'GET', `/moderation/queue${query}`), 200);
    const decide = (u: User | null, contentId: string, decision: 'accept' | 'reject') => req(u, 'POST', `/moderation/queue/${contentId}/${decision}`);
    /** Whether each record of a hashtag's feed is flagged as moderated there. */
    const flagsOf = async (tag: string, query = '') => Object.fromEntries(records(await feed(`tags=${tag}${query}`), tag).map((i) => [i.contentId, i.moderated]));
    /** Runs the compactor until it has deleted what was set for deletion. */
    const deletedBy = async (runs: number) => {
      const deleted: string[] = [];
      for (let i = 0; i < runs; i++) deleted.push(...(await ctx.compact()).deleted);
      return deleted;
    };

    it('holds a post whose trust score is between the thresholds: stored, but published only once an admin accepts it', async () => {
      ctx = await createTestContext(target, { trust: { deleteBelow: 0 } });
      const root = await admin();
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      ok(await req(root, 'POST', '/moderation/blocked-words', { words: ['spam'] }), 200);
      ok(await req(bob, 'PUT', `/users/${bob.userId}/following/${alice.userId}`));
      const following = async () => ids(ok(await req(bob, 'GET', `/feed/following?userId=${bob.userId}`), 200).records).sort();

      const fine = ok(await store(alice, 'An honest post #news'));
      expect(fine).not.toHaveProperty('status');
      ctx.clock.now += 1000;
      const queuedAt = now();
      const text = 'Free SPAM inside #news #deals';
      const held = ok(await store(alice, text), 202);
      expect(held).toEqual({ contentId: expect.any(String), status: 'pending_review', tags: ['news', 'deals'], preview: { kind: 'text', text }, aiGenerated: false, comments: false });
      const { contentId } = held;

      // It is stored, with its score, and in no feed: nothing is queued for the compactor to put it in one.
      expect(await ctx.db.selectFrom('moderation_queue').selectAll().execute()).toEqual([{ content_id: contentId, trust_score: 0, created_at: ctx.clock.now }]);
      expect((await queued(ctx)).filter((row) => row.startsWith(contentId))).toEqual([]);
      await ctx.compactor.runOnce();
      expect(ids(await feedOf('news'))).toEqual([fine.contentId]);
      expect(await feedOf('deals')).toEqual([]);
      expect(await following()).toEqual([fine.contentId]);

      // Only its publisher and admins can read it; to anyone else it isn't there, nor to a hashtag's moderators.
      for (const u of [null, bob, { userId: alice.userId, apiKey: bob.apiKey }]) {
        expect((await req(u, 'GET', `/content/${contentId}`)).statusCode).toBe(404);
        expect((await req(u, 'GET', `/content/${contentId}/raw`)).statusCode).toBe(404);
      }
      for (const u of [alice, root]) {
        expect(ok(await req(u, 'GET', `/content/${contentId}`), 200)).toMatchObject({ contentId, status: 'pending_review', text, tags: ['news', 'deals'] });
        expect((await req(u, 'GET', `/content/${contentId}/raw`)).body).toBe(text);
      }
      expect(ok(await req(null, 'GET', `/content/${fine.contentId}`), 200)).not.toHaveProperty('status');
      expect((await like(bob, contentId)).statusCode).toBe(404);
      expect((await req(root, 'PUT', `/content/${contentId}/tags/news`)).statusCode).toBe(404);
      expect((await req(root, 'DELETE', `/content/${contentId}/tags/news`)).statusCode).toBe(404);

      // Admins read the queue.
      expect((await req(null, 'GET', '/moderation/queue')).statusCode).toBe(401);
      expect((await req(alice, 'GET', '/moderation/queue')).statusCode).toBe(403);
      const record = {
        kind: 'post',
        contentId,
        publisher: { userId: alice.userId, username: 'alice' },
        mimeType: 'text/plain',
        aiGenerated: false,
        comments: false,
        preview: { kind: 'text', text },
        tags: ['news', 'deals'],
        likes: 0,
        createdAt: queuedAt,
        updatedAt: queuedAt,
        text,
        trustScore: 0,
        queuedAt,
      };
      expect(await queue(root)).toEqual({ queue: [record], nextCursor: null });

      // Sent again as it is, it stays as it is. Updated, it keeps its place in the queue, before what came after it.
      expect(ok(await store(alice, text, { contentId }), 200)).toEqual({ contentId, unchanged: true, status: 'pending_review' });
      ctx.clock.now += 1000;
      const later = ok(await store(bob, 'More spam #news'), 202).contentId;
      expect((await req(alice, 'GET', `/content/${later}`)).statusCode).toBe(404);
      ctx.clock.now += 1000;
      const updatedAt = now();
      const updated = 'Free spam inside, really #news #deals';
      expect(ok(await store(alice, updated, { contentId }), 202)).toMatchObject({ contentId, status: 'pending_review' });
      const page1 = await queue(root, '?limit=1');
      expect(page1.queue).toEqual([{ ...record, preview: { kind: 'text', text: updated }, text: updated, updatedAt }]);
      expect(page1.nextCursor).toBeTruthy();
      const page2 = await queue(root, `?limit=1&cursor=${page1.nextCursor}`);
      expect([ids(page2.queue), page2.nextCursor]).toEqual([[later], null]);
      expect((await req(root, 'GET', '/moderation/queue?limit=101')).statusCode).toBe(400);

      // No compactor run publishes it, whatever the run rebuilds.
      await ctx.compact();
      ctx.clock.now += 1000;
      await ctx.compactor.runOnce({ all: true, rebuild: true });
      expect(ids(await feedOf('news'))).toEqual([fine.contentId]);
      expect(await feedOf('deals')).toEqual([]);
      expect(await following()).toEqual([fine.contentId]);

      // An admin accepts it: it is published, under its hashtags, as posted when it was sent, and in feeds
      // after the compactor's next run like any post.
      for (const u of [alice, bob]) expect((await decide(u, contentId, 'accept')).statusCode).toBe(403);
      expect((await decide(null, contentId, 'accept')).statusCode).toBe(401);
      expect((await decide(root, NO_CONTENT, 'accept')).statusCode).toBe(404);
      expect((await decide(root, fine.contentId, 'accept')).json().error).toBe(NOT_QUEUED);
      ctx.clock.now += 1000;
      expect(ok(await decide(root, contentId, 'accept'), 200)).toEqual({ contentId, status: 'published', tags: ['news', 'deals'] });
      expect(ok(await req(null, 'GET', `/content/${contentId}`), 200)).not.toHaveProperty('status');
      expect(await queued(ctx)).toEqual([`@${alice.userId}`, 'deals', 'news'].map((tag) => `${contentId} ${tag}`).sort());
      expect(await feedOf('deals')).toEqual([]);
      await ctx.compactor.runOnce();
      expect(await feedOf('deals')).toEqual([
        {
          contentId,
          publisher: { userId: alice.userId, username: 'alice' },
          mimeType: 'text/plain',
          aiGenerated: false,
          comments: false,
          preview: { kind: 'text', text: updated },
          tags: ['news', 'deals'],
          likes: 0,
          moderated: false,
          createdAt: queuedAt,
          updatedAt,
        },
      ]);
      expect(ids(await feedOf('news')).sort()).toEqual([fine.contentId, contentId].sort());
      expect(await following()).toEqual([fine.contentId, contentId].sort());
      expect(ok(await req(null, 'GET', `/content/${contentId}`), 200)).not.toHaveProperty('status');
      expect((await decide(root, contentId, 'accept')).json().error).toBe(NOT_QUEUED);
      expect((await decide(root, contentId, 'reject')).json().error).toBe(NOT_QUEUED);
      expect(ids((await queue(root)).queue)).toEqual([later]);
      expect(ok(await like(bob, contentId))).toMatchObject({ likes: 1 });
      await ctx.compact();
      expect((await feedOf('deals')).map((i) => [i.contentId, i.likes])).toEqual([[contentId, 1]]);
      expect(await queued(ctx)).toEqual([]);

      // An admin rejects the other: it is deleted.
      expect((await decide(alice, later, 'reject')).statusCode).toBe(403);
      expect(ok(await decide(root, later, 'reject'), 202)).toEqual({ contentId: later, status: 'pending_deletion', requestedAt: now() });
      expect(await queue(root)).toEqual({ queue: [], nextCursor: null });
      expect((await req(bob, 'GET', `/content/${later}`)).statusCode).toBe(404);
      expect((await decide(root, later, 'accept')).statusCode).toBe(404);
      expect(await deletedBy(2)).toEqual([later]);
      expect(await ctx.db.selectFrom('moderation_queue').selectAll().execute()).toEqual([]);
      expect(await ctx.content.getMeta(later)).toBeNull();
    });

    it("lets a server moderator, whom admins appoint, work through the moderation queue, and do nothing else of an admin's", async () => {
      ctx = await createTestContext(target, { trust: { deleteBelow: 0 } });
      const root = await admin();
      const mod = await ctx.register('mod');
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      ok(await req(root, 'POST', '/moderation/blocked-words', { words: ['spam'] }), 200);
      const moderators = async () => ok(await req(root, 'GET', '/moderators'), 200).moderators;
      const profile = async (u: User) => ok(await req(null, 'GET', `/users/${u.userId}`), 200);
      const whoami = async (u: User) => ok(await req(u, 'GET', '/whoami'), 200);
      const NOT_A_MODERATOR = 'only an admin or a server moderator can do this';

      // Only admins appoint them, and list them: not they themselves.
      for (const [method, url] of [['GET', '/moderators'], ['PUT', `/moderators/${mod.userId}`], ['DELETE', `/moderators/${mod.userId}`]] as const) {
        expect((await req(null, method, url)).statusCode).toBe(401);
        expect((await req(mod, method, url)).statusCode).toBe(403);
      }
      expect(await moderators()).toEqual([]);
      expect(await profile(mod)).toMatchObject({ admin: false, moderator: false });
      expect(ok(await req(root, 'PUT', `/moderators/${mod.userId}`))).toEqual({ userId: mod.userId, username: 'mod', alreadyModerator: false });
      expect(ok(await req(root, 'PUT', `/moderators/${mod.userId}`), 200)).toMatchObject({ alreadyModerator: true });
      expect((await req(root, 'PUT', `/moderators/${NO_CONTENT}`)).statusCode).toBe(404);
      expect((await req(root, 'PUT', '/moderators/mod')).statusCode).toBe(400);
      expect(await moderators()).toEqual([{ userId: mod.userId, username: 'mod' }]);
      expect(await profile(mod)).toMatchObject({ admin: false, moderator: true, moderates: [] });
      expect(await whoami(mod)).toEqual({ userId: mod.userId, username: 'mod', language: 'en', admin: false, moderator: true, moderates: [], messages: true, showFollowing: false, showFollowers: false, banned: false });
      // An admin isn't one, and doesn't need to be.
      expect(await profile(root)).toMatchObject({ admin: true, moderator: false });
      expect((await req(mod, 'GET', '/moderators')).statusCode).toBe(403);

      // The queue is theirs to read, and so is the content that waits in it.
      const text = 'Free spam #news';
      const held = ok(await store(alice, text), 202).contentId;
      ctx.clock.now += 1000;
      const other = ok(await store(alice, 'More spam #news'), 202).contentId;
      ctx.clock.now += 1000;
      const third = ok(await store(alice, 'Yet more spam #news'), 202).contentId;
      expect(ids((await queue(mod)).queue)).toEqual([held, other, third]);
      expect((await queue(mod)).queue[0]).toMatchObject({ contentId: held, text, trustScore: 0 });
      expect(ok(await req(mod, 'GET', `/content/${held}`), 200)).toMatchObject({ contentId: held, status: 'pending_review', text });
      expect((await req(mod, 'GET', `/content/${held}/raw`)).body).toBe(text);
      expect((await req(bob, 'GET', `/content/${held}`)).statusCode).toBe(404);

      // They accept and reject what waits there, as an admin does; what is published is not theirs to reject.
      expect(ok(await decide(mod, held, 'accept'), 200)).toEqual({ contentId: held, status: 'published', tags: ['news'] });
      await ctx.compactor.runOnce();
      expect(ids(await feedOf('news'))).toEqual([held]);
      expect(ok(await decide(mod, other, 'reject'), 202)).toEqual({ contentId: other, status: 'pending_deletion', requestedAt: now() });
      expect((await decide(mod, held, 'reject')).json().error).toBe(NOT_QUEUED);
      expect(ids((await queue(mod)).queue)).toEqual([third]);
      expect(ids((await queue(root)).queue)).toEqual([third]);

      // Nothing else that takes an admin, or a hashtag's moderator.
      const published = ok(await store(bob, 'An honest post #news')).contentId;
      const notTheirs: [method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>][] = [
        ['DELETE', `/content/${published}`],
        ['DELETE', `/content/${third}`],
        ['GET', '/moderation/blocked-words'],
        ['POST', '/moderation/blocked-words', { words: ['honest'] }],
        ['GET', '/admins'],
        ['PUT', `/admins/${mod.userId}`],
        ['DELETE', `/admins/${root.userId}`],
        ['PUT', `/tags/news/moderators/${mod.userId}`],
        ['PUT', `/content/${published}/tags/news`],
        ['DELETE', `/content/${published}/tags/news`],
        ['GET', '/tags/news/muted'],
        ['POST', '/tags/news/blocked-words', { words: ['honest'] }],
      ];
      for (const [method, url, payload] of notTheirs) expect((await req(mod, method, url, payload)).statusCode, `${method} ${url}`).toBe(403);
      await ctx.compactor.runOnce();
      expect(ids(await feedOf('news')).sort()).toEqual([held, published].sort());

      // No longer one: the queue is closed to them at once, and what they decided stays decided.
      expect(ok(await req(root, 'DELETE', `/moderators/${mod.userId}`), 200)).toEqual({ userId: mod.userId, wasModerator: true });
      expect(ok(await req(root, 'DELETE', `/moderators/${mod.userId}`), 200)).toEqual({ userId: mod.userId, wasModerator: false });
      expect(ok(await req(root, 'DELETE', `/moderators/${NO_CONTENT}`), 200)).toEqual({ userId: NO_CONTENT, wasModerator: false });
      expect(await moderators()).toEqual([]);
      expect(await whoami(mod)).toMatchObject({ admin: false, moderator: false });
      const closed = await req(mod, 'GET', '/moderation/queue');
      expect([closed.statusCode, closed.json().error]).toEqual([403, NOT_A_MODERATOR]);
      for (const decision of ['accept', 'reject'] as const) {
        const refused = await decide(mod, third, decision);
        expect([refused.statusCode, refused.json().error]).toEqual([403, NOT_A_MODERATOR]);
      }
      expect((await req(mod, 'GET', `/content/${third}`)).statusCode).toBe(404);
      expect(ids(await feedOf('news')).sort()).toEqual([held, published].sort());
      expect(ids((await queue(root)).queue)).toEqual([third]);

      // The two roles are apart: an admin who is one too is still one once no longer an admin.
      ok(await req(root, 'PUT', `/moderators/${mod.userId}`));
      await setAdmin(ctx.db, 'mod', true);
      expect(await whoami(mod)).toMatchObject({ admin: true, moderator: true });
      await setAdmin(ctx.db, 'mod', false);
      expect(await whoami(mod)).toMatchObject({ admin: false, moderator: true });
      expect((await req(mod, 'GET', '/admins')).statusCode).toBe(403);
      expect(ok(await decide(mod, third, 'accept'), 200)).toMatchObject({ contentId: third, status: 'published' });
      expect(await queue(root)).toEqual({ queue: [], nextCursor: null });
    });

    it('holds a comment as it holds a post, in the same queue, where a server moderator or an admin accepts it or rejects it', async () => {
      ctx = await createTestContext(target, { trust: { deleteBelow: 0 } });
      const root = await admin();
      const mod = await ctx.register('mod');
      ok(await req(root, 'PUT', `/moderators/${mod.userId}`));
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const carol = await ctx.register('carol');
      ok(await req(root, 'POST', '/moderation/blocked-words', { words: ['spam'] }), 200);
      const NO_COMMENT = 'comment not found';
      const COMMENT_NOT_QUEUED = 'the comment is not in the moderation queue';
      const comment = (u: User, contentId: string, text: string) => req(u, 'POST', `/content/${contentId}/comments`, { text });
      const listed = async (contentId: string, query = '') => ok(await req(null, 'GET', `/content/${contentId}/comments${query}`), 200);
      const one = (u: User | null, contentId: string, commentId: string) => req(u, 'GET', `/content/${contentId}/comments/${commentId}`);
      const decideOn = (u: User | null, contentId: string, commentId: string, decision: 'accept' | 'reject') =>
        req(u, 'POST', `/moderation/queue/${contentId}/comments/${commentId}/${decision}`);
      const refusal = (res: LightMyRequestResponse) => [res.statusCode, res.json().error];
      /** What waits in the queue, in its order: each item's kind and id. */
      const waiting = (page: { queue: { kind: string; contentId: string; commentId?: string }[] }) => page.queue.map((i) => [i.kind, i.commentId ?? i.contentId]);
      const rows = async () => (await ctx.db.selectFrom('comment_queue').select('comment_id').execute()).map((r) => r.comment_id).sort();
      const inbox = async (u: User) =>
        ok(await req(u, 'GET', `/users/${u.userId}/inbox`), 200).inbox.map((m: Record<string, unknown>) => [m.kind, m.contentId, m.excerpt, m.text]);

      const contentId = ok(await store(alice, 'Talk to me #news', { comments: true })).contentId;
      const first = ok(await comment(bob, contentId, 'An honest comment'));
      expect(first).not.toHaveProperty('status');
      ctx.clock.now += 1000;
      const heldPost = ok(await store(alice, 'Free spam #news'), 202).contentId;
      ctx.clock.now += 1000;
      const queuedAt = now();
      const text = 'Buy SPAM here';
      const held = ok(await comment(bob, contentId, text), 202);
      expect(held).toEqual({ commentId: expect.any(String), contentId, author: { userId: bob.userId, username: 'bob' }, text, createdAt: queuedAt, status: 'pending_review' });
      const { commentId } = held;

      // It is stored, with its score, and not among the post's comments.
      expect(await ctx.db.selectFrom('comment_queue').selectAll().execute()).toEqual([{ comment_id: commentId, content_id: contentId, trust_score: 0, created_at: ctx.clock.now }]);
      expect(await listed(contentId)).toEqual({ contentId, count: 1, comments: [first], nextCursor: null });
      expect(await ctx.comments.get(contentId, commentId)).toBeNull();
      expect(await ctx.comments.getHeld(contentId, commentId)).toMatchObject({ commentId, text });

      // Only its author and those who decide on it can read it; to anyone else it isn't there, nor to the post's publisher.
      for (const u of [null, alice, carol, { userId: bob.userId, apiKey: carol.apiKey }]) expect(refusal(await one(u, contentId, commentId))).toEqual([404, NO_COMMENT]);
      for (const u of [bob, mod, root]) expect(ok(await one(u, contentId, commentId), 200)).toEqual(held);
      expect(ok(await one(null, contentId, first.commentId), 200)).toEqual(first);
      // So it isn't the publisher's to delete, nor anyone's to report; and a server moderator rejects it rather than deletes it.
      for (const u of [alice, carol]) expect(refusal(await req(u, 'DELETE', `/content/${contentId}/comments/${commentId}`))).toEqual([404, NO_COMMENT]);
      expect((await req(mod, 'DELETE', `/content/${contentId}/comments/${commentId}`)).statusCode).toBe(403);
      expect(refusal(await req(carol, 'POST', '/report', { contentId, commentId }))).toEqual([404, NO_COMMENT]);

      // It waits among the posts, longest waiting first, and the queue pages across both.
      ctx.clock.now += 1000;
      const second = ok(await comment(carol, contentId, 'More spam'), 202).commentId;
      const third = ok(await comment(carol, contentId, 'Spam again'), 202).commentId;
      ctx.clock.now += 1000;
      const laterPost = ok(await store(bob, 'Spam of my own #news'), 202).contentId;
      const record = { kind: 'comment', commentId, contentId, author: { userId: bob.userId, username: 'bob' }, text, createdAt: queuedAt, trustScore: 0, queuedAt };
      const whole = [['post', heldPost], ['comment', commentId], ['comment', second], ['comment', third], ['post', laterPost]];
      for (const u of [mod, root]) {
        const queued = await queue(u);
        expect(waiting(queued)).toEqual(whole);
        expect(queued.queue[1]).toEqual(record);
        expect(queued.queue[0]).toMatchObject({ kind: 'post', contentId: heldPost, text: 'Free spam #news', trustScore: 0 });
        expect(queued.nextCursor).toBeNull();
      }
      const paged: string[][] = [];
      for (let cursor: string | null = '', pages = 0; cursor !== null; pages++) {
        const page = await queue(mod, `?limit=2${cursor && `&cursor=${cursor}`}`);
        expect(page.queue.length, `page ${pages}`).toBeGreaterThan(0);
        paged.push(...waiting(page));
        cursor = page.nextCursor;
      }
      expect(paged).toEqual(whole);

      // Accepted: it is published among the post's comments, where it was sent, and its author is told.
      expect((await decideOn(null, contentId, commentId, 'accept')).statusCode).toBe(401);
      for (const u of [alice, bob]) expect((await decideOn(u, contentId, commentId, 'accept')).statusCode).toBe(403);
      expect(refusal(await decideOn(mod, NO_CONTENT, commentId, 'accept'))).toEqual([404, 'content not found']);
      expect(refusal(await decideOn(mod, contentId, NO_CONTENT, 'accept'))).toEqual([404, COMMENT_NOT_QUEUED]);
      expect(refusal(await decideOn(mod, contentId, first.commentId, 'accept'))).toEqual([404, COMMENT_NOT_QUEUED]);
      expect(refusal(await decideOn(mod, heldPost, commentId, 'accept'))).toEqual([404, COMMENT_NOT_QUEUED]);
      ctx.clock.now += 1000;
      const after = ok(await comment(bob, contentId, 'Sent after it'));
      ctx.clock.now += 1000;
      expect(ok(await decideOn(mod, contentId, commentId, 'accept'), 200)).toEqual({ contentId, commentId, status: 'published' });
      const { status: _status, ...published } = held;
      expect(await listed(contentId)).toEqual({ contentId, count: 3, comments: [first, published, after], nextCursor: null });
      expect(ok(await one(null, contentId, commentId), 200)).toEqual(published);
      expect(await ctx.comments.getHeld(contentId, commentId)).toBeNull();
      for (const decision of ['accept', 'reject'] as const) expect(refusal(await decideOn(root, contentId, commentId, decision))).toEqual([404, COMMENT_NOT_QUEUED]);
      expect(waiting(await queue(mod))).toEqual(whole.filter(([, id]) => id !== commentId));
      expect(await inbox(bob)).toEqual([['comment_accepted', contentId, text, 'Your comment was accepted from the moderation queue, and is published.']]);
      // Published, it is the publisher's to delete, and anyone's to report.
      ok(await req(carol, 'POST', '/report', { contentId, commentId }));

      // Rejected: it is deleted, at once and for good, and its author is told. An admin decides as a server moderator does.
      expect((await decideOn(carol, contentId, second, 'reject')).statusCode).toBe(403);
      expect(ok(await decideOn(root, contentId, second, 'reject'), 200)).toEqual({ contentId, commentId: second, status: 'deleted' });
      expect(refusal(await one(carol, contentId, second))).toEqual([404, NO_COMMENT]);
      expect(await ctx.comments.getHeld(contentId, second)).toBeNull();
      expect(refusal(await decideOn(root, contentId, second, 'accept'))).toEqual([404, COMMENT_NOT_QUEUED]);
      expect((await listed(contentId)).count).toBe(3);
      expect(await inbox(carol)).toEqual([['comment_rejected', contentId, 'More spam', 'Your comment was rejected from the moderation queue, and deleted.']]);

      // Its author deletes one that waits, which takes it out of the queue, and nobody is told.
      expect(ok(await req(carol, 'DELETE', `/content/${contentId}/comments/${third}`), 200)).toEqual({ contentId, commentId: third, status: 'deleted' });
      expect(waiting(await queue(root))).toEqual([['post', heldPost], ['post', laterPost]]);
      expect(await rows()).toEqual([]);
      expect(await inbox(carol)).toHaveLength(1);

      // What waits on a post goes with the post: out of the queue at once, and removed by the compactor.
      ctx.clock.now += 1000;
      const fourth = ok(await comment(carol, contentId, 'Spam to the last'), 202).commentId;
      expect(waiting(await queue(root))).toEqual([['post', heldPost], ['post', laterPost], ['comment', fourth]]);
      ok(await req(alice, 'DELETE', `/content/${contentId}`), 202);
      expect(waiting(await queue(root))).toEqual([['post', heldPost], ['post', laterPost]]);
      expect((await decideOn(root, contentId, fourth, 'accept')).statusCode).toBe(404);
      expect(await rows()).toEqual([fourth]);
      expect(await deletedBy(2)).toEqual([contentId]);
      expect(await rows()).toEqual([]);
      expect(await ctx.db.selectFrom('comment_reports').selectAll().execute()).toEqual([]);
      expect(await ctx.comments.getHeld(contentId, fourth)).toBeNull();
      expect(await ctx.comments.count(contentId)).toBe(0);
    });

    it('refuses a comment that scores under the lower threshold, storing nothing, and leaves a hashtag out of it', async () => {
      ctx = await createTestContext(target);
      const root = await admin();
      const mod = await ctx.register('mod');
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      ok(await req(root, 'POST', '/moderation/blocked-words', { words: ['spam'] }), 200);
      ok(await req(root, 'PUT', `/tags/news/moderators/${mod.userId}`));
      const comment = (u: User, contentId: string, text: string) => req(u, 'POST', `/content/${contentId}/comments`, { text });
      const contentId = ok(await store(alice, 'Talk to me #news', { comments: true })).contentId;

      const refused = await comment(bob, contentId, 'Free spam');
      expect([refused.statusCode, refused.json()]).toEqual([422, { error: "the comment contains a word or phrase this server doesn't allow, so it wasn't published" }]);
      expect(await ctx.comments.count(contentId)).toBe(0);
      expect(await ctx.db.selectFrom('comment_queue').selectAll().execute()).toEqual([]);

      // What a hashtag's moderators keep from the hashtag doesn't keep a comment from a post under it:
      // neither the words they block, nor the users they mute.
      ok(await req(mod, 'POST', '/tags/news/blocked-words', { words: ['course'] }), 200);
      ok(await req(mod, 'PUT', `/tags/news/muted/${bob.userId}`));
      expect((await queue(root)).queue).toEqual([]);
      const kept = ok(await comment(bob, contentId, 'Take my course'));
      expect(ok(await req(null, 'GET', `/content/${contentId}/comments`), 200)).toMatchObject({ count: 1, comments: [kept] });
      // Nor is a comment theirs to delete, or to decide on.
      expect((await req(mod, 'DELETE', `/content/${contentId}/comments/${kept.commentId}`)).statusCode).toBe(403);
      expect((await req(mod, 'GET', '/moderation/queue')).statusCode).toBe(403);
      expect((await req(mod, 'POST', `/moderation/queue/${contentId}/comments/${kept.commentId}/accept`)).statusCode).toBe(403);
    });

    it('takes a published post out of every feed at once when an update of it is held, and publishes it again when one is not', async () => {
      ctx = await createTestContext(target, { trust: { deleteBelow: 0 } });
      const root = await admin();
      const alice = await ctx.register('alice');
      ok(await req(root, 'POST', '/moderation/blocked-words', { words: ['spam'] }), 200);
      const { contentId } = ok(await store(alice, 'Deals of the day #news #deals'));
      const other = ok(await store(alice, 'Other news #news')).contentId;
      await ctx.compact();
      const createdAt = ctx.clock.now - ctx.config.compact.graceSeconds * 1000 - 1000;
      const summaryOf = async () => (await ctx.summaries.getMany([{ contentId, createdAt }]))[0];
      const published = await summaryOf();
      expect(published).toMatchObject({ contentId, tags: ['news', 'deals'] });

      // Held: its summary is erased, which leaves it out of every feed whose index still holds it.
      ctx.clock.now += 1000;
      expect(ok(await store(alice, 'Spam of the day #news', { contentId }), 202)).toMatchObject({ contentId, status: 'pending_review', tags: ['news'] });
      expect(await summaryOf()).toBeNull();
      expect(ids(await feedOf('news'))).toEqual([other]);
      expect(await feedOf('deals')).toEqual([]);
      expect((await req(null, 'GET', `/content/${contentId}`)).statusCode).toBe(404);
      expect((await queue(root)).queue).toMatchObject([{ contentId, tags: ['news'], trustScore: 0, queuedAt: now() }]);
      // The compactor takes its entries out of the indexes, and writes no summary for it. One that a run
      // restored as the update went through, having read the post as published, is erased again.
      await ctx.summaries.put(published!);
      await ctx.compact();
      expect(await summaryOf()).toBeNull();
      expect(ids(await feedOf('news'))).toEqual([other]);
      expect(await feedOf('deals')).toEqual([]);

      // An update the server trusts needs no admin.
      ctx.clock.now += 1000;
      const clean = ok(await store(alice, 'Deals of the day, again #news', { contentId }), 200);
      expect(clean).toMatchObject({ contentId, tags: ['news'] });
      expect(clean).not.toHaveProperty('status');
      expect(await queue(root)).toEqual({ queue: [], nextCursor: null });
      expect((await decide(root, contentId, 'accept')).json().error).toBe(NOT_QUEUED);
      await ctx.compactor.runOnce();
      expect(ids(await feedOf('news')).sort()).toEqual([contentId, other].sort());

      // Held again while an index holds it, and accepted before the compactor runs: it shows where it was
      // at once, as accepted, and under the hashtag the update gave after the next run.
      expect(ok(await store(alice, 'Spam again #news #deals', { contentId }), 202)).toMatchObject({ status: 'pending_review' });
      expect(ids(await feedOf('news'))).toEqual([other]);
      expect(ok(await decide(root, contentId, 'accept'), 200)).toMatchObject({ tags: ['news', 'deals'] });
      expect((await feedOf('news')).map((i) => i.preview.text).sort()).toEqual(['Other news #news', 'Spam again #news #deals']);
      expect(await feedOf('deals')).toEqual([]);
      await ctx.compact();
      expect(ids(await feedOf('news')).sort()).toEqual([contentId, other].sort());
      expect((await feedOf('deals')).map((i) => [i.contentId, i.preview.text])).toEqual([[contentId, 'Spam again #news #deals']]);
      expect(await queued(ctx)).toEqual([]);
    });

    it('refuses what scores under the lower threshold, storing nothing, and holds every post when the upper one is out of reach', async () => {
      ctx = await createTestContext(target, { trust: { allowFrom: 101 } });
      const root = await admin();
      const alice = await ctx.register('alice');
      ok(await req(root, 'POST', '/moderation/blocked-words', { words: ['spam'] }), 200);

      const refused = await store(alice, 'Free spam #news');
      expect([refused.statusCode, refused.json().error]).toEqual([422, REFUSED]);
      expect(await ctx.db.selectFrom('content').select('id').execute()).toEqual([]);

      const { contentId } = ok(await store(alice, 'An honest post #news'), 202);
      expect((await queue(root)).queue).toMatchObject([{ contentId, trustScore: 100 }]);
      expect(await feedOf('news')).toEqual([]);
      ok(await decide(root, contentId, 'accept'), 200);
      await ctx.compactor.runOnce();
      expect(ids(await feedOf('news'))).toEqual([contentId]);
      // An update of it waits like any post, and takes it out of the feed at once.
      ctx.clock.now += 1000;
      ok(await store(alice, 'An honest post, corrected #news', { contentId }), 202);
      expect(await feedOf('news')).toEqual([]);
    });

    it("flags each record of a hashtag's feed as moderated or not, and leaves the hashtag's queue to moderated=false", async () => {
      ctx = await createTestContext(target);
      const root = await admin();
      const mod = await ctx.register('mod');
      const alice = await ctx.register('alice');
      ok(await req(root, 'PUT', `/tags/news/moderators/${mod.userId}`));
      const approve = (u: User | null, contentId: string, tag = 'news') => req(u, 'PUT', `/content/${contentId}/tags/${tag}`);
      const decisions = async () =>
        (await ctx.db.selectFrom('tag_moderation').select(['content_id', 'tag', 'decision', 'applied_at']).execute())
          .map((d) => [d.content_id, d.tag, d.decision, d.applied_at])
          .sort();

      const a = ok(await store(alice, 'First #news #mumbai')).contentId;
      ctx.clock.now += 1000;
      const b = ok(await store(alice, 'Second #news #mumbai')).contentId;
      await ctx.compact();
      ctx.clock.now += 1000;
      const c = ok(await store(alice, 'Third #news #weather')).contentId;
      await ctx.compactor.runOnce();

      // Every post is published unmoderated, which is what puts it in the queue of each of its hashtags.
      const all = { [a]: false, [b]: false, [c]: false };
      expect(await flagsOf('news')).toEqual(all);
      expect(await flagsOf('news', '&moderated=false')).toEqual(all);
      expect(await flagsOf('news', '&moderated=true')).toEqual({});

      // The hashtag's moderators, and admins, approve what is under it.
      expect((await approve(null, a)).statusCode).toBe(401);
      expect((await approve(alice, a)).statusCode).toBe(403);
      expect((await approve(mod, a, 'mumbai')).statusCode).toBe(403);
      expect((await approve(root, a, 'weather')).json().error).toBe("the content isn't tagged #weather");
      expect((await approve(root, NO_CONTENT)).statusCode).toBe(404);
      expect(ok(await approve(mod, a))).toEqual({ contentId: a, tag: 'news', moderated: true, alreadyApproved: false });
      expect(ok(await approve(root, a), 200)).toEqual({ contentId: a, tag: 'news', moderated: true, alreadyApproved: true });
      ok(await approve(root, c));

      // The decision is recorded at once, and feeds show it after the compactor's next run, only under that hashtag.
      const approved = { [a]: true, [b]: false, [c]: true };
      expect(await decisions()).toEqual([[a, 'news', 'approved', null], [c, 'news', 'approved', null]].sort());
      expect(await flagsOf('news')).toEqual(all);
      await ctx.compact();
      const appliedAt = ctx.clock.now;
      expect(await decisions()).toEqual([[a, 'news', 'approved', appliedAt], [c, 'news', 'approved', appliedAt]].sort());
      expect(await flagsOf('news')).toEqual(approved);
      expect(await flagsOf('news', '&moderated=false')).toEqual({ [b]: false });
      expect(await flagsOf('news', '&moderated=true')).toEqual({ [a]: true, [c]: true });
      expect(await flagsOf('mumbai')).toEqual({ [a]: false, [b]: false });
      // Across hashtags, a post waits under those it isn't approved under.
      const both = await feed('tags=news,mumbai&moderated=false');
      expect(ids(records(both, 'news'))).toEqual([b]);
      expect(ids(records(both, 'mumbai'))).toContain(a);

      // Nothing the compactor does afterwards undoes it: not a later run, nor a like, nor a rebuild.
      await ctx.compact();
      expect(await decisions()).toEqual([[a, 'news', 'approved', appliedAt], [c, 'news', 'approved', appliedAt]].sort());
      expect(await flagsOf('news')).toEqual(approved);
      ok(await like(mod, a));
      await ctx.compact();
      expect(await flagsOf('news')).toEqual(approved);
      expect(await flagsOf('mumbai')).toEqual({ [a]: false, [b]: false });
      await ctx.hot.clear();
      ctx.clock.now += 1000;
      await ctx.compactor.runOnce({ rebuild: true });
      expect(await flagsOf('news')).toEqual(approved);
      expect(await flagsOf('news', '&moderated=false')).toEqual({ [b]: false });

      // An approval is of the post as it was: an update puts it back in the queue, until it is approved again.
      ctx.clock.now += 1000;
      ok(await store(alice, 'First, corrected #news #mumbai', { contentId: a }), 200);
      expect(await decisions()).toEqual([[c, 'news', 'approved', expect.any(Number)]]);
      await ctx.compactor.runOnce();
      expect(await flagsOf('news')).toEqual({ ...approved, [a]: false });
      expect(ok(await approve(mod, a))).toMatchObject({ alreadyApproved: false });
      await ctx.compact();
      expect(await flagsOf('news')).toEqual(approved);
      // Also an update that comes before the compactor has applied the approval.
      ctx.clock.now += 1000;
      ok(await store(alice, 'First, corrected twice #news #mumbai', { contentId: a }), 200);
      expect(ok(await approve(mod, a))).toMatchObject({ alreadyApproved: false });
      ctx.clock.now += 1000;
      ok(await store(alice, 'First, corrected three times #news #mumbai', { contentId: a }), 200);
      await ctx.compact();
      expect(await flagsOf('news')).toEqual({ ...approved, [a]: false });

      // Removing the hashtag is the other way out of the queue, also for a post that was approved. The
      // compactor's next run takes the post out of the hashtag's feed.
      expect(ok(await req(mod, 'DELETE', `/content/${b}/tags/news`), 200)).toMatchObject({ tags: ['mumbai'] });
      expect(ok(await req(mod, 'DELETE', `/content/${c}/tags/news`), 200)).toMatchObject({ tags: ['weather'] });
      expect((await approve(mod, c)).json().error).toBe("the content isn't tagged #news");
      expect(await decisions()).toEqual([[b, 'news', 'removed', null], [c, 'news', 'removed', null]].sort());
      await ctx.compact();
      expect(await flagsOf('news')).toEqual({ [a]: false });
      expect(await flagsOf('news', '&moderated=true')).toEqual({});
      await ctx.compact();
      expect(await flagsOf('news')).toEqual({ [a]: false });
      expect((await feedOf('weather')).map((i) => [i.contentId, i.tags, i.moderated])).toEqual([[c, ['weather'], false]]);
    });

    it("keeps a feed session's view of what was moderated when it started, and ties a cursor to its filter", async () => {
      ctx = await createTestContext(target, { feed: { pageSize: 2 } });
      const root = await admin();
      const alice = await ctx.register('alice');
      const posted: string[] = [];
      const post = async (n: number) => {
        ctx.clock.now += 1000;
        posted.push(ok(await store(alice, `Post ${n} #news`)).contentId);
      };
      for (let n = 0; n < 3; n++) await post(n);
      await ctx.compact();
      for (let n = 3; n < 5; n++) await post(n);
      await ctx.compactor.runOnce();

      const first = await feed('tags=news&moderated=false');
      expect(first.count).toBe(2);
      expect(first.nextCursor).toBeTruthy();
      for (const id of posted) ok(await req(root, 'PUT', `/content/${id}/tags/news`));
      await ctx.compact();

      // A session that starts now finds the queue empty; the one under way reads on as it began.
      expect(await feed('tags=news&moderated=false')).toMatchObject({ count: 0, nextCursor: null });
      const seen = records(first, 'news');
      for (let cursor = first.nextCursor; cursor; ) {
        const page = await feed(`tags=news&moderated=false&cursor=${cursor}`);
        seen.push(...records(page, 'news'));
        cursor = page.nextCursor;
      }
      expect(ids(seen).sort()).toEqual([...posted].sort());
      expect(seen.every((i) => i.moderated === false)).toBe(true);

      for (const other of ['', '&moderated=true']) {
        const res = await ctx.app.inject({ method: 'GET', url: `/feed?tags=news${other}&cursor=${first.nextCursor}` });
        expect([res.statusCode, res.json().error]).toEqual([400, 'cursor does not match the requested tags/hours/algorithm/addRelated/aiGenerated/moderated']);
      }
      expect((await ctx.app.inject({ method: 'GET', url: '/feed?tags=news&moderated=maybe' })).statusCode).toBe(400);

      await ctx.compact();
      expect((await feed('tags=news&moderated=false')).count).toBe(0);
      expect(Object.keys(await flagsOf('news', '&moderated=true&limit=5')).sort()).toEqual([...posted].sort());
    });
  });
}
