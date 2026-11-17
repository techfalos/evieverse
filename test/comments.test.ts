import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_COMMENT_CHARS, newCommentId } from '../src/comments.js';
import { loadConfig } from '../src/config.js';
import { setAdmin } from '../src/moderation/policy.js';
import { commentIndexKey, commentKey, commentLikesKey } from '../src/storage/commentStore.js';
import { HOUR } from '../src/time.js';
import { as, createTestContext, JPEG, multipart, PNG, requests, TARGETS, type TestContext, type User } from './helpers.js';

const NO_ID = '00000000-0000-4000-8000-000000000000';
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OFF = "this post doesn't take comments";
const NO_COMMENT = 'comment not found';

describe('COMMENTS_PER_MINUTE and COMMENTS_HOT_HOURS', () => {
  it('are 10 and 24 unless set, and 0 comments a minute is no limit', () => {
    const load = (env: Record<string, string> = {}) => loadConfig({}, { EVIEVERSE_CONFIG: '/nonexistent.json', ...env }).comments;
    // The limit on reading the lists of comments by address is its own setting (see ratelimit.test.ts).
    expect(load()).toEqual({ perMinute: 10, hotHours: 24, listRateLimitPerMinute: 120 });
    expect(load({ COMMENTS_PER_MINUTE: '0', COMMENTS_HOT_HOURS: '2' })).toEqual({ perMinute: 0, hotHours: 2, listRateLimitPerMinute: 120 });
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

    const { storeText, post, feedItems, like } = requests(() => ctx);
    const req = (u: User | null, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
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
    /** The files the content store holds of a post's comments: a comment each, and for a reply, what says whose it is. */
    const stored = async (contentId: string) =>
      (await readdir(join(ctx.dir, 'content', 'comments', contentId), { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort();
    /** Whose likes of a comment the content store holds. */
    const likers = async (contentId: string, commentId: string) => (await readdir(join(ctx.dir, 'content', 'comments', contentId, 'likes', commentId)).catch(() => [])).sort();
    const reply = (u: User | null, contentId: string, parentId: string, text: string) => req(u, 'POST', `/content/${contentId}/comments`, { text, parentId });
    const replies = async (contentId: string, commentId: string, query = '') => ok(await req(null, 'GET', `/content/${contentId}/comments/${commentId}/replies${query}`), 200);
    const edit = (u: User | null, contentId: string, commentId: string, text: string) => req(u, 'PATCH', `/content/${contentId}/comments/${commentId}`, { text });
    const likeComment = (u: User | null, contentId: string, commentId: string) => req(u, 'POST', '/like', { contentId, commentId });
    type SentFile = { name: string; type: string; data: Buffer };
    /** A comment sent as a form, with its image or video as the form's file. */
    const attach = (u: User | null, contentId: string, fields: Record<string, string>, file?: SentFile) => {
      const form = multipart(fields, file);
      return ctx.app.inject({ method: 'POST', url: `/content/${contentId}/comments`, payload: form.payload, headers: { ...form.headers, ...(u && as(u)) } });
    };
    /** The bytes of the image or video a comment came with. */
    const rawOf = (u: User | null, contentId: string, commentId: string) => req(u, 'GET', `/content/${contentId}/comments/${commentId}/raw`);
    /** The comments whose image or video the content store holds. */
    const filed = async (contentId: string) => (await readdir(join(ctx.dir, 'content', 'comments', contentId, 'media')).catch(() => [])).sort();
    /** What a client does with an upload link: puts the file in the content store, here a directory. */
    const putUpload = async (u: User, uploadId: string, bytes: Buffer) => {
      const dir = join(ctx.dir, 'content', 'uploads', u.userId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, uploadId), bytes);
    };
    const uploads = (u: User) => readdir(join(ctx.dir, 'content', 'uploads', u.userId)).catch(() => []);
    const uploadId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    /** A video's bytes are stored as they came, whatever they are. */
    const CLIP = Buffer.from('a video, as far as anyone checks');

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
      await ctx.compactor.runOnce();
      expect(await inFeed()).toEqual({ [closed.contentId]: false, [contentId]: true });
      // It is in the meta file, and nowhere in the database.
      expect((await ctx.content.getMeta(contentId))?.comments).toBe(true);
      expect(await list(contentId)).toEqual({ contentId, count: 0, comments: [], nextCursor: null });

      const first = ok(await comment(bob, contentId, '  First!\n'));
      expect(first).toEqual({
        commentId: expect.stringMatching(UUID_V7),
        contentId,
        parentId: null,
        author: { userId: bob.userId, username: 'bob' },
        text: 'First!',
        media: null,
        likes: 0,
        replies: 0,
        createdAt: now(),
        editedAt: null,
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
      expect(await ctx.hot.lexRange(index, { limit: 10 })).toEqual([`:${sent[3]!.commentId}`]);
      expect(await list(contentId, '?limit=2')).toMatchObject({ count: 4, comments: [sent[0], sent[1]], nextCursor: sent[1]!.commentId });
      expect(await list(contentId)).toEqual({ contentId, count: 4, comments: sent, nextCursor: null });
      expect(await ctx.comments.count(contentId)).toBe(4);

      // A comment the index holds that the store doesn't have is dropped from it when it is read.
      const ghost = ':00000000-0000-7000-8000-000000000000';
      await ctx.hot.lexAdd(index, [ghost], HOUR);
      expect(texts(await list(contentId))).toEqual(['First', 'Second', 'Third', 'Fourth']);
      expect(await ctx.hot.lexHas(index, ghost)).toBe(false);
      expect((await list(contentId)).count).toBe(4);

      // A deleted comment isn't brought back by an index that still has it, nor by the list that builds one.
      ok(await remove(bob, contentId, sent[0]!.commentId), 200);
      await ctx.hot.lexAdd(index, [`:${sent[0]!.commentId}`], HOUR);
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

    it('removes the comments of a post with the post, their replies and their likes too', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const contentId = await post(alice, 'Talk to me #news', { comments: true });
      const kept = await post(alice, 'And to me #news', { comments: true });
      const [first] = [ok(await comment(bob, contentId, 'First')), ok(await comment(bob, contentId, 'Second'))];
      ok(await reply(alice, contentId, first.commentId, 'A reply'));
      ok(await likeComment(alice, contentId, first.commentId));
      const staying = ok(await comment(bob, kept, 'Staying'));
      // Three comments, and what says one of them is a reply.
      expect(await stored(contentId)).toHaveLength(4);
      expect(await likers(contentId, first.commentId)).toEqual([alice.userId]);

      // Deleted, the post is gone to readers at once; the compactor then removes it, and its comments.
      ok(await req(alice, 'DELETE', `/content/${contentId}`), 202);
      expect((await req(null, 'GET', `/content/${contentId}/comments`)).statusCode).toBe(404);
      expect(await stored(contentId)).toHaveLength(4);
      const deleted: string[] = [];
      for (let i = 0; i < 2; i++) deleted.push(...(await ctx.compact()).deleted);
      expect(deleted).toEqual([contentId]);
      expect(await stored(contentId)).toEqual([]);
      expect(await likers(contentId, first.commentId)).toEqual([]);
      expect(await ctx.hot.exists([commentIndexKey(contentId)])).toEqual([false]);
      expect(await ctx.comments.count(contentId)).toBe(0);
      expect(await list(kept)).toMatchObject({ count: 1, comments: [staying] });
    });

    it('takes replies to a comment, and replies to those, and reads them a level at a time', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const carol = await ctx.register('carol');
      const contentId = await post(alice, 'Talk to me #news', { comments: true });
      const other = await post(alice, 'And here #news', { comments: true });
      const closed = await post(alice, 'Not here #news');
      const elsewhere = ok(await comment(bob, other, 'Elsewhere')).commentId;
      type Sent = { commentId: string; text: string };
      const having = (c: Sent, count: number) => ({ ...c, replies: count });
      const idsOf = (page: { comments: Sent[] }) => page.comments.map((c) => c.commentId);

      const top: Sent = ok(await comment(bob, contentId, 'What do you think?'));
      ctx.clock.now += 1000;
      // A reply is a comment that says which comment it replies to.
      const r1 = ok(await reply(carol, contentId, top.commentId, 'Not much'));
      expect(r1).toEqual({
        commentId: expect.stringMatching(UUID_V7),
        contentId,
        parentId: top.commentId,
        author: { userId: carol.userId, username: 'carol' },
        text: 'Not much',
        media: null,
        likes: 0,
        replies: 0,
        createdAt: now(),
        editedAt: null,
      });
      ctx.clock.now += 1000;
      const r2: Sent = ok(await reply(alice, contentId, top.commentId, 'Quite a lot'));
      ctx.clock.now += 1000;
      const r3: Sent = ok(await reply(bob, contentId, top.commentId, 'Go on'));
      // A reply is replied to as a comment is, and so on down. Two in one millisecond are still in order.
      ctx.clock.now += 1000;
      const r1a: Sent = ok(await reply(bob, contentId, r1.commentId, 'Why not?'));
      const r1b: Sent = ok(await reply(alice, contentId, r1.commentId, 'Do tell'));
      const r1a1: Sent = ok(await reply(carol, contentId, r1a.commentId, 'No reason'));
      ctx.clock.now += 1000;
      const second: Sent = ok(await comment(carol, contentId, 'Another thing'));

      // Only to a comment of the same post, that is there.
      expect((await reply(null, contentId, top.commentId, 'Hello')).statusCode).toBe(401);
      expect(refusal(await reply(carol, contentId, NO_ID, 'Hello'))).toEqual([404, NO_COMMENT]);
      expect(refusal(await reply(carol, contentId, elsewhere, 'Hello'))).toEqual([404, NO_COMMENT]);
      expect((await reply(carol, contentId, 'x', 'Hello')).statusCode).toBe(400);

      // A post's comments are the ones on the post itself, each with how many reply to it; the post counts them all.
      const whole = { contentId, count: 8, comments: [having(top, 3), second], nextCursor: null };
      expect(await list(contentId)).toEqual(whole);
      expect(idsOf(await list(contentId, '?order=newest'))).toEqual([second.commentId, top.commentId]);
      const firstPage = await list(contentId, '?limit=1');
      expect(firstPage).toEqual({ contentId, count: 8, comments: [having(top, 3)], nextCursor: top.commentId });
      expect(await list(contentId, `?limit=1&cursor=${firstPage.nextCursor}`)).toMatchObject({ comments: [second], nextCursor: null });
      expect(ok(await one(null, contentId, top.commentId), 200)).toEqual(having(top, 3));
      expect(ok(await one(null, contentId, r1.commentId), 200)).toEqual(having(r1, 2));

      // The replies to a comment are a list of their own, read as a post's comments are.
      const under = { contentId, commentId: top.commentId, count: 3, comments: [having(r1, 2), r2, r3], nextCursor: null };
      expect(await replies(contentId, top.commentId)).toEqual(under);
      expect(await replies(contentId, r1.commentId)).toEqual({ contentId, commentId: r1.commentId, count: 2, comments: [having(r1a, 1), r1b], nextCursor: null });
      expect(await replies(contentId, r1a.commentId)).toMatchObject({ count: 1, comments: [r1a1] });
      expect(await replies(contentId, r1a1.commentId)).toEqual({ contentId, commentId: r1a1.commentId, count: 0, comments: [], nextCursor: null });
      const page1 = await replies(contentId, top.commentId, '?limit=2');
      expect([idsOf(page1), page1.count, page1.nextCursor]).toEqual([[r1.commentId, r2.commentId], 3, r2.commentId]);
      expect(await replies(contentId, top.commentId, `?limit=2&cursor=${page1.nextCursor}`)).toMatchObject({ comments: [r3], nextCursor: null });
      const newest = await replies(contentId, top.commentId, '?order=newest&limit=2');
      expect(newest).toMatchObject({ comments: [r3, r2], nextCursor: r2.commentId });
      expect(idsOf(await replies(contentId, top.commentId, `?order=newest&limit=2&cursor=${newest.nextCursor}`))).toEqual([r1.commentId]);
      const repliesTo = (contentId: string, commentId: string, query = '') => req(null, 'GET', `/content/${contentId}/comments/${commentId}/replies${query}`);
      expect(refusal(await repliesTo(contentId, NO_ID))).toEqual([404, NO_COMMENT]);
      expect(refusal(await repliesTo(contentId, elsewhere))).toEqual([404, NO_COMMENT]);
      expect(refusal(await repliesTo(NO_ID, top.commentId))).toEqual([404, 'content not found']);
      expect(refusal(await repliesTo(closed, top.commentId))).toEqual([404, OFF]);
      for (const query of ['?limit=0', '?order=best', '?cursor=x']) expect((await repliesTo(contentId, top.commentId, query)).statusCode, query).toBe(400);

      // In the store, a reply is its comment and an object whose name says what it replies to. No rows anywhere.
      const all = [top, r1, r2, r3, r1a, r1b, r1a1, second];
      const pairs = [[top, r1], [top, r2], [top, r3], [r1, r1a], [r1, r1b], [r1a, r1a1]] as const;
      expect(await stored(contentId)).toEqual([...all.map((c) => `${c.commentId}.json`), ...pairs.map(([p, c]) => `${p.commentId}.${c.commentId}.reply`)].sort());
      for (const table of ['comment_queue', 'comment_reports'] as const) expect(await ctx.db.selectFrom(table).selectAll().execute()).toEqual([]);

      // Redis has nothing of them: one list of the store finds the whole tree again.
      const index = commentIndexKey(contentId);
      await ctx.hot.del([index, ...all.map((c) => commentKey(c.commentId))]);
      expect(await replies(contentId, r1.commentId)).toMatchObject({ count: 2, comments: [having(r1a, 1), r1b] });
      expect(await ctx.hot.lexHas(index, `${top.commentId}:${r1.commentId}`)).toBe(true);
      expect(await list(contentId)).toEqual(whole);
      expect(await replies(contentId, top.commentId)).toEqual(under);
      // The index is gone, and a new reply begins another: it isn't taken for the whole of them.
      await ctx.hot.del([index]);
      ctx.clock.now += 1000;
      const r4: Sent = ok(await reply(carol, contentId, top.commentId, 'One more'));
      expect(await ctx.hot.lexRange(index, { limit: 10 })).toEqual([`${top.commentId}:${r4.commentId}`]);
      expect(await replies(contentId, top.commentId)).toMatchObject({ count: 4, comments: [having(r1, 2), r2, r3, r4] });
      expect((await list(contentId)).count).toBe(9);
    });

    it('deletes a comment alone: the replies to it stay, under what is left in its place, until none is left', async () => {
      ctx = await createTestContext(target);
      const root = await ctx.register('root');
      await setAdmin(ctx.db, 'root', true);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const carol = await ctx.register('carol');
      const contentId = await post(alice, 'Talk to me #news', { comments: true });
      const inbox = async (u: User) => ok(await req(u, 'GET', `/users/${u.userId}/inbox`), 200).inbox.map((m: Record<string, unknown>) => [m.kind, m.excerpt]);
      type Sent = { commentId: string; text: string };
      const sent = async (u: User, text: string, parentId?: string): Promise<Sent> => {
        ctx.clock.now += 1000;
        return ok(await (parentId ? reply(u, contentId, parentId, text) : comment(u, contentId, text)));
      };
      /** What is left in the place of a deleted comment that has replies: where it was and when, and nothing of it. */
      const left = (c: Sent, count: number) => ({ ...c, author: null, text: '', media: null, likes: 0, replies: count, editedAt: null, status: 'deleted' });
      const reportsOf = async () => (await ctx.db.selectFrom('comment_reports').select('comment_id').execute()).map((r) => r.comment_id).sort();
      const top = await sent(bob, 'Top');
      const r1 = await sent(carol, 'One', top.commentId);
      const r1a = await sent(alice, 'One A', r1.commentId);
      const r1b = await sent(bob, 'One B', r1.commentId);
      const r1a1 = await sent(carol, 'One A 1', r1a.commentId);
      const r2 = await sent(bob, 'Two', top.commentId);
      const other = await sent(carol, 'Other');
      const otherReply = await sent(bob, 'Stays', other.commentId);
      const all = [top, r1, r1a, r1b, r1a1, r2, other, otherReply];
      const pairs = [[top, r1], [r1, r1a], [r1, r1b], [r1a, r1a1], [top, r2], [other, otherReply]] as const;
      const files = (comments: Sent[]) => [...comments.map((c) => `${c.commentId}.json`), ...pairs.filter(([, c]) => comments.includes(c)).map(([p, c]) => `${p.commentId}.${c.commentId}.reply`)].sort();
      // What a comment and its replies have of their own: likes, and reports.
      for (const c of [r1, r1a]) ok(await likeComment(alice, contentId, c.commentId));
      ok(await likeComment(bob, contentId, r1a1.commentId));
      for (const c of [r1, r1a1]) ok(await req(bob, 'POST', '/report', { contentId, commentId: c.commentId }));
      ok(await req(alice, 'POST', '/report', { contentId, commentId: other.commentId }));
      expect((await list(contentId)).count).toBe(8);

      // A reply's author deletes it: that comment is gone, and what replies to it stays where it was, whoever wrote it.
      expect(ok(await remove(carol, contentId, r1.commentId), 200)).toEqual({ contentId, commentId: r1.commentId, status: 'deleted' });
      const gone = left(r1, 2);
      expect(ok(await one(null, contentId, r1.commentId), 200)).toEqual(gone);
      expect(ok(await one(carol, contentId, r1.commentId), 200)).toEqual(gone);
      expect(await replies(contentId, r1.commentId)).toMatchObject({ count: 2, comments: [{ ...r1a, likes: 1, replies: 1 }, r1b] });
      expect(await replies(contentId, r1a.commentId)).toMatchObject({ count: 1, comments: [{ ...r1a1, likes: 1 }] });
      expect(await replies(contentId, top.commentId)).toEqual({ contentId, commentId: top.commentId, count: 2, comments: [gone, r2], nextCursor: null });
      expect(await list(contentId)).toMatchObject({ count: 8, comments: [{ commentId: top.commentId, replies: 2 }, { commentId: other.commentId, replies: 1 }] });
      // The store keeps its place, and nothing of what it was; its likes and the reports of it went with it, and no reply's did.
      expect(await stored(contentId)).toEqual(files(all));
      expect(await ctx.comments.find(contentId, r1.commentId)).toEqual({ commentId: r1.commentId, contentId, parentId: top.commentId, userId: '', text: '', createdAt: expect.any(Number), gone: 'deleted' });
      expect(await ctx.comments.get(contentId, r1.commentId)).toBeNull();
      expect(await likers(contentId, r1.commentId)).toEqual([]);
      expect(await likers(contentId, r1a.commentId)).toEqual([alice.userId]);
      expect(await likers(contentId, r1a1.commentId)).toEqual([bob.userId]);
      expect(await reportsOf()).toEqual([r1a1.commentId, other.commentId].sort());
      // Nobody is told: the replies are where they were, and their author deleted the comment.
      for (const u of [alice, bob, carol]) expect(await inbox(u)).toEqual([]);
      // What is left isn't a comment: nobody replies to it, likes it, reports it, edits it or deletes it. Its replies are replied to as before.
      expect(refusal(await reply(bob, contentId, r1.commentId, 'Too late'))).toEqual([404, NO_COMMENT]);
      for (const url of ['/like', '/report']) expect(refusal(await req(bob, 'POST', url, { contentId, commentId: r1.commentId }))).toEqual([404, NO_COMMENT]);
      expect(refusal(await edit(carol, contentId, r1.commentId, 'Back'))).toEqual([404, NO_COMMENT]);
      for (const u of [carol, alice, root]) expect(refusal(await remove(u, contentId, r1.commentId))).toEqual([404, NO_COMMENT]);
      const late = await sent(carol, 'Not too late', r1b.commentId);
      ok(await remove(carol, contentId, late.commentId), 200);

      // Redis without any of it reads the same from the store: one list finds the tree, with what is left of the comment in it.
      await ctx.hot.del([commentIndexKey(contentId), ...all.map((c) => commentKey(c.commentId))]);
      expect(await replies(contentId, top.commentId)).toEqual({ contentId, commentId: top.commentId, count: 2, comments: [gone, r2], nextCursor: null });
      expect((await list(contentId)).count).toBe(8);

      // The post's publisher deletes a comment on it, which has replies too: its author is told, of the comment.
      ok(await remove(alice, contentId, top.commentId), 200);
      expect(await inbox(bob)).toEqual([['comment_deleted', 'Top']]);
      expect(await list(contentId)).toEqual({ contentId, count: 8, comments: [left(top, 2), { ...other, replies: 1 }], nextCursor: null });
      expect(await replies(contentId, top.commentId)).toMatchObject({ count: 2, comments: [gone, r2] });

      // A comment nothing replies to leaves nothing: the comment it replied to has one reply fewer.
      ok(await remove(carol, contentId, r1a1.commentId), 200);
      expect(refusal(await one(null, contentId, r1a1.commentId))).toEqual([404, NO_COMMENT]);
      expect(refusal(await req(null, 'GET', `/content/${contentId}/comments/${r1a1.commentId}/replies`))).toEqual([404, NO_COMMENT]);
      expect(ok(await one(null, contentId, r1a.commentId), 200)).toMatchObject({ text: 'One A', replies: 0 });
      expect(await likers(contentId, r1a1.commentId)).toEqual([]);
      expect(await reportsOf()).toEqual([other.commentId]);
      expect((await list(contentId)).count).toBe(7);
      ok(await remove(alice, contentId, r1a.commentId), 200);
      expect(await replies(contentId, r1.commentId)).toMatchObject({ count: 1, comments: [r1b] });
      expect(await stored(contentId)).toEqual(files([top, r1, r1b, r2, other, otherReply]));

      // What is left of a deleted comment goes once its last reply does: it kept a place for them, and keeps none for itself.
      ok(await remove(bob, contentId, r1b.commentId), 200);
      expect(refusal(await one(null, contentId, r1.commentId))).toEqual([404, NO_COMMENT]);
      expect(await replies(contentId, top.commentId)).toEqual({ contentId, commentId: top.commentId, count: 1, comments: [r2], nextCursor: null });
      expect(await list(contentId)).toMatchObject({ count: 4, comments: [left(top, 1), { commentId: other.commentId }] });
      expect(await stored(contentId)).toEqual(files([top, r2, other, otherReply]));
      // And so on up: the last reply to what is left of a comment takes that with it.
      ok(await remove(bob, contentId, r2.commentId), 200);
      expect(refusal(await one(null, contentId, top.commentId))).toEqual([404, NO_COMMENT]);
      expect(await list(contentId)).toEqual({ contentId, count: 2, comments: [{ ...other, replies: 1 }], nextCursor: null });
      expect(await stored(contentId)).toEqual(files([other, otherReply]));
      // Nothing an index is built from brings any of them back.
      await ctx.hot.del([commentIndexKey(contentId)]);
      expect(await list(contentId)).toEqual({ contentId, count: 2, comments: [{ ...other, replies: 1 }], nextCursor: null });
      expect(await replies(contentId, other.commentId)).toMatchObject({ count: 1, comments: [otherReply] });

      // A comment that is there stays when its last reply goes.
      ctx.clock.now += 1000;
      ok(await remove(root, contentId, otherReply.commentId), 200);
      expect(await list(contentId)).toEqual({ contentId, count: 1, comments: [other], nextCursor: null });
      expect(await stored(contentId)).toEqual([`${other.commentId}.json`]);
      expect(await inbox(bob)).toEqual([
        ['comment_deleted', 'Stays'],
        ['comment_deleted', 'Top'],
      ]);
    });

    it("lets a comment's author edit it, and nobody else, and keeps its replies and its likes", async () => {
      ctx = await createTestContext(target);
      const root = await ctx.register('root');
      await setAdmin(ctx.db, 'root', true);
      const mod = await ctx.register('mod');
      ok(await req(root, 'PUT', `/moderators/${mod.userId}`));
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const carol = await ctx.register('carol');
      const text = 'Talk to me #news';
      const contentId = await post(alice, text, { comments: true });
      const other = await post(alice, 'Or here #news', { comments: true });
      const sent = ok(await comment(bob, contentId, 'Frist!'));
      const { commentId } = sent;
      const answer = ok(await reply(carol, contentId, commentId, 'First?'));
      ok(await likeComment(carol, contentId, commentId));

      // Its author, and nobody else: not the post's publisher, nor a server moderator, nor an admin.
      expect((await edit(null, contentId, commentId, 'First!')).statusCode).toBe(401);
      for (const u of [alice, carol, mod, root]) expect(refusal(await edit(u, contentId, commentId, 'First!'))).toEqual([403, "only the comment's author can edit this comment"]);
      for (const bad of ['', '   ', 'x'.repeat(MAX_COMMENT_CHARS + 1)]) expect((await edit(bob, contentId, commentId, bad)).statusCode).toBe(400);
      expect(refusal(await edit(bob, contentId, NO_ID, 'First!'))).toEqual([404, NO_COMMENT]);
      expect(refusal(await edit(bob, other, commentId, 'First!'))).toEqual([404, NO_COMMENT]);
      expect(refusal(await edit(bob, NO_ID, commentId, 'First!'))).toEqual([404, 'content not found']);
      expect(ok(await one(null, contentId, commentId), 200)).toEqual({ ...sent, likes: 1, replies: 1 });

      // It is the same comment, with another text, and says when it was edited.
      ctx.clock.now += 5000;
      const edited = ok(await edit(bob, contentId, commentId, '  First!\n'), 200);
      expect(edited).toEqual({ ...sent, text: 'First!', likes: 1, replies: 1, editedAt: now() });
      expect(edited.createdAt).not.toBe(edited.editedAt);
      expect(ok(await one(null, contentId, commentId), 200)).toEqual(edited);
      expect(await list(contentId)).toEqual({ contentId, count: 2, comments: [edited], nextCursor: null });
      expect((await replies(contentId, commentId)).comments).toEqual([answer]);

      // The text it has changes nothing, and isn't an edit.
      ctx.clock.now += 1000;
      expect(ok(await edit(bob, contentId, commentId, 'First!'), 200)).toEqual({ contentId, commentId, unchanged: true });
      expect(ok(await one(null, contentId, commentId), 200)).toEqual(edited);
      // It is the store that was edited: Redis without it reads the edit from there.
      await ctx.hot.del([commentKey(commentId)]);
      expect(ok(await one(null, contentId, commentId), 200)).toEqual(edited);
      ctx.clock.now += 1000;
      const again = ok(await edit(bob, contentId, commentId, 'First.'), 200);
      expect(again).toEqual({ ...edited, text: 'First.', editedAt: now() });
      await ctx.hot.del([commentIndexKey(contentId), commentKey(commentId)]);
      expect(await list(contentId)).toEqual({ contentId, count: 2, comments: [again], nextCursor: null });

      // A reply is edited as a comment is, and is still a reply to what it replied to.
      ctx.clock.now += 1000;
      const editedAnswer = ok(await edit(carol, contentId, answer.commentId, 'Second, then'), 200);
      expect(editedAnswer).toEqual({ ...answer, text: 'Second, then', editedAt: now() });
      expect(await replies(contentId, commentId)).toMatchObject({ count: 1, comments: [editedAnswer] });
      expect(await stored(contentId)).toEqual([`${commentId}.json`, `${answer.commentId}.json`, `${commentId}.${answer.commentId}.reply`].sort());

      // Not by a banned user, nor on a post that takes no comments now.
      ok(await req(mod, 'PUT', `/banned/${bob.userId}`));
      expect((await edit(bob, contentId, commentId, 'Banned')).statusCode).toBe(403);
      ok(await req(mod, 'DELETE', `/banned/${bob.userId}`), 200);
      ctx.clock.now += 1000;
      ok(await storeText(alice, text, { contentId, comments: false }), 200);
      expect(refusal(await edit(bob, contentId, commentId, 'Closed'))).toEqual([404, OFF]);
      ctx.clock.now += 1000;
      ok(await storeText(alice, text, { contentId, comments: true }), 200);
      expect(ok(await one(null, contentId, commentId), 200)).toEqual(again);

      // A deleted comment isn't edited (see test/pending.test.ts for an edit under way as it is deleted):
      // not one that left its place to its reply,
      ok(await remove(bob, contentId, commentId), 200);
      const gone = { ...sent, author: null, text: '', replies: 1, status: 'deleted' };
      expect(refusal(await edit(bob, contentId, commentId, 'Back'))).toEqual([404, NO_COMMENT]);
      expect(await stored(contentId)).toEqual([`${commentId}.json`, `${answer.commentId}.json`, `${commentId}.${answer.commentId}.reply`].sort());
      for (let i = 0; i < 2; i++) {
        expect(await list(contentId)).toEqual({ contentId, count: 2, comments: [gone], nextCursor: null });
        expect((await replies(contentId, commentId)).comments).toEqual([editedAnswer]);
        // Nor does Redis without it find anything else in the store.
        await ctx.hot.del([commentIndexKey(contentId), commentKey(commentId)]);
      }
      // nor one of which nothing is left.
      ok(await remove(carol, contentId, answer.commentId), 200);
      expect(refusal(await edit(bob, contentId, commentId, 'Back'))).toEqual([404, NO_COMMENT]);
      expect(await stored(contentId)).toEqual([]);
      expect(await list(contentId)).toEqual({ contentId, count: 0, comments: [], nextCursor: null });
    });

    it('counts an edit towards the comments a user sends in a minute', async () => {
      ctx = await createTestContext(target, { comments: { perMinute: 2 } });
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const contentId = await post(alice, 'Talk to me #news', { comments: true });
      const { commentId } = ok(await comment(bob, contentId, 'One'));
      // The text it has isn't an edit, and counts for nothing.
      ok(await edit(bob, contentId, commentId, 'One'), 200);
      ok(await edit(bob, contentId, commentId, 'Two'), 200);
      for (const res of [await edit(bob, contentId, commentId, 'Three'), await comment(bob, contentId, 'Three')]) {
        expect(res.statusCode).toBe(429);
        expect(res.json().error).toMatch(/^too many comments; try again in (59|60) seconds$/);
      }
      expect(texts(await list(contentId))).toEqual(['Two']);
    });

    it('takes an image or a video with a comment only where the server takes posts of that type, and a text either way', async () => {
      // A server of pictures: no text posts, and no video.
      ctx = await createTestContext(target, { postTypes: { text: false, video: false } });
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const png = { name: 'pixel.png', type: 'image/png', data: PNG };
      const form = multipart({ type: 'image', tags: 'news', comments: 'true' }, png);
      const { contentId } = ok(await ctx.app.inject({ method: 'POST', url: '/store', payload: form.payload, headers: { ...form.headers, ...as(alice) } }));

      // A comment's text is no text post.
      expect(ok(await comment(bob, contentId, 'Only words'))).toMatchObject({ text: 'Only words', media: null });
      expect(ok(await attach(bob, contentId, { text: 'Look' }, png))).toMatchObject({ media: { kind: 'image' } });
      // No video, however it is sent, and nothing of the comment is kept: its text neither.
      const NO_VIDEO = "this server doesn't take video files, as posts or with comments";
      expect(refusal(await attach(bob, contentId, { text: 'Watch' }, { name: 'clip.mp4', type: 'video/mp4', data: CLIP }))).toEqual([400, NO_VIDEO]);
      await putUpload(bob, uploadId(1), CLIP);
      expect(refusal(await req(bob, 'POST', `/content/${contentId}/comments`, { uploadId: uploadId(1), filename: 'clip.mp4' }))).toEqual([400, NO_VIDEO]);
      expect(texts(await list(contentId))).toEqual(['Only words', 'Look']);
      expect(await filed(contentId)).toHaveLength(1);
    });

    it('takes an image or a video with a comment, with a text or without, and serves it to whoever reads the comment', async () => {
      ctx = await createTestContext(target, { publicBaseUrl: 'https://api.example.com' });
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const contentId = await post(alice, 'Show me #news', { comments: true });
      const closed = await post(alice, 'Show me nothing #news');
      const urlOf = (commentId: string) => `https://api.example.com/content/${contentId}/comments/${commentId}/raw`;
      const png = { name: 'pixel.png', type: 'image/png', data: PNG };

      // A form with the file as its one file part, and the comment's fields beside it.
      const pictured = ok(await attach(bob, contentId, { text: '  Look at this\n' }, png));
      const { commentId } = pictured;
      expect(pictured).toEqual({
        commentId: expect.stringMatching(UUID_V7),
        contentId,
        parentId: null,
        author: { userId: bob.userId, username: 'bob' },
        text: 'Look at this',
        media: { kind: 'image', url: urlOf(commentId), mimeType: 'image/png', size: PNG.length },
        likes: 0,
        replies: 0,
        createdAt: now(),
        editedAt: null,
      });
      // The file is one more object in the content store, beside the comment's, and still no row anywhere.
      expect(await stored(contentId)).toEqual([`${commentId}.json`]);
      expect(await filed(contentId)).toEqual([commentId]);
      for (const table of ['comment_queue', 'comment_reports'] as const) expect(await ctx.db.selectFrom(table).selectAll().execute()).toEqual([]);

      // Anyone who reads the comment reads its file, which is served as a post's is: to show, and nothing more.
      const bytes = await rawOf(null, contentId, commentId);
      expect(bytes.statusCode, bytes.body).toBe(200);
      expect(bytes.rawPayload.equals(PNG)).toBe(true);
      expect(bytes.headers['content-type']).toBe('image/png');
      expect(bytes.headers['content-length']).toBe(String(PNG.length));
      expect(bytes.headers['x-content-type-options']).toBe('nosniff');
      expect(bytes.headers['content-security-policy']).toMatch(/default-src 'none'.*; sandbox$/);

      // The file alone is a comment: one inline in a JSON request, which says what it is by its name.
      ctx.clock.now += 1000;
      const wordless = ok(await req(bob, 'POST', `/content/${contentId}/comments`, { content: JPEG.toString('base64'), contentEncoding: 'base64', filename: 'grey.jpg' }));
      expect(wordless).toMatchObject({ text: '', media: { kind: 'image', url: urlOf(wordless.commentId), mimeType: 'image/jpeg', size: JPEG.length } });
      expect((await rawOf(null, contentId, wordless.commentId)).rawPayload.equals(JPEG)).toBe(true);

      // A video, sent to the content store first and named by its uploadId, on a reply. The upload is then gone.
      ctx.clock.now += 1000;
      await putUpload(alice, uploadId(1), CLIP);
      const clip = ok(await req(alice, 'POST', `/content/${contentId}/comments`, { text: 'And this', parentId: commentId, uploadId: uploadId(1), filename: 'clip.mp4' }));
      expect(clip).toMatchObject({ parentId: commentId, text: 'And this', media: { kind: 'video', url: urlOf(clip.commentId), mimeType: 'video/mp4', size: CLIP.length } });
      expect(await uploads(alice)).toEqual([]);
      const video = await rawOf(null, contentId, clip.commentId);
      expect(video.rawPayload.equals(CLIP)).toBe(true);
      expect(video.headers['content-type']).toBe('video/mp4');
      expect(video.headers['content-security-policy']).toMatch(/sandbox allow-same-origin$/);
      // An image sent that way is still read as the image it is, whatever it was sent as.
      await putUpload(bob, uploadId(2), PNG);
      const uploaded = ok(await req(bob, 'POST', `/content/${contentId}/comments`, { uploadId: uploadId(2), contentType: 'image/jpeg' }));
      expect(uploaded).toMatchObject({ text: '', media: { kind: 'image', mimeType: 'image/png', size: PNG.length } });
      expect(await uploads(bob)).toEqual([]);

      // They are read as any comment is, each with its file: in the list, as replies, and one at a time.
      ctx.clock.now += 1000;
      const plain = ok(await comment(bob, contentId, 'Only words'));
      expect(plain.media).toBeNull();
      const withReply = { ...pictured, replies: 1 };
      expect(await list(contentId)).toEqual({ contentId, count: 5, comments: [withReply, wordless, uploaded, plain], nextCursor: null });
      expect((await replies(contentId, commentId)).comments).toEqual([clip]);
      expect(ok(await one(null, contentId, wordless.commentId), 200)).toEqual(wordless);
      // Redis without them reads them from the store, files and all.
      await ctx.hot.del([commentIndexKey(contentId), ...[pictured, wordless, uploaded, plain].map((c) => commentKey(c.commentId))]);
      expect((await list(contentId)).comments).toEqual([withReply, wordless, uploaded, plain]);
      // A comment that is only text has no file to read, nor has one that isn't there.
      expect(refusal(await rawOf(null, contentId, plain.commentId))).toEqual([404, 'this comment has no image or video']);
      expect(refusal(await rawOf(null, contentId, NO_ID))).toEqual([404, NO_COMMENT]);
      expect(refusal(await rawOf(null, closed, commentId))).toEqual([404, OFF]);
      expect(refusal(await rawOf(null, NO_ID, commentId))).toEqual([404, 'content not found']);

      // A comment needs a text or a file, and takes one file, from one place: an image or a video, and nothing else.
      const NOTHING = 'a comment needs a text, an image or a video';
      const ONE_SOURCE = 'Send content as an uploadId, a file or a field: one of them';
      await putUpload(bob, uploadId(3), CLIP);
      for (const res of [await req(bob, 'POST', `/content/${contentId}/comments`, {}), await comment(bob, contentId, '   '), await attach(bob, contentId, { text: '' })]) {
        expect(refusal(res)).toEqual([400, NOTHING]);
      }
      expect(refusal(await attach(bob, contentId, { text: 'Listen' }, { name: 'song.mp3', type: 'audio/mpeg', data: CLIP }))).toEqual([400, 'comments take image/* and video/* files, got audio/mpeg']);
      expect(refusal(await attach(bob, contentId, {}, { name: 'report.pdf', type: 'application/pdf', data: PNG }))).toEqual([400, 'comments take image/* and video/* files, got application/pdf']);
      expect(refusal(await req(bob, 'POST', `/content/${contentId}/comments`, { text: 'Read', content: 'Some words' }))).toEqual([400, 'comments take image/* and video/* files, got text/plain']);
      expect(refusal(await attach(bob, contentId, {}, { name: 'pixel.png', type: 'image/png', data: CLIP }))).toEqual([400, 'image posts take JPEG, PNG, GIF and WebP files, and the file is none of them']);
      expect(refusal(await attach(bob, contentId, { content: 'inline' }, png))).toEqual([400, 'Send content either as a file or as a field, not both']);
      expect(refusal(await attach(bob, contentId, { uploadId: uploadId(3) }, png))).toEqual([400, ONE_SOURCE]);
      expect(refusal(await req(bob, 'POST', `/content/${contentId}/comments`, { uploadId: uploadId(3), content: PNG.toString('base64'), contentEncoding: 'base64' }))).toEqual([400, ONE_SOURCE]);
      expect((await req(bob, 'POST', `/content/${contentId}/comments`, { uploadId: uploadId(9), filename: 'clip.mp4' })).statusCode).toBe(400);
      // An upload is its user's own: nobody else's comment comes with it.
      expect((await req(alice, 'POST', `/content/${contentId}/comments`, { uploadId: uploadId(3), filename: 'clip.mp4' })).statusCode).toBe(400);
      // A file changes nothing of who comments, or where.
      expect((await attach(null, contentId, { text: 'Look' }, png)).statusCode).toBe(401);
      expect(refusal(await attach(bob, closed, { text: 'Look' }, png))).toEqual([404, OFF]);
      expect(refusal(await attach(bob, contentId, { text: 'Look', parentId: NO_ID }, png))).toEqual([404, NO_COMMENT]);
      expect(refusal(await req(bob, 'POST', `/content/${closed}/comments`, { uploadId: uploadId(3), filename: 'clip.mp4' }))).toEqual([404, OFF]);

      // A refused comment leaves nothing behind, but for an upload, which is kept for the request to be sent again.
      expect(await filed(contentId)).toEqual([commentId, wordless.commentId, clip.commentId, uploaded.commentId].sort());
      expect(await readdir(join(ctx.dir, 'tmp')).catch(() => [])).toEqual([]);
      expect(await uploads(bob)).toEqual([uploadId(3)]);
      expect(ok(await req(bob, 'POST', `/content/${contentId}/comments`, { uploadId: uploadId(3), filename: 'clip.mp4' }))).toMatchObject({ text: '', media: { kind: 'video' } });
      expect(await uploads(bob)).toEqual([]);
      expect((await list(contentId)).count).toBe(6);
    });

    it('refuses a file larger than a post may be, and counts a comment with a file as any other', async () => {
      ctx = await createTestContext(target, { maxUploadBytes: 20, comments: { perMinute: 2 } });
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const contentId = await post(alice, 'Show me #news', { comments: true });
      const clip = (data: Buffer) => ({ name: 'clip.mp4', type: 'video/mp4', data });

      expect((await attach(bob, contentId, {}, clip(Buffer.alloc(21, 1)))).statusCode).toBe(413);
      await putUpload(bob, uploadId(1), Buffer.alloc(21, 1));
      expect((await req(bob, 'POST', `/content/${contentId}/comments`, { uploadId: uploadId(1), filename: 'clip.mp4' })).statusCode).toBe(413);
      // Neither counted: only a comment that is stored does.
      ok(await attach(bob, contentId, {}, clip(Buffer.alloc(20, 1))));
      ok(await attach(bob, contentId, { text: 'Again' }, clip(Buffer.alloc(20, 2))));
      const third = await attach(bob, contentId, {}, clip(Buffer.alloc(20, 3)));
      expect(third.statusCode).toBe(429);
      expect((await list(contentId)).count).toBe(2);
      expect(await filed(contentId)).toHaveLength(2);
      expect(await readdir(join(ctx.dir, 'tmp')).catch(() => [])).toEqual([]);
    });

    it('keeps an upload for a comment to be sent again with its challenge solved, and stores nothing until then', async () => {
      ctx = await createTestContext(target, { challenge: { commentsPerMinute: 1 } });
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const contentId = await post(alice, 'Show me #news', { comments: true });
      ok(await comment(bob, contentId, 'One'));

      await putUpload(bob, uploadId(1), CLIP);
      const payload = { text: 'Two', uploadId: uploadId(1), filename: 'clip.mp4' };
      const challenged = await req(bob, 'POST', `/content/${contentId}/comments`, payload);
      expect(challenged.statusCode).toBe(428);
      expect(challenged.json()).toMatchObject({ error: 'you commented once in the last minute; solve the challenge to comment', challenge: { step: 1, steps: 1 } });
      expect(await uploads(bob)).toEqual([uploadId(1)]);
      expect(await filed(contentId)).toEqual([]);
      expect(texts(await list(contentId))).toEqual(['One']);

      const solved = ok(await req(bob, 'POST', `/content/${contentId}/comments`, { ...payload, ...(await ctx.solve(challenged.json().challenge)) }));
      expect(solved).toMatchObject({ text: 'Two', media: { kind: 'video', size: CLIP.length } });
      expect(await uploads(bob)).toEqual([]);
      expect(await filed(contentId)).toEqual([solved.commentId]);
    });

    it("keeps a comment's image or video through an edit of its text, and until the comment goes: deleted, or with the post", async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const carol = await ctx.register('carol');
      const contentId = await post(alice, 'Show me #news', { comments: true });
      const png = { name: 'pixel.png', type: 'image/png', data: PNG };
      const pictured = ok(await attach(bob, contentId, { text: 'Look' }, png));
      const { commentId } = pictured;
      ok(await likeComment(carol, contentId, commentId));

      // An edit is of the text: the file stays as it is, and a comment that has one can do without a text.
      ctx.clock.now += 1000;
      const edited = ok(await edit(bob, contentId, commentId, 'Look closer'), 200);
      expect(edited).toEqual({ ...pictured, text: 'Look closer', likes: 1, editedAt: now() });
      ctx.clock.now += 1000;
      const wordless = ok(await edit(bob, contentId, commentId, ''), 200);
      expect(wordless).toEqual({ ...edited, text: '', editedAt: now() });
      expect(ok(await edit(bob, contentId, commentId, '  '), 200)).toEqual({ contentId, commentId, unchanged: true });
      expect(ok(await one(null, contentId, commentId), 200)).toEqual(wordless);
      expect((await rawOf(null, contentId, commentId)).rawPayload.equals(PNG)).toBe(true);
      expect(await filed(contentId)).toEqual([commentId]);
      // One that has none needs its text, and an edit gives it no file.
      const plain = ok(await comment(carol, contentId, 'Only words'));
      expect(refusal(await edit(carol, contentId, plain.commentId, ''))).toEqual([400, 'text is required: the comment has no image or video']);
      expect(ok(await req(carol, 'PATCH', `/content/${contentId}/comments/${plain.commentId}`, { text: 'Words', content: PNG.toString('base64'), contentEncoding: 'base64' }), 200)).toMatchObject({ text: 'Words', media: null });

      // Deleted, the comment takes its file with it, and nobody is quoted a text it didn't have.
      ok(await remove(alice, contentId, commentId), 200);
      expect(await filed(contentId)).toEqual([]);
      expect(refusal(await rawOf(null, contentId, commentId))).toEqual([404, NO_COMMENT]);
      const inbox = ok(await req(bob, 'GET', `/users/${bob.userId}/inbox`), 200).inbox;
      expect(inbox).toMatchObject([{ kind: 'comment_deleted', contentId }]);
      expect(inbox[0].excerpt ?? null).toBeNull();

      // One that has replies leaves its place, and not its file; the replies to it keep theirs.
      const r1 = ok(await attach(bob, contentId, { parentId: plain.commentId }, png));
      const r2 = ok(await attach(alice, contentId, { parentId: r1.commentId, text: 'Mine too' }, png));
      const apart = ok(await attach(bob, contentId, {}, png));
      expect(await filed(contentId)).toEqual([r1.commentId, r2.commentId, apart.commentId].sort());
      ok(await remove(bob, contentId, r1.commentId), 200);
      expect(await filed(contentId)).toEqual([r2.commentId, apart.commentId].sort());
      expect(ok(await one(null, contentId, r1.commentId), 200)).toMatchObject({ author: null, text: '', media: null, replies: 1, status: 'deleted' });
      expect(refusal(await rawOf(null, contentId, r1.commentId))).toEqual([404, NO_COMMENT]);
      expect((await rawOf(null, contentId, r2.commentId)).rawPayload.equals(PNG)).toBe(true);
      expect(await list(contentId)).toMatchObject({ count: 4, comments: [{ commentId: plain.commentId, replies: 1 }, apart] });

      // And every file goes with the post.
      ok(await attach(carol, contentId, { parentId: apart.commentId }, png));
      expect(await filed(contentId)).toHaveLength(3);
      ok(await req(alice, 'DELETE', `/content/${contentId}`), 202);
      expect((await rawOf(null, contentId, apart.commentId)).statusCode).toBe(404);
      for (let i = 0; i < 2; i++) await ctx.compact();
      expect(await filed(contentId)).toEqual([]);
      expect(await stored(contentId)).toEqual([]);
    });

    it('takes a like of a comment from each user once, and keeps the likes in the content store alone', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const carol = await ctx.register('carol');
      const dave = await ctx.register('dave');
      const contentId = await post(alice, 'Talk to me #news', { comments: true });
      const closed = await post(alice, 'Not to me #news');
      const { commentId } = ok(await comment(bob, contentId, 'Like this'));
      const answer = ok(await reply(carol, contentId, commentId, 'And this')).commentId;
      const liked = (likes: number, alreadyLiked: boolean, id = commentId) => ({ contentId, commentId: id, likes, alreadyLiked });
      const count = commentLikesKey(commentId);

      // A user, of a comment that is there, on a post that takes comments.
      expect((await likeComment(null, contentId, commentId)).statusCode).toBe(401);
      expect(refusal(await likeComment(carol, contentId, NO_ID))).toEqual([404, NO_COMMENT]);
      expect(refusal(await likeComment(carol, NO_ID, commentId))).toEqual([404, 'content not found']);
      expect(refusal(await likeComment(carol, closed, commentId))).toEqual([404, OFF]);
      expect((await likeComment(carol, contentId, 'x')).statusCode).toBe(400);

      // Once each: liking again changes nothing. Its author likes it too, and a reply is liked as a comment is.
      expect(ok(await likeComment(carol, contentId, commentId))).toEqual(liked(1, false));
      expect(ok(await likeComment(carol, contentId, commentId), 200)).toEqual(liked(1, true));
      expect(ok(await likeComment(bob, contentId, commentId))).toEqual(liked(2, false));
      expect(ok(await likeComment(alice, contentId, answer))).toEqual(liked(1, false, answer));
      expect(await list(contentId)).toMatchObject({ comments: [{ commentId, likes: 2, replies: 1 }] });
      expect(ok(await one(null, contentId, answer), 200)).toMatchObject({ likes: 1 });
      expect(await replies(contentId, commentId)).toMatchObject({ comments: [{ commentId: answer, likes: 1 }] });

      // A like is an object in the content store, and no row: the post's likes are its own.
      expect(await likers(contentId, commentId)).toEqual([bob.userId, carol.userId].sort());
      expect(await likers(contentId, answer)).toEqual([alice.userId]);
      expect(await ctx.db.selectFrom('likes').selectAll().execute()).toEqual([]);
      expect(ok(await like(alice, contentId))).toEqual({ contentId, likes: 1, alreadyLiked: false });
      expect(await ctx.db.selectFrom('likes').select(['user_id', 'content_id']).execute()).toEqual([{ user_id: alice.userId, content_id: contentId }]);
      expect(ok(await one(null, contentId, commentId), 200)).toMatchObject({ likes: 2 });

      // Redis has nothing of them: the likes are counted from the store, and a like made is still made.
      await ctx.hot.del([count]);
      expect(ok(await likeComment(carol, contentId, commentId), 200)).toEqual(liked(2, true));
      expect(await ctx.hot.exists([count])).toEqual([true]);
      await ctx.hot.del([count]);
      expect(ok(await one(null, contentId, commentId), 200)).toMatchObject({ likes: 2 });
      await ctx.hot.del([count]);
      expect(ok(await likeComment(alice, contentId, commentId))).toEqual(liked(3, false));
      expect(await ctx.comments.likes(contentId, [answer, commentId, NO_ID])).toEqual([1, 3, 0]);

      // The same like sent twice at once is made once.
      const both = await Promise.all([likeComment(dave, contentId, commentId), likeComment(dave, contentId, commentId)]);
      expect(both.map((res) => res.statusCode).sort()).toEqual([200, 201]);
      expect(ok(await one(null, contentId, commentId), 200)).toMatchObject({ likes: 4 });
      await ctx.hot.del([count]);
      expect(ok(await one(null, contentId, commentId), 200)).toMatchObject({ likes: 4 });

      // An edit keeps them, and they go with the comment: its own, and not those of the reply to it, which stays.
      expect(ok(await edit(bob, contentId, commentId, 'Like that'), 200)).toMatchObject({ likes: 4 });
      ok(await remove(bob, contentId, commentId), 200);
      expect(await likers(contentId, commentId)).toEqual([]);
      expect(await likers(contentId, answer)).toEqual([alice.userId]);
      expect(ok(await one(null, contentId, commentId), 200)).toMatchObject({ status: 'deleted', likes: 0, replies: 1 });
      expect(ok(await one(null, contentId, answer), 200)).toMatchObject({ likes: 1 });
      expect(refusal(await likeComment(carol, contentId, commentId))).toEqual([404, NO_COMMENT]);
      expect(await ctx.hot.exists([count])).toEqual([false]);
    });
  });
}
