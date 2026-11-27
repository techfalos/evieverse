import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { setAdmin } from '../src/moderation/policy.js';
import { HOUR, MINUTE } from '../src/time.js';
import { as, BASE_ENV, createTestContext, requests, TARGETS, type TestContext, type User } from './helpers.js';

const NO_CONTENT = '00000000-0000-4000-8000-000000000000';
const NOT_REPORTED = 'the content has no reports waiting for a decision';
const NOT_A_MODERATOR = 'only an admin or a server moderator can do this';

describe('REPORTS_PER_HOUR', () => {
  it('is 20 unless set, and 0 for no limit', () => {
    const load = (env: Record<string, string> = {}) => loadConfig({}, { ...BASE_ENV, ...env }).reportsPerHour;
    expect(load()).toBe(20);
    expect(load({ REPORTS_PER_HOUR: '0' })).toBe(0);
    expect(() => load({ REPORTS_PER_HOUR: '-1' })).toThrow();
  });
});

for (const target of TARGETS) {
  describe(`reports (${target.name})`, () => {
    let ctx: TestContext;
    afterEach(() => ctx.close());

    const { storeText: store, post, feedItems: feedOf, like } = requests(() => ctx);
    const req = (u: User | null, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
      ctx.app.inject({ method, url, headers: u ? as(u) : {}, ...(payload && { payload }) });
    const ok = (res: LightMyRequestResponse, status = 201) => {
      expect(res.statusCode, res.body).toBe(status);
      return res.json();
    };
    const now = () => new Date(ctx.clock.now).toISOString();
    const admin = async (name = 'root') => {
      const u = await ctx.register(name);
      await setAdmin(ctx.db, name, true);
      return u;
    };
    const ids = (items: { contentId: string }[]) => items.map((i) => i.contentId);
    const report = (u: User | null, contentId: string, reason?: string) => req(u, 'POST', '/report', { contentId, ...(reason !== undefined && { reason }) });
    /** The report queue, as a server moderator or an admin reads it. */
    const queue = async (u: User, query = '') => ok(await req(u, 'GET', `/moderation/reports${query}`), 200);
    const reportsOf = (u: User | null, contentId: string, query = '') => req(u, 'GET', `/moderation/reports/${contentId}${query}`);
    const decide = (u: User | null, contentId: string, decision: 'accept' | 'delete') => req(u, 'POST', `/moderation/reports/${contentId}/${decision}`);
    const rows = async () =>
      (await ctx.db.selectFrom('reports').select(['content_id', 'user_id', 'reason', 'created_at', 'accepted_at']).execute())
        .map((r) => [r.content_id, r.user_id, r.reason, r.created_at, r.accepted_at])
        .sort();

    it('puts a reported post in the report queue, where a server moderator or an admin accepts it or deletes it', async () => {
      ctx = await createTestContext(target);
      const root = await admin();
      const mod = await ctx.register('mod');
      ok(await req(root, 'PUT', `/moderators/${mod.userId}`));
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const carol = await ctx.register('carol');
      const dave = await ctx.register('dave');

      const postedAt = now();
      const text = 'Buy my course #news';
      const a = await post(alice, text);
      const b = await post(alice, 'Something unkind #news');
      const c = await post(alice, 'An honest post #news');
      expect(await queue(mod)).toEqual({ queue: [], nextCursor: null });

      // Any user reports a post, with a reason or without, and only once: the first report stands.
      expect((await report(null, a)).statusCode).toBe(401);
      expect((await report(bob, NO_CONTENT)).statusCode).toBe(404);
      expect((await report(bob, 'a')).statusCode).toBe(400);
      expect((await report(bob, a, 'x'.repeat(501))).statusCode).toBe(400);
      ctx.clock.now += 1000;
      const first = ctx.clock.now;
      expect(ok(await report(bob, a, '  Looks like spam  '))).toEqual({ contentId: a, reportedAt: now(), alreadyReported: false });
      ctx.clock.now += 1000;
      const second = ctx.clock.now;
      expect(ok(await report(bob, a, 'Or worse'), 200)).toEqual({ contentId: a, reportedAt: new Date(first).toISOString(), alreadyReported: true });
      expect(ok(await report(carol, a, ' '))).toMatchObject({ alreadyReported: false });
      ctx.clock.now += 1000;
      const third = ctx.clock.now;
      ok(await report(carol, b, 'Unkind'));
      expect(await rows()).toEqual(
        [
          [a, bob.userId, 'Looks like spam', first, null],
          [a, carol.userId, null, second, null],
          [b, carol.userId, 'Unkind', third, null],
        ].sort(),
      );

      // A reported post stays published while it waits.
      await ctx.compactor.runOnce();
      expect(ids(await feedOf('news')).sort()).toEqual([a, b, c].sort());
      expect(ok(await req(null, 'GET', `/content/${a}`), 200)).not.toHaveProperty('status');
      expect(ok(await like(dave, a))).toMatchObject({ likes: 1 });

      // Server moderators and admins read the queue, longest reported first, and nobody else.
      expect((await req(null, 'GET', '/moderation/reports')).statusCode).toBe(401);
      for (const u of [alice, bob]) {
        const closed = await req(u, 'GET', '/moderation/reports');
        expect([closed.statusCode, closed.json().error]).toEqual([403, NOT_A_MODERATOR]);
      }
      const record = {
        kind: 'post',
        contentId: a,
        publisher: { userId: alice.userId, username: 'alice' },
        mimeType: 'text/plain',
        aiGenerated: false,
        comments: false,
        commentCount: 0,
        preview: { kind: 'text', text },
        tags: ['news'],
        likes: 1,
        views: 0,
        dislikes: null,
        createdAt: postedAt,
        updatedAt: postedAt,
        text,
        reports: 2,
        reportedAt: new Date(first).toISOString(),
      };
      for (const u of [mod, root]) {
        const listed = await queue(u);
        expect(listed).toMatchObject({ queue: [record, { contentId: b, reports: 1, reportedAt: now() }], nextCursor: null });
        expect(listed.queue[0]).toEqual(record);
      }
      const page1 = await queue(mod, '?limit=1');
      expect([ids(page1.queue), typeof page1.nextCursor]).toEqual([[a], 'string']);
      const page2 = await queue(mod, `?limit=1&cursor=${page1.nextCursor}`);
      expect([ids(page2.queue), page2.nextCursor]).toEqual([[b], null]);
      expect((await req(mod, 'GET', '/moderation/reports?limit=101')).statusCode).toBe(400);

      // And each post's reports: who made them, when, and why if they said.
      expect((await reportsOf(null, a)).statusCode).toBe(401);
      expect((await reportsOf(bob, a)).statusCode).toBe(403);
      expect((await reportsOf(mod, NO_CONTENT)).statusCode).toBe(404);
      const byCarol = { userId: carol.userId, username: 'carol', reportedAt: new Date(second).toISOString() };
      const byBob = { userId: bob.userId, username: 'bob', reason: 'Looks like spam', reportedAt: new Date(first).toISOString() };
      expect(ok(await reportsOf(mod, a), 200)).toEqual({ contentId: a, reports: [byCarol, byBob], nextCursor: null });
      const reports1 = ok(await reportsOf(root, a, '?limit=1'), 200);
      expect([reports1.reports, typeof reports1.nextCursor]).toEqual([[byCarol], 'string']);
      expect(ok(await reportsOf(root, a, `?limit=1&cursor=${reports1.nextCursor}`), 200)).toEqual({ contentId: a, reports: [byBob], nextCursor: null });
      expect(ok(await reportsOf(mod, c), 200)).toEqual({ contentId: c, reports: [], nextCursor: null });

      // Accepted: the post stays as it is, and is out of the queue.
      expect((await decide(null, a, 'accept')).statusCode).toBe(401);
      for (const u of [alice, bob]) expect((await decide(u, a, 'accept')).statusCode).toBe(403);
      expect((await decide(mod, NO_CONTENT, 'accept')).statusCode).toBe(404);
      const unreported = await decide(mod, c, 'accept');
      expect([unreported.statusCode, unreported.json().error]).toEqual([404, NOT_REPORTED]);
      ctx.clock.now += 1000;
      const accepted = ctx.clock.now;
      expect(ok(await decide(mod, a, 'accept'), 200)).toEqual({ contentId: a, status: 'accepted', reports: 2 });
      expect((await decide(root, a, 'accept')).json().error).toBe(NOT_REPORTED);
      expect((await decide(root, a, 'delete')).json().error).toBe(NOT_REPORTED);
      expect(ids((await queue(mod)).queue)).toEqual([b]);
      expect(ok(await reportsOf(mod, a), 200)).toMatchObject({ reports: [] });
      expect(ids(await feedOf('news')).sort()).toEqual([a, b, c].sort());

      // Those whose reports were answered can't bring it back; someone else's report does, behind what already waits.
      expect(ok(await report(bob, a, 'Still spam'), 200)).toMatchObject({ alreadyReported: true });
      expect(ids((await queue(mod)).queue)).toEqual([b]);
      ctx.clock.now += 1000;
      ok(await report(dave, a));
      expect((await queue(root)).queue).toMatchObject([{ contentId: b }, { contentId: a, reports: 1, reportedAt: now() }]);
      expect(await rows()).toEqual(
        [
          [a, bob.userId, 'Looks like spam', first, accepted],
          [a, carol.userId, null, second, accepted],
          [a, dave.userId, null, ctx.clock.now, null],
          [b, carol.userId, 'Unkind', third, null],
        ].sort(),
      );

      // Deleted: the post can't be read from then on, as when its publisher deletes it, and leaves feeds on the
      // compactor's next run. Only what is in the queue.
      for (const u of [alice, bob]) expect((await decide(u, b, 'delete')).statusCode).toBe(403);
      expect((await decide(mod, c, 'delete')).json().error).toBe(NOT_REPORTED);
      expect((await req(mod, 'DELETE', `/content/${c}`)).statusCode).toBe(403);
      expect(ok(await decide(mod, b, 'delete'), 202)).toEqual({ contentId: b, status: 'pending_deletion', requestedAt: now() });
      expect((await req(null, 'GET', `/content/${b}`)).statusCode).toBe(404);
      expect(ids((await queue(mod)).queue)).toEqual([a]);
      for (const decision of ['accept', 'delete'] as const) expect((await decide(mod, b, decision)).statusCode).toBe(404);
      expect((await reportsOf(mod, b)).statusCode).toBe(404);
      expect((await report(dave, b)).statusCode).toBe(404);

      // The compactor then removes it, and its reports with it.
      const deleted: string[] = [];
      for (let i = 0; i < 2; i++) deleted.push(...(await ctx.compact()).deleted);
      expect(deleted).toEqual([b]);
      expect(ids(await feedOf('news')).sort()).toEqual([a, c].sort());
      expect((await rows()).map((r) => r[0])).toEqual([a, a, a]);

      // An admin decides as a server moderator does.
      expect(ok(await decide(root, a, 'delete'), 202)).toMatchObject({ contentId: a, status: 'pending_deletion' });
      expect(await queue(root)).toEqual({ queue: [], nextCursor: null });
      expect((await ctx.compactor.runOnce()).deleted).toEqual([a]);
      expect(ids(await feedOf('news'))).toEqual([c]);

      // No longer a server moderator: the queue is closed to them.
      ok(await req(root, 'DELETE', `/moderators/${mod.userId}`), 200);
      ok(await report(bob, c));
      for (const res of [await req(mod, 'GET', '/moderation/reports'), await reportsOf(mod, c), await decide(mod, c, 'accept'), await decide(mod, c, 'delete')]) {
        expect([res.statusCode, res.json().error]).toEqual([403, NOT_A_MODERATOR]);
      }
      expect(ids((await queue(root)).queue)).toEqual([c]);
    });

    it('takes reports of published posts only, as many from a user in an hour as the server allows', async () => {
      ctx = await createTestContext(target, { trust: { deleteBelow: 0 }, reportsPerHour: 2 });
      const root = await admin();
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const carol = await ctx.register('carol');
      ok(await req(root, 'POST', '/moderation/blocked-words', { words: ['spam'] }), 200);

      // A post that waits in the moderation queue isn't there to report, nor is one set for deletion.
      const held = ok(await store(alice, 'Free spam #news'), 202).contentId;
      expect((await report(bob, held)).statusCode).toBe(404);
      const gone = await post(alice, 'Soon gone #news');
      ok(await req(alice, 'DELETE', `/content/${gone}`), 202);
      expect((await report(bob, gone)).statusCode).toBe(404);
      expect(await rows()).toEqual([]);

      // A user's reports past the limit are refused, until the hour that began with their first is over.
      const posts: string[] = [];
      for (let n = 0; n < 4; n++) posts.push(await post(alice, `Post ${n} #news`));
      const [p0, p1, p2, p3] = posts as [string, string, string, string];
      ok(await report(bob, p0));
      ctx.clock.now += 1000;
      ok(await report(bob, p1));
      ctx.clock.now += 1000;
      const limited = await report(bob, p2);
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error).toMatch(/^too many reports; try again in (59|60) minutes$/);
      expect(limited.json().retryAfterSeconds).toBeGreaterThan(3500);
      expect(limited.json().retryAfterSeconds).toBeLessThanOrEqual(3600);
      expect(limited.headers['retry-after']).toBe(String(limited.json().retryAfterSeconds));
      // One sent again counts for nothing, and each user has their own hour.
      expect(ok(await report(bob, p0), 200)).toMatchObject({ alreadyReported: true });
      ok(await report(carol, p2));
      expect(ids((await queue(root)).queue)).toEqual([p0, p1, p2]);
      expect((await queue(root)).queue.map((p: { reports: number }) => p.reports)).toEqual([1, 1, 1]);
      // The hour is Redis's to count, from the first report: once it is over, the next is taken.
      const [left] = Object.values(await ctx.lapse(`reports:${bob.userId}`));
      expect(left).toBeGreaterThan(HOUR - MINUTE);
      expect(left).toBeLessThanOrEqual(HOUR);
      ctx.clock.now += HOUR;
      ok(await report(bob, p3));

      // What its publisher deletes leaves the queue; what an update has held stays in it, to be decided on.
      ok(await req(alice, 'DELETE', `/content/${p0}`), 202);
      ok(await store(alice, 'Post 1, now spam #news', { contentId: p1 }), 202);
      const waiting = ids((await queue(root)).queue);
      expect(waiting.slice(0, 2)).toEqual([p1, p2]);
      expect((await decide(root, p0, 'accept')).statusCode).toBe(404);
      expect(ok(await decide(root, p1, 'accept'), 200)).toEqual({ contentId: p1, status: 'accepted', reports: 1 });
      expect(ok(await req(root, 'GET', `/content/${p1}`), 200)).toMatchObject({ status: 'pending_review' });
    });

    it('puts a reported comment in the report queue among the posts, where it is accepted or deleted', async () => {
      ctx = await createTestContext(target, { reportsPerHour: 2 });
      const root = await admin();
      const mod = await ctx.register('mod');
      ok(await req(root, 'PUT', `/moderators/${mod.userId}`));
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const carol = await ctx.register('carol');
      const dave = await ctx.register('dave');
      const NO_COMMENT = 'comment not found';
      const COMMENT_NOT_REPORTED = 'the comment has no reports waiting for a decision';
      const comment = async (u: User, contentId: string, text: string) => ok(await req(u, 'POST', `/content/${contentId}/comments`, { text }));
      const listed = async (contentId: string) => ok(await req(null, 'GET', `/content/${contentId}/comments`), 200);
      const reportComment = (u: User | null, contentId: string, commentId: string, reason?: string) =>
        req(u, 'POST', '/report', { contentId, commentId, ...(reason !== undefined && { reason }) });
      const commentReports = (u: User | null, contentId: string, commentId: string, query = '') => req(u, 'GET', `/moderation/reports/${contentId}/comments/${commentId}${query}`);
      const decideOn = (u: User | null, contentId: string, commentId: string, decision: 'accept' | 'delete') =>
        req(u, 'POST', `/moderation/reports/${contentId}/comments/${commentId}/${decision}`);
      const refusal = (res: LightMyRequestResponse) => [res.statusCode, res.json().error];
      /** What waits in the queue, in its order: each item's kind, id and number of reports. */
      const waiting = (page: { queue: { kind: string; contentId: string; commentId?: string; reports: number }[] }) =>
        page.queue.map((i) => [i.kind, i.commentId ?? i.contentId, i.reports]);
      const commentRows = async () =>
        (await ctx.db.selectFrom('comment_reports').select(['comment_id', 'content_id', 'user_id', 'reason', 'created_at', 'accepted_at']).execute())
          .map((r) => [r.comment_id, r.content_id, r.user_id, r.reason, r.created_at, r.accepted_at])
          .sort();
      const inbox = async (u: User) =>
        ok(await req(u, 'GET', `/users/${u.userId}/inbox`), 200).inbox.map((m: Record<string, unknown>) => [m.kind, m.contentId, m.excerpt, m.text]);

      const contentId = await post(alice, 'Talk to me #news', { comments: true });
      const closed = await post(alice, 'Not to me #news');
      const x = await comment(bob, contentId, 'Something unkind');
      const y = await comment(bob, contentId, 'Buy my course');
      const z = await comment(carol, contentId, 'An honest comment');

      // Any user reports a comment, with a reason or without, and only once.
      expect((await reportComment(null, contentId, x.commentId)).statusCode).toBe(401);
      expect(refusal(await reportComment(carol, contentId, NO_CONTENT))).toEqual([404, NO_COMMENT]);
      expect(refusal(await reportComment(carol, NO_CONTENT, x.commentId))).toEqual([404, 'content not found']);
      expect(refusal(await reportComment(carol, closed, x.commentId))).toEqual([404, "this post doesn't take comments"]);
      expect((await reportComment(carol, contentId, 'x')).statusCode).toBe(400);
      expect((await reportComment(carol, contentId, x.commentId, 'x'.repeat(501))).statusCode).toBe(400);
      ctx.clock.now += 1000;
      const first = ctx.clock.now;
      expect(ok(await reportComment(carol, contentId, x.commentId, '  Unkind  '))).toEqual({ contentId, commentId: x.commentId, reportedAt: now(), alreadyReported: false });
      ctx.clock.now += 1000;
      const second = ctx.clock.now;
      expect(ok(await reportComment(carol, contentId, x.commentId, 'Or worse'), 200)).toEqual({
        contentId,
        commentId: x.commentId,
        reportedAt: new Date(first).toISOString(),
        alreadyReported: true,
      });
      ok(await reportComment(dave, contentId, x.commentId));
      // A post's reports and its comments' are apart.
      ok(await report(dave, contentId, 'The post itself'));
      ctx.clock.now += 1000;
      const third = ctx.clock.now;
      ok(await reportComment(carol, contentId, y.commentId, 'Spam'));
      expect(await commentRows()).toEqual(
        [
          [x.commentId, contentId, carol.userId, 'Unkind', first, null],
          [x.commentId, contentId, dave.userId, null, second, null],
          [y.commentId, contentId, carol.userId, 'Spam', third, null],
        ].sort(),
      );
      expect((await rows()).map((r) => r.slice(0, 3))).toEqual([[contentId, dave.userId, 'The post itself']]);

      // The reports of comments count towards the reports a user makes in an hour, as those of posts do.
      const limited = await reportComment(carol, contentId, z.commentId);
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error).toMatch(/^too many reports; try again in (59|60) minutes$/);
      expect((await report(carol, closed)).statusCode).toBe(429);
      expect(ok(await reportComment(carol, contentId, x.commentId), 200)).toMatchObject({ alreadyReported: true });

      // A reported comment stays published while it waits.
      expect(await listed(contentId)).toEqual({ contentId, count: 3, comments: [x, y, z], nextCursor: null });

      // Server moderators and admins read the queue: posts and comments, longest reported first.
      const record = { kind: 'comment', ...x, reports: 2, reportedAt: new Date(first).toISOString() };
      const whole = [['comment', x.commentId, 2], ['post', contentId, 1], ['comment', y.commentId, 1]];
      for (const u of [mod, root]) {
        const queued = await queue(u);
        expect(waiting(queued)).toEqual(whole);
        expect(queued.queue[0]).toEqual(record);
        expect(queued.queue[1]).toMatchObject({ kind: 'post', contentId, comments: true, reports: 1, reportedAt: new Date(second).toISOString() });
        expect(queued.queue[2]).toMatchObject({ kind: 'comment', text: 'Buy my course', reportedAt: now() });
        expect(queued.nextCursor).toBeNull();
      }
      const paged: unknown[][] = [];
      for (let cursor: string | null = ''; cursor !== null; ) {
        const page = await queue(mod, `?limit=1${cursor && `&cursor=${cursor}`}`);
        expect(page.queue).toHaveLength(1);
        paged.push(...waiting(page));
        cursor = page.nextCursor;
      }
      expect(paged).toEqual(whole);

      // And each comment's reports: who made them, when, and why if they said.
      expect((await commentReports(null, contentId, x.commentId)).statusCode).toBe(401);
      expect(refusal(await commentReports(bob, contentId, x.commentId))).toEqual([403, NOT_A_MODERATOR]);
      expect((await commentReports(mod, NO_CONTENT, x.commentId)).statusCode).toBe(404);
      const byDave = { userId: dave.userId, username: 'dave', reportedAt: new Date(second).toISOString() };
      const byCarol = { userId: carol.userId, username: 'carol', reason: 'Unkind', reportedAt: new Date(first).toISOString() };
      expect(ok(await commentReports(mod, contentId, x.commentId), 200)).toEqual({ contentId, commentId: x.commentId, reports: [byDave, byCarol], nextCursor: null });
      const reports1 = ok(await commentReports(root, contentId, x.commentId, '?limit=1'), 200);
      expect([reports1.reports, typeof reports1.nextCursor]).toEqual([[byDave], 'string']);
      expect(ok(await commentReports(root, contentId, x.commentId, `?limit=1&cursor=${reports1.nextCursor}`), 200)).toMatchObject({ reports: [byCarol], nextCursor: null });
      expect(ok(await commentReports(mod, contentId, z.commentId), 200)).toEqual({ contentId, commentId: z.commentId, reports: [], nextCursor: null });
      // The post's own reports are still its own.
      expect(ok(await reportsOf(mod, contentId), 200).reports).toMatchObject([{ userId: dave.userId, reason: 'The post itself' }]);

      // Accepted: the comment stays as it is, and is out of the queue.
      expect((await decideOn(null, contentId, x.commentId, 'accept')).statusCode).toBe(401);
      for (const u of [alice, bob]) expect((await decideOn(u, contentId, x.commentId, 'accept')).statusCode).toBe(403);
      expect((await decideOn(mod, NO_CONTENT, x.commentId, 'accept')).statusCode).toBe(404);
      expect(refusal(await decideOn(mod, contentId, z.commentId, 'accept'))).toEqual([404, COMMENT_NOT_REPORTED]);
      expect(refusal(await decideOn(mod, closed, x.commentId, 'accept'))).toEqual([404, COMMENT_NOT_REPORTED]);
      ctx.clock.now += 1000;
      expect(ok(await decideOn(mod, contentId, x.commentId, 'accept'), 200)).toEqual({ contentId, commentId: x.commentId, status: 'accepted', reports: 2 });
      for (const decision of ['accept', 'delete'] as const) expect(refusal(await decideOn(root, contentId, x.commentId, decision))).toEqual([404, COMMENT_NOT_REPORTED]);
      expect(waiting(await queue(mod))).toEqual(whole.slice(1));
      expect(ok(await commentReports(mod, contentId, x.commentId), 200)).toMatchObject({ reports: [] });
      expect((await listed(contentId)).count).toBe(3);
      // Those whose reports were answered can't bring it back; someone else's report does, behind what already waits.
      expect(ok(await reportComment(dave, contentId, x.commentId), 200)).toMatchObject({ alreadyReported: true });
      ctx.clock.now += 1000;
      ok(await reportComment(alice, contentId, x.commentId));
      expect(waiting(await queue(root))).toEqual([...whole.slice(1), ['comment', x.commentId, 1]]);

      // Deleted: the comment is gone at once, and for good, with its reports. Its author is told, and not of the reports.
      for (const u of [alice, bob]) expect((await decideOn(u, contentId, y.commentId, 'delete')).statusCode).toBe(403);
      expect(refusal(await decideOn(mod, contentId, z.commentId, 'delete'))).toEqual([404, COMMENT_NOT_REPORTED]);
      expect(await inbox(bob)).toEqual([]);
      expect(ok(await decideOn(mod, contentId, y.commentId, 'delete'), 200)).toEqual({ contentId, commentId: y.commentId, status: 'deleted' });
      expect(await listed(contentId)).toEqual({ contentId, count: 2, comments: [x, z], nextCursor: null });
      expect(refusal(await decideOn(mod, contentId, y.commentId, 'delete'))).toEqual([404, COMMENT_NOT_REPORTED]);
      expect(refusal(await reportComment(dave, contentId, y.commentId))).toEqual([404, NO_COMMENT]);
      expect((await commentRows()).map((r) => r[0])).toEqual([x.commentId, x.commentId, x.commentId]);
      expect(await inbox(bob)).toEqual([['comment_deleted', contentId, 'Buy my course', 'Your comment was deleted.']]);
      expect(waiting(await queue(mod))).toEqual([['post', contentId, 1], ['comment', x.commentId, 1]]);

      // A comment its author deletes leaves the queue, and its reports go with it.
      ok(await req(bob, 'DELETE', `/content/${contentId}/comments/${x.commentId}`), 200);
      expect(waiting(await queue(mod))).toEqual([['post', contentId, 1]]);
      expect(await commentRows()).toEqual([]);

      // The comments of a post that is deleted leave it with the post, and the compactor removes their reports.
      ok(await reportComment(alice, contentId, z.commentId));
      expect(waiting(await queue(root))).toEqual([['post', contentId, 1], ['comment', z.commentId, 1]]);
      expect(ok(await decide(root, contentId, 'delete'), 202)).toMatchObject({ contentId, status: 'pending_deletion' });
      expect(await queue(root)).toEqual({ queue: [], nextCursor: null });
      expect((await decideOn(root, contentId, z.commentId, 'accept')).statusCode).toBe(404);
      expect(await commentRows()).toHaveLength(1);
      for (let i = 0; i < 2; i++) await ctx.compact();
      expect(await commentRows()).toEqual([]);
      expect(await ctx.comments.count(contentId)).toBe(0);
    });

    it('takes any number of reports from a user when there is no limit', async () => {
      ctx = await createTestContext(target, { reportsPerHour: 0 });
      const root = await admin();
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const posts: string[] = [];
      // One more than the limit a server has unless it says.
      for (let n = 0; n < 21; n++) posts.push(await post(alice, `Post ${n} #news`));
      for (const contentId of posts) ok(await report(bob, contentId));
      expect((await queue(root, '?limit=100')).queue).toHaveLength(21);
    });
  });
}
