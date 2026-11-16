import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_COMMENT_CHARS, newCommentId } from '../src/comments.js';
import { loadConfig } from '../src/config.js';
import { setAdmin } from '../src/moderation/policy.js';
import { commentIndexKey, commentKey } from '../src/storage/commentStore.js';
import { HOUR } from '../src/time.js';
import { as, createTestContext, requests, TARGETS, type TestContext, type User } from './helpers.js';

const NO_ID = '00000000-0000-4000-8000-000000000000';
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OFF = "this post doesn't take comments";
const NO_COMMENT = 'comment not found';

describe('COMMENTS_PER_MINUTE and COMMENTS_HOT_HOURS', () => {
  it('are 10 and 24 unless set, and 0 comments a minute is no limit', () => {
    const load = (env: Record<string, string> = {}) => loadConfig({}, { EVIEVERSE_CONFIG: '/nonexistent.json', ...env }).comments;
    expect(load()).toEqual({ perMinute: 10, hotHours: 24 });
    expect(load({ COMMENTS_PER_MINUTE: '0', COMMENTS_HOT_HOURS: '2' })).toEqual({ perMinute: 0, hotHours: 2 });
    expect(() => load({ COMMENTS_PER_MINUTE: '-1' })).toThrow();
  });
});

// Before any test below makes one: the ids of a process only go up, from the time of its last.
describe('comment ids', () => {
  it('are UUIDv7s in the order they were made, also within a millisecond and when the clock goes back', () => {
    const at = Date.UTC(2026, 0, 1);
    const time = (id: string) => parseInt(id.replace(/-/g, '').slice(0, 12), 16);
    // More than the 4,096 a millisecond has room for.
    const ids = Array.from({ length: 5000 }, () => newCommentId(at));
    expect(ids.every((id) => UUID_V7.test(id))).toBe(true);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect([time(ids[0]!), time(ids.at(-1)!)]).toEqual([at, at + 1]);

    const later = newCommentId(at + 5000);
    expect(time(later)).toBe(at + 5000);
    expect(newCommentId(at) > later).toBe(true);
  });
});

for (const target of TARGETS) {
  describe(`comments (${target.name})`, () => {
    let ctx: TestContext;
    afterEach(() => ctx.close());

    const { storeText, post, feedItems } = requests(() => ctx);
    const req = (u: User | null, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
      ctx.app.inject({ method, url, headers: u ? as(u) : {}, ...(payload && { payload }) });
    const ok = (res: LightMyRequestResponse, status = 201) => {
      expect(res.statusCode, res.body).toBe(status);
      return res.json();
    };
    const now = () => new Date(ctx.clock.now).toISOString();
    const comment = (u: User | null, contentId: string, text: string) => req(u, 'POST', `/content/${contentId}/comments`, { text });
    const list = async (contentId: string, query = '') => ok(await req(null, 'GET', `/content/${contentId}/comments${query}`), 200);
    const one = (u: User | null, contentId: string, commentId: string) => req(u, 'GET', `/content/${contentId}/comments/${commentId}`);
    const remove = (u: User | null, contentId: string, commentId: string) => req(u, 'DELETE', `/content/${contentId}/comments/${commentId}`);
    const texts = (page: { comments: { text: string }[] }) => page.comments.map((c) => c.text);
    const refusal = (res: LightMyRequestResponse) => [res.statusCode, res.json().error];
    /** The files the content store holds of a post's comments. */
    const stored = async (contentId: string) => (await readdir(join(ctx.dir, 'content', 'comments', contentId)).catch(() => [])).sort();

    it('takes comments only on a post whose publisher turned them on, which an update keeps unless it says otherwise', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const flagOf = async (contentId: string) => ok(await req(null, 'GET', `/content/${contentId}`), 200).comments;
      const inFeed = async () => Object.fromEntries((await feedItems('news')).map((i) => [i.contentId, i.comments]));

      // Off unless the publisher says: there are no comments to read, and none are taken.
      const closed = ok(await storeText(alice, 'Nothing to add #news'));
      expect(closed.comments).toBe(false);
      expect(await flagOf(closed.contentId)).toBe(false);
      for (const res of [await req(null, 'GET', `/content/${closed.contentId}/comments`), await one(null, closed.contentId, NO_ID), await comment(bob, closed.contentId, 'Hello')]) {
        expect(refusal(res)).toEqual([404, OFF]);
      }

      const text = 'Say what you think #news';
      const open = ok(await storeText(alice, text, { comments: true }));
      expect(open.comments).toBe(true);
      const { contentId } = open;
      expect(await flagOf(contentId)).toBe(true);
      expect(await inFeed()).toEqual({ [closed.contentId]: false, [contentId]: true });
      // It is in the meta file, and nowhere in the database.
      expect((await ctx.content.getMeta(contentId))?.comments).toBe(true);
      expect(await list(contentId)).toEqual({ contentId, count: 0, comments: [], nextCursor: null });

      const first = ok(await comment(bob, contentId, '  First!\n'));
      expect(first).toEqual({
        commentId: expect.stringMatching(UUID_V7),
        contentId,
        author: { userId: bob.userId, username: 'bob' },
        text: 'First!',
        createdAt: now(),
      });
      // A comment is one object in the content store, and no row anywhere.
      expect(await stored(contentId)).toEqual([`${first.commentId}.json`]);
      for (const table of ['comment_queue', 'comment_reports'] as const) expect(await ctx.db.selectFrom(table).selectAll().execute()).toEqual([]);

      // An update that doesn't say keeps the flag, as it keeps the AI flag.
      expect(ok(await storeText(alice, text, { contentId }), 200)).toEqual({ contentId, unchanged: true });
      ctx.clock.now += 1000;
      const kindly = 'Say what you think, kindly #news';
      expect(ok(await storeText(alice, kindly, { contentId }), 200)).toMatchObject({ contentId, comments: true });
      expect(await flagOf(contentId)).toBe(true);
      expect((await list(contentId)).count).toBe(1);
      // Nor does the compactor lose it, whatever it rebuilds.
      await ctx.compact();
      ctx.clock.now += 1000;
      await ctx.compactor.runOnce({ all: true, rebuild: true });
      expect(await inFeed()).toEqual({ [closed.contentId]: false, [contentId]: true });

      // Turning it off is an update of its own: the comments are closed and hidden, and kept.
      ctx.clock.now += 1000;
      expect(ok(await storeText(alice, kindly, { contentId, comments: false }), 200)).toMatchObject({ contentId, comments: false });
      expect(await inFeed()).toEqual({ [closed.contentId]: false, [contentId]: false });
      for (const res of [await req(null, 'GET', `/content/${contentId}/comments`), await one(null, contentId, first.commentId), await comment(bob, contentId, 'Second')]) {
        expect(refusal(res)).toEqual([404, OFF]);
      }
      expect(await stored(contentId)).toEqual([`${first.commentId}.json`]);

      // On again, they are back.
      ctx.clock.now += 1000;
      expect(ok(await storeText(alice, kindly, { contentId, comments: 'true' }), 200)).toMatchObject({ comments: true });
      expect(await list(contentId)).toEqual({ contentId, count: 1, comments: [first], nextCursor: null });
      // And a post can be given them after the fact.
      ok(await storeText(alice, 'Nothing to add #news', { contentId: closed.contentId, comments: true }), 200);
      ok(await comment(bob, closed.contentId, 'Hello'));
    });

    it("reads a post's comments a page at a time from either end, in the order they were sent, and one by its id", async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const carol = await ctx.register('carol');
      const contentId = await post(alice, 'Talk to me #news', { comments: true });
      const other = await post(alice, 'And here #news', { comments: true });

      // Who and what: a user, with something to say, on a post that is there.
      expect((await comment(null, contentId, 'Hello')).statusCode).toBe(401);
      for (const text of ['', '   ', 'x'.repeat(MAX_COMMENT_CHARS + 1)]) expect((await comment(bob, contentId, text)).statusCode).toBe(400);
      expect(refusal(await comment(bob, NO_ID, 'Hello'))).toEqual([404, 'content not found']);
      expect((await comment(bob, 'x', 'Hello')).statusCode).toBe(400);
      expect(await list(contentId)).toEqual({ contentId, count: 0, comments: [], nextCursor: null });

      // Some of them in the same millisecond: they are still in the order they were sent.
      const sent: { commentId: string; text: string }[] = [];
      for (let n = 0; n < 5; n++) {
        if (n % 2) ctx.clock.now += 1000;
        sent.push(ok(await comment(n % 2 ? bob : carol, contentId, `Comment ${n}`)));
      }
      const [c0, c1, c2, c3, c4] = sent as [(typeof sent)[0], (typeof sent)[0], (typeof sent)[0], (typeof sent)[0], (typeof sent)[0]];
      expect(sent.map((c) => c.commentId)).toEqual(sent.map((c) => c.commentId).sort());
      ok(await comment(bob, other, 'Elsewhere'));
      const longest = ok(await comment(bob, other, '字'.repeat(MAX_COMMENT_CHARS)));
      expect(longest.text).toHaveLength(MAX_COMMENT_CHARS);

      // Oldest first, unless asked for the newest; anyone reads them, with no key.
      expect(await list(contentId)).toEqual({ contentId, count: 5, comments: sent, nextCursor: null });
      expect(await list(contentId, '?order=oldest&limit=5')).toEqual({ contentId, count: 5, comments: sent, nextCursor: null });
      expect((await list(contentId, '?order=newest')).comments).toEqual([...sent].reverse());
      expect(texts(await list(other))).toEqual(['Elsewhere', longest.text]);

      // A page ends on a comment, whose id is the cursor of the next.
      const page1 = await list(contentId, '?limit=2');
      expect(page1).toEqual({ contentId, count: 5, comments: [c0, c1], nextCursor: c1.commentId });
      const page2 = await list(contentId, `?limit=2&cursor=${page1.nextCursor}`);
      expect(page2).toMatchObject({ comments: [c2, c3], nextCursor: c3.commentId });
      expect(await list(contentId, `?limit=2&cursor=${page2.nextCursor}`)).toMatchObject({ comments: [c4], nextCursor: null });
      const newest1 = await list(contentId, '?order=newest&limit=2');
      expect(newest1).toMatchObject({ count: 5, comments: [c4, c3], nextCursor: c3.commentId });
      const newest2 = await list(contentId, `?order=newest&limit=2&cursor=${newest1.nextCursor}`);
      expect(newest2).toMatchObject({ comments: [c2, c1], nextCursor: c1.commentId });
      expect(await list(contentId, `?order=newest&limit=2&cursor=${newest2.nextCursor}`)).toMatchObject({ comments: [c0], nextCursor: null });
      // One sent since a reader's first page is on a later page of the oldest first, and on none of the newest first.
      ctx.clock.now += 1000;
      const c5 = ok(await comment(carol, contentId, 'Comment 5'));
      expect(await list(contentId, `?limit=2&cursor=${page2.nextCursor}`)).toMatchObject({ count: 6, comments: [c4, c5], nextCursor: null });
      expect(await list(contentId, `?order=newest&limit=2&cursor=${newest1.nextCursor}`)).toMatchObject({ comments: [c2, c1] });
      for (const query of ['?limit=0', '?limit=101', '?order=best', '?cursor=x']) {
        expect((await req(null, 'GET', `/content/${contentId}/comments${query}`)).statusCode, query).toBe(400);
      }

      // One comment, of the post it is on.
      expect(ok(await one(null, contentId, c2.commentId), 200)).toEqual(c2);
      expect(refusal(await one(null, contentId, NO_ID))).toEqual([404, NO_COMMENT]);
      expect(refusal(await one(null, other, c2.commentId))).toEqual([404, NO_COMMENT]);
      expect(refusal(await one(null, NO_ID, c2.commentId))).toEqual([404, 'content not found']);
      expect((await one(null, contentId, 'x')).statusCode).toBe(400);
      expect(texts(await list(other))).toEqual(['Elsewhere', longest.text]);

      // A post set for deletion is gone, and so are its comments.
      ok(await req(alice, 'DELETE', `/content/${other}`), 202);
      for (const res of [await req(null, 'GET', `/content/${other}/comments`), await comment(bob, other, 'Too late'), await one(null, other, longest.commentId)]) {
        expect(refusal(res)).toEqual([404, 'content not found']);
      }
    });

    it("lets a comment's author, the post's publisher and admins delete it, and tells its author when someone else did", async () => {
      ctx = await createTestContext(target);
      const root = await ctx.register('root');
      await setAdmin(ctx.db, 'root', true);
      const mod = await ctx.register('mod');
      ok(await req(root, 'PUT', `/moderators/${mod.userId}`));
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const carol = await ctx.register('carol');
      const contentId = await post(alice, 'Talk to me #news', { comments: true });
      const other = await post(carol, 'Or to me #news', { comments: true });
      const ids: string[] = [];
      for (const text of ['First', 'Second', 'Third\nof four', 'Fourth']) {
        ctx.clock.now += 1000;
        ids.push(ok(await comment(bob, contentId, text)).commentId);
      }
      const [first, second, third, fourth] = ids as [string, string, string, string];

      // Not anyone else: not another user, nor the publisher of another post, nor a server moderator.
      expect((await remove(null, contentId, first)).statusCode).toBe(401);
      for (const u of [carol, mod]) {
        expect(refusal(await remove(u, contentId, first))).toEqual([403, "only the comment's author, the post's publisher or an admin can delete this comment"]);
      }
      expect(refusal(await remove(bob, contentId, NO_ID))).toEqual([404, NO_COMMENT]);
      expect(refusal(await remove(bob, other, first))).toEqual([404, NO_COMMENT]);
      expect(refusal(await remove(bob, NO_ID, first))).toEqual([404, 'content not found']);
      expect((await list(contentId)).count).toBe(4);

      // Its author, the post's publisher, an admin: it is gone at once, and for good.
      expect(ok(await remove(bob, contentId, first), 200)).toEqual({ contentId, commentId: first, status: 'deleted' });
      expect(refusal(await remove(bob, contentId, first))).toEqual([404, NO_COMMENT]);
      expect(refusal(await one(null, contentId, first))).toEqual([404, NO_COMMENT]);
      ctx.clock.now += 1000;
      ok(await remove(alice, contentId, second), 200);
      ctx.clock.now += 1000;
      ok(await remove(root, contentId, third), 200);
      expect(await list(contentId)).toMatchObject({ count: 1, comments: [{ commentId: fourth, text: 'Fourth' }], nextCursor: null });
      expect(texts(await list(contentId, '?order=newest'))).toEqual(['Fourth']);
      expect(await stored(contentId)).toEqual([`${fourth}.json`]);

      // Its author is told of the two they didn't delete themselves, each with the start of the comment.
      const inbox = ok(await req(bob, 'GET', `/users/${bob.userId}/inbox`), 200).inbox;
      expect(inbox.map((m: Record<string, unknown>) => [m.kind, m.contentId, m.excerpt, m.text])).toEqual([
        ['comment_deleted', contentId, 'Third of four', 'Your comment was deleted.'],
        ['comment_deleted', contentId, 'Second', 'Your comment was deleted.'],
      ]);

      // A comment written while the post took comments is still its author's to delete once it doesn't.
      ok(await storeText(alice, 'Talk to me #news', { contentId, comments: false }), 200);
      expect((await req(null, 'GET', `/content/${contentId}/comments`)).statusCode).toBe(404);
      ok(await remove(bob, contentId, fourth), 200);
      expect(await stored(contentId)).toEqual([]);
    });

    it('takes as many comments from a user in a minute as the server allows', async () => {
      ctx = await createTestContext(target, { comments: { perMinute: 2 } });
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const carol = await ctx.register('carol');
      const contentId = await post(alice, 'Talk to me #news', { comments: true });
      const closed = await post(alice, 'Not to me #news');

      ok(await comment(bob, contentId, 'One'));
      // One that isn't taken counts for nothing.
      expect((await comment(bob, closed, 'Nowhere')).statusCode).toBe(404);
      ok(await comment(bob, contentId, 'Two'));
      const limited = await comment(bob, contentId, 'Three');
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error).toMatch(/^too many comments; try again in (59|60) seconds$/);
      expect(limited.json().retryAfterSeconds).toBeGreaterThan(50);
      expect(limited.json().retryAfterSeconds).toBeLessThanOrEqual(60);
      expect(limited.headers['retry-after']).toBe(String(limited.json().retryAfterSeconds));
      // Each user has their own minute.
      ok(await comment(carol, contentId, 'Mine'));
      expect(texts(await list(contentId))).toEqual(['One', 'Two', 'Mine']);
      if (target.hot === 'memory') {
        ctx.clock.now += 60_000;
        ok(await comment(bob, contentId, 'Three'));
      }
    });

    it('keeps comments in the content store alone: what Redis loses of them is read from there again', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const contentId = await post(alice, 'Talk to me #news', { comments: true });
      const sent: { commentId: string; text: string }[] = [];
      for (const text of ['First', 'Second', 'Third']) {
        ctx.clock.now += 1000;
        sent.push(ok(await comment(bob, contentId, text)));
      }
      const index = commentIndexKey(contentId);
      const bodies = () => sent.map((c) => commentKey(c.commentId));
      expect(await stored(contentId)).toEqual(sent.map((c) => `${c.commentId}.json`));
      expect(await ctx.hot.exists([index, ...bodies()])).toEqual([true, true, true, true]);
      const whole = { contentId, count: 3, comments: sent, nextCursor: null };

      // Redis has nothing of them: one list of the store finds them, and they are kept again.
      await ctx.hot.del([index, ...bodies()]);
      expect(await list(contentId)).toEqual(whole);
      expect(await ctx.hot.exists([index, ...bodies()])).toEqual([true, true, true, true]);
      expect(await list(contentId, '?order=newest&limit=1')).toMatchObject({ count: 3, comments: [sent[2]], nextCursor: sent[2]!.commentId });
      // Only the comments themselves are gone, or one of them.
      await ctx.hot.del(bodies());
      expect(ok(await one(null, contentId, sent[1]!.commentId), 200)).toEqual(sent[1]);
      expect(await list(contentId)).toEqual(whole);

      // The index is gone, and a new comment begins another: it isn't taken for the whole of them.
      await ctx.hot.del([index]);
      ctx.clock.now += 1000;
      sent.push(ok(await comment(bob, contentId, 'Fourth')));
      expect(await ctx.hot.lexRange(index, { limit: 10 })).toEqual([sent[3]!.commentId]);
      expect(await list(contentId, '?limit=2')).toMatchObject({ count: 4, comments: [sent[0], sent[1]], nextCursor: sent[1]!.commentId });
      expect(await list(contentId)).toEqual({ contentId, count: 4, comments: sent, nextCursor: null });
      expect(await ctx.comments.count(contentId)).toBe(4);

      // An id the index holds of a comment the store doesn't have is dropped from it when it is read.
      const ghost = '00000000-0000-7000-8000-000000000000';
      await ctx.hot.lexAdd(index, [ghost], HOUR);
      expect(texts(await list(contentId))).toEqual(['First', 'Second', 'Third', 'Fourth']);
      expect(await ctx.hot.lexHas(index, ghost)).toBe(false);
      expect((await list(contentId)).count).toBe(4);

      // A deleted comment isn't brought back by an index that still has it, nor by the list that builds one.
      ok(await remove(bob, contentId, sent[0]!.commentId), 200);
      await ctx.hot.lexAdd(index, [sent[0]!.commentId], HOUR);
      expect(texts(await list(contentId))).toEqual(['Second', 'Third', 'Fourth']);
      await ctx.hot.del([index]);
      expect(await list(contentId)).toMatchObject({ count: 3, comments: sent.slice(1) });

      // Redis keeps none of it for longer than COMMENTS_HOT_HOURS, however often it is read.
      if (target.hot === 'memory') {
        ctx.clock.now += 23 * HOUR;
        expect((await list(contentId)).count).toBe(3);
        ctx.clock.now += HOUR;
        expect(await ctx.hot.exists([index])).toEqual([false]);
        expect(await list(contentId)).toMatchObject({ count: 3, comments: sent.slice(1) });
        expect(await ctx.hot.exists([index])).toEqual([true]);
      }
    });

    it('removes the comments of a post with the post', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const contentId = await post(alice, 'Talk to me #news', { comments: true });
      const kept = await post(alice, 'And to me #news', { comments: true });
      for (const text of ['First', 'Second']) ok(await comment(bob, contentId, text));
      const staying = ok(await comment(bob, kept, 'Staying'));
      expect(await stored(contentId)).toHaveLength(2);

      // Deleted, the post is gone to readers at once; the compactor then removes it, and its comments.
      ok(await req(alice, 'DELETE', `/content/${contentId}`), 202);
      expect((await req(null, 'GET', `/content/${contentId}/comments`)).statusCode).toBe(404);
      expect(await stored(contentId)).toHaveLength(2);
      const deleted: string[] = [];
      for (let i = 0; i < 2; i++) deleted.push(...(await ctx.compact()).deleted);
      expect(deleted).toEqual([contentId]);
      expect(await stored(contentId)).toEqual([]);
      expect(await ctx.hot.exists([commentIndexKey(contentId)])).toEqual([false]);
      expect(await ctx.comments.count(contentId)).toBe(0);
      expect(await list(kept)).toMatchObject({ count: 1, comments: [staying] });
    });
  });
}
