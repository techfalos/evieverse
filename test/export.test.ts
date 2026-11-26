import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { setAdmin } from '../src/moderation/policy.js';
import type { TestPlugin } from '../src/moderation/trust.types.js';
import { DAY } from '../src/time.js';
import { as, BASE_ENV, createTestContext, requests, TARGETS, type TestContext, type User } from './helpers.js';

/** A record of an export, as far as tests read it. */
type ExportRecord = { type: string; [field: string]: unknown };
/** A page of an export. */
type ExportPage = { userId: string; records: ExportRecord[]; nextCursor: string | null };

/** A trust plugin that holds whatever says "held" for the moderation queue, and lets the rest through. */
const holdsHeld: TestPlugin = { name: 'holds-held', rules: [{ includes: 'held', ignoreCase: true, set: 50 }] };

describe('the export setting', () => {
  it('comes from the environment: the pages a user can read in a minute, or no limit', () => {
    const load = (env: Record<string, string> = {}) => loadConfig({}, { ...BASE_ENV, ...env }).export;
    expect(load()).toEqual({ pagesPerMinute: 120 });
    expect(load({ EXPORT_PAGES_PER_MINUTE: '0' })).toEqual({ pagesPerMinute: 0 });
    expect(load({ EXPORT_PAGES_PER_MINUTE: '5' })).toEqual({ pagesPerMinute: 5 });
    expect(() => load({ EXPORT_PAGES_PER_MINUTE: '-1' })).toThrow();
  });
});

for (const target of TARGETS) {
  describe(`a user's export of their data (${target.name})`, () => {
    let ctx: TestContext;
    afterEach(() => ctx.close());

    const { post, storeText, like } = requests(() => ctx);
    /**
     * A server whose index of users' comments holds everything, which is what the process that
     * runs the compactor makes of a new one as it starts (compactor/src/author_index.rs): an export is
     * given from then on.
     */
    const setup = async (opts: Parameters<typeof createTestContext>[1] = {}) => {
      const made = await createTestContext(target, opts);
      await made.comments.indexAuthors();
      return made;
    };
    const req = (u: User | null, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
      ctx.app.inject({ method, url, headers: u ? as(u) : {}, ...(payload && { payload }) });
    const ok = (res: LightMyRequestResponse, status = 200) => {
      expect(res.statusCode, res.body).toBe(status);
      return res.json();
    };
    const now = () => new Date(ctx.clock.now).toISOString();
    const admin = async (name = 'root') => {
      const u = await ctx.register(name);
      await setAdmin(ctx.db, name, true);
      return u;
    };
    /** One page of a user's export, as whoever asks gets it. */
    const page = (u: User | null, of: User, query = '') => req(u, 'GET', `/users/${of.userId}/export${query}`);
    /** A user's whole export, read as a client reads it: page after page, until a page has no next. */
    const pages = async (u: User, limit?: number): Promise<ExportPage[]> => {
      const read: ExportPage[] = [];
      for (let cursor: string | null = null; ; ) {
        const query = [limit !== undefined && `limit=${limit}`, cursor !== null && `cursor=${cursor}`].filter(Boolean).join('&');
        const next: ExportPage = ok(await page(u, u, query && `?${query}`));
        read.push(next);
        cursor = next.nextCursor;
        if (cursor === null) return read;
        expect(read.length, 'an export that never ends').toBeLessThan(1000);
      }
    };
    const everything = async (u: User, limit?: number) => (await pages(u, limit)).flatMap((p) => p.records);
    const ofType = (records: ExportRecord[], type: string) => records.filter((r) => r.type === type);
    const comment = (u: User, contentId: string, text: string, parentId?: string) => req(u, 'POST', `/content/${contentId}/comments`, { text, ...(parentId && { parentId }) });
    const likeComment = (u: User, contentId: string, commentId: string) => req(u, 'POST', '/like', { contentId, commentId });
    /** What the comment store's index says a user wrote and liked: the ids of the comments, in its order. */
    const indexOf = async (u: User) => ({
      wrote: (await ctx.comments.authored(u.userId, null, 1000)).map((mark) => mark.commentId),
      liked: (await ctx.comments.likedBy(u.userId, null, 1000)).map((mark) => mark.commentId),
    });
    /** Moves the clock on a second, so whatever is written next has a time of its own. */
    const tick = () => {
      ctx.clock.now += 1000;
      return now();
    };

    it('holds everything the server has of the user, in records that each say what they are', async () => {
      ctx = await setup({ inbox: { messagesPerMinute: 0 } });
      const root = await admin();
      const registeredAt = now();
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const carol = await ctx.register('carol');
      const dave = await ctx.register('dave');

      // What alice wrote.
      const firstAt = tick();
      const first = await post(alice, 'Flooding downtown #news', { comments: true });
      const secondAt = tick();
      const second = await post(alice, 'Made with a model #art', { aiGenerated: true });
      // What she did with what others wrote.
      const bobs = await post(bob, 'Sunny all week #news', { comments: true });
      const likedAt = tick();
      ok(await like(alice, bobs), 201);
      const repostedAt = tick();
      ok(await req(alice, 'POST', '/repost', { contentId: bobs, tags: ['weather', 'forecast'] }), 201);
      const reportedAt = tick();
      ok(await req(alice, 'POST', '/report', { contentId: bobs, reason: 'It rained' }), 201);
      const remark = ok(await comment(bob, bobs, 'Did not'), 201);
      const saidAt = tick();
      const said = ok(await comment(alice, bobs, 'It did', remark.commentId), 201);
      ok(await likeComment(alice, bobs, remark.commentId), 201);
      const remarkReportedAt = tick();
      ok(await req(alice, 'POST', '/report', { contentId: bobs, commentId: remark.commentId }), 201);
      // Whom she knows.
      const followedAt = tick();
      ok(await req(alice, 'PUT', `/users/${alice.userId}/following/${bob.userId}`), 201);
      const followedByAt = tick();
      ok(await req(carol, 'PUT', `/users/${carol.userId}/following/${alice.userId}`), 201);
      const blockedAt = tick();
      ok(await req(alice, 'PUT', `/users/${alice.userId}/blocked/${dave.userId}`), 201);
      // What moderators made of her.
      const mutedAt = tick();
      ok(await req(root, 'PUT', `/tags/spam/muted/${alice.userId}`), 201);
      const appointedAt = tick();
      ok(await req(root, 'PUT', `/tags/news/moderators/${alice.userId}`), 201);
      // Her messages.
      tick();
      ok(await req(bob, 'POST', '/messages', { to: alice.userId, text: 'Hello Alice' }), 201);
      const sentAt = tick();
      const sent = ok(await req(alice, 'POST', '/messages', { to: bob.userId, text: 'Hello Bob' }), 201);
      await ctx.compact();

      const [whole, ...more] = await pages(alice);
      expect(more).toEqual([]);
      expect(whole).toEqual({ userId: alice.userId, records: expect.any(Array), nextCursor: null });
      const records = whole!.records;
      // The sections, in their order.
      expect([...new Set(records.map((r) => r.type))]).toEqual([
        'account',
        'apiKey',
        'post',
        'comment',
        'like',
        'commentLike',
        'repost',
        'following',
        'follower',
        'block',
        'mute',
        'moderatedTag',
        'report',
        'inbox',
        'sentMessage',
      ]);

      expect(ofType(records, 'account')).toEqual([
        {
          type: 'account',
          userId: alice.userId,
          username: 'alice',
          createdAt: registeredAt,
          usernameSetAt: registeredAt,
          bio: null,
          links: [],
          avatarUrl: null,
          pinnedContentIds: [],
          language: 'en',
          admin: false,
          moderator: false,
          messages: true,
          showFollowing: false,
          showFollowers: false,
          bannedAt: null,
          claimsBarredAt: null,
        },
      ]);
      // The key's row, and nothing a key could be made from.
      expect(ofType(records, 'apiKey')).toEqual([{ type: 'apiKey', keyId: expect.any(String), createdAt: registeredAt, revokedAt: null }]);
      expect(JSON.stringify(records)).not.toContain(alice.apiKey);
      expect(JSON.stringify(records)).not.toContain((await ctx.db.selectFrom('api_keys').select('key_hash').where('user_id', '=', alice.userId).executeTakeFirstOrThrow()).key_hash);

      // Her posts, oldest first, each as the post itself reads.
      expect(ofType(records, 'post')).toEqual([
        {
          type: 'post',
          contentId: first,
          preview: { kind: 'text', text: 'Flooding downtown #news' },
          text: 'Flooding downtown #news',
          tags: ['news'],
          mimeType: expect.stringContaining('text/plain'),
          comments: true,
          size: Buffer.byteLength('Flooding downtown #news'),
          likes: 0,
          aiGenerated: false,
          contentUrl: `/content/${first}/raw`,
          createdAt: firstAt,
          updatedAt: firstAt,
        },
        {
          type: 'post',
          contentId: second,
          preview: { kind: 'text', text: 'Made with a model #art' },
          text: 'Made with a model #art',
          tags: ['art'],
          mimeType: expect.stringContaining('text/plain'),
          comments: false,
          size: Buffer.byteLength('Made with a model #art'),
          likes: 0,
          aiGenerated: true,
          contentUrl: `/content/${second}/raw`,
          createdAt: secondAt,
          updatedAt: secondAt,
        },
      ]);
      for (const { type: _type, ...fields } of ofType(records, 'post')) expect(ok(await req(alice, 'GET', `/content/${fields.contentId as string}`))).toMatchObject(fields);

      // Her comment, as the comment itself reads, without what others made of it.
      expect(ofType(records, 'comment')).toEqual([
        { type: 'comment', commentId: said.commentId, contentId: bobs, parentId: remark.commentId, text: 'It did', aiGenerated: false, media: null, createdAt: saidAt, editedAt: null },
      ]);
      expect(ok(await req(alice, 'GET', `/content/${bobs}/comments/${said.commentId}`))).toMatchObject((({ type: _type, ...fields }) => fields)(ofType(records, 'comment')[0]!));
      expect(ofType(records, 'like')).toEqual([{ type: 'like', contentId: bobs, likedAt }]);
      expect(ofType(records, 'commentLike')).toEqual([{ type: 'commentLike', contentId: bobs, commentId: remark.commentId }]);
      expect(ofType(records, 'repost')).toEqual([{ type: 'repost', contentId: bobs, tags: ['forecast', 'weather'], repostedAt }]);
      expect(ofType(records, 'following')).toEqual([{ type: 'following', userId: bob.userId, username: 'bob', followedAt }]);
      expect(ofType(records, 'follower')).toEqual([{ type: 'follower', userId: carol.userId, username: 'carol', followedAt: followedByAt }]);
      expect(ofType(records, 'block')).toEqual([{ type: 'block', userId: dave.userId, username: 'dave', blockedAt }]);
      expect(ofType(records, 'mute')).toEqual([{ type: 'mute', tag: 'spam', mutedAt }]);
      expect(ofType(records, 'moderatedTag')).toEqual([{ type: 'moderatedTag', tag: 'news', since: appointedAt }]);
      // Of the post, then of the comment.
      expect(ofType(records, 'report')).toEqual([
        { type: 'report', contentId: bobs, reason: 'It rained', reportedAt },
        { type: 'report', contentId: bobs, commentId: remark.commentId, reason: null, reportedAt: remarkReportedAt },
      ]);
      // Her inbox, oldest first, each as the inbox itself gives it: the notices of her mute and of her appointment, if it left one, and bob's message.
      const inbox = ok(await req(alice, 'GET', `/users/${alice.userId}/inbox`)).inbox as Record<string, unknown>[];
      expect(inbox.map((m) => m.kind)).toContain('tag_muted');
      expect(inbox.at(0)).toMatchObject({ kind: 'message', from: { userId: bob.userId, username: 'bob' }, text: 'Hello Alice' });
      expect(ofType(records, 'inbox')).toEqual(inbox.reverse().map((m) => ({ type: 'inbox', ...m })));
      expect(ofType(records, 'sentMessage')).toEqual([
        { type: 'sentMessage', messageId: sent.messageId, to: { userId: bob.userId, username: 'bob' }, text: 'Hello Bob', sentAt },
      ]);

      // Each user's export is of what is theirs: bob's has his post and his message, and none of alice's.
      const bobsRecords = await everything(bob);
      expect(ofType(bobsRecords, 'post').map((r) => r.contentId)).toEqual([bobs]);
      expect(ofType(bobsRecords, 'post')[0]).toMatchObject({ likes: 1 });
      expect(ofType(bobsRecords, 'follower')).toEqual([{ type: 'follower', userId: alice.userId, username: 'alice', followedAt }]);
      expect(ofType(bobsRecords, 'sentMessage').map((r) => r.text)).toEqual(['Hello Alice']);
      expect(ofType(bobsRecords, 'inbox').map((r) => r.text)).toEqual(['Hello Bob']);
      expect(ofType(bobsRecords, 'comment').map((r) => [r.commentId, r.text])).toEqual([[remark.commentId, 'Did not']]);
      expect(ofType(bobsRecords, 'like').concat(ofType(bobsRecords, 'commentLike'), ofType(bobsRecords, 'report'), ofType(bobsRecords, 'block'))).toEqual([]);
      // A user with nothing but an account.
      expect((await everything(dave)).map((r) => r.type)).toEqual(['account', 'apiKey']);

      // A like that is taken back is no longer the user's: the post's, and the comment's. What she did besides is as it was.
      ok(await req(alice, 'DELETE', '/like', { contentId: bobs }));
      ok(await req(alice, 'DELETE', '/like', { contentId: bobs, commentId: remark.commentId }));
      const since = await everything(alice);
      expect(ofType(since, 'like').concat(ofType(since, 'commentLike'))).toEqual([]);
      expect(since.filter((r) => r.type !== 'apiKey')).toEqual(records.filter((r) => !['like', 'commentLike', 'apiKey'].includes(r.type)));
      expect(ofType(await everything(bob), 'post')[0]).toMatchObject({ likes: 0 });
    });

    it('is the user\'s alone to read: not another user\'s, nor an admin\'s', async () => {
      ctx = await setup();
      const root = await admin();
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      expect((await page(null, alice)).statusCode).toBe(401);
      expect((await page({ userId: alice.userId, apiKey: bob.apiKey }, alice)).statusCode).toBe(401);
      for (const other of [bob, root]) {
        const res = await page(other, alice);
        expect([res.statusCode, res.json()]).toEqual([403, { error: 'you can only export your own data' }]);
      }
      expect((await req(alice, 'GET', '/users/not-a-user/export')).statusCode).toBe(400);
      expect(ok(await page(alice, alice))).toMatchObject({ userId: alice.userId, nextCursor: null });
    });

    it('is read a page at a time, each page taking up where the one before it ended, whatever the size of the pages', async () => {
      ctx = await setup({ inbox: { messagesPerMinute: 0 } });
      const alice = await ctx.register('alice');
      const others = await Promise.all(['bob', 'carol', 'dave'].map((name) => ctx.register(name)));
      // Posts that share a time, and posts that don't: a page that ends among the first takes up by their ids.
      const posts: string[] = [];
      for (let i = 0; i < 7; i++) {
        if (i % 3 === 0) tick();
        posts.push(await post(alice, `Post ${i} #news`));
      }
      for (const other of others) {
        const theirs = await post(other, `By ${other.userId} #news`, { comments: true });
        // Comments that share a millisecond: they are told apart by their ids, which are in the order they were sent in.
        for (const text of ['First', 'Second']) ok(await comment(alice, theirs, text), 201);
        ok(await likeComment(alice, theirs, ok(await comment(other, theirs, 'Mine'), 201).commentId), 201);
        ok(await like(alice, theirs), 201);
        ok(await req(alice, 'POST', '/repost', { contentId: theirs, tags: ['weather'] }), 201);
        ok(await req(alice, 'PUT', `/users/${alice.userId}/following/${other.userId}`), 201);
        // All three at once: followers that share a time are told apart by who they are.
        ok(await req(other, 'PUT', `/users/${other.userId}/following/${alice.userId}`), 201);
        ok(await req(other, 'POST', '/messages', { to: alice.userId, text: 'Hello' }), 201);
        ok(await req(alice, 'POST', '/messages', { to: other.userId, text: 'Hello yourself' }), 201);
      }

      const whole = await everything(alice);
      expect(whole).toHaveLength(2 + 7 + 6 * 3 + 6 + 3);
      expect(ofType(whole, 'comment').map((r) => r.text)).toEqual(['First', 'Second', 'First', 'Second', 'First', 'Second']);
      // Oldest first: the three of the first second, in the order of their ids, then the next three, then the last.
      const exported = ofType(whole, 'post').map((r) => r.contentId as string);
      expect([exported.slice(0, 3).sort(), exported.slice(3, 6).sort(), exported.slice(6)]).toEqual([posts.slice(0, 3).sort(), posts.slice(3, 6).sort(), posts.slice(6)]);

      for (const limit of [1, 2, 3, 7, 1000]) {
        const read = await pages(alice, limit);
        // The same records, in the same order, each once, and no page past its size.
        expect(read.flatMap((p) => p.records), `in pages of ${limit}`).toEqual(whole);
        expect(Math.max(...read.map((p) => p.records.length))).toBeLessThanOrEqual(limit);
        // Every page but the last is full: a page goes on into the next section where one ends.
        expect(read.slice(0, -1).every((p) => p.records.length === limit)).toBe(true);
      }
      // A page that is full doesn't know that nothing comes after it: the page after it is empty, and the last.
      expect((await pages(alice, whole.length)).map((p) => p.records.length)).toEqual([whole.length, 0]);
      expect((await pages(alice, whole.length + 1)).map((p) => p.records.length)).toEqual([whole.length]);

      for (const query of ['?limit=0', '?limit=1001', '?limit=many']) expect((await page(alice, alice, query)).statusCode, query).toBe(400);
    });

    it('refuses a cursor that isn\'t an export\'s', async () => {
      ctx = await setup();
      const alice = await ctx.register('alice');
      const cursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const id = alice.userId;
      const bad = [
        'nonsense',
        cursor('posts'),
        cursor({ section: 'posts' }),
        cursor([]),
        cursor(['nothing']),
        cursor([7]),
        cursor(['comments', 1]),
        cursor(['commentLikes', id, id]),
        // A position that isn't the section's: too short, too long, of the wrong types.
        cursor(['posts', 1]),
        cursor(['posts', 1, id, id]),
        cursor(['posts', id, 1]),
        cursor(['posts', '1', id]),
        cursor(['posts', 1.5, id]),
        cursor(['posts', null, id]),
        cursor(['likes', 1]),
        cursor(['likes', { $gt: '' }]),
        cursor(['likes', 'x'.repeat(65)]),
      ];
      for (const value of bad) {
        const res = await page(alice, alice, `?cursor=${value}`);
        expect([res.statusCode, res.json()], value).toEqual([400, { error: 'invalid cursor' }]);
      }
      // A cursor names a section, and a place in it or none.
      expect(ok(await page(alice, alice, `?cursor=${cursor(['posts'])}`))).toEqual({ userId: id, records: [], nextCursor: null });
      expect(ok(await page(alice, alice, `?cursor=${cursor(['keys'])}`)).records).toHaveLength(1);
      expect(ok(await page(alice, alice, `?cursor=${cursor(['posts', 0, id])}`)).records).toEqual([]);
    });

    it('ends a page once its records come to about a megabyte, however few they are', async () => {
      ctx = await setup();
      const alice = await ctx.register('alice');
      const long = (i: number) => `${i} #news `.padEnd(40_000, 'x');
      const posts: string[] = [];
      for (let i = 0; i < 30; i++) {
        tick();
        posts.push(await post(alice, long(i)));
      }

      const read = await pages(alice, 1000);
      expect(read.length).toBeGreaterThan(1);
      for (const p of read) expect(Buffer.byteLength(JSON.stringify(p.records))).toBeLessThan(1024 * 1024 + 100_000);
      // Nothing is left out, or given twice, where pages end by their size.
      expect(ofType(read.flatMap((p) => p.records), 'post').map((r) => r.contentId)).toEqual(posts);
      expect(ofType(read.flatMap((p) => p.records), 'post').every((r, i) => r.text === long(i).trimEnd())).toBe(true);
    });

    it('gives a post as its publisher reads it: held ones too, the newest write before the compactor has applied it, and not a deleted one', async () => {
      ctx = await setup({ settle: false, trustPlugins: [holdsHeld] });
      const alice = await ctx.register('alice');
      const kept = await post(alice, 'An honest post #news');
      tick();
      const held = ok(await storeText(alice, 'To be held #news'), 202).contentId as string;
      tick();
      const gone = await post(alice, 'Soon gone #news');
      await ctx.apply();
      ok(await req(alice, 'DELETE', `/content/${gone}`), 202);
      // An edit that is committed and not yet applied: the export has it, as the post does.
      tick();
      ok(await storeText(alice, 'An honest post, edited #news #edits', { contentId: kept }));
      const waiting = await post(alice, 'Just written #news');

      const posts = ofType(await everything(alice), 'post');
      expect(posts.map((r) => [r.contentId, r.text, r.tags, r.status])).toEqual([
        [kept, 'An honest post, edited #news #edits', ['news', 'edits'], undefined],
        [held, 'To be held #news', ['news'], 'pending_review'],
        [waiting, 'Just written #news', ['news'], undefined],
      ]);
      for (const { type: _type, ...fields } of posts) expect(ok(await req(alice, 'GET', `/content/${fields.contentId as string}`))).toMatchObject(fields);

      // And the same once the compactor has applied them.
      await ctx.apply();
      expect(ofType(await everything(alice), 'post')).toEqual(posts);
    });

    it('holds the comments a user wrote and the ones they liked, by the index the comment store keeps of them', async () => {
      ctx = await setup({ trustPlugins: [holdsHeld] });
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const sunny = await post(bob, 'Sunny all week #news', { comments: true });
      const rainy = await post(bob, 'Rain all week #news', { comments: true });
      // Days apart, so the index has them in several parts, and on two posts.
      const wrote: string[] = [];
      for (let i = 0; i < 6; i++) {
        ctx.clock.now += 2 * DAY;
        wrote.push(ok(await comment(alice, i % 2 ? rainy : sunny, `Comment ${i}`), 201).commentId);
      }
      const [c0, c1, c2, c3, c4, c5] = wrote as [string, string, string, string, string, string];
      const bobs = [ok(await comment(bob, sunny, 'Mine', c0), 201).commentId, ok(await comment(bob, rainy, 'Mine too'), 201).commentId] as [string, string];
      for (const [i, on] of [sunny, rainy].entries()) ok(await likeComment(alice, on, bobs[i]!), 201);
      ok(await likeComment(bob, sunny, c0), 201);
      // One that waits in the moderation queue is hers to read, and is in her export.
      ctx.clock.now += 2 * DAY;
      const held = ok(await comment(alice, sunny, 'To be held'), 202).commentId as string;
      expect(await indexOf(alice)).toEqual({ wrote: [...wrote, held], liked: bobs });
      expect(await indexOf(bob)).toEqual({ wrote: bobs, liked: [c0] });

      const comments = async (limit?: number) => ofType(await everything(alice, limit), 'comment').map((r) => [r.commentId, r.contentId, r.text, r.status]);
      const all = [...wrote.map((id, i) => [id, i % 2 ? rainy : sunny, `Comment ${i}`, undefined]), [held, sunny, 'To be held', 'pending_review']];
      expect(await comments()).toEqual(all);
      // A page takes up after the comment the one before it ended with, in whichever part of the index that is.
      for (const limit of [1, 2, 5]) expect(await comments(limit), `in pages of ${limit}`).toEqual(all);
      expect(ofType(await everything(alice, 1), 'commentLike')).toEqual([
        { type: 'commentLike', contentId: sunny, commentId: bobs[0] },
        { type: 'commentLike', contentId: rainy, commentId: bobs[1] },
      ]);

      // An edit is in it, and a comment that is removed isn't: neither is anything of it left in the index, its likes included.
      tick();
      expect((await req(alice, 'PATCH', `/content/${sunny}/comments/${c2}`, { text: 'Comment 2, edited' })).statusCode).toBeLessThan(300);
      expect((await req(alice, 'DELETE', `/content/${rainy}/comments/${c1}`)).statusCode).toBeLessThan(300);
      // One that has a reply leaves a placeholder, which is nobody's.
      expect((await req(alice, 'DELETE', `/content/${sunny}/comments/${c0}`)).statusCode).toBeLessThan(300);
      expect((await req(bob, 'DELETE', `/content/${rainy}/comments/${bobs[1]}`)).statusCode).toBeLessThan(300);
      expect(await comments()).toEqual([
        [c2, sunny, 'Comment 2, edited', undefined],
        [c3, rainy, 'Comment 3', undefined],
        [c4, sunny, 'Comment 4', undefined],
        [c5, rainy, 'Comment 5', undefined],
        [held, sunny, 'To be held', 'pending_review'],
      ]);
      expect(await indexOf(alice)).toEqual({ wrote: [c2, c3, c4, c5, held], liked: [bobs[0]] });
      expect(await indexOf(bob)).toEqual({ wrote: [bobs[0]], liked: [] });

      // A post that is deleted takes its comments with it, and what the indexes had of them.
      ok(await req(bob, 'DELETE', `/content/${sunny}`), 202);
      await ctx.compact();
      expect(await comments()).toEqual([
        [c3, rainy, 'Comment 3', undefined],
        [c5, rainy, 'Comment 5', undefined],
      ]);
      expect(await indexOf(alice)).toEqual({ wrote: [c3, c5], liked: [] });
      expect(await indexOf(bob)).toEqual({ wrote: [], liked: [] });
      expect(ofType(await everything(alice), 'commentLike')).toEqual([]);
    });

    it('gives a comment as its author reads it before the compactor has applied its newest write', async () => {
      ctx = await setup({ settle: false });
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const on = await post(bob, 'Sunny all week #news', { comments: true });
      const kept = ok(await comment(alice, on, 'To be edited'), 201).commentId as string;
      const gone = ok(await comment(alice, on, 'To be removed'), 201).commentId as string;
      await ctx.apply();
      expect((await req(alice, 'PATCH', `/content/${on}/comments/${kept}`, { text: 'Edited' })).statusCode).toBeLessThan(300);
      expect((await req(alice, 'DELETE', `/content/${on}/comments/${gone}`)).statusCode).toBeLessThan(300);
      // One the compactor hasn't written is in no index yet: it is in the export once it has.
      const waiting = ok(await comment(alice, on, 'Just written'), 201).commentId as string;
      const texts = async () => ofType(await everything(alice), 'comment').map((r) => [r.commentId, r.text]);
      expect(await texts()).toEqual([[kept, 'Edited']]);
      await ctx.apply();
      expect(await texts()).toEqual([
        [kept, 'Edited'],
        [waiting, 'Just written'],
      ]);
    });

    it('gives no page while the index lacks the comments that are older than it, and everything once they are indexed', async () => {
      // A server that never said its index holds everything, as one is that had comments before it kept the index.
      ctx = await createTestContext(target, { trustPlugins: [holdsHeld] });
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const posts = [await post(bob, 'Sunny all week #news', { comments: true }), await post(bob, 'Rain all week #news', { comments: true })];
      const wrote: string[] = [];
      const liked: string[] = [];
      for (const on of posts) {
        tick();
        wrote.push(ok(await comment(alice, on, 'Mine'), 201).commentId);
        liked.push(ok(await comment(bob, on, 'And mine', wrote.at(-1)), 201).commentId);
        ok(await likeComment(alice, on, liked.at(-1)!), 201);
      }
      wrote.push(ok(await comment(alice, posts[0]!, 'To be held'), 202).commentId);
      // And its store as that server has it: the comments, and no index of them.
      await rm(join(ctx.dir, 'content', 'authors'), { recursive: true });
      expect(await indexOf(alice)).toEqual({ wrote: [], liked: [] });

      // No page of an export, the ones without comments included: it would be taken for the whole.
      const refused = async () => {
        for (const query of ['', '?limit=1', `?cursor=${Buffer.from(JSON.stringify(['following'])).toString('base64url')}`]) {
          const res = await page(alice, alice, query);
          expect([res.statusCode, res.json(), res.headers['retry-after']], query).toEqual([
            503,
            { error: "your export isn't ready yet: the server is indexing its comments; try again later", retryAfterSeconds: 60 },
            '60',
          ]);
        }
      };
      await refused();
      // Nor once the indexing has begun, and was stopped.
      expect(await ctx.comments.indexAuthors(() => true)).toBe(false);
      await refused();

      // The process that runs the compactor indexes them, as it starts.
      await ctx.compactor.authorIndex();
      expect(await ctx.comments.indexed()).toBe(true);
      expect(await indexOf(alice)).toEqual({ wrote, liked });
      expect(await indexOf(bob)).toEqual({ wrote: liked, liked: [] });
      const records = await everything(alice);
      expect(ofType(records, 'comment').map((r) => [r.commentId, r.text, r.status])).toEqual([
        [wrote[0], 'Mine', undefined],
        [wrote[1], 'Mine', undefined],
        [wrote[2], 'To be held', 'pending_review'],
      ]);
      expect(ofType(records, 'commentLike').map((r) => r.commentId)).toEqual(liked);
      // Once: there is nothing left for it to do, on this start or the next.
      expect(await ctx.comments.indexAuthors(() => true)).toBe(true);
      await ctx.compactor.authorIndex();
    });

    it('lets a user read so many pages in a minute', async () => {
      ctx = await setup({ export: { pagesPerMinute: 3 } });
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      for (let i = 0; i < 3; i++) ok(await page(alice, alice, '?limit=1'));
      const res = await page(alice, alice);
      expect([res.statusCode, res.json(), res.headers['retry-after']]).toEqual([429, { error: 'too many pages of your export; try again in 60 seconds', retryAfterSeconds: 60 }, '60']);
      // Each user's own count, and a request that is refused for whose it is counts for nobody.
      expect((await page(bob, alice)).statusCode).toBe(403);
      ok(await page(bob, bob));
    });
  });
}
