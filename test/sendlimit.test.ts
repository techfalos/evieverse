import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { payloadOf } from '../src/pending.js';
import type { CommentPutPayload, PostPayload } from '../src/pending.types.js';
import { BASE_ENV, createTestContext, requests, TARGETS, type TestContext, type User } from './helpers.js';

describe('POST_RATE_LIMIT_PER_MINUTE and COMMENTS_PER_MINUTE', () => {
  it('are 3 and 10 unless set, 0 for no limit, and all that posts and comments are held to', () => {
    const load = (env: Record<string, string> = {}) => loadConfig({}, { ...BASE_ENV, ...env });
    expect([load().postRateLimitPerMinute, load().comments.perMinute]).toEqual([3, 10]);
    expect(load({ POST_RATE_LIMIT_PER_MINUTE: '5', COMMENTS_PER_MINUTE: '20' })).toMatchObject({ postRateLimitPerMinute: 5, comments: { perMinute: 20 } });
    expect(load({ POST_RATE_LIMIT_PER_MINUTE: '0', COMMENTS_PER_MINUTE: '0' })).toMatchObject({ postRateLimitPerMinute: 0, comments: { perMinute: 0 } });
    expect(() => load({ POST_RATE_LIMIT_PER_MINUTE: '-1' })).toThrow();
    expect(() => load({ COMMENTS_PER_MINUTE: '-1' })).toThrow();

    // What once set the challenges for posts and comments, in the environment or in a config file, is no setting now, and changes nothing.
    const old = loadConfig(
      { challenge: { postWindowSeconds: 60, commentsPerMinute: 3 } },
      { ...BASE_ENV, CHALLENGE_POST_WINDOW_SECONDS: '60', CHALLENGE_COMMENTS_PER_MINUTE: '3' },
    );
    expect(old.challenge).toEqual({ ttlSeconds: 120, powBits: 18, minSolveMs: 2000 });
  });
});

for (const target of TARGETS) {
  describe(`the limits on posts and comments a minute (${target.name})`, () => {
    let ctx: TestContext;
    /** The texts of the posts and comments that got as far as their commit, which is all of a request's write. */
    let written: string[];
    beforeEach(async () => {
      written = [];
      ctx = await createTestContext(target);
      // A write whose text starts with "fail" fails as its commit would: nothing of it is kept.
      const transaction = ctx.db.transaction.bind(ctx.db);
      const seen = new Set<string>();
      vi.spyOn(ctx.db, 'transaction').mockImplementation(
        () =>
          ({
            execute: async (fn: (trx: Parameters<Parameters<ReturnType<typeof transaction>['execute']>[0]>[0]) => Promise<unknown>) =>
              transaction().execute(async (trx) => {
                const out = await fn(trx);
                for (const row of await trx.selectFrom('pending_writes').select(['content_id', 'seq', 'write_key', 'kind', 'payload']).where('kind', 'in', ['post', 'comment_put']).execute()) {
                  const key = `${row.content_id}:${row.seq}:${row.write_key}`;
                  if (seen.has(key)) continue;
                  const text = row.kind === 'post' ? payloadOf<PostPayload>(row.payload).meta.text! : payloadOf<CommentPutPayload>(row.payload).comment.text;
                  written.push(text);
                  if (text.startsWith('fail')) throw new Error('storage unavailable');
                  seen.add(key);
                }
                return out;
              }),
          }) as never,
      );
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await ctx.close();
    });

    const { storeText, post } = requests(() => ctx);
    const comment = (user: User, contentId: string, text: string, extra: Record<string, unknown> = {}) =>
      ctx.app.inject({ method: 'POST', url: `/content/${contentId}/comments`, payload: { ...user, text, ...extra } });
    const edit = (user: User, contentId: string, commentId: string, text: string) =>
      ctx.app.inject({ method: 'PATCH', url: `/content/${contentId}/comments/${commentId}`, payload: { ...user, text } });
    const commentTexts = async (contentId: string) =>
      ((await ctx.app.inject({ method: 'GET', url: `/content/${contentId}/comments` })).json().comments as { text: string }[]).map((c) => c.text);
    /** A post of alice's that takes comments, and bob to comment on it, on a server that takes `perMinute` comments a minute from a user. */
    const commented = async (perMinute: number) => {
      ctx.config.comments.perMinute = perMinute;
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      return { alice, bob, contentId: await post(alice, 'Talk to me #news', { comments: true }) };
    };

    it('asks no challenge of a post or a comment, however many are sent in a row', async () => {
      const { alice, bob, contentId } = await commented(0);
      for (const text of ['one #news', 'two #news', 'three #news', 'four #news', 'five #news']) expect((await storeText(alice, text)).statusCode).toBe(201);
      for (const text of ['one', 'two', 'three', 'four', 'five']) expect((await comment(bob, contentId, text)).statusCode).toBe(201);
      // A client that still sends the answer to a challenge is sending fields the server doesn't read.
      const answer = { challengeId: randomUUID(), challengeAnswer: 'ACDEFG', challengeNonce: '0' };
      expect((await storeText(alice, 'six #news', answer)).statusCode).toBe(201);
      expect((await comment(bob, contentId, 'six', answer)).statusCode).toBe(201);
    });

    it('refuses a post past three in a minute, an update among them, until the oldest is a minute old', async () => {
      ctx.config.postRateLimitPerMinute = 3;
      const alice = await ctx.register('alice');
      const start = ctx.clock.now;
      // Three in 20 seconds: two posts, and an update, which is a post too.
      const { contentId } = (await storeText(alice, 'one #news')).json();
      ctx.clock.now += 10_000;
      expect((await storeText(alice, 'two #news')).statusCode).toBe(201);
      ctx.clock.now += 10_000;
      expect((await storeText(alice, 'one, edited #news', { contentId })).statusCode).toBe(200);
      ctx.clock.now += 10_000;

      const refused = await storeText(alice, 'three #news');
      expect(refused.statusCode).toBe(429);
      expect(refused.headers['retry-after']).toBe('30');
      expect(refused.json()).toEqual({ error: 'you can post at most 3 times a minute; try again in 30 seconds', retryAfterSeconds: 30 });
      expect(written).toEqual(['one #news', 'two #news', 'one, edited #news']);
      // Storing what the content has again isn't a post: it is answered as ever, with the limit used up.
      expect((await storeText(alice, 'one, edited #news', { contentId })).json()).toEqual({ contentId, unchanged: true });
      ctx.clock.now = start + 59_500;
      expect((await storeText(alice, 'three #news')).json().error).toBe('you can post at most 3 times a minute; try again in 1 second');

      // The minute is the one before the post: the first is a minute old, and the second isn't for 10 seconds more.
      ctx.clock.now = start + 60_000;
      expect((await storeText(alice, 'three #news')).statusCode).toBe(201);
      expect((await storeText(alice, 'four #news')).json().retryAfterSeconds).toBe(10);

      // Each user has their own minute.
      const bob = await ctx.register('bob');
      expect((await storeText(bob, 'hello #news')).statusCode).toBe(201);

      ctx.config.postRateLimitPerMinute = 1;
      expect((await storeText(alice, 'four #news')).json().error).toBe('you can post at most once a minute; try again in 60 seconds');
    });

    it('counts only posts that go through, and lets only as many of concurrent posts through', async () => {
      ctx.config.postRateLimitPerMinute = 3;
      const alice = await ctx.register('alice');
      expect((await storeText(alice, 'fail #news')).statusCode).toBe(500);
      const { contentId } = (await storeText(alice, 'one #news')).json();
      expect((await storeText(alice, 'one #news', { contentId })).json()).toMatchObject({ unchanged: true });

      ctx.clock.now += 30_000;
      const posts = await Promise.all(['a', 'b', 'c', 'd'].map((t) => storeText(alice, `${t} #news`)));
      expect(posts.map((r) => r.statusCode).sort()).toEqual([201, 201, 429, 429]);
      expect(posts.find((r) => r.statusCode === 429)!.json().retryAfterSeconds).toBe(30);

      // 'one' leaves the minute.
      ctx.clock.now += 30_000;
      expect((await storeText(alice, 'e #news')).statusCode).toBe(201);
      const refused = await storeText(alice, 'f #news');
      expect([refused.statusCode, refused.json().retryAfterSeconds]).toEqual([429, 30]);
    });

    it('refuses a comment past three in a minute, an edit among them, until the oldest is a minute old', async () => {
      const { bob, contentId } = await commented(3);
      const start = ctx.clock.now;
      // Three in 20 seconds: two comments, and an edit, which is a comment too.
      const { commentId } = (await comment(bob, contentId, 'one')).json();
      ctx.clock.now += 10_000;
      expect((await comment(bob, contentId, 'two')).statusCode).toBe(201);
      ctx.clock.now += 10_000;
      expect((await edit(bob, contentId, commentId, 'one, edited')).statusCode).toBe(200);
      ctx.clock.now += 10_000;

      const refused = await comment(bob, contentId, 'three');
      expect(refused.statusCode).toBe(429);
      expect(refused.headers['retry-after']).toBe('30');
      expect(refused.json()).toEqual({ error: 'too many comments; try again in 30 seconds', retryAfterSeconds: 30 });
      // An edit is one comment too many as well, but for the text the comment has, which isn't an edit.
      expect((await edit(bob, contentId, commentId, 'one, edited again')).statusCode).toBe(429);
      expect((await edit(bob, contentId, commentId, 'one, edited')).json()).toMatchObject({ unchanged: true });
      expect(await commentTexts(contentId)).toEqual(['one, edited', 'two']);

      // A user's own comments alone count, on whichever posts.
      const carol = await ctx.register('carol');
      for (const text of ['hers', 'hers too', 'and this']) expect((await comment(carol, contentId, text)).statusCode).toBe(201);

      // Posts and comments are counted apart: bob's comments leave him his posts, and a post leaves the comments as they were.
      ctx.config.postRateLimitPerMinute = 1;
      expect((await storeText(bob, 'hello #news')).statusCode).toBe(201);
      expect((await storeText(bob, 'hello again #news')).statusCode).toBe(429);
      expect((await comment(bob, contentId, 'three')).json().retryAfterSeconds).toBe(30);

      // The first is a minute old, and the second isn't for 10 seconds more.
      ctx.clock.now = start + 60_000;
      expect((await comment(bob, contentId, 'three')).statusCode).toBe(201);
      expect((await comment(bob, contentId, 'four')).json()).toEqual({ error: 'too many comments; try again in 10 seconds', retryAfterSeconds: 10 });
    });

    it('counts only comments that are stored, and lets only as many of concurrent comments through', async () => {
      const { bob, contentId } = await commented(3);

      // One that fails gives its place in the minute back, and one that is refused never took one.
      for (const text of ['fail', 'fail again', 'fail once more']) expect((await comment(bob, contentId, text)).statusCode).toBe(500);
      expect((await comment(bob, contentId, 'lost', { parentId: randomUUID() })).statusCode).toBe(404);
      const answers = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((text) => comment(bob, contentId, text)));
      expect(answers.map((r) => r.statusCode).sort()).toEqual([201, 201, 201, 429, 429]);
      expect(answers.find((r) => r.statusCode === 429)!.json()).toEqual({ error: 'too many comments; try again in 60 seconds', retryAfterSeconds: 60 });
      const passed = ['a', 'b', 'c', 'd', 'e'].filter((_, i) => answers[i]!.statusCode === 201);
      expect((await commentTexts(contentId)).sort()).toEqual(passed);
    });
  });
}
