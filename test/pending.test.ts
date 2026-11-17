import { randomUUID } from 'node:crypto';
import { readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newCommentId } from '../src/comments.js';
import { setAdmin } from '../src/moderation/policy.js';
import { insertPending, writeUnnumbered } from '../src/pending.js';
import { as, createTestContext, feedItems, multipart, PNG, store, storeText, TARGETS, type TestContext, type User } from './helpers.js';

/** A video's bytes are stored as they came, whatever they are. */
const CLIP = Buffer.from('a video, as far as anyone checks');
const OTHER_CLIP = Buffer.from('another video, of another length');

/**
 * What a request commits and the compactor writes (`pending_writes`): the time in between, and
 * the writes that cross each other in it. The writes of these tests wait for the compactor, or
 * for `ctx.apply()`, as they do on a server (`settle: false`).
 */
for (const target of TARGETS) {
  describe(`pending writes (${target.name})`, () => {
    let ctx: TestContext;
    /** What went wrong in what a test ran in the middle of a write (see beforeCommit). */
    let crossed: unknown[] = [];
    afterEach(async () => {
      vi.restoreAllMocks();
      await ctx.close();
      const [failure] = crossed;
      crossed = [];
      if (failure) throw failure;
    });

    const req = (u: User | null, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
      ctx.app.inject({ method, url, headers: u ? as(u) : {}, ...(payload && { payload }) });
    const ok = (res: LightMyRequestResponse, status = 201) => {
      expect(res.statusCode, res.body).toBe(status);
      return res.json();
    };
    const refusal = (res: LightMyRequestResponse) => [res.statusCode, res.json().error];
    const admin = async (name = 'root') => {
      const u = await ctx.register(name);
      await setAdmin(ctx.db, name, true);
      return u;
    };
    const clip = (u: User, data: Buffer, fields: Record<string, unknown> = {}) =>
      store(ctx, u, { type: 'video', content: data.toString('base64'), contentEncoding: 'base64', contentType: 'video/mp4', tags: ['clips'], ...fields });
    const raw = (contentId: string) => req(null, 'GET', `/content/${contentId}/raw`);
    const del = (u: User, contentId: string) => req(u, 'DELETE', `/content/${contentId}`);
    const comment = (u: User, contentId: string, text: string, parentId?: string) => req(u, 'POST', `/content/${contentId}/comments`, { text, ...(parentId && { parentId }) });
    const attach = (u: User, contentId: string, text: string) => {
      const form = multipart({ text }, { name: 'pixel.png', type: 'image/png', data: PNG });
      return ctx.app.inject({ method: 'POST', url: `/content/${contentId}/comments`, payload: form.payload, headers: { ...form.headers, ...as(u) } });
    };
    const one = (u: User | null, contentId: string, commentId: string) => req(u, 'GET', `/content/${contentId}/comments/${commentId}`);
    const list = async (contentId: string) => ok(await req(null, 'GET', `/content/${contentId}/comments`), 200);
    const replies = async (contentId: string, commentId: string) => ok(await req(null, 'GET', `/content/${contentId}/comments/${commentId}/replies`), 200);
    const edit = (u: User, contentId: string, commentId: string, text: string) => req(u, 'PATCH', `/content/${contentId}/comments/${commentId}`, { text });
    const remove = (u: User, contentId: string, commentId: string) => req(u, 'DELETE', `/content/${contentId}/comments/${commentId}`);
    const likeComment = (u: User, contentId: string, commentId: string) => req(u, 'POST', '/like', { contentId, commentId });
    const rawOf = (contentId: string, commentId: string) => req(null, 'GET', `/content/${contentId}/comments/${commentId}/raw`);

    /**
     * The writes that wait for the compactor, "<number> <kind>" of each: the ones that took no number first (0: new
     * comments, likes of comments), by kind, then the numbered ones in the order they committed.
     */
    const pending = async () =>
      (await ctx.db.selectFrom('pending_writes').select(['seq', 'kind']).orderBy('seq').orderBy('kind').execute()).map((r) => `${Number(r.seq)} ${r.kind}`);
    /** The kinds of the writes that wait, in that order. */
    const kinds = async () => (await pending()).map((write) => write.split(' ')[1]);
    /** The files requests staged that the content store still holds. */
    const staged = async () => (await readdir(join(ctx.dir, 'content', 'staged')).catch(() => [])).sort();
    /** The files the content store holds of a post: its bytes and its meta file. */
    const postFiles = async (contentId: string) => (await readdir(join(ctx.dir, 'content', 'content')).catch(() => [])).filter((f) => f.startsWith(contentId)).sort();
    /** Every file the content store holds of a post's comments, by its path under them. */
    const commentFiles = async (contentId: string) => {
      const root = join(ctx.dir, 'content', 'comments', contentId);
      return (await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
        .sort();
    };
    /**
     * Runs `between` once the next write has read what it writes over, just before its commit.
     * What `between` throws fails the test, not the write (see `crossed`).
     */
    const beforeCommit = (between: () => Promise<unknown>) => {
      const transaction = ctx.db.transaction.bind(ctx.db);
      vi.spyOn(ctx.db, 'transaction').mockImplementationOnce(
        () =>
          ({
            execute: async (fn: (trx: unknown) => Promise<unknown>) => {
              await between().catch((err) => crossed.push(err));
              return transaction().execute(fn);
            },
          }) as never,
      );
    };
    /** Has the next call of a store's method do its work and then fail, as a run killed right after it would leave things. */
    const killAfter = <T extends object, K extends keyof T & string>(of: T, method: K) => {
      const real = (of[method] as (...args: unknown[]) => Promise<unknown>).bind(of);
      vi.spyOn(of, method as never).mockImplementationOnce((async (...args: unknown[]) => {
        await real(...args);
        throw new Error('killed');
      }) as never);
    };

    it('answers by the writes that wait, and writes nothing to the stores until the compactor runs', async () => {
      ctx = await createTestContext(target, { settle: false });
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');

      // A post with a file: the file is staged, and the post is a row.
      const { contentId } = ok(await clip(alice, CLIP, { text: 'One clip', comments: true }));
      expect(await pending()).toEqual(['1 post']);
      expect(await staged()).toHaveLength(1);
      expect(await postFiles(contentId)).toEqual([]);
      // Read by its id, it is there, with its bytes. It is in no feed.
      expect(ok(await req(null, 'GET', `/content/${contentId}`), 200)).toMatchObject({ contentId, text: 'One clip', tags: ['clips'], comments: true });
      const bytes = await raw(contentId);
      expect([bytes.statusCode, bytes.headers['content-type'], bytes.rawPayload.equals(CLIP)]).toEqual([200, 'video/mp4', true]);
      expect(await feedItems(ctx, 'clips')).toEqual([]);

      // A comment on it, with an image: the same.
      const sent = ok(await attach(bob, contentId, 'Look'));
      expect(await pending()).toEqual(['0 comment_put', '1 post']);
      expect(await staged()).toHaveLength(2);
      expect(await commentFiles(contentId)).toEqual([]);
      expect(ok(await one(null, contentId, sent.commentId), 200)).toEqual(sent);
      const image = await rawOf(contentId, sent.commentId);
      expect([image.statusCode, image.headers['content-type']]).toEqual([200, 'image/png']);
      // The post's list of comments is the store's: it has the comment once the compactor has run.
      expect(await list(contentId)).toEqual({ contentId, count: 0, comments: [], nextCursor: null });

      // A like of it, once: the second finds the first, which waits.
      expect(ok(await likeComment(alice, contentId, sent.commentId))).toEqual({ contentId, commentId: sent.commentId, likes: 1, alreadyLiked: false });
      expect(ok(await likeComment(alice, contentId, sent.commentId), 200)).toEqual({ contentId, commentId: sent.commentId, likes: 1, alreadyLiked: true });
      // And an edit, which is of the comment as it was sent.
      ctx.clock.now += 1000;
      const edited = ok(await edit(bob, contentId, sent.commentId, 'Look at this'), 200);
      expect(edited).toMatchObject({ commentId: sent.commentId, text: 'Look at this', media: sent.media });
      expect(ok(await one(null, contentId, sent.commentId), 200)).toMatchObject({ text: 'Look at this' });
      // The comment and the like took no number, and left the post's as it was: the edit has the one after the post's.
      expect(await pending()).toEqual(['0 comment_like', '0 comment_put', '1 post', '2 comment_put']);

      // The run writes it all, and deletes the rows and the staged files.
      await ctx.compactor.runOnce();
      expect(await pending()).toEqual([]);
      expect(await staged()).toEqual([]);
      expect(await postFiles(contentId)).toEqual([contentId, `${contentId}.meta.json`]);
      expect((await raw(contentId)).rawPayload.equals(CLIP)).toBe(true);
      expect((await feedItems(ctx, 'clips')).map((i) => i.contentId)).toEqual([contentId]);
      expect(await list(contentId)).toMatchObject({ count: 1, comments: [{ commentId: sent.commentId, text: 'Look at this', likes: 1 }] });
      expect(await commentFiles(contentId)).toEqual([`${sent.commentId}.json`, `likes/${sent.commentId}/${alice.userId}`, `media/${sent.commentId}`].sort());
      expect((await rawOf(contentId, sent.commentId)).rawPayload.equals(image.rawPayload)).toBe(true);
      expect(ok(await likeComment(alice, contentId, sent.commentId), 200)).toMatchObject({ likes: 1, alreadyLiked: true });
    });

    it('never applies an update that committed before its post was set for deletion, and refuses one that commits after', async () => {
      ctx = await createTestContext(target, { settle: false });
      const alice = await ctx.register('alice');
      const { contentId } = ok(await clip(alice, CLIP));
      await ctx.compactor.runOnce();

      // An update that committed, and waits: the deletion comes before the compactor does.
      ctx.clock.now += 1000;
      ok(await clip(alice, OTHER_CLIP, { contentId }), 200);
      expect(await pending()).toEqual(['2 post']);
      expect(await staged()).toHaveLength(1);
      ok(await del(alice, contentId), 202);

      // One that read the post before the deletion, and commits after it: refused, and nothing of it is left.
      const other = ok(await clip(alice, CLIP)).contentId;
      beforeCommit(() => del(alice, other));
      expect(refusal(await clip(alice, OTHER_CLIP, { contentId: other }))).toEqual([409, 'content is set for deletion']);
      expect(refusal(await clip(alice, OTHER_CLIP, { contentId }))).toEqual([409, 'content is set for deletion']);
      expect(await pending()).toEqual(['1 post', '2 post']);
      expect(await staged()).toHaveLength(2);

      // The run writes neither post, and deletes both, with what their writes staged.
      const putMeta = vi.spyOn(ctx.content, 'putMeta');
      expect((await ctx.compactor.runOnce()).deleted.sort()).toEqual([contentId, other].sort());
      expect(putMeta).not.toHaveBeenCalled();
      expect(await pending()).toEqual([]);
      expect(await staged()).toEqual([]);
      expect([...(await postFiles(contentId)), ...(await postFiles(other))]).toEqual([]);
      expect(await ctx.db.selectFrom('content').select('id').execute()).toEqual([]);
    });

    it('writes no comment, edit, like or removal under a post that is set for deletion, whichever committed first', async () => {
      ctx = await createTestContext(target, { settle: false });
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const contentId = ok(await storeText(ctx, alice, 'Talk to me #news', { comments: true })).contentId;
      const first = ok(await comment(bob, contentId, 'First'));
      await ctx.compactor.runOnce();
      expect(await commentFiles(contentId)).toEqual([`${first.commentId}.json`]);

      // These committed before the deletion, and wait: a comment with an image, a like, an edit and a removal.
      const second = ok(await attach(bob, contentId, 'Second'));
      ok(await likeComment(alice, contentId, first.commentId));
      ok(await edit(bob, contentId, first.commentId, 'First, edited'), 200);
      ok(await remove(bob, contentId, second.commentId), 200);
      expect(await pending()).toEqual(['0 comment_like', '0 comment_put', '2 comment_put', '3 comment_remove']);
      expect(await staged()).toHaveLength(1);

      // A comment under way as the post is deleted, and whatever is sent after: refused.
      beforeCommit(() => del(alice, contentId));
      expect(refusal(await comment(bob, contentId, 'Too late'))).toEqual([404, 'content not found']);
      expect(refusal(await likeComment(bob, contentId, first.commentId))).toEqual([404, 'content not found']);
      expect(refusal(await edit(bob, contentId, first.commentId, 'Too late'))).toEqual([404, 'content not found']);
      expect(refusal(await remove(bob, contentId, first.commentId))).toEqual([404, 'content not found']);
      expect(await pending()).toHaveLength(4);

      // The run applies none of them: the comment is as it was until the post goes, and everything under it with it.
      const written = [vi.spyOn(ctx.comments, 'publish'), vi.spyOn(ctx.comments, 'put'), vi.spyOn(ctx.comments, 'addLike'), vi.spyOn(ctx.comments, 'remove')];
      expect((await ctx.compactor.runOnce()).deleted).toEqual([contentId]);
      for (const spy of written) expect(spy).not.toHaveBeenCalled();
      expect(await pending()).toEqual([]);
      expect(await staged()).toEqual([]);
      expect(await commentFiles(contentId)).toEqual([]);
      expect(await ctx.db.selectFrom('comment_queue').selectAll().execute()).toEqual([]);
    });

    it('does not bring a deleted comment back by an edit or a like that was under way, and takes with it the ones that committed before', async () => {
      ctx = await createTestContext(target, { settle: false });
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const contentId = ok(await storeText(ctx, alice, 'Talk to me #news', { comments: true })).contentId;
      const [a, b, c] = [ok(await comment(bob, contentId, 'A')), ok(await comment(bob, contentId, 'B')), ok(await comment(bob, contentId, 'C'))];
      await ctx.compactor.runOnce();
      expect((await list(contentId)).count).toBe(3);

      // An edit that read the comment before it was deleted, and commits after.
      beforeCommit(() => remove(bob, contentId, a.commentId));
      expect(refusal(await edit(bob, contentId, a.commentId, 'Back'))).toEqual([404, 'comment not found']);
      // A like, the same; and a reply.
      beforeCommit(() => remove(bob, contentId, b.commentId));
      expect(refusal(await likeComment(alice, contentId, b.commentId))).toEqual([404, 'comment not found']);
      expect(refusal(await comment(alice, contentId, 'To B', b.commentId))).toEqual([404, 'comment not found']);
      // From the commit on, the comment is gone to whoever asks for it by its id.
      expect(refusal(await one(null, contentId, a.commentId))).toEqual([404, 'comment not found']);

      // A like and an edit that committed before the deletion are applied before it, and go with the comment.
      ok(await likeComment(alice, contentId, c.commentId));
      ok(await edit(bob, contentId, c.commentId, 'C, edited'), 200);
      ok(await remove(bob, contentId, c.commentId), 200);
      expect(await kinds()).toEqual(['comment_like', 'comment_remove', 'comment_remove', 'comment_put', 'comment_remove']);

      expect(await ctx.apply()).toBe(true);
      expect(await pending()).toEqual([]);
      expect(await list(contentId)).toEqual({ contentId, count: 0, comments: [], nextCursor: null });
      expect(await commentFiles(contentId)).toEqual([]);
    });

    it('keeps the hashtag a moderator removed off a post, and the one a repost gave on it, whatever an update that was under way says', async () => {
      ctx = await createTestContext(target, { settle: false });
      const root = await admin();
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const contentId = ok(await storeText(ctx, alice, 'Flooding in Mumbai #news #mumbai')).contentId;
      await ctx.compactor.runOnce();
      const tags = async () => (await ctx.content.getMeta(contentId))!.tags;
      const shown = async (tag: string) => (await feedItems(ctx, tag)).map((i) => [i.preview.text, i.tags]);

      // The update passed moderation with the hashtag; a moderator removes it, and the compactor applies that, before the update commits.
      ctx.clock.now += 1000;
      beforeCommit(async () => {
        ok(await req(root, 'DELETE', `/content/${contentId}/tags/news`), 200);
        ctx.clock.now += 1000;
        await ctx.compactor.runOnce();
        expect(await tags()).toEqual(['mumbai']);
      });
      expect(ok(await storeText(ctx, alice, 'Still flooding #news #mumbai', { contentId }), 200)).toMatchObject({ tags: ['news', 'mumbai'] });
      await ctx.compactor.runOnce();
      expect(await tags()).toEqual(['mumbai']);
      expect(await shown('news')).toEqual([]);
      expect(await shown('mumbai')).toEqual([['Still flooding #news #mumbai', ['mumbai']]]);

      // The update read the post before a repost gave it a hashtag, and commits after: it says nothing of that hashtag.
      ctx.clock.now += 1000;
      beforeCommit(async () => ok(await ctx.app.inject({ method: 'POST', url: '/repost', payload: { ...bob, contentId, tags: 'weather' } })));
      expect(ok(await storeText(ctx, alice, 'The water recedes #mumbai', { contentId }), 200)).toMatchObject({ tags: ['mumbai'] });
      await ctx.compactor.runOnce();
      expect(await tags()).toEqual(['mumbai', 'weather']);
      expect(await shown('weather')).toEqual([['The water recedes #mumbai', ['mumbai', 'weather']]]);
      expect(await shown('mumbai')).toEqual([['The water recedes #mumbai', ['mumbai', 'weather']]]);
      expect(await pending()).toEqual([]);
    });

    it('applies again a write that a run wrote and was killed before it deleted, which changes nothing', async () => {
      ctx = await createTestContext(target, { settle: false });
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const contentId = ok(await storeText(ctx, alice, 'Talk to me #news', { comments: true })).contentId;
      const sent = ok(await comment(bob, contentId, 'First'));
      ok(await likeComment(alice, contentId, sent.commentId));
      expect(await pending()).toEqual(['0 comment_like', '0 comment_put', '1 post']);

      // Killed once the post's meta file was written, and once the comment was: the rows are still there.
      killAfter(ctx.content, 'putMeta');
      killAfter(ctx.comments, 'put');
      await ctx.compactor.runOnce();
      expect(await pending()).toEqual(['0 comment_like', '0 comment_put', '1 post']);
      expect(await postFiles(contentId)).toEqual([contentId, `${contentId}.meta.json`]);
      // The like waits for the comment's write, which is before it.
      expect(await commentFiles(contentId)).toEqual([`${sent.commentId}.json`]);

      // The next run applies them again, and is killed once the like was made.
      killAfter(ctx.comments, 'addLike');
      await ctx.compactor.runOnce();
      expect(await pending()).toEqual(['0 comment_like']);
      await ctx.compactor.runOnce();
      expect(await pending()).toEqual([]);

      expect((await feedItems(ctx, 'news')).map((i) => i.contentId)).toEqual([contentId]);
      expect(await list(contentId)).toMatchObject({ count: 1, comments: [{ commentId: sent.commentId, text: 'First', likes: 1 }] });
      expect(await commentFiles(contentId)).toEqual([`${sent.commentId}.json`, `likes/${sent.commentId}/${alice.userId}`]);
      expect(await ctx.comments.likes(contentId, [sent.commentId])).toEqual([1]);
    });

    it('leaves a placeholder for a deleted comment whose held reply is accepted before the compactor runs, and publishes the reply under it', async () => {
      ctx = await createTestContext(target, { settle: false, trust: { deleteBelow: 0 } });
      const root = await admin();
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const carol = await ctx.register('carol');
      ok(await req(root, 'POST', '/moderation/blocked-words', { words: ['spam'] }), 200);
      const contentId = ok(await storeText(ctx, alice, 'Talk to me #news', { comments: true })).contentId;
      const parent = ok(await comment(bob, contentId, 'An honest comment'));
      const held = ok(await comment(carol, contentId, 'Not spam, honestly', parent.commentId), 202);
      await ctx.compactor.runOnce();
      expect(await list(contentId)).toMatchObject({ count: 1, comments: [{ commentId: parent.commentId, replies: 0 }] });

      // The comment is deleted while its reply waits in the queue, and the reply is accepted before the compactor runs:
      // the reply is then in neither the queue nor the post's comments, and still a reply.
      ok(await remove(bob, contentId, parent.commentId), 200);
      ok(await req(root, 'POST', `/moderation/queue/${contentId}/comments/${held.commentId}/accept`), 200);
      expect((await pending()).map((w) => w.split(' ')[1])).toEqual(['comment_remove', 'comment_put']);
      expect(await ctx.db.selectFrom('comment_queue').selectAll().execute()).toEqual([]);

      expect(await ctx.apply()).toBe(true);
      expect(await pending()).toEqual([]);
      expect(await list(contentId)).toMatchObject({ count: 2, comments: [{ commentId: parent.commentId, status: 'deleted', author: null, text: '', replies: 1 }] });
      expect(await replies(contentId, parent.commentId)).toMatchObject({ count: 1, comments: [{ commentId: held.commentId, text: 'Not spam, honestly' }] });
    });

    it('writes a comment once for all the writes of it that wait, as the newest has it', async () => {
      ctx = await createTestContext(target, { settle: false });
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const contentId = ok(await storeText(ctx, alice, 'Talk to me #news', { comments: true })).contentId;
      await ctx.compactor.runOnce();

      const sent = ok(await comment(bob, contentId, 'Frist'));
      ctx.clock.now += 1000;
      ok(await edit(bob, contentId, sent.commentId, 'First'), 200);
      ok(await likeComment(alice, contentId, sent.commentId));
      ctx.clock.now += 1000;
      ok(await edit(bob, contentId, sent.commentId, 'First!'), 200);
      expect(await kinds()).toEqual(['comment_like', 'comment_put', 'comment_put', 'comment_put']);

      const [put, publish, addLike] = [vi.spyOn(ctx.comments, 'put'), vi.spyOn(ctx.comments, 'publish'), vi.spyOn(ctx.comments, 'addLike')];
      expect(await ctx.apply()).toBe(true);
      expect(put.mock.calls.map(([written]) => written.text)).toEqual(['First!']);
      expect(publish).not.toHaveBeenCalled();
      expect(addLike).toHaveBeenCalledTimes(1);
      expect(await pending()).toEqual([]);
      expect(await list(contentId)).toMatchObject({ count: 1, comments: [{ commentId: sent.commentId, text: 'First!', likes: 1 }] });
      expect(await commentFiles(contentId)).toEqual([`${sent.commentId}.json`, `likes/${sent.commentId}/${alice.userId}`]);
    });

    it('keeps the place of a comment that was published and then held before the compactor ran, with its reply under it', async () => {
      ctx = await createTestContext(target, { settle: false, trust: { deleteBelow: 0 } });
      const root = await admin();
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const carol = await ctx.register('carol');
      ok(await req(root, 'POST', '/moderation/blocked-words', { words: ['spam'] }), 200);
      const contentId = ok(await storeText(ctx, alice, 'Talk to me #news', { comments: true })).contentId;
      await ctx.compactor.runOnce();

      // Published, replied to, and then edited into the moderation queue: three writes, and no run between them.
      const parent = ok(await comment(bob, contentId, 'An honest comment'));
      const reply = ok(await comment(carol, contentId, 'I agree', parent.commentId));
      ctx.clock.now += 1000;
      ok(await edit(bob, contentId, parent.commentId, 'Buy spam'), 202);
      expect(await kinds()).toEqual(['comment_put', 'comment_put', 'comment_put']);

      const put = vi.spyOn(ctx.comments, 'put');
      expect(await ctx.apply()).toBe(true);
      expect(await pending()).toEqual([]);
      // What it said while it was published is written nowhere: the write that held it is the one that counts.
      expect(put.mock.calls.map(([written]) => written.text)).not.toContain('An honest comment');
      // It waits, and what stands in its place keeps its reply where it was.
      expect(await list(contentId)).toMatchObject({ count: 2, comments: [{ commentId: parent.commentId, status: 'pending_review', author: null, text: '', replies: 1 }] });
      expect(await replies(contentId, parent.commentId)).toMatchObject({ count: 1, comments: [{ commentId: reply.commentId, text: 'I agree' }] });
      expect(await commentFiles(contentId)).toEqual(
        [`${parent.commentId}.json`, `${parent.commentId}.${reply.commentId}.reply`, `${reply.commentId}.json`, `held/${parent.commentId}.json`].sort(),
      );

      // Accepted, it is published where it was.
      ok(await req(root, 'POST', `/moderation/queue/${contentId}/comments/${parent.commentId}/accept`), 200);
      expect(await ctx.apply()).toBe(true);
      expect(await list(contentId)).toMatchObject({ count: 2, comments: [{ commentId: parent.commentId, text: 'Buy spam', replies: 1 }] });
      expect(await commentFiles(contentId)).toEqual([`${parent.commentId}.json`, `${parent.commentId}.${reply.commentId}.reply`, `${reply.commentId}.json`].sort());
    });

    it('applies the other comments of a post when one fails, and leaves that one, its reply and its removal for the next run', async () => {
      ctx = await createTestContext(target, { settle: false });
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const contentId = ok(await storeText(ctx, alice, 'Talk to me #news', { comments: true })).contentId;
      await ctx.compactor.runOnce();

      const a = ok(await comment(bob, contentId, 'A'));
      const b = ok(await comment(bob, contentId, 'B'));
      const toA = ok(await comment(alice, contentId, 'To A', a.commentId));
      ok(await likeComment(alice, contentId, b.commentId));
      ok(await remove(bob, contentId, a.commentId), 200);
      expect(await pending()).toEqual(['0 comment_like', '0 comment_put', '0 comment_put', '0 comment_put', '2 comment_remove']);

      // The store takes every comment but A.
      const put = ctx.comments.put.bind(ctx.comments);
      vi.spyOn(ctx.comments, 'put').mockImplementation(async (written, opts) => {
        if (written.commentId === a.commentId) throw new Error('the store is unavailable');
        return put(written, opts);
      });
      expect(await ctx.apply()).toBe(true);
      // B is written, with its like. A's write is left, and with it what can't be applied before it: its reply, and its removal.
      expect(await pending()).toEqual(['0 comment_put', '0 comment_put', '2 comment_remove']);
      expect(await list(contentId)).toMatchObject({ count: 1, comments: [{ commentId: b.commentId, text: 'B', likes: 1 }] });

      // The next run applies them as the first would have: A is removed, and its place kept for the reply.
      vi.restoreAllMocks();
      expect(await ctx.apply()).toBe(true);
      expect(await pending()).toEqual([]);
      const listed = await list(contentId);
      expect(listed.count).toBe(3);
      const byId = new Map<string, Record<string, unknown>>(listed.comments.map((c: { commentId: string }) => [c.commentId, c]));
      expect(byId.get(a.commentId)).toMatchObject({ status: 'deleted', author: null, text: '', replies: 1 });
      expect(byId.get(b.commentId)).toMatchObject({ text: 'B', likes: 1 });
      expect(await replies(contentId, a.commentId)).toMatchObject({ count: 1, comments: [{ commentId: toA.commentId, text: 'To A' }] });
    });

    it('publishes a comment whose staged file is gone with its text alone, and removes one that was nothing else, holding nothing up', async () => {
      ctx = await createTestContext(target, { settle: false });
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const carol = await ctx.register('carol');
      const contentId = ok(await storeText(ctx, alice, 'Talk to me #news', { comments: true })).contentId;
      await ctx.compactor.runOnce();

      const withText = ok(await attach(bob, contentId, 'Look'));
      const fileOnly = ok(await attach(bob, contentId, ''));
      const alone = ok(await attach(carol, contentId, ''));
      const reply = ok(await comment(carol, contentId, 'Nice', fileOnly.commentId));
      const after = ok(await comment(carol, contentId, 'After'));
      ok(await likeComment(alice, contentId, alone.commentId));
      expect(await staged()).toHaveLength(3);

      // The files are gone from where they waited, as a bucket that expired them leaves things.
      for (const file of await staged()) await rm(join(ctx.dir, 'content', 'staged', file));
      expect(await ctx.apply()).toBe(true);
      expect(await pending()).toEqual([]);

      const listed = await list(contentId);
      const byId = new Map<string, Record<string, unknown>>(listed.comments.map((c: { commentId: string }) => [c.commentId, c]));
      // The one with a text says what it said, with no file.
      expect(byId.get(withText.commentId)).toMatchObject({ text: 'Look', media: null });
      expect(refusal(await rawOf(contentId, withText.commentId))[0]).toBe(404);
      // The one that was only its file is removed, as a deleted comment is: its place is kept for the reply it has.
      expect(byId.get(fileOnly.commentId)).toMatchObject({ status: 'deleted', author: null, replies: 1 });
      expect(await replies(contentId, fileOnly.commentId)).toMatchObject({ count: 1, comments: [{ commentId: reply.commentId, text: 'Nice' }] });
      // The one nothing replies to leaves nothing, and its like is made of nothing.
      expect(refusal(await one(null, contentId, alone.commentId))).toEqual([404, 'comment not found']);
      // And what was sent after them is there.
      expect(byId.get(after.commentId)).toMatchObject({ text: 'After' });
      expect(listed.count).toBe(4);
      expect(await commentFiles(contentId)).toEqual(
        [`${withText.commentId}.json`, `${fileOnly.commentId}.json`, `${fileOnly.commentId}.${reply.commentId}.reply`, `${reply.commentId}.json`, `${after.commentId}.json`].sort(),
      );
    });

    it('keeps a staged file it applied for as long as a link to it may be in use, where the store signs links, and deletes it with its post', async () => {
      ctx = await createTestContext(target, { settle: false });
      // A store that signs links, good for a quarter of an hour.
      vi.spyOn(ctx.content, 'linkMs').mockReturnValue(900_000);
      const alice = await ctx.register('alice');
      const kept = async () => (await ctx.db.selectFrom('staged_removals').select(['staged_key', 'content_id']).execute()).map((r) => `${r.content_id} ${r.staged_key}`);

      const { contentId } = ok(await clip(alice, CLIP));
      const [file] = await staged();
      await ctx.compactor.runOnce();
      // The write is applied, and the file it staged is still there for whoever was sent to it.
      expect(await pending()).toEqual([]);
      expect(await postFiles(contentId)).toEqual([contentId, `${contentId}.meta.json`]);
      expect(await staged()).toEqual([file]);
      expect(await kept()).toEqual([`${contentId} staged/${file}`]);

      // For as long as the link is good, and a minute more.
      ctx.clock.now += 900_000;
      expect(await ctx.apply()).toBe(true);
      expect(await staged()).toEqual([file]);
      ctx.clock.now += 61_000;
      expect(await ctx.apply()).toBe(true);
      expect(await staged()).toEqual([]);
      expect(await kept()).toEqual([]);
      expect((await raw(contentId)).rawPayload.equals(CLIP)).toBe(true);

      // A post that is deleted meanwhile takes the file with it, whatever time it had left.
      const other = ok(await clip(alice, OTHER_CLIP)).contentId;
      await ctx.compactor.runOnce();
      expect(await staged()).toHaveLength(1);
      expect(await kept()).toHaveLength(1);
      ok(await del(alice, other), 202);
      expect((await ctx.compactor.runOnce()).deleted).toEqual([other]);
      expect(await staged()).toEqual([]);
      expect(await kept()).toEqual([]);
    });

    it("makes a user's like of a comment once, whichever of their requests commits it", async () => {
      ctx = await createTestContext(target, { settle: false });
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const contentId = ok(await storeText(ctx, alice, 'Talk to me #news', { comments: true })).contentId;
      const sent = ok(await comment(bob, contentId, 'First'));

      // Two at once: both find no like, and the row's key lets one of them in.
      const both = await Promise.all([likeComment(alice, contentId, sent.commentId), likeComment(alice, contentId, sent.commentId)]);
      expect(both.map((res) => res.statusCode).sort()).toEqual([200, 201]);
      expect(both.map((res) => res.json().alreadyLiked).sort()).toEqual([false, true]);
      expect(await pending()).toEqual(['0 comment_like', '0 comment_put', '1 post']);
      expect(ok(await likeComment(bob, contentId, sent.commentId))).toMatchObject({ likes: 2, alreadyLiked: false });

      await ctx.compactor.runOnce();
      expect(await pending()).toEqual([]);
      expect(await ctx.comments.likes(contentId, [sent.commentId])).toEqual([2]);
      expect(ok(await likeComment(alice, contentId, sent.commentId), 200)).toMatchObject({ likes: 2, alreadyLiked: true });
    });

    // SQLite has one connection, which runs one transaction at a time: there is nothing of it to hold open beside another.
    it.skipIf(target.dialect === 'sqlite')('takes the comments and the likes of one post side by side, with no lock on the post and no number of it', async () => {
      ctx = await createTestContext(target, { settle: false });
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const contentId = ok(await storeText(ctx, alice, 'Talk to me #news', { comments: true })).contentId;
      const first = ok(await comment(bob, contentId, 'First'));
      const seq = async () => Number((await ctx.db.selectFrom('content').select('seq').where('id', '=', contentId).executeTakeFirstOrThrow()).seq);
      expect(await seq()).toBe(1);

      // A comment whose transaction has written its row and is yet to commit.
      let reached!: () => void;
      let release!: () => void;
      const paused = new Promise<void>((resolve) => (reached = resolve));
      const released = new Promise<void>((resolve) => (release = resolve));
      const slowId = newCommentId(ctx.clock.now);
      const slow = writeUnnumbered(ctx.db, target.dialect, contentId, {}, async (trx) => {
        const written = { commentId: slowId, contentId, userId: bob.userId, text: 'Slow', createdAt: ctx.clock.now };
        await insertPending(trx, { contentId, key: slowId, kind: 'comment_put', commentId: slowId, payload: { comment: written, held: false }, at: ctx.clock.now });
        reached();
        await released;
      });
      await paused;

      // Others commit meanwhile: a comment, a reply and a like. None waits for it, nor for each other.
      try {
        const second = ok(await comment(alice, contentId, 'Second'));
        ok(await comment(alice, contentId, 'To the first', first.commentId));
        ok(await likeComment(alice, contentId, first.commentId));
        expect(ok(await one(null, contentId, second.commentId), 200)).toMatchObject({ text: 'Second' });
        expect(await pending()).toEqual(['0 comment_like', '0 comment_put', '0 comment_put', '0 comment_put', '1 post']);
      } finally {
        release();
        await slow;
      }
      // The post's row is as it was: none of them took a number.
      expect(await seq()).toBe(1);

      // They are listed in the order they were sent in, which their ids are in, whichever committed first.
      await ctx.compactor.runOnce();
      expect(await pending()).toEqual([]);
      expect(await list(contentId)).toMatchObject({ count: 4, comments: [{ text: 'First', likes: 1, replies: 1 }, { text: 'Slow' }, { text: 'Second' }] });
    });

    it('keeps the place of a comment for a reply that commits as the compactor removes the comment', async () => {
      ctx = await createTestContext(target, { settle: false });
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const contentId = ok(await storeText(ctx, alice, 'Talk to me #news', { comments: true })).contentId;
      const parent = ok(await comment(bob, contentId, 'First'));
      await ctx.compactor.runOnce();

      // A reply that has read the comment in its transaction, found it there, and is yet to write its row.
      let reached!: () => void;
      let release!: () => void;
      const paused = new Promise<void>((resolve) => (reached = resolve));
      const released = new Promise<void>((resolve) => (release = resolve));
      const get = ctx.comments.get.bind(ctx.comments);
      let reads = 0;
      vi.spyOn(ctx.comments, 'get').mockImplementation(async (postId, commentId) => {
        const found = await get(postId, commentId);
        // The reply reads it twice: before its transaction, and in it.
        if (commentId === parent.commentId && ++reads === 2) {
          reached();
          await released;
        }
        return found;
      });
      const replying = comment(alice, contentId, 'To the first', parent.commentId);
      await paused;

      // The comment is deleted meanwhile, and the compactor runs. On PostgreSQL the deletion commits at once, and the run
      // waits for the reply before it decides what to leave; elsewhere the deletion itself waits for the reply to commit.
      const removing = remove(bob, contentId, parent.commentId);
      if (target.dialect === 'postgres') ok(await removing, 200);
      let ran = false;
      const running = ctx.compactor.runOnce().then(() => (ran = true));
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (target.dialect === 'postgres') expect(ran).toBe(false);
      release();
      const reply = ok(await replying);
      ok(await removing, 200);
      await running;
      await ctx.compactor.runOnce();
      expect(await pending()).toEqual([]);

      // The reply is there, under what is left of the comment: nothing of it but its place.
      expect(await list(contentId)).toMatchObject({ count: 2, comments: [{ commentId: parent.commentId, status: 'deleted', author: null, text: '', replies: 1 }] });
      expect(await replies(contentId, parent.commentId)).toMatchObject({ count: 1, comments: [{ commentId: reply.commentId, text: 'To the first' }] });
      // And nothing replies to it from then on.
      expect(refusal(await comment(alice, contentId, 'Too late', parent.commentId))).toEqual([404, 'comment not found']);
    });

    it('deletes with a post the file of a comment that committed as the post was being deleted', async () => {
      ctx = await createTestContext(target, { settle: false });
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const contentId = ok(await storeText(ctx, alice, 'Talk to me #news', { comments: true })).contentId;
      await ctx.compactor.runOnce();
      ok(await attach(bob, contentId, 'Look'));
      ok(await del(alice, contentId), 202);
      expect(await staged()).toHaveLength(1);

      // A comment that read the post before the deletion was set commits its row, and the file it staged, as the run
      // deletes the files of the post's rows: after the run has read which there are.
      const late = newCommentId(ctx.clock.now);
      const file = randomUUID();
      const removeStaged = ctx.content.removeStaged.bind(ctx.content);
      vi.spyOn(ctx.content, 'removeStaged').mockImplementationOnce(async (key) => {
        await writeFile(join(ctx.dir, 'content', 'staged', file), PNG);
        await ctx.db.transaction().execute((trx) =>
          insertPending(trx, {
            contentId,
            key: late,
            kind: 'comment_put',
            commentId: late,
            payload: { comment: { commentId: late, contentId, userId: bob.userId, text: 'Late', createdAt: ctx.clock.now }, held: false },
            stagedKey: `staged/${file}`,
            at: ctx.clock.now,
          }),
        );
        return removeStaged(key);
      });
      expect((await ctx.compactor.runOnce()).deleted).toEqual([contentId]);
      expect(await staged()).toEqual([]);
      expect(await pending()).toEqual([]);
      expect(await ctx.db.selectFrom('content').select('id').execute()).toEqual([]);
    });

    it('finishes the write it is making when the compactor is stopped, makes no other, and frees the lease', async () => {
      ctx = await createTestContext(target, { settle: false, compact: { intervalSeconds: 1 } });
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const contentId = ok(await storeText(ctx, alice, 'Talk to me #news', { comments: true })).contentId;
      ok(await comment(bob, contentId, 'First'));
      expect(await pending()).toEqual(['0 comment_put', '1 post']);

      // The compactor's pass is held as it writes the post's meta file.
      let reached!: () => void;
      let release!: () => void;
      const paused = new Promise<void>((resolve) => (reached = resolve));
      const released = new Promise<void>((resolve) => (release = resolve));
      const putMeta = ctx.content.putMeta.bind(ctx.content);
      vi.spyOn(ctx.content, 'putMeta').mockImplementationOnce(async (meta) => {
        reached();
        await released;
        return putMeta(meta);
      });
      const stop = ctx.compactor.start();
      await paused;

      // Told to stop, it waits for that write.
      let stopped = false;
      const stopping = stop().then(() => (stopped = true));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(stopped).toBe(false);
      release();
      await stopping;

      // The post was written, whole, and its row deleted. The comment's write was never begun, and waits.
      expect(await pending()).toEqual(['0 comment_put']);
      expect(await postFiles(contentId)).toEqual([contentId, `${contentId}.meta.json`]);
      expect(await commentFiles(contentId)).toEqual([]);
      expect(await ctx.db.selectFrom('compactor_lease').select('holder').execute()).toEqual([{ holder: null }]);

      // The next pass, of whichever compactor, makes the rest.
      await ctx.compactor.runOnce();
      expect(await pending()).toEqual([]);
      expect((await feedItems(ctx, 'news')).map((i) => i.contentId)).toEqual([contentId]);
      expect(await list(contentId)).toMatchObject({ count: 1, comments: [{ text: 'First' }] });
    });
  });
}
