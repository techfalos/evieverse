import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attest, readAttestation, signedBy, signingKeys, type Attestable } from '../src/attestation.js';
import type { PublishedKey, SigningKey } from '../src/attestation.types.js';
import { summaryOf } from '../src/content.js';
import { setAdmin } from '../src/moderation/policy.js';
import type { TrustPlugin } from '../src/moderation/trust.types.js';
import { authorIndex } from '../src/tagfeed/layout.js';
import { DAY, HOUR, MINUTE, utcDay } from '../src/time.js';
import { contentWriter } from '../src/write.js';
import { as, createTestContext, multipart, PNG, queued, requests, TARGETS, type FeedItem, type TestContext, type User } from './helpers.js';

const NO_CONTENT = '00000000-0000-4000-8000-000000000000';
const OTHER = 'https://other.example';
const ORIGINAL = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
const DANA = { userId: '11111111-1111-4111-8111-111111111111', username: 'Dana of the North' };

/** A signing key as a setting writes it: 32 bytes, here all the same one. */
const seed = (byte: number) => Buffer.alloc(32, byte).toString('base64');
/** The key the other server signs with, the one it changes to, one that is no server's, and the ones this server is given. */
const [KEY, NEXT_KEY, STRAY_KEY] = signingKeys([seed(1), seed(2), seed(9)]) as [SigningKey, SigningKey, SigningKey];
const OWN_SEEDS = [seed(3), seed(4)];
/** What a server answers GET /repost/keys with. */
const published = (...keys: PublishedKey[]) => ({ keys: keys.map(({ id, publicKey }) => ({ id, publicKey, algorithm: 'ed25519' })) });
const KEYS = `${OTHER}/repost/keys`;

const INVALID = "origin.attestation must be the attestation of a post, as the post's own server gives it at GET /content/<id>/attestation";
const EXPIRED = "the attestation is more than 10 minutes old, or from a clock that runs ahead of this server's: get a new one from the post's own server";
const UNSIGNED = "the attestation isn't signed with a key of the post's own server, so the post wasn't reposted";
const NO_KEYS = (server: string) => `${server} didn't give the keys it signs with, so the attestation can't be checked: try again in a minute`;
const NOT_HTTPS = "a post on another server is reposted from an https address, on the port https has: no other port is asked for a server's keys";
const GONE = 'the attestation says there is no post at that address any more, so there is nothing to repost';
const NOT_NEWER = "this server's entry is from an attestation as new as this one, or newer, so nothing was changed";
const NO_ENTRY = 'this server has no entry for that post, so there is nothing to refresh: repost it to make one';
const NOT_TRUSTED = "this server doesn't trust the post enough to keep it, so it wasn't published";
const NO_TAGS_LEFT = "none of the repost's hashtags is one the post can have and doesn't have already, so it wasn't reposted";
const ALREADY = 'you already reposted this post';
const NOT_REPOSTED = 'that user has no repost of this post';

for (const target of TARGETS) {
  describe(`reposts (${target.name})`, () => {
    let ctx: TestContext;
    afterEach(() => ctx.close());

    /** What the other servers answer when they are asked for their keys, by the address asked. One that isn't here gives no answer. */
    let servers: Record<string, unknown>;
    /** The addresses the server asked, in order. */
    let asked: string[];
    beforeEach(() => {
      servers = { [KEYS]: published(KEY) };
      asked = [];
    });
    const keyFetcher = async (address: string) => {
      asked.push(address);
      if (!(address in servers)) throw new Error('no answer');
      return servers[address];
    };

    const { post, store, storeText, like, unlike, feed, feedItems: feedOf } = requests(() => ctx);
    const req = (u: User | null, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
      ctx.app.inject({ method, url, headers: u ? as(u) : {}, ...(payload && { payload }) });
    const ok = (res: LightMyRequestResponse, status = 200) => {
      expect(res.statusCode, res.body).toBe(status);
      return res.json();
    };
    const refused = (res: LightMyRequestResponse) => [res.statusCode, res.json().error];
    const admin = async (name = 'root') => {
      const u = await ctx.register(name);
      await setAdmin(ctx.db, name, true);
      return u;
    };
    const iso = (ms: number) => new Date(ms).toISOString();
    const ids = (items: { contentId: string }[]) => items.map((i) => i.contentId);

    /** POST /repost as `user`. */
    const repost = (user: User, payload: Record<string, unknown>) => ctx.app.inject({ method: 'POST', url: '/repost', payload: { ...user, ...payload } });
    const content = async (contentId: string, as: User | null = null) => ok(await req(as, 'GET', `/content/${contentId}`));
    const follow = async (user: User, whom: User) => ok(await req(user, 'PUT', `/users/${user.userId}/following/${whom.userId}`), 201);
    const following = async (user: User, query = '') => ok(await req(user, 'GET', `/feed/following?userId=${user.userId}${query}`)).records as FeedItem[];
    /** The rows a repost leaves: "<tag> <username of who reposted, or -> <likes the post had>", sorted. */
    const places = async (contentId: string) =>
      (
        await ctx.db
          .selectFrom('reposts')
          .leftJoin('users', 'users.id', 'reposts.user_id')
          .select(['reposts.tag', 'users.username', 'reposts.likes_before'])
          .where('reposts.content_id', '=', contentId)
          .execute()
      )
        .map((r) => `${r.tag} ${r.username ?? '-'} ${r.likes_before}`)
        .sort();
    /** The places of removed reposts that the compactor is yet to take away (`repost_removals`): their tags, sorted. */
    const removals = async () => (await ctx.db.selectFrom('repost_removals').select('tag').execute()).map((r) => r.tag).sort();
    /** The notices in a user's inbox, oldest first. */
    const inbox = async (u: User) => ok(await req(u, 'GET', `/users/${u.userId}/inbox`)).inbox as Record<string, unknown>[];
    /** The days a piece of content's summary is kept under, in the object store. */
    const summaryDays = async (contentId: string) =>
      (await readdir(join(ctx.dir, 'summaries', 'summaries'), { recursive: true, withFileTypes: true }))
        .filter((f) => f.isFile() && f.name === `${contentId}.br`)
        .map((f) => Number(f.parentPath.split('/').pop()))
        .sort((a, b) => a - b);
    /** The attestation of a post on another server: its address, who published it there, and its summary, signed by that server just now, unless said otherwise. */
    const attested = (o: Record<string, unknown> = {}, { key = KEY, at = ctx.clock.now }: { key?: SigningKey; at?: number } = {}) =>
      attest(key, { url: `${OTHER}/content/${ORIGINAL}`, publisher: DANA, aiGenerated: false, preview: { kind: 'text', text: 'Flooding closes the coast road.' }, ...o } as Attestable, at);
    /** What a client sends of a post on another server: the attestation that server gave it. */
    const origin = (o: Record<string, unknown> = {}, signing: { key?: SigningKey; at?: number } = {}) => ({ attestation: attested(o, signing) });
    /** What the other server signs for a post it no longer publishes: that there is none at the address. */
    const gone = ({ url = `${OTHER}/content/${ORIGINAL}`, key = KEY, at = ctx.clock.now }: { url?: string; key?: SigningKey; at?: number } = {}) => attest(key, { url, gone: true }, at);
    /** POST /repost/refresh as `user`, with an attestation. */
    const refresh = (user: User | null, attestation: unknown) => ctx.app.inject({ method: 'POST', url: '/repost/refresh', payload: { ...user, origin: { attestation } } });
    const other = (n: number) => `${OTHER}/content/${ORIGINAL.slice(0, -1)}${n}`;

    it('gives a post more hashtags, under which it is a new post: placed at the repost, with the likes since', async () => {
      ctx = await createTestContext(target);
      const [alice, bob, carol, dave] = await Promise.all(['alice', 'bob', 'carol', 'dave'].map((name) => ctx.register(name)));
      const postedAt = ctx.clock.now;
      const contentId = await post(alice!, 'Flooding downtown #news');
      ok(await like(carol!, contentId), 201);
      await ctx.compact();

      // Two days on, bob reposts it under #weather. It has #news already, which it isn't given again.
      ctx.clock.now += 2 * DAY;
      const repostedAt = ctx.clock.now;
      const res = ok(await repost(bob!, { contentId, tags: ['Weather', '#news'] }), 201);
      expect(res).toEqual({ contentId, tags: ['weather'], removedTags: [{ tag: 'news', reason: 'already_tagged' }], repostedAt: iso(repostedAt) });

      // The request wrote rows, and nothing else: the post is as it was until the compactor has run.
      expect(await places(contentId)).toEqual([`${authorIndex(bob!.userId)} bob 1`, 'weather bob 1']);
      expect(await queued(ctx)).toEqual([authorIndex(bob!.userId), 'weather'].map((tag) => `${contentId} ${tag}`).sort());
      expect((await content(contentId)).tags).toEqual(['news']);
      expect(await feedOf('weather')).toEqual([]);
      expect((await ctx.db.selectFrom('content').select('id').execute()).length).toBe(1);

      await ctx.compact();
      expect(await queued(ctx)).toEqual([]);
      // It is the one post, with one count of likes, still its publisher's, and says who reposted it.
      expect(await content(contentId)).toMatchObject({
        publisher: { userId: alice!.userId, username: 'alice' },
        tags: ['news', 'weather'],
        likes: 1,
        createdAt: iso(postedAt),
        reposts: [{ by: { userId: bob!.userId, username: 'bob' }, tags: ['weather'], at: iso(repostedAt) }],
      });

      // Under the hashtag the repost gave it, it is a post of the repost's time, with no likes yet.
      const [reposted, ...others] = await feedOf('weather');
      expect(others).toEqual([]);
      expect(reposted).toMatchObject({
        contentId,
        publisher: { userId: alice!.userId, username: 'alice' },
        tags: ['news', 'weather'],
        likes: 0,
        createdAt: iso(postedAt),
        repost: { at: iso(repostedAt) },
      });
      expect(reposted!.repost).not.toHaveProperty('by');
      // Under its own, it is where it was: two days old, out of a day's feed, with all its likes.
      expect(await feedOf('news')).toEqual([]);
      const [own] = (await feed('tags=news&hours=72')).tags.news!;
      expect(own).toMatchObject({ contentId, likes: 1, tags: ['news', 'weather'] });
      expect(own).not.toHaveProperty('repost');
      // A feed of both returns it once.
      expect(Object.values((await feed('tags=news,weather&hours=72')).tags).flat().map((r) => r.contentId)).toEqual([contentId]);

      // A like is the post's, wherever it was read: the repost's entry counts the ones since.
      ok(await like(dave!, contentId), 201);
      await ctx.compact();
      expect((await feedOf('weather'))[0]).toMatchObject({ likes: 1, repost: { at: iso(repostedAt) } });
      expect((await feed('tags=news&hours=72')).tags.news![0]).toMatchObject({ likes: 2 });
      expect((await content(contentId)).likes).toBe(2);

      // A like from before the repost that is taken back was never the entry's: the post loses it, and the entry's count stays.
      expect(ok(await unlike(carol!, contentId))).toEqual({ contentId, likes: 1, wasLiked: true });
      expect(await places(contentId)).toEqual([`${authorIndex(bob!.userId)} bob 0`, 'weather bob 0']);
      await ctx.compact();
      expect((await feedOf('weather'))[0]).toMatchObject({ likes: 1, repost: { at: iso(repostedAt) } });
      expect((await feed('tags=news&hours=72')).tags.news![0]).toMatchObject({ likes: 1 });
      // One from since the repost is the entry's to lose, with the post.
      expect(ok(await unlike(dave!, contentId))).toEqual({ contentId, likes: 0, wasLiked: true });
      expect(await places(contentId)).toEqual([`${authorIndex(bob!.userId)} bob 0`, 'weather bob 0']);
      await ctx.compact();
      expect((await feedOf('weather'))[0]).toMatchObject({ likes: 0, repost: { at: iso(repostedAt) } });
      expect((await feed('tags=news&hours=72')).tags.news![0]).toMatchObject({ likes: 0 });
      expect((await content(contentId)).likes).toBe(0);

      // Its summary is kept under the day it was posted and the day it was reposted, which is where each entry looks for it.
      expect(await summaryDays(contentId)).toEqual([utcDay(postedAt), utcDay(repostedAt)]);
      // The hashtag is listed like any that was just posted under, and counted with the post's others.
      const tags = ok(await req(null, 'GET', '/tags')).tags.map((t: { tag: string }) => t.tag);
      expect(tags).toEqual(expect.arrayContaining(['news', 'weather']));
      expect(await ctx.db.selectFrom('tag_pairs').select(['tag_a', 'tag_b', 'posts']).orderBy('tag_a').orderBy('tag_b').execute()).toEqual([
        { tag_a: 'news', tag_b: 'news', posts: 1 },
        { tag_a: 'news', tag_b: 'weather', posts: 1 },
        { tag_a: 'weather', tag_b: 'weather', posts: 1 },
      ]);
    });

    it("shows a repost to those who follow the reposter, as a new post that says who reposted it", async () => {
      ctx = await createTestContext(target);
      const [alice, bob, erin, frank] = await Promise.all(['alice', 'bob', 'erin', 'frank'].map((name) => ctx.register(name)));
      await follow(erin!, bob!);
      await follow(frank!, alice!);
      await follow(frank!, bob!);
      const postedAt = ctx.clock.now;
      const contentId = await post(alice!, 'Flooding downtown #news');
      ctx.clock.now += HOUR;
      const bobs = await post(bob!, 'My own post #diary');
      await ctx.compact();
      expect(ids(await following(erin!))).toEqual([bobs]);

      ctx.clock.now += HOUR;
      const repostedAt = ctx.clock.now;
      ok(await repost(bob!, { contentId, tags: 'weather' }), 201);
      await ctx.compact();

      // Erin follows bob, not alice: the post reaches her as bob's repost, newest first.
      const erins = await following(erin!);
      expect(ids(erins)).toEqual([contentId, bobs]);
      expect(erins[0]).toMatchObject({
        publisher: { userId: alice!.userId, username: 'alice' },
        createdAt: iso(postedAt),
        likes: 0,
        repost: { at: iso(repostedAt), by: { userId: bob!.userId, username: 'bob' } },
      });
      expect(erins[1]).not.toHaveProperty('repost');

      // Frank follows both: he has it as alice's post, where it was, and again as bob's repost.
      const franks = await following(frank!);
      expect(franks.map((r) => [r.contentId, r.repost?.by?.username])).toEqual([[contentId, 'bob'], [bobs, undefined], [contentId, undefined]]);
      // A page ends between the two, and the next carries on.
      const first = ok(await req(frank!, 'GET', `/feed/following?userId=${frank!.userId}&limit=2`));
      expect(first.truncated).toBe(true);
      const rest = ok(await req(frank!, 'GET', `/feed/following?userId=${frank!.userId}&limit=2&cursor=${first.nextCursor}`));
      expect([...first.records, ...rest.records].map((r: FeedItem) => r.contentId)).toEqual([contentId, bobs, contentId]);

      // An update of the post shows in both at once: they are the one post.
      ok(await storeText(alice!, 'Flooding downtown, roads closed #news', { contentId }));
      expect((await following(erin!))[0]!.preview.text).toBe('Flooding downtown, roads closed #news');
      expect((await feedOf('weather'))[0]).toMatchObject({ preview: { text: 'Flooding downtown, roads closed #news' }, tags: ['news', 'weather'], repost: { at: iso(repostedAt) } });
    });

    it('refuses a repost that is not one: of your own post, a second of the same post, of what is not published, or with no hashtag to give', async () => {
      ctx = await createTestContext(target);
      const root = await admin();
      const [alice, bob, carol] = await Promise.all(['alice', 'bob', 'carol'].map((name) => ctx.register(name)));
      const contentId = await post(alice!, 'Flooding downtown #news #mumbai');

      expect((await ctx.app.inject({ method: 'POST', url: '/repost', payload: { contentId, tags: 'weather' } })).statusCode).toBe(401);
      expect((await repost({ ...bob!, apiKey: carol!.apiKey }, { contentId, tags: 'weather' })).statusCode).toBe(401);
      expect(refused(await repost(alice!, { contentId, tags: 'weather' }))).toEqual([400, "you can't repost your own post: update it to give it other hashtags"]);
      expect(refused(await repost(bob!, { contentId: NO_CONTENT, tags: 'weather' }))).toEqual([404, 'content not found']);
      expect((await repost(bob!, { contentId: 'not-an-id', tags: 'weather' })).statusCode).toBe(400);
      // It says what to repost, one way, and the hashtags to give it.
      const ONE = 'say what to repost: a contentId, for a post on this server, or an origin, for a post on another server: one of them';
      expect(refused(await repost(bob!, { tags: 'weather' }))).toEqual([400, ONE]);
      expect(refused(await repost(bob!, { contentId, origin: origin(), tags: 'weather' }))).toEqual([400, ONE]);
      for (const tags of [undefined, [], '', ' , ']) {
        expect(refused(await repost(bob!, { contentId, tags }))).toEqual([400, "tags is required: a repost gives the post hashtags it doesn't have"]);
      }
      expect(refused(await repost(bob!, { contentId, tags: ['!!!'] }))).toEqual([400, '"!!!" is not a usable hashtag: hashtags are letters, digits and underscores']);
      expect(await places(contentId)).toEqual([]);

      // Hashtags the post has give it nothing, and a repost has to give it one.
      const none = await repost(bob!, { contentId, tags: ['news', '#Mumbai'] });
      expect(refused(none)).toEqual([422, NO_TAGS_LEFT]);
      expect(none.json().removedTags).toEqual([{ tag: 'news', reason: 'already_tagged' }, { tag: 'mumbai', reason: 'already_tagged' }]);

      // A user reposts a post once. Another user can, under other hashtags; ones a repost gave it are the post's by then.
      ok(await repost(bob!, { contentId, tags: 'weather' }), 201);
      expect(refused(await repost(bob!, { contentId, tags: 'rain' }))).toEqual([409, ALREADY]);
      await ctx.compact();
      expect(refused(await repost(bob!, { contentId, tags: 'rain' }))).toEqual([409, ALREADY]);
      expect(refused(await repost(carol!, { contentId, tags: 'weather' }))).toEqual([422, NO_TAGS_LEFT]);
      expect(ok(await repost(carol!, { contentId, tags: 'weather, rain' }), 201)).toMatchObject({ tags: ['rain'], removedTags: [{ tag: 'weather', reason: 'already_tagged' }] });

      // A banned user reposts nothing.
      ok(await req(root, 'PUT', `/banned/${carol!.userId}`), 201);
      expect(refused(await repost(carol!, { contentId, tags: 'storms' }))).toEqual([403, "your account is banned: you can't post, comment, like or send messages"]);

      // What is set for deletion is gone to a repost as to a reader, and so is what waits in the moderation queue.
      ok(await req(alice!, 'DELETE', `/content/${contentId}`), 202);
      expect(refused(await repost(root, { contentId, tags: 'storms' }))).toEqual([404, 'content not found']);
    });

    it('holds a repost to what a post is held to: the limit on posts a minute, the server\'s hashtags, and whether the server takes reposts', async () => {
      ctx = await createTestContext(target, { postRateLimitPerMinute: 1, tagging: { mode: 'server', serverTags: ['news', 'weather', 'local'] } });
      const [alice, bob] = await Promise.all(['alice', 'bob'].map((name) => ctx.register(name)));
      const contentId = await post(alice!, 'Flooding downtown #news');
      const second = await post(bob!, 'Bob was here #local');

      // In server tagging mode a repost gives only the server's hashtags, and is refused before the limit on posts a minute.
      expect(refused(await repost(bob!, { contentId, tags: ['weather', 'sports'] }))).toEqual([400, "#sports is not one of this server's hashtags, which GET /tagging lists"]);
      // So is one refused for what it is, which is told that, not when to try again.
      expect(refused(await repost(alice!, { contentId: second, tags: 'local' }))).toEqual([422, NO_TAGS_LEFT]);
      // Bob posted a moment ago, so his repost is refused as a post would be, and goes through once the minute is over.
      const limited = await repost(bob!, { contentId, tags: 'weather' });
      expect(refused(limited)).toEqual([429, 'you can post at most once a minute; try again in 60 seconds']);
      expect(await places(contentId)).toEqual([]);
      ctx.clock.now += 60_000;
      ok(await repost(bob!, { contentId, tags: 'weather' }), 201);
      // And a post straight after a repost is refused in turn.
      expect((await storeText(bob!, 'Again #local')).statusCode).toBe(429);
      await ctx.close();

      // REPOSTS=false: the server takes none. What was reposted stays.
      ctx = await createTestContext(target);
      const [carol, dave] = await Promise.all(['carol', 'dave'].map((name) => ctx.register(name)));
      const kept = await post(carol!, 'Flooding downtown #news');
      ok(await repost(dave!, { contentId: kept, tags: 'weather' }), 201);
      await ctx.compact();
      ctx.config.reposts.enabled = false;
      expect(refused(await repost(dave!, { contentId: kept, tags: 'rain' }))).toEqual([400, "this server doesn't take reposts"]);
      expect(ids(await feedOf('weather'))).toEqual([kept]);
      // REPOSTS_REMOTE=false: none of posts on other servers.
      ctx.config.reposts.enabled = true;
      ctx.config.reposts.remote = false;
      expect(refused(await repost(dave!, { origin: origin(), tags: 'rain' }))).toEqual([400, "this server doesn't take reposts of posts on other servers"]);
      expect(ok(await repost(carol!, { contentId: await post(dave!, 'Dave was here #local'), tags: 'rain' }), 201).tags).toEqual(['rain']);
    });

    it('lets reposts give a post ten hashtags between them, beside its own', async () => {
      ctx = await createTestContext(target);
      const users = await Promise.all(['alice', 'bob', 'carol', 'dave'].map((name) => ctx.register(name)));
      const [alice, bob, carol, dave] = users;
      const own = Array.from({ length: 10 }, (_, i) => `own${i}`);
      const contentId = await post(alice!, 'Ten of its own', { tags: own });
      const given = Array.from({ length: 10 }, (_, i) => `given${i}`);
      ok(await repost(bob!, { contentId, tags: given.slice(0, 6) }), 201);
      // More than a post can be sent with is refused as a list, and more than reposts can give, as that.
      expect(refused(await repost(carol!, { contentId, tags: Array.from({ length: 11 }, (_, i) => `more${i}`) }))).toEqual([400, 'at most 10 hashtags are allowed, got 11']);
      expect(refused(await repost(carol!, { contentId, tags: ['x1', 'x2', 'x3', 'x4', 'x5'] }))).toEqual([409, 'reposts can give a post at most 10 hashtags']);
      ok(await repost(carol!, { contentId, tags: given.slice(6) }), 201);
      expect(refused(await repost(dave!, { contentId, tags: 'onemore' }))).toEqual([409, 'reposts can give a post at most 10 hashtags']);
      await ctx.compact();
      expect((await content(contentId)).tags).toEqual([...own, ...given]);

      // Its publisher still updates it, sending back all twenty or only their own, and changes only their own.
      expect(ok(await storeText(alice!, 'Ten of its own', { contentId, tags: [...own, ...given] }))).toEqual({ contentId, unchanged: true });
      expect(ok(await storeText(alice!, 'Ten of its own', { contentId, tags: own }))).toEqual({ contentId, unchanged: true });
      expect(refused(await storeText(alice!, 'Ten of its own', { contentId, tags: [...own, 'eleventh'] }))).toEqual([400, 'at most 10 hashtags are allowed, got 11']);
      expect(ok(await storeText(alice!, 'Nine of its own', { contentId, tags: own.slice(1) })).tags).toEqual([...own.slice(1), ...given]);
    });

    it("keeps the hashtags reposts gave a post through its publisher's updates, and holds them to their rules", async () => {
      ctx = await createTestContext(target);
      const root = await admin();
      const [alice, bob, carol] = await Promise.all(['alice', 'bob', 'carol'].map((name) => ctx.register(name)));
      const contentId = await post(alice!, 'Flooding downtown #news');
      ok(await repost(bob!, { contentId, tags: ['weather', 'rain'] }), 201);

      // An update made before the compactor has written the hashtags to the post keeps them all the same.
      const early = ok(await storeText(alice!, 'Flooding downtown, again #news', { contentId }));
      expect(early.tags).toEqual(['news', 'rain', 'weather']);
      await ctx.compact();
      expect(ids(await feedOf('weather'))).toEqual([contentId]);

      // They aren't the publisher's to drop: an update says the publisher's own, and those change as ever.
      expect(ok(await storeText(alice!, 'Flooding downtown, again #news', { contentId, tags: ['news'] }))).toEqual({ contentId, unchanged: true });
      const moved = ok(await storeText(alice!, 'Flooding downtown, again', { contentId, tags: ['local'] }));
      expect(moved.tags).toEqual(['local', 'rain', 'weather']);
      await ctx.compact();
      expect(await feedOf('news')).toEqual([]);
      expect(ids(await feedOf('local'))).toEqual([contentId]);
      expect((await feedOf('rain'))[0]).toMatchObject({ contentId, tags: ['local', 'rain', 'weather'], repost: expect.anything() });
      // Nor does the publisher lose their last: an update with none of their own is refused, as it is of any post.
      expect(refused(await storeText(alice!, 'Flooding downtown, again', { contentId, tags: ['weather'] }))).toEqual([
        400,
        'tags is required: on this server, publishers choose the hashtags of their posts',
      ]);

      // A hashtag's moderators block a word. An update that now says it loses that hashtag, though a repost gave it.
      ok(await req(root, 'POST', '/tags/rain/blocked-words', { words: ['sewage'] }));
      const lost = ok(await storeText(alice!, 'Sewage in the streets', { contentId, tags: ['local'] }));
      expect(lost).toMatchObject({ tags: ['local', 'weather'], removedTags: [{ tag: 'rain', reason: 'blocked_word' }] });
      // At once, by the summary, and for good: it is recorded as removed, by nobody.
      expect(await feedOf('rain')).toEqual([]);
      expect(await ctx.db.selectFrom('tag_moderation').select(['tag', 'decision', 'moderator_id']).where('content_id', '=', contentId).execute()).toEqual([
        { tag: 'rain', decision: 'removed', moderator_id: null },
      ]);
      await ctx.compact();
      expect(await places(contentId)).toEqual([`${authorIndex(bob!.userId)} bob 0`, 'weather bob 0']);
      expect((await content(contentId)).tags).toEqual(['local', 'weather']);
      expect((await content(contentId)).reposts).toEqual([{ by: { userId: bob!.userId, username: 'bob' }, tags: ['weather'], at: expect.any(String) }]);
      // Neither an update nor another repost gets it back.
      ok(await storeText(alice!, 'Dry streets again', { contentId, tags: ['local'] }));
      const again = await repost(carol!, { contentId, tags: 'rain' });
      expect([again.statusCode, again.json().removedTags]).toEqual([422, [{ tag: 'rain', reason: 'removed' }]]);
      await ctx.compact();
      expect(await feedOf('rain')).toEqual([]);
      expect(ids(await feedOf('weather'))).toEqual([contentId]);
    });

    it("holds a repost's hashtags to their moderators: mutes, blocked words and removals, which take a reposted hashtag off like any", async () => {
      ctx = await createTestContext(target);
      const root = await admin();
      const [alice, bob, carol, dave] = await Promise.all(['alice', 'bob', 'carol', 'dave'].map((name) => ctx.register(name)));
      const contentId = await post(alice!, 'Cheap pills downtown #news');
      await follow(dave!, bob!);

      // A user muted on a hashtag doesn't put posts under it, their own or anyone's, and nobody puts theirs there.
      ok(await req(root, 'PUT', `/tags/weather/muted/${bob!.userId}`), 201);
      ok(await req(root, 'PUT', `/tags/rain/muted/${alice!.userId}`), 201);
      // Nor does a post with a hashtag's blocked words get that hashtag from a repost.
      ok(await req(root, 'POST', '/tags/health/blocked-words', { words: ['pills'] }));
      const res = ok(await repost(bob!, { contentId, tags: ['weather', 'rain', 'health', 'local'] }), 201);
      expect(res.tags).toEqual(['local']);
      expect(res.removedTags).toEqual([
        { tag: 'weather', reason: 'muted' },
        { tag: 'rain', reason: 'muted' },
        { tag: 'health', reason: 'blocked_word' },
      ]);
      const all = await repost(carol!, { contentId, tags: ['rain', 'health'] });
      expect([all.statusCode, all.json().error, all.json().removedTags]).toEqual([422, NO_TAGS_LEFT, [{ tag: 'rain', reason: 'muted' }, { tag: 'health', reason: 'blocked_word' }]]);
      await ctx.compact();
      expect(ids(await feedOf('local'))).toEqual([contentId]);
      expect(ids(await following(dave!))).toEqual([contentId]);

      // The hashtag is its moderators' to approve, or to take off the post, as any hashtag of it is. Not the publisher's.
      expect((await feed('tags=local&moderated=false')).tags.local).toHaveLength(1);
      ok(await req(root, 'PUT', `/content/${contentId}/tags/local`), 201);
      await ctx.compact();
      expect((await feedOf('local'))[0]).toMatchObject({ moderated: true, repost: expect.anything() });
      expect((await req(alice!, 'DELETE', `/content/${contentId}/tags/local`)).statusCode).toBe(403);
      expect(ok(await req(root, 'DELETE', `/content/${contentId}/tags/local`))).toMatchObject({ tag: 'local', tags: ['news'] });
      await ctx.compact();
      expect(await feedOf('local')).toEqual([]);
      expect((await content(contentId)).tags).toEqual(['news']);
      // The repost itself stays: bob's followers still have it. It gave the post no hashtag it still has.
      expect(await places(contentId)).toEqual([`${authorIndex(bob!.userId)} bob 0`]);
      expect((await content(contentId)).reposts).toEqual([{ by: { userId: bob!.userId, username: 'bob' }, tags: [], at: expect.any(String) }]);
      expect(ids(await following(dave!))).toEqual([contentId]);
      // And the removal stays: no repost gives the hashtag back.
      const back = await repost(carol!, { contentId, tags: 'local' });
      expect([back.statusCode, back.json().removedTags]).toEqual([422, [{ tag: 'local', reason: 'removed' }]]);
    });

    it('takes a deleted post out of everywhere a repost put it, and a deleted account\'s reposts out of its followers\' feeds', async () => {
      ctx = await createTestContext(target);
      const [alice, bob, carol, erin] = await Promise.all(['alice', 'bob', 'carol', 'erin'].map((name) => ctx.register(name)));
      await follow(erin!, bob!);
      const first = await post(alice!, 'Flooding downtown #news');
      const second = await post(alice!, 'Sunshine at last #news');
      const postedAt = ctx.clock.now;
      await ctx.compact();
      ctx.clock.now += 2 * DAY;
      for (const contentId of [first, second]) ok(await repost(bob!, { contentId, tags: 'weather' }), 201);
      const repostedAt = ctx.clock.now;
      await ctx.compact();
      expect(ids(await feedOf('weather')).sort()).toEqual([first, second].sort());
      expect(ids(await following(erin!)).sort()).toEqual([first, second].sort());
      expect(await summaryDays(first)).toEqual([utcDay(postedAt), utcDay(repostedAt)]);

      // The publisher deletes the first: it is gone from the hashtag the repost gave it and from bob's followers, with its rows and summaries.
      ok(await req(alice!, 'DELETE', `/content/${first}`), 202);
      expect((await ctx.compact()).deleted).toEqual([first]);
      expect(ids(await feedOf('weather'))).toEqual([second]);
      expect(ids(await following(erin!))).toEqual([second]);
      expect(await places(first)).toEqual([]);
      expect(await summaryDays(first)).toEqual([]);

      // Bob deletes his account. He has no posts, but what he reposted is still in his index: the account goes once that is out.
      const closed = ok(await req(bob!, 'DELETE', `/users/${bob!.userId}`), 202);
      expect(closed.status).toBe('pending_deletion');
      expect(await following(erin!)).toEqual([]);
      await ctx.compact();
      expect(await ctx.db.selectFrom('users').select('id').where('id', '=', bob!.userId).execute()).toEqual([]);
      // The hashtag he gave the post is the post's: it stays, with nobody named for it.
      expect(await places(second)).toEqual(['weather - 0']);
      expect(ids(await feedOf('weather'))).toEqual([second]);
      expect((await content(second)).reposts).toEqual([{ tags: ['weather'], at: iso(repostedAt) }]);
      // Whoever follows someone else who reposts it sees that repost, and not his.
      await follow(erin!, carol!);
      ok(await repost(carol!, { contentId: second, tags: 'sun' }), 201);
      await ctx.compact();
      expect((await following(erin!)).map((r) => [r.contentId, r.repost?.by?.username])).toEqual([[second, 'carol']]);
    });

    it("lets a server moderator or an admin remove one user's repost: what it added goes, and the post stays", async () => {
      ctx = await createTestContext(target);
      const root = await admin();
      const [alice, bob, carol, erin, mod] = await Promise.all(['alice', 'bob', 'carol', 'erin', 'mod'].map((name) => ctx.register(name)));
      ok(await req(root, 'PUT', `/moderators/${mod!.userId}`), 201);
      await follow(erin!, bob!);
      const postedAt = ctx.clock.now;
      const contentId = await post(alice!, 'Flooding downtown #news');
      ok(await like(erin!, contentId), 201);
      await ctx.compact();

      // Bob reposts it two days on, and carol the day after: two reposts, on two days.
      ctx.clock.now += 2 * DAY;
      const bobsAt = ctx.clock.now;
      ok(await repost(bob!, { contentId, tags: ['weather', 'rain'] }), 201);
      ctx.clock.now += 13 * HOUR;
      const carolsAt = ctx.clock.now;
      ok(await repost(carol!, { contentId, tags: 'storms' }), 201);
      await ctx.compact();
      expect(ids(await feedOf('weather'))).toEqual([contentId]);
      expect(ids(await following(erin!))).toEqual([contentId]);
      expect((await content(contentId)).tags).toEqual(['news', 'rain', 'weather', 'storms']);
      expect(await summaryDays(contentId)).toEqual([utcDay(postedAt), utcDay(bobsAt), utcDay(carolsAt)]);

      // It is a server moderator's to remove, or an admin's: not the publisher's, nor the reposter's own, nor a stranger's.
      const bobs = `/content/${contentId}/reposts/${bob!.userId}`;
      expect((await req(null, 'DELETE', bobs)).statusCode).toBe(401);
      for (const user of [alice!, bob!, carol!]) expect(refused(await req(user, 'DELETE', bobs))).toEqual([403, 'only an admin or a server moderator can do this']);
      // And only a repost that is there: of content that is, by a user who made one.
      expect(refused(await req(mod!, 'DELETE', `/content/${NO_CONTENT}/reposts/${bob!.userId}`))).toEqual([404, 'content not found']);
      for (const user of [alice!, erin!]) expect(refused(await req(mod!, 'DELETE', `/content/${contentId}/reposts/${user.userId}`))).toEqual([404, NOT_REPOSTED]);
      expect(await places(contentId)).toHaveLength(5);

      expect(ok(await req(mod!, 'DELETE', bobs))).toEqual({ contentId, userId: bob!.userId, status: 'removed', tags: ['rain', 'weather'], repostedAt: iso(bobsAt) });
      // The request deleted the repost's rows, and wrote nothing else: it is no repost from then on, and bob is told.
      expect(await places(contentId)).toEqual([`${authorIndex(carol!.userId)} carol 1`, 'storms carol 1']);
      expect((await content(contentId)).reposts).toEqual([{ by: { userId: carol!.userId, username: 'carol' }, tags: ['storms'], at: iso(carolsAt) }]);
      expect(refused(await req(mod!, 'DELETE', bobs))).toEqual([404, NOT_REPOSTED]);
      expect(await inbox(bob!)).toMatchObject([{ kind: 'repost_removed', contentId, excerpt: 'Flooding downtown #news', text: 'A moderator removed your repost of a post from this server.' }]);
      expect(await inbox(alice!)).toEqual([]);
      // Feeds show it until the compactor has run.
      expect(ids(await feedOf('weather'))).toEqual([contentId]);

      await ctx.compact();
      // What the repost added is gone: its hashtags, with the post's places under them, and its place among what bob's followers see.
      expect(await feedOf('weather')).toEqual([]);
      expect(await feedOf('rain')).toEqual([]);
      expect(await following(erin!)).toEqual([]);
      // The post stays as its publisher and the other repost made it, with its likes.
      expect(await content(contentId)).toMatchObject({ publisher: { userId: alice!.userId, username: 'alice' }, tags: ['news', 'storms'], likes: 1 });
      expect((await feedOf('storms'))[0]).toMatchObject({ contentId, tags: ['news', 'storms'], repost: { at: iso(carolsAt) } });
      expect((await feed('tags=news&hours=336')).tags.news![0]).toMatchObject({ contentId, tags: ['news', 'storms'], likes: 1 });
      // Its summary is under the days it is still found by, and the removal is done with.
      expect(await summaryDays(contentId)).toEqual([utcDay(postedAt), utcDay(carolsAt)]);
      expect(await removals()).toEqual([]);

      // It blocks nothing: bob reposts the post again, and it is back where his repost puts it.
      ctx.clock.now += HOUR;
      expect(ok(await repost(bob!, { contentId, tags: ['weather', 'storms'] }), 201).tags).toEqual(['weather']);
      await ctx.compact();
      expect(ids(await feedOf('weather'))).toEqual([contentId]);
      expect(ids(await following(erin!))).toEqual([contentId]);
      // An admin removes it as a server moderator does. A ban is what keeps bob from making it a third time.
      expect(ok(await req(root, 'DELETE', bobs))).toMatchObject({ status: 'removed', tags: ['weather'] });
      ok(await req(root, 'PUT', `/banned/${bob!.userId}`), 201);
      expect(refused(await repost(bob!, { contentId, tags: 'weather' }))).toEqual([403, "your account is banned: you can't post, comment, like or send messages"]);
      await ctx.compact();
      expect(await feedOf('weather')).toEqual([]);
      expect(await following(erin!)).toEqual([]);
      expect((await content(contentId)).tags).toEqual(['news', 'storms']);
      expect(await places(contentId)).toEqual([`${authorIndex(carol!.userId)} carol 1`, 'storms carol 1']);
    });

    it('takes the hashtags of a removed repost off a post whatever was written of the post around the removal', async () => {
      // The writes requests commit wait for the compactor here, as they do on a server.
      ctx = await createTestContext(target, { settle: false });
      const root = await admin();
      const [alice, bob, carol] = await Promise.all(['alice', 'bob', 'carol'].map((name) => ctx.register(name)));
      const postedAt = ctx.clock.now;
      const contentId = await post(alice!, 'Flooding downtown #news');
      const bobs = `/content/${contentId}/reposts/${bob!.userId}`;
      const tags = async () => (await content(contentId)).tags;
      await ctx.compact();

      // A repost that is removed before a run has made it show never does.
      ok(await repost(bob!, { contentId, tags: 'weather' }), 201);
      ok(await req(root, 'DELETE', bobs));
      await ctx.compact();
      expect(await tags()).toEqual(['news']);
      expect(await feedOf('weather')).toEqual([]);
      expect([await queued(ctx), await removals()]).toEqual([[], []]);

      // An update that committed while the repost was there holds its hashtag, and is applied after the removal: without it.
      ok(await repost(bob!, { contentId, tags: 'weather' }), 201);
      await ctx.compact();
      expect(await tags()).toEqual(['news', 'weather']);
      expect(ok(await storeText(alice!, 'Flooding downtown, again #news', { contentId })).tags).toEqual(['news', 'weather']);
      ok(await req(root, 'DELETE', bobs));
      // The run can't apply the update: the file it names isn't there. It takes the repost away all the same...
      await ctx.db.updateTable('pending_writes').set({ staged_key: 'staged/nowhere' }).where('content_id', '=', contentId).execute();
      await ctx.compact();
      expect(await ctx.content.getMeta(contentId)).toMatchObject({ tags: ['news'], preview: { text: 'Flooding downtown #news' } });
      expect(await feedOf('weather')).toEqual([]);
      // ...and keeps what says the hashtag was the repost's, for the run that does apply it.
      expect(await removals()).toEqual([authorIndex(bob!.userId), 'weather']);
      await ctx.db.updateTable('pending_writes').set({ staged_key: null }).where('content_id', '=', contentId).execute();
      await ctx.compact();
      expect(await content(contentId)).toMatchObject({ tags: ['news'], preview: { text: 'Flooding downtown, again #news' } });
      expect(await feedOf('weather')).toEqual([]);
      expect((await feed('tags=news')).tags.news![0]).toMatchObject({ contentId, tags: ['news'] });
      expect(await removals()).toEqual([]);

      // An update whose request read the post while the repost was there, and that commits once the removal is done with,
      // leaves the hashtag out: it held it as the repost's, and no repost gives it by then.
      ok(await repost(bob!, { contentId, tags: 'weather' }), 201);
      await ctx.compact();
      const row = await ctx.db.selectFrom('content').selectAll().where('id', '=', contentId).executeTakeFirstOrThrow();
      const meta = (await ctx.content.getMeta(contentId))!;
      expect(meta.tags).toEqual(['news', 'weather']);
      ok(await req(root, 'DELETE', bobs));
      await ctx.compact();
      expect(await removals()).toEqual([]);
      const written = await contentWriter(ctx, { warn: () => {} }).write({
        publisher: { userId: alice!.userId, username: 'alice' },
        previous: meta,
        seenSeq: Number(row.seq),
        summary: { ...summaryOf(row, meta, ctx.config.publicBaseUrl), updatedAt: ctx.clock.now },
        meta: { ...meta, updatedAt: ctx.clock.now },
        given: ['weather'],
      });
      expect(written).toEqual(['news']);
      await ctx.compact();
      expect(await tags()).toEqual(['news']);
      expect(await feedOf('weather')).toEqual([]);

      // A hashtag that another repost gives the post before a run has taken the removed one's away is that repost's, and stays.
      ok(await repost(bob!, { contentId, tags: 'weather' }), 201);
      ok(await req(root, 'DELETE', bobs));
      ctx.clock.now += HOUR;
      const carols = ctx.clock.now;
      ok(await repost(carol!, { contentId, tags: 'weather' }), 201);
      await ctx.compact();
      expect(await tags()).toEqual(['news', 'weather']);
      expect((await feedOf('weather'))[0]).toMatchObject({ contentId, repost: { at: iso(carols) } });
      expect((await content(contentId)).reposts).toEqual([{ by: { userId: carol!.userId, username: 'carol' }, tags: ['weather'], at: iso(carols) }]);
      expect(await removals()).toEqual([]);

      // A post that is deleted while a removal waits goes with every copy of its summary, the removed repost's too.
      ctx.clock.now += 2 * DAY;
      ok(await repost(bob!, { contentId, tags: 'rain' }), 201);
      await ctx.compact();
      expect(await summaryDays(contentId)).toEqual([utcDay(postedAt), utcDay(ctx.clock.now)]);
      ok(await req(root, 'DELETE', bobs));
      ok(await req(alice!, 'DELETE', `/content/${contentId}`), 202);
      expect((await ctx.compact()).deleted).toEqual([contentId]);
      expect(await summaryDays(contentId)).toEqual([]);
      expect(await feedOf('rain')).toEqual([]);
      expect(await removals()).toEqual([]);
    });

    it("removes the first repost of a post on another server by deleting the server's entry for it, and a later one on its own", async () => {
      ctx = await createTestContext(target, { publicBaseUrl: 'https://api.example.com', reposts: { signingKeys: OWN_SEEDS }, keyFetcher });
      const root = await admin();
      const [bob, carol, erin, mod] = await Promise.all(['bob', 'carol', 'erin', 'mod'].map((name) => ctx.register(name)));
      ok(await req(root, 'PUT', `/moderators/${mod!.userId}`), 201);
      await follow(erin!, bob!);
      await follow(erin!, carol!);
      const { contentId } = ok(await repost(bob!, { origin: origin(), tags: 'news' }), 201);
      ctx.clock.now += HOUR;
      ok(await repost(carol!, { origin: origin(), tags: 'weather' }), 201);
      await ctx.compact();
      expect(ids(await feedOf('weather'))).toEqual([contentId]);
      expect((await following(erin!)).map((r) => [r.contentId, r.repost?.by?.username])).toEqual([[contentId, 'carol'], [contentId, undefined]]);

      // Carol's is a repost of the entry, and goes like a repost of a post written here: the entry stays, as bob's.
      expect(ok(await req(mod!, 'DELETE', `/content/${contentId}/reposts/${carol!.userId}`))).toMatchObject({ status: 'removed', tags: ['weather'] });
      await ctx.compact();
      expect(await feedOf('weather')).toEqual([]);
      expect(ids(await feedOf('news'))).toEqual([contentId]);
      expect((await following(erin!)).map((r) => [r.contentId, r.repost?.by?.username])).toEqual([[contentId, undefined]]);
      expect((await content(contentId)).tags).toEqual(['news']);

      // Bob's is the entry itself: removing it deletes the entry, which is all this server has of the post, and he is told.
      ok(await repost(carol!, { contentId, tags: 'weather' }), 201);
      const removed = ok(await req(mod!, 'DELETE', `/content/${contentId}/reposts/${bob!.userId}`), 202);
      expect(removed).toEqual({ contentId, userId: bob!.userId, status: 'pending_deletion', requestedAt: iso(ctx.clock.now) });
      expect(refused(await req(null, 'GET', `/content/${contentId}`))).toEqual([404, 'content not found']);
      expect(refused(await req(mod!, 'DELETE', `/content/${contentId}/reposts/${bob!.userId}`))).toEqual([404, 'content not found']);
      expect(await inbox(bob!)).toMatchObject([{ kind: 'repost_removed', contentId, text: 'A moderator removed your repost of a post from this server.' }]);
      expect((await ctx.compact()).deleted).toEqual([contentId]);
      expect([await feedOf('news'), await feedOf('weather'), await following(erin!)]).toEqual([[], [], []]);
      // The original is where it was, on its own server, and can be reposted here anew.
      const anew = ok(await repost(carol!, { origin: origin(), tags: 'news' }), 201);
      expect(anew.contentId).not.toBe(contentId);
    });

    it('shows a repost of a post older than the feeds keep, for as long as they keep the repost, and rebuilds it from the database', async () => {
      ctx = await createTestContext(target, { feed: { tagRetentionDays: 10, maxLookbackDays: 10 } });
      const [alice, bob, erin] = await Promise.all(['alice', 'bob', 'erin'].map((name) => ctx.register(name)));
      await follow(erin!, bob!);
      const postedAt = ctx.clock.now;
      const contentId = await post(alice!, 'Flooding downtown #news');
      await ctx.compact();
      ctx.clock.now += 20 * DAY;
      await ctx.compact();
      expect((await feed('tags=news&hours=2160')).tags).toEqual({});

      // The post is past retention, and out of its own hashtag's feed. Reposted, it is new under the repost's.
      const repostedAt = ctx.clock.now;
      ok(await repost(bob!, { contentId, tags: 'weather' }), 201);
      await ctx.compact();
      expect((await feedOf('weather'))[0]).toMatchObject({ contentId, createdAt: iso(postedAt), repost: { at: iso(repostedAt) } });
      expect(ids(await following(erin!))).toEqual([contentId]);
      expect((await feed('tags=news&hours=2160')).tags).toEqual({});

      // Redis lost everything: --rebuild puts it back where the repost put it, and nowhere else.
      await ctx.hot.clear();
      await ctx.compactor.runOnce({ rebuild: true });
      expect((await feedOf('weather'))[0]).toMatchObject({ contentId, tags: ['news', 'weather'], likes: 0, repost: { at: iso(repostedAt) } });
      expect(ids(await following(erin!))).toEqual([contentId]);
      expect((await feed('tags=news&hours=2160')).tags).toEqual({});

      // The repost ages out like a post of its day.
      ctx.clock.now += 11 * DAY;
      await ctx.compact();
      expect((await feed('tags=weather&hours=2160')).tags).toEqual({});
      expect(await following(erin!)).toEqual([]);
      expect((await content(contentId)).tags).toEqual(['news', 'weather']);
    });

    it('keeps a post on another server as a link to it with its summary: one entry, which is then reposted like any post', async () => {
      ctx = await createTestContext(target, { publicBaseUrl: 'https://api.example.com', reposts: { signingKeys: OWN_SEEDS }, keyFetcher });
      const [alice, bob, carol, erin] = await Promise.all(['alice', 'bob', 'carol', 'erin'].map((name) => ctx.register(name)));
      await follow(erin!, bob!);
      const address = `${OTHER}/content/${ORIGINAL}`;
      // An attestation is good for minutes, so each repost carries one of its own.
      const sent = () => origin({ mimeType: 'image/PNG', aiGenerated: true, preview: { kind: 'image', url: 'https://elsewhere.example/ignored', text: 'Sunset over the bay' } });

      const createdAt = ctx.clock.now;
      const res = ok(await repost(bob!, { origin: sent(), tags: ['Pics'] }), 201);
      const { contentId } = res;
      const stored = { url: address, publisher: DANA };
      // The image is the original's: the link is to the server that has it, not to this one.
      const preview = { kind: 'image', url: `${address}/raw`, text: 'Sunset over the bay' };
      expect(res).toEqual({ contentId, tags: ['pics'], preview, aiGenerated: true, origin: stored });
      await ctx.compact();

      // It is content of the reposter's, in feeds like a post: under its hashtags and to bob's followers, from when it was made.
      const record = { contentId, publisher: { userId: bob!.userId, username: 'bob' }, mimeType: 'image/png', aiGenerated: true, comments: false, preview, tags: ['pics'], origin: stored };
      const [listed] = await feedOf('pics');
      expect(listed).toMatchObject({ ...record, likes: 0, createdAt: iso(createdAt) });
      expect(listed).not.toHaveProperty('repost');
      expect((await following(erin!))[0]).toMatchObject(record);
      const read = await content(contentId);
      expect(read).toMatchObject({ ...record, likes: 0, contentUrl: `/content/${contentId}/raw` });
      // Nothing of the original is here but its summary: no bytes, so no size, and no whole text.
      expect(read).not.toHaveProperty('size');
      expect(read).not.toHaveProperty('text');
      expect(read).not.toHaveProperty('reposts');
      const raw = await req(null, 'GET', `/content/${contentId}/raw`);
      expect([raw.statusCode, raw.headers.location]).toEqual([302, `${address}/raw`]);
      expect(await ctx.db.selectFrom('content').select(['id', 'user_id']).execute()).toEqual([{ id: contentId, user_id: bob!.userId }]);

      // An original has one entry here, however its address is written: the next to repost it gives that entry hashtags.
      ctx.clock.now += HOUR;
      const repostedAt = ctx.clock.now;
      const second = ok(await repost(carol!, { origin: origin({ url: `HTTPS://OTHER.example/content/${ORIGINAL.toUpperCase()}`, preview: { kind: 'text', text: 'Not what it is' } }), tags: ['art', 'pics'] }), 201);
      expect(second).toEqual({ contentId, tags: ['art'], removedTags: [{ tag: 'pics', reason: 'already_tagged' }], repostedAt: iso(repostedAt) });
      expect(await ctx.db.selectFrom('content').select('id').execute()).toHaveLength(1);
      await ctx.compact();
      expect((await feedOf('art'))[0]).toMatchObject({ ...record, tags: ['pics', 'art'], repost: { at: iso(repostedAt) } });
      expect((await content(contentId)).reposts).toEqual([{ by: { userId: carol!.userId, username: 'carol' }, tags: ['art'], at: iso(repostedAt) }]);
      // By its id too. Whoever made the entry reposted the original by making it.
      expect(ok(await repost(alice!, { contentId, tags: 'sunsets' }), 201).tags).toEqual(['sunsets']);
      expect(refused(await repost(bob!, { origin: sent(), tags: 'sunsets2' }))).toEqual([409, ALREADY]);
      expect(refused(await repost(bob!, { contentId, tags: 'sunsets2' }))).toEqual([409, ALREADY]);
      expect(refused(await repost(carol!, { origin: sent(), tags: 'sunsets2' }))).toEqual([409, ALREADY]);

      // It has nothing to update: it is a link. Its owner deletes it like any post, and the original can then be reposted anew.
      const update = await store(bob!, { contentId, type: 'image', text: 'Mine now', tags: ['pics'], content: PNG.toString('base64'), contentEncoding: 'base64', filename: 'pixel.png' });
      expect(refused(update)[0]).toBe(400);
      expect(refused(update)[1]).toMatch(/^a repost of a post on another server can't be updated/);
      ok(await req(bob!, 'DELETE', `/content/${contentId}`), 202);
      expect(refused(await repost(alice!, { origin: sent(), tags: 'pics' }))).toEqual([
        409,
        "this server's entry for the original isn't published: it waits in the moderation queue, or is being deleted",
      ]);
      expect((await ctx.compact()).deleted).toEqual([contentId]);
      expect(await feedOf('art')).toEqual([]);
      const anew = ok(await repost(alice!, { origin: sent(), tags: 'pics' }), 201);
      expect(anew.contentId).not.toBe(contentId);

      // The other server was asked for its keys once, for all of these.
      expect(asked).toEqual([KEYS]);

      // An address that is this server's own names a post of its own, and is reposted as one: nothing is made.
      // Its attestation is this server's, checked with this server's keys, and nobody else's key signs for it.
      const own = await post(alice!, 'Written here #news');
      const mine = ok(await req(null, 'GET', `/content/${own}/attestation`));
      expect(refused(await repost(carol!, { origin: origin({ url: `https://api.example.com/content/${own}` }), tags: 'local' }))).toEqual([400, UNSIGNED]);
      const here = ok(await repost(carol!, { origin: mine, tags: 'local' }), 201);
      expect(here).toMatchObject({ contentId: own, tags: ['local'] });
      expect(here).not.toHaveProperty('origin');
      expect(refused(await repost(alice!, { origin: mine, tags: 'local' }))[0]).toBe(400);
      expect(asked).toEqual([KEYS]);
    });

    it('takes a text or a link from another server too, cut to its own previews, and nothing that is not the summary of a post', async () => {
      ctx = await createTestContext(target, { feed: { previewWords: 5 }, postTypes: { video: false }, keyFetcher });
      const [bob] = await Promise.all(['bob'].map((name) => ctx.register(name)));

      const text = ok(await repost(bob!, { origin: origin({ url: other(1), preview: { kind: 'text', text: 'One two three four five six seven' } }), tags: 'news' }), 201);
      expect(text.preview.kind).toBe('text');
      expect(text.preview.text.startsWith('One two three four five')).toBe(true);
      expect(text.preview.text).not.toContain('six');
      const link = ok(await repost(bob!, { origin: origin({ url: other(2), preview: { kind: 'link', url: 'https://news.example/a?b=c' } }), tags: 'news' }), 201);
      expect(link.preview).toEqual({ kind: 'link', url: 'https://news.example/a?b=c' });
      await ctx.compact();
      const listed = await feedOf('news');
      expect(listed.map((r) => [r.contentId, r.origin?.url]).sort()).toEqual([[text.contentId, other(1)], [link.contentId, other(2)]].sort());
      expect((await content(text.contentId)).mimeType).toBe('text/plain');
      expect((await content(link.contentId)).mimeType).toBe('text/uri-list');

      // What is refused, signed or not: an address that isn't a post's, a publisher that isn't one, a summary that isn't of what it says it is.
      const invalid = async (o: Record<string, unknown>) => {
        const res = await repost(bob!, { origin: origin({ url: other(3), ...o }), tags: 'news' });
        expect(res.statusCode, res.body).toBe(400);
        return res.json();
      };
      /** Refused as no attestation of a post, for what it says at `path`. */
      const unreadable = async (o: Record<string, unknown>, path: string) => {
        const { error, details } = await invalid(o);
        expect([error, details[0].path.join('.')], JSON.stringify(o)).toEqual([INVALID, path]);
      };
      for (const url of [`${OTHER}/content/${ORIGINAL}/raw`, `${OTHER}/content/${ORIGINAL}?a=b`, `${OTHER}/content/${ORIGINAL}#top`, `${OTHER}/posts/${ORIGINAL}`, `https://user:pass@other.example/content/${ORIGINAL}`]) {
        await unreadable({ url }, 'url');
      }
      for (const url of ['ftp://other.example/content/x', 'not a url', `javascript:alert(1)//content/${ORIGINAL}`]) await unreadable({ url }, 'url');
      await unreadable({ publisher: { userId: DANA.userId, username: 'Dana\nof the North' } }, 'publisher.username');
      await unreadable({ publisher: { userId: 'dana', username: 'Dana' } }, 'publisher.userId');
      await unreadable({ publisher: { userId: DANA.userId, username: '' } }, 'publisher.username');
      await unreadable({ preview: { kind: 'text', text: '  ' } }, 'preview.text');
      await unreadable({ preview: { kind: 'link', url: 'javascript:alert(1)' } }, 'preview.url');
      await unreadable({ preview: { kind: 'poll', text: 'Yes or no?' } }, 'preview.kind');
      await unreadable({ mimeType: 'image/png\nx', preview: { kind: 'image' } }, 'mimeType');
      await unreadable({ aiGenerated: 'no' }, 'aiGenerated');
      // An image, video or audio says what file it is, and it is that kind of file.
      expect((await invalid({ preview: { kind: 'image' } })).error).toBe('the original is image, so its attestation must give its image/* content type');
      expect((await invalid({ mimeType: 'video/mp4', preview: { kind: 'audio' } })).error).toBe('the original is audio, so its attestation must give its audio/* content type');
      // A type of post the server doesn't take, it doesn't take from another server either.
      expect((await invalid({ mimeType: 'video/mp4', preview: { kind: 'video' } })).error).toBe("this server doesn't take video posts: the types it takes are image, audio, text, link");
      expect(await ctx.db.selectFrom('content').select('id').execute()).toHaveLength(2);
    });

    it('moderates a repost from another server as the post it is here: by what there is of it to read', async () => {
      const seen: { userId: string; contentId?: string; tags: string[]; texts: string[] }[] = [];
      const wary: TrustPlugin = {
        name: 'wary',
        assess: (assessed) => {
          seen.push(assessed);
          return assessed.texts.some((t) => t.includes('scam')) ? { set: 50 } : assessed.texts.some((t) => t.includes('malware')) ? { set: 0 } : null;
        },
      };
      ctx = await createTestContext(target, { trustPlugins: [wary], keyFetcher });
      const root = await admin();
      const [bob, carol] = await Promise.all(['bob', 'carol'].map((name) => ctx.register(name)));
      ok(await req(root, 'POST', '/tags/health/blocked-words', { words: ['pills'] }));
      ok(await req(root, 'PUT', `/tags/deals/muted/${bob!.userId}`), 201);

      // The trust plugins read its summary, where it is from and who by, and its hashtags' own rules apply.
      const fine = ok(await repost(bob!, { origin: origin({ url: other(1), preview: { kind: 'text', text: 'Cheap **pills** today' } }), tags: ['news', 'health', 'deals'] }), 201);
      expect(fine).toMatchObject({ tags: ['news'], removedTags: [{ tag: 'health', reason: 'blocked_word' }, { tag: 'deals', reason: 'muted' }] });
      expect(seen.at(-1)).toMatchObject({ userId: bob!.userId, tags: ['news', 'health', 'deals'], texts: ['Cheap pills today', other(1), DANA.username] });
      expect(seen.at(-1)!.contentId).toBeUndefined();
      const none = await repost(bob!, { origin: origin({ url: other(2), preview: { kind: 'text', text: 'Cheap pills today' } }), tags: ['health'] });
      expect(refused(none)).toEqual([422, "none of the post's hashtags is allowed on it, and a post needs one, so it wasn't published"]);

      // A score that refuses a post refuses it, and one that holds a post holds it: nobody else reposts it meanwhile.
      const bad = await repost(bob!, { origin: origin({ url: other(3), publisher: { ...DANA, username: 'malware inc' } }), tags: 'news' });
      expect(refused(bad)).toEqual([422, "this server doesn't trust the post enough to keep it, so it wasn't published"]);
      const held = ok(await repost(bob!, { origin: origin({ url: other(4), preview: { kind: 'link', url: 'https://scam.example/win' } }), tags: 'news' }), 202);
      expect(held).toMatchObject({ status: 'pending_review', tags: ['news'], origin: { url: other(4) } });
      expect(refused(await repost(carol!, { origin: origin({ url: other(4) }), tags: 'deals' }))).toEqual([
        409,
        "this server's entry for the original isn't published: it waits in the moderation queue, or is being deleted",
      ]);
      expect(refused(await repost(carol!, { contentId: held.contentId, tags: 'deals' }))).toEqual([404, 'content not found']);
      await ctx.compact();
      expect(ids(await feedOf('news'))).toEqual([fine.contentId]);
      // The queue shows it with where it is from, and accepting it publishes it.
      const waiting = ok(await req(root, 'GET', '/moderation/queue')).queue;
      expect(waiting).toHaveLength(1);
      expect(waiting[0]).toMatchObject({ contentId: held.contentId, origin: { url: other(4), publisher: DANA }, preview: { kind: 'link', url: 'https://scam.example/win' } });
      ok(await req(root, 'POST', `/moderation/queue/${held.contentId}/accept`));
      await ctx.compact();
      expect(ids(await feedOf('news')).sort()).toEqual([fine.contentId, held.contentId].sort());
      expect(ok(await repost(carol!, { origin: origin({ url: other(4) }), tags: 'offers' }), 201)).toMatchObject({ contentId: held.contentId, tags: ['offers'] });

      // A repost of a post that is here is not scored again: the post was, when it was written.
      const scored = seen.length;
      ok(await repost(carol!, { contentId: fine.contentId, tags: 'local' }), 201);
      expect(seen).toHaveLength(scored);
    });

    it("takes a post on another server on that server's signature, and on nothing else", async () => {
      ctx = await createTestContext(target, { keyFetcher });
      const [bob, carol] = await Promise.all(['bob', 'carol'].map((name) => ctx.register(name)));
      const entries = async () => (await ctx.db.selectFrom('content').select('id').execute()).length;
      const send = async (user: User, attestation: unknown, tags = 'news') => refused(await repost(user, { origin: { attestation }, tags }));

      // What a client says of a post itself is not what is asked for: it was all there was, once.
      const said = { url: `${OTHER}/content/${ORIGINAL}`, publisher: DANA, preview: { kind: 'text', text: 'Flooding closes the coast road.' } };
      expect((await repost(bob!, { origin: said, tags: 'news' })).statusCode).toBe(400);
      expect((await repost(bob!, { origin: { ...said, attestation: '' }, tags: 'news' })).statusCode).toBe(400);
      // Nor is what isn't written as an attestation, or says nothing as JSON.
      const signature = attested().split('.')[1]!;
      for (const attestation of ['abc', 'a.b', attested().split('.')[0]!, `${attested()}.x`, `${Buffer.from('not json').toString('base64url')}.${signature}`]) {
        expect(await send(bob!, attestation), attestation).toEqual([400, INVALID]);
      }
      expect(asked).toEqual([]);

      // Signed by somebody else, under the id of the server's key: the id is what is claimed, the signature what is checked.
      const forger = { ...NEXT_KEY, id: KEY.id };
      expect(await send(bob!, attested({}, { key: forger }))).toEqual([400, UNSIGNED]);
      // The server's signature, moved to a payload it didn't sign.
      const changed = attested({ publisher: { ...DANA, username: 'Mallory' } }, { key: forger }).split('.')[0]!;
      expect(await send(bob!, `${changed}.${signature}`)).toEqual([400, UNSIGNED]);
      // Signed with a key the server never had.
      expect(await send(bob!, attested({}, { key: STRAY_KEY }))).toEqual([400, UNSIGNED]);
      // One server's key signs nothing for another server's address.
      servers['https://elsewhere.example/repost/keys'] = published(NEXT_KEY);
      expect(await send(bob!, attested({ url: `https://elsewhere.example/content/${ORIGINAL}` }))).toEqual([400, UNSIGNED]);

      // It is taken for ten minutes from when it was signed, and not from a clock far ahead.
      const now = ctx.clock.now;
      expect(await send(bob!, attested({}, { at: now - 10 * MINUTE - 1 }))).toEqual([400, EXPIRED]);
      expect(await send(bob!, attested({}, { at: now + MINUTE + 1 }))).toEqual([400, EXPIRED]);
      // Keys are asked for over https, on its own port, so a post is reposted from an https address that names no other.
      expect(await send(bob!, attested({ url: `http://other.example/content/${ORIGINAL}` }))).toEqual([400, NOT_HTTPS]);
      expect(await send(bob!, attested({ url: `https://other.example:8443/content/${ORIGINAL}` }))).toEqual([400, NOT_HTTPS]);
      expect(asked).toEqual([KEYS, 'https://elsewhere.example/repost/keys']);
      expect(await entries()).toBe(0);

      // What the server did sign, in time, is taken.
      const made = ok(await repost(bob!, { origin: origin({}, { at: now - 10 * MINUTE }), tags: 'news' }), 201);
      expect(made.origin).toEqual({ url: `${OTHER}/content/${ORIGINAL}`, publisher: DANA });
      expect(ok(await repost(carol!, { origin: origin({ url: other(1) }, { at: now + MINUTE }), tags: 'news' }), 201).origin.url).toBe(other(1));

      // An original the server has an entry of is no easier to forge a repost of: the signature is checked all the same.
      expect(await send(carol!, attested({}, { key: forger }), 'weather')).toEqual([400, UNSIGNED]);
      expect(await places(made.contentId)).toEqual([]);
      expect(ok(await repost(carol!, { origin: origin(), tags: 'weather' }), 201)).toMatchObject({ contentId: made.contentId, tags: ['weather'] });
      expect(await entries()).toBe(2);
    });

    it("keeps a server's keys, and asks again for one it doesn't know, at most once a minute", async () => {
      ctx = await createTestContext(target, { keyFetcher });
      const [bob, carol] = await Promise.all(['bob', 'carol'].map((name) => ctx.register(name)));
      const from = (n: number, key: SigningKey, user = bob!) => repost(user, { origin: origin({ url: other(n) }, { key }), tags: 'news' });

      ok(await from(1, KEY), 201);
      ok(await from(2, KEY, carol!), 201);
      expect(asked).toEqual([KEYS]);

      // The server signs with a new key, and still publishes the old one. The new one isn't known here, so it is asked.
      // Not within a minute of the last time, though: until then the key is taken for nobody's.
      servers[KEYS] = published(NEXT_KEY, KEY);
      expect(refused(await from(3, NEXT_KEY))).toEqual([400, UNSIGNED]);
      expect(asked).toEqual([KEYS]);
      ctx.clock.now += MINUTE;
      ok(await from(3, NEXT_KEY), 201);
      expect(asked).toEqual([KEYS, KEYS]);
      // A key that is nobody's has the server asked again, but not twice in a minute.
      expect(refused(await from(4, STRAY_KEY))).toEqual([400, UNSIGNED]);
      expect(refused(await from(4, STRAY_KEY, carol!))).toEqual([400, UNSIGNED]);
      expect(asked).toHaveLength(2);
      ctx.clock.now += MINUTE;
      expect(refused(await from(4, STRAY_KEY))).toEqual([400, UNSIGNED]);
      expect(asked).toHaveLength(3);

      // The server stops answering. The keys it gave are still its keys, for as long as they were kept for.
      delete servers[KEYS];
      ctx.clock.now += MINUTE;
      expect(refused(await from(4, STRAY_KEY))).toEqual([400, UNSIGNED]);
      expect(asked).toHaveLength(4);
      ok(await from(4, KEY), 201);
      expect(asked).toHaveLength(4);
      // Three hours after it last gave them, they are not: until it answers, nothing from it is taken.
      ctx.clock.now += 3 * HOUR;
      expect(refused(await from(5, KEY))).toEqual([502, NO_KEYS(OTHER)]);
      // It answers again, without the key it took out: what that key signs is no longer taken.
      servers[KEYS] = published(NEXT_KEY);
      expect(refused(await from(5, KEY))).toEqual([502, NO_KEYS(OTHER)]);
      ctx.clock.now += MINUTE;
      expect(refused(await from(5, KEY))).toEqual([400, UNSIGNED]);
      ok(await from(5, NEXT_KEY), 201);

      // A server that gives no keys isn't asked again for a minute, whoever reposts from it. Nothing says why it gave none.
      const before = asked.length;
      const gone = (user: User) => repost(user, { origin: origin({ url: `https://gone.example/content/${ORIGINAL}` }), tags: 'news' });
      expect(refused(await gone(bob!))).toEqual([502, NO_KEYS('https://gone.example')]);
      expect(refused(await gone(carol!))).toEqual([502, NO_KEYS('https://gone.example')]);
      expect(asked.slice(before)).toEqual(['https://gone.example/repost/keys']);
      // One that answers with something else gave none either, and one that signs nothing signed nothing.
      servers['https://odd.example/repost/keys'] = { keys: 'none' };
      servers['https://plain.example/repost/keys'] = { keys: [] };
      servers['https://sly.example/repost/keys'] = { keys: [{ id: KEY.id, algorithm: 'ed25519', publicKey: NEXT_KEY.publicKey }, { id: KEY.id, publicKey: 'short' }, null] };
      expect(refused(await repost(bob!, { origin: origin({ url: `https://odd.example/content/${ORIGINAL}` }), tags: 'news' }))).toEqual([502, NO_KEYS('https://odd.example')]);
      expect(refused(await repost(bob!, { origin: origin({ url: `https://plain.example/content/${ORIGINAL}` }), tags: 'news' }))).toEqual([400, UNSIGNED]);
      // A key's id is worked out from the key: a server doesn't publish its key under another's id.
      expect(refused(await repost(bob!, { origin: origin({ url: `https://sly.example/content/${ORIGINAL}` }), tags: 'news' }))).toEqual([400, UNSIGNED]);
      ok(await repost(bob!, { origin: origin({ url: `https://sly.example/content/${ORIGINAL}` }, { key: NEXT_KEY }), tags: 'news' }), 201);
    });

    it('limits how many servers a user has it ask in a minute', async () => {
      ctx = await createTestContext(target, { keyFetcher });
      const [bob, carol] = await Promise.all(['bob', 'carol'].map((name) => ctx.register(name)));
      const from = (user: User, server: string, tags = 'news') => repost(user, { origin: origin({ url: `https://${server}/content/${ORIGINAL}` }), tags });
      ok(await from(carol!, 'other.example'), 201);

      for (let n = 0; n < 10; n++) expect(refused(await from(bob!, `nowhere${n}.example`))).toEqual([502, NO_KEYS(`https://nowhere${n}.example`)]);
      const limited = await from(bob!, 'nowhere10.example');
      expect(limited.statusCode, limited.body).toBe(429);
      expect(limited.json().error).toMatch(/^too many reposts from servers this one had to ask for their keys; try again in \d+ seconds?$/);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      expect(asked).toHaveLength(11);
      // What needs nobody asked is not limited: a server whose keys are here, and one that was just asked.
      ok(await from(bob!, 'other.example', 'weather'), 201);
      expect(refused(await from(bob!, 'nowhere3.example'))).toEqual([502, NO_KEYS('https://nowhere3.example')]);
      // The limit is each user's own.
      expect(refused(await from(carol!, 'nowhere10.example'))).toEqual([502, NO_KEYS('https://nowhere10.example')]);
      expect(asked).toHaveLength(12);
    });

    it('brings its entry for a post on another server up to a later attestation of it, and never back to an earlier one', async () => {
      const wary: TrustPlugin = {
        name: 'wary',
        assess: (assessed) => (assessed.texts.some((t) => t.includes('scam')) ? { set: 50 } : assessed.texts.some((t) => t.includes('malware')) ? { set: 0 } : null),
      };
      ctx = await createTestContext(target, { publicBaseUrl: 'https://api.example.com', reposts: { signingKeys: OWN_SEEDS }, trustPlugins: [wary], keyFetcher });
      const root = await admin();
      const [alice, bob, carol, dave] = await Promise.all(['alice', 'bob', 'carol', 'dave'].map((name) => ctx.register(name)));
      const address = `${OTHER}/content/${ORIGINAL}`;

      const madeAt = ctx.clock.now;
      const { contentId } = ok(await repost(bob!, { origin: origin(), tags: 'news' }), 201);
      ok(await repost(carol!, { origin: origin(), tags: 'rain' }), 201);
      await ctx.compact();
      // The entry says when the other server signed what it shows.
      expect((await content(contentId)).origin).toEqual({ url: address, publisher: DANA, attestedAt: iso(madeAt) });

      // The post is edited where it is, and its publisher renamed. Somebody brings what the other server now signs:
      // anyone with an account can, and alice has nothing to do with the entry.
      ctx.clock.now += HOUR;
      const editedAt = ctx.clock.now;
      const edited = { preview: { kind: 'text', text: 'The coast road is open again.' }, aiGenerated: true, publisher: { ...DANA, username: 'Dana' } };
      const now = { url: address, publisher: edited.publisher };
      expect((await refresh(null, attested(edited))).statusCode).toBe(401);
      expect(ok(await refresh(alice!, attested(edited)))).toEqual({ contentId, tags: ['news', 'rain'], preview: edited.preview, aiGenerated: true, origin: now });
      // It is read as written at once, and feeds show it once the compactor has run: bob's entry still, where it was, with what reposts gave it.
      expect(await content(contentId)).toMatchObject({
        publisher: { userId: bob!.userId, username: 'bob' },
        preview: edited.preview,
        aiGenerated: true,
        tags: ['news', 'rain'],
        origin: { ...now, attestedAt: iso(editedAt) },
        createdAt: iso(madeAt),
        updatedAt: iso(editedAt),
      });
      await ctx.compact();
      expect((await feedOf('news'))[0]).toMatchObject({ contentId, preview: edited.preview, aiGenerated: true, origin: now });
      expect((await feedOf('rain'))[0]).toMatchObject({ contentId, preview: edited.preview, repost: expect.anything() });
      expect(await places(contentId)).toEqual([`${authorIndex(carol!.userId)} carol 0`, 'rain carol 0']);

      // What says the same changes nothing. What the post was before is not brought back, for the minutes its attestation is still good for.
      ctx.clock.now += MINUTE;
      expect(ok(await refresh(alice!, attested(edited)))).toEqual({ contentId, unchanged: true });
      expect(refused(await refresh(carol!, attested({}, { at: editedAt - 1 })))).toEqual([409, NOT_NEWER]);
      expect(refused(await refresh(carol!, attested({}, { at: editedAt })))).toEqual([409, NOT_NEWER]);
      // It is checked as a repost's is: signed by the post's own server, a short while ago.
      expect(refused(await refresh(carol!, attested({}, { key: STRAY_KEY })))).toEqual([400, UNSIGNED]);
      expect(refused(await refresh(carol!, attested({}, { at: ctx.clock.now - 10 * MINUTE - 1 })))).toEqual([400, EXPIRED]);
      expect(refused(await refresh(carol!, 'abc'))).toEqual([400, INVALID]);
      // There is nothing to refresh of a post the server has no entry for, nor of its own posts. And a post keeps its type.
      expect(refused(await refresh(carol!, attested({ url: other(1) })))).toEqual([404, NO_ENTRY]);
      const own = await post(alice!, 'Written here #local');
      expect(refused(await refresh(carol!, ok(await req(null, 'GET', `/content/${own}/attestation`)).attestation))).toEqual([400, "that post is this server's own: what it is now is what this server shows"]);
      expect(refused(await refresh(carol!, attested({ mimeType: 'image/png', preview: { kind: 'image', text: 'A picture now' } })))).toEqual([
        400,
        "this server's entry for the original is text/plain, and the attestation says image/png: a post keeps its type, so the entry is as it was",
      ]);
      expect((await content(contentId)).preview).toEqual(edited.preview);

      // What it now says is moderated as an update of a post is. A hashtag whose blocked words it has comes off it, though a repost gave it.
      ok(await req(root, 'POST', '/tags/rain/blocked-words', { words: ['sewage'] }));
      const lost = ok(await refresh(alice!, attested({ ...edited, preview: { kind: 'text', text: 'Sewage on the coast road.' } })));
      expect(lost).toMatchObject({ tags: ['news'], removedTags: [{ tag: 'rain', reason: 'blocked_word' }] });
      await ctx.compact();
      expect(await feedOf('rain')).toEqual([]);
      expect((await content(contentId)).tags).toEqual(['news']);
      // A score that refuses a post refuses it, and the entry stays as it was. One that holds a post holds it: out of the feeds until it is accepted.
      ctx.clock.now += MINUTE;
      expect(refused(await refresh(alice!, attested({ ...edited, preview: { kind: 'text', text: 'Free malware on the coast road.' } })))).toEqual([422, NOT_TRUSTED]);
      expect((await content(contentId)).preview.text).toBe('Sewage on the coast road.');
      expect(ok(await refresh(alice!, attested({ ...edited, preview: { kind: 'text', text: 'A scam on the coast road.' } })), 202)).toMatchObject({ contentId, status: 'pending_review', tags: ['news'] });
      await ctx.compact();
      expect(await feedOf('news')).toEqual([]);
      ok(await req(root, 'POST', `/moderation/queue/${contentId}/accept`));
      await ctx.compact();
      expect((await feedOf('news'))[0]).toMatchObject({ contentId, preview: { kind: 'text', text: 'A scam on the coast road.' } });

      // One user's refreshes change an entry ten times a minute. What changes nothing isn't counted.
      const nth = (n: number) => attested({ ...edited, preview: { kind: 'text', text: `The coast road, ${n}.` } });
      for (let n = 0; n < 10; n++) {
        ctx.clock.now += 1;
        ok(await refresh(dave!, nth(n)));
      }
      ctx.clock.now += 1;
      const limited = await refresh(dave!, nth(10));
      expect(limited.statusCode, limited.body).toBe(429);
      expect(limited.json().error).toMatch(/^too many refreshes of reposts; try again in \d+ seconds?$/);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      expect(ok(await refresh(dave!, nth(9)))).toEqual({ contentId, unchanged: true });
      expect((await content(contentId)).preview.text).toBe('The coast road, 9.');
      // The other server's keys were asked for once for all of it, and once more for the key that was nobody's.
      expect(asked).toEqual([KEYS, KEYS]);

      // Where the server takes no reposts of posts on other servers, it takes no word of them either.
      ctx.config.reposts.remote = false;
      expect(refused(await refresh(alice!, nth(11)))).toEqual([400, "this server doesn't take reposts of posts on other servers"]);
    });

    it("hides its entry for a post that the post's own server says is gone, brings it back when the post is attested again, and deletes it after days with no word of it", async () => {
      ctx = await createTestContext(target, { keyFetcher });
      const root = await admin();
      const [alice, bob, carol, erin] = await Promise.all(['alice', 'bob', 'carol', 'erin'].map((name) => ctx.register(name)));
      const address = `${OTHER}/content/${ORIGINAL}`;
      await follow(erin!, bob!);
      const madeAt = ctx.clock.now;
      const { contentId } = ok(await repost(bob!, { origin: origin(), tags: 'news' }), 201);
      ok(await repost(carol!, { origin: origin(), tags: 'rain' }), 201);
      await ctx.compact();
      expect(ids(await following(erin!))).toEqual([contentId]);
      const carols = [`${authorIndex(carol!.userId)} carol 0`, 'rain carol 0'];

      // That a post is gone is nothing to repost.
      ctx.clock.now += 5 * MINUTE;
      expect(refused(await repost(alice!, { origin: { attestation: gone() }, tags: 'weather' }))).toEqual([400, GONE]);
      // It is the post's own server that says so, after it said what the entry holds: nobody else, and not from before.
      expect(refused(await refresh(alice!, gone({ key: STRAY_KEY })))).toEqual([400, UNSIGNED]);
      expect(refused(await refresh(alice!, gone({ at: madeAt })))).toEqual([409, NOT_NEWER]);
      expect(refused(await refresh(alice!, gone({ url: other(1) })))).toEqual([404, NO_ENTRY]);
      expect((await content(contentId)).contentId).toBe(contentId);

      // Then the entry is hidden, and not deleted: the other server says the same of a post that only waits in its moderation queue.
      const goneAt = ctx.clock.now;
      const hidden = { contentId, status: 'origin_gone', goneAt: iso(goneAt), deleteAfter: iso(goneAt + 7 * DAY) };
      expect(ok(await refresh(alice!, gone()))).toEqual(hidden);
      // It is gone to readers at once, as content that waits in the moderation queue is: its owner and the admins still read it, and are told why.
      for (const reader of [null, alice!, carol!]) expect(refused(await req(reader, 'GET', `/content/${contentId}`))).toEqual([404, 'content not found']);
      for (const reader of [bob!, root]) {
        expect(await content(contentId, reader)).toMatchObject({ status: 'origin_gone', tags: ['news', 'rain'], origin: { url: address, goneAt: iso(goneAt), deleteAfter: iso(goneAt + 7 * DAY) } });
      }
      expect((await req(null, 'GET', `/content/${contentId}/raw`)).statusCode).toBe(404);
      // Nobody likes it or reposts it meanwhile.
      expect(refused(await like(alice!, contentId))).toEqual([404, 'content not found']);
      expect(refused(await repost(alice!, { contentId, tags: 'weather' }))).toEqual([404, 'content not found']);
      // The same word again changes nothing, and later word that it is still gone leaves it hidden from when it first was.
      expect(refused(await refresh(alice!, gone()))).toEqual([409, NOT_NEWER]);
      ctx.clock.now += MINUTE;
      const confirmedAt = ctx.clock.now;
      expect(ok(await refresh(alice!, gone()))).toEqual({ ...hidden, unchanged: true });
      // The compactor's next run takes it out of every feed, and its summary with it. What reposts gave it stays its own.
      expect((await ctx.compact()).deleted).toEqual([]);
      expect([await feedOf('news'), await feedOf('rain'), await following(erin!)]).toEqual([[], [], []]);
      expect(await summaryDays(contentId)).toEqual([]);
      expect(await places(contentId)).toEqual(carols);

      // What the other server said of the post before it said it was gone doesn't bring it back, for the minutes that is still good for.
      expect(refused(await refresh(alice!, attested({}, { at: confirmedAt - 1 })))).toEqual([409, NOT_NEWER]);
      // The post only waited in a queue there, and is published again: a later attestation of it puts the entry back where it was.
      ctx.clock.now += HOUR;
      const backAt = ctx.clock.now;
      const back = ok(await refresh(alice!, attested()));
      expect(back).toMatchObject({ contentId, tags: ['news', 'rain'], origin: { url: address, publisher: DANA } });
      expect(back).not.toHaveProperty('status');
      const read = await content(contentId);
      expect(read).not.toHaveProperty('status');
      expect(read.origin).toEqual({ url: address, publisher: DANA, attestedAt: iso(backAt) });
      await ctx.compact();
      expect([ids(await feedOf('news')), ids(await feedOf('rain')), ids(await following(erin!))]).toEqual([[contentId], [contentId], [contentId]]);
      expect((await feedOf('rain'))[0]).toMatchObject({ repost: expect.anything(), tags: ['news', 'rain'] });
      expect(await places(contentId)).toEqual(carols);
      ok(await like(alice!, contentId), 201);

      // It is gone again, and this time no attestation of it follows. The entry is deleted by the first run after seven days of that, and not before.
      ctx.clock.now += MINUTE;
      const againAt = ctx.clock.now;
      expect(ok(await refresh(alice!, gone()))).toMatchObject({ status: 'origin_gone', goneAt: iso(againAt), deleteAfter: iso(againAt + 7 * DAY) });
      ctx.clock.now += 7 * DAY - HOUR;
      expect((await ctx.compact()).deleted).toEqual([]);
      expect(await content(contentId, bob!)).toMatchObject({ status: 'origin_gone', likes: 1 });
      // A like is still its user's to take back while the entry is hidden. To whoever has no like of it, the entry isn't there.
      expect(refused(await unlike(carol!, contentId))).toEqual([404, 'content not found']);
      expect(ok(await unlike(alice!, contentId))).toEqual({ contentId, likes: 0, wasLiked: true });
      expect(refused(await unlike(alice!, contentId))).toEqual([404, 'content not found']);
      expect(await content(contentId, bob!)).toMatchObject({ status: 'origin_gone', likes: 0 });
      ctx.clock.now += HOUR;
      expect((await ctx.compact()).deleted).toEqual([contentId]);
      expect((await req(bob!, 'GET', `/content/${contentId}`)).statusCode).toBe(404);
      expect(await places(contentId)).toEqual([]);
      expect(refused(await refresh(alice!, gone()))).toEqual([404, NO_ENTRY]);

      // A post that is there again after that is reposted anew, and what said it was gone before isn't taken against the new entry.
      ctx.clock.now += MINUTE;
      const anew = ok(await repost(carol!, { origin: origin(), tags: 'news' }), 201).contentId;
      expect(anew).not.toBe(contentId);
      expect(refused(await refresh(alice!, gone({ at: ctx.clock.now - MINUTE })))).toEqual([409, NOT_NEWER]);
      expect((await content(anew)).contentId).toBe(anew);
    });

    it('takes a repost of a hidden entry as word that the post is there again', async () => {
      const wary: TrustPlugin = { name: 'wary', assess: (assessed) => (assessed.texts.some((t) => t.includes('scam')) ? { set: 50 } : null) };
      ctx = await createTestContext(target, { trustPlugins: [wary], keyFetcher });
      const [alice, bob, carol] = await Promise.all(['alice', 'bob', 'carol'].map((name) => ctx.register(name)));
      const { contentId } = ok(await repost(bob!, { origin: origin(), tags: 'news' }), 201);
      const held = ok(await repost(bob!, { origin: origin({ url: other(1) }), tags: 'news' }), 201).contentId;
      await ctx.compact();
      ctx.clock.now += MINUTE;
      const goneAt = ctx.clock.now;
      expect(ok(await refresh(alice!, gone()))).toMatchObject({ contentId, status: 'origin_gone' });
      expect(ok(await refresh(alice!, gone({ url: other(1) })))).toMatchObject({ contentId: held, status: 'origin_gone' });
      await ctx.compact();
      expect(await feedOf('news')).toEqual([]);

      // Not with what the other server said before the post was gone: that is the older word.
      expect(refused(await repost(carol!, { origin: origin({}, { at: goneAt - 1 }), tags: 'rain' }))).toEqual([409, NOT_NEWER]);
      expect((await req(null, 'GET', `/content/${contentId}`)).statusCode).toBe(404);
      // With a later attestation of the post, the entry is back as the post is now, and the repost is made of it as of any entry.
      ctx.clock.now += MINUTE;
      const now = { preview: { kind: 'text', text: 'The coast road is open again.' } };
      expect(ok(await repost(carol!, { origin: origin(now), tags: 'rain' }), 201)).toMatchObject({ contentId, tags: ['rain'] });
      expect(await content(contentId)).toMatchObject({ preview: now.preview, origin: { attestedAt: iso(ctx.clock.now) } });
      await ctx.compact();
      expect([ids(await feedOf('news')), ids(await feedOf('rain'))]).toEqual([[contentId], [contentId]]);
      expect((await feedOf('rain'))[0]).toMatchObject({ preview: now.preview, tags: ['news', 'rain'] });

      // What the post now says is moderated like any update. Held, it leaves the entry unpublished, though no longer for being gone, and nobody reposts it yet.
      const scam = { url: other(1), preview: { kind: 'text', text: 'A scam on the coast road.' } };
      expect(refused(await repost(carol!, { origin: origin(scam), tags: 'rain' }))).toEqual([409, "this server's entry for the original isn't published: it waits in the moderation queue, or is being deleted"]);
      expect(await content(held, bob!)).toMatchObject({ status: 'pending_review', preview: scam.preview });
      expect((await req(null, 'GET', `/content/${held}`)).statusCode).toBe(404);
      expect(await places(held)).toEqual([]);
    });

    it('asks the servers of the posts it holds reposts of what the posts are now, itself, a day after it last heard', async () => {
      /** What the other servers answer when they are asked for a post's attestation, by the address asked. One that isn't here gives no answer. */
      const answers: Record<string, () => { status: number; body: unknown }> = {};
      const fetched: string[] = [];
      const attestationFetcher = async (address: string) => {
        fetched.push(address);
        const answer = answers[address];
        if (!answer) throw new Error('no answer');
        return answer();
      };
      /** The addresses asked since this was last called. */
      const asks = () => fetched.splice(0);
      ctx = await createTestContext(target, { keyFetcher, attestationFetcher });
      servers['https://slow.example/repost/keys'] = published(KEY);
      const [bob, carol] = await Promise.all(['bob', 'carol'].map((name) => ctx.register(name)));
      const address = `${OTHER}/content/${ORIGINAL}`;
      const slow = (n: number) => `https://slow.example/content/${ORIGINAL.slice(0, -1)}${n}`;
      const shown = async (id: string) => (await content(id)).preview.text;
      /** A hashtag's feed of the last week: the entries are older than a day by the time they are asked about. */
      const week = async (tag: string) => (await feed(`tags=${tag}&hours=168`)).tags[tag] ?? [];
      const is = (url: string, text: string) => () => ({ status: 200, body: { attestation: attested({ url, preview: { kind: 'text', text } }) } });
      const isGone = (url: string) => () => ({ status: 404, body: { error: 'content not found', gone: gone({ url }) } });

      // Three entries, made a moment apart: one of a post on one server, two of posts on another.
      const { contentId } = ok(await repost(bob!, { origin: origin(), tags: 'news' }), 201);
      ok(await repost(carol!, { origin: origin(), tags: 'rain' }), 201);
      ctx.clock.now += 1;
      const first = ok(await repost(bob!, { origin: origin({ url: slow(1) }), tags: 'news' }), 201).contentId;
      ctx.clock.now += 1;
      const second = ok(await repost(bob!, { origin: origin({ url: slow(2) }), tags: 'news' }), 201).contentId;
      await ctx.compact();

      // Nobody is asked about a post the server heard of within the day.
      ctx.clock.now += 23 * HOUR;
      expect(await ctx.sweep()).toBe(0);
      expect(asks()).toEqual([]);

      // A day on, each post's own server is asked for its attestation. One post was edited, and the entry now says so.
      // The other server gives no answer: it is asked once, not once for each of its posts, and its entries stay as they are.
      ctx.clock.now += HOUR;
      answers[`${address}/attestation`] = is(address, 'The coast road is open again.');
      expect(await ctx.sweep()).toBe(3);
      expect(asks()).toEqual([`${address}/attestation`, `${slow(1)}/attestation`]);
      expect(await shown(contentId)).toBe('The coast road is open again.');
      expect(await shown(first)).toBe('Flooding closes the coast road.');
      await ctx.compact();
      expect((await week('rain'))[0]).toMatchObject({ contentId, preview: { kind: 'text', text: 'The coast road is open again.' }, tags: ['news', 'rain'] });
      // The entry that was heard of isn't asked about again for a day, and the others for an hour.
      expect(await ctx.sweep()).toBe(0);

      // An hour on, that server answers. What it says is checked as what a client brings is: an attestation
      // that isn't signed with its key, or is of another post, changes nothing.
      ctx.clock.now += HOUR;
      answers[`${slow(1)}/attestation`] = () => ({ status: 200, body: { attestation: attested({ url: slow(1), preview: { kind: 'text', text: 'Forged.' } }, { key: STRAY_KEY }) } });
      expect(await ctx.sweep()).toBe(2);
      expect(asks()).toEqual([`${slow(1)}/attestation`]);
      ctx.clock.now += HOUR;
      answers[`${slow(1)}/attestation`] = is(slow(2), 'Of another post.');
      expect(await ctx.sweep()).toBe(2);
      expect(asks()).toEqual([`${slow(1)}/attestation`]);
      expect([await shown(first), await shown(second)]).toEqual(['Flooding closes the coast road.', 'Flooding closes the coast road.']);

      // It says one post is gone: a 404 that carries its signed word of that. The entry is hidden. A 404 with nothing signed says nothing.
      ctx.clock.now += HOUR;
      answers[`${slow(1)}/attestation`] = isGone(slow(1));
      answers[`${slow(2)}/attestation`] = () => ({ status: 404, body: { error: 'content not found' } });
      expect(await ctx.sweep()).toBe(2);
      expect(asks()).toEqual([`${slow(1)}/attestation`, `${slow(2)}/attestation`]);
      expect((await req(null, 'GET', `/content/${first}`)).statusCode).toBe(404);
      expect(await content(first, bob!)).toMatchObject({ status: 'origin_gone' });
      expect(await shown(second)).toBe('Flooding closes the coast road.');
      await ctx.compact();
      expect(ids(await week('news')).sort()).toEqual([contentId, second].sort());

      // A hidden entry is asked about again after six hours, not a day. The post is back, and so is the entry.
      answers[`${slow(2)}/attestation`] = is(slow(2), 'Flooding closes the coast road.');
      ctx.clock.now += 5 * HOUR;
      expect(await ctx.sweep()).toBe(1);
      expect(asks()).toEqual([`${slow(2)}/attestation`]);
      ctx.clock.now += HOUR;
      answers[`${slow(1)}/attestation`] = is(slow(1), 'Back on the coast road.');
      expect(await ctx.sweep()).toBe(1);
      expect(asks()).toEqual([`${slow(1)}/attestation`]);
      expect(await shown(first)).toBe('Back on the coast road.');
      await ctx.compact();
      expect(ids(await week('news')).sort()).toEqual([contentId, first, second].sort());
    });

    it('keeps the later of two attestations that arrive at once, whichever is written first', async () => {
      ctx = await createTestContext(target, { keyFetcher });
      const [alice, bob] = await Promise.all(['alice', 'bob'].map((name) => ctx.register(name)));
      const { contentId } = ok(await repost(bob!, { origin: origin(), tags: 'news' }), 201);
      const saying = (text: string, at: number) => attested({ preview: { kind: 'text', text } }, { at });
      const shown = async () => (await content(contentId)).preview.text;
      ctx.clock.now += 5 * MINUTE;
      const t = ctx.clock.now;

      // Another refresh, run between one's reading the entry and its writing it: where a refresh that changes something is counted.
      let meanwhile: (() => Promise<unknown>) | undefined;
      const incr = ctx.hot.incr.bind(ctx.hot);
      ctx.hot.incr = async (key, ttlMs) => {
        const run = key.startsWith('originrefreshes:') ? meanwhile : undefined;
        if (run) {
          meanwhile = undefined;
          await run();
        }
        return incr(key, ttlMs);
      };

      // A later attestation commits while an earlier one is on its way: the earlier one is refused as it commits.
      meanwhile = async () => ok(await refresh(alice!, saying('Later.', t)));
      expect(refused(await refresh(alice!, saying('Earlier.', t - 1)))).toEqual([409, NOT_NEWER]);
      expect(await shown()).toBe('Later.');
      // The other way round both are written, in turn, and the later one last.
      meanwhile = async () => ok(await refresh(alice!, saying('Earlier still.', t + 1)));
      ok(await refresh(alice!, saying('Latest.', t + 2)));
      expect(await shown()).toBe('Latest.');

      // Word that the post is gone is held to the same. The post was attested again while it was on its way: it is the older word as it commits.
      meanwhile = async () => ok(await refresh(alice!, saying('Back again.', t + 4)));
      expect(refused(await refresh(alice!, gone({ at: t + 3 })))).toEqual([409, NOT_NEWER]);
      expect(await shown()).toBe('Back again.');
      await ctx.compact();
      expect((await feedOf('news'))[0]).toMatchObject({ contentId, preview: { kind: 'text', text: 'Back again.' } });

      // And the other way round: an attestation of the post from before it was gone, which commits after the word that it is, doesn't bring it back.
      meanwhile = async () => expect(ok(await refresh(alice!, gone({ at: t + 6 })))).toMatchObject({ status: 'origin_gone' });
      expect(refused(await refresh(alice!, saying('Too late.', t + 5)))).toEqual([409, NOT_NEWER]);
      expect((await req(null, 'GET', `/content/${contentId}`)).statusCode).toBe(404);
      expect(await content(contentId, bob!)).toMatchObject({ status: 'origin_gone', preview: { kind: 'text', text: 'Back again.' } });
    });

    it('attests its own published posts, signed with its first key, and publishes its keys', async () => {
      const wary: TrustPlugin = { name: 'wary', assess: (assessed) => (assessed.texts.some((t) => t.includes('scam')) ? { set: 50 } : null) };
      ctx = await createTestContext(target, { publicBaseUrl: 'https://api.example.com/', reposts: { signingKeys: OWN_SEEDS }, trustPlugins: [wary], keyFetcher });
      const [alice, bob] = await Promise.all(['alice', 'bob'].map((name) => ctx.register(name)));
      const [first, second] = signingKeys(OWN_SEEDS) as [SigningKey, SigningKey];
      const attestation = (contentId: string, as: User | null = null) => req(as, 'GET', `/content/${contentId}/attestation`);

      // The keys it publishes are the public halves, each under the id worked out from it.
      const keys = await req(null, 'GET', '/repost/keys');
      expect(ok(keys)).toEqual(published(first, second));
      expect(keys.body).not.toContain(OWN_SEEDS[0]);

      // A post's attestation says where it is, who published it, and its summary, as of now.
      const contentId = await post(alice!, 'Flooding downtown #news');
      const res = await attestation(contentId);
      const read = readAttestation(ok(res).attestation)!;
      expect(res.headers['cache-control']).toBe('no-store');
      expect(read.payload).toEqual({
        v: 1,
        kid: first.id,
        issuedAt: ctx.clock.now,
        url: `https://api.example.com/content/${contentId}`,
        publisher: { userId: alice!.userId, username: 'alice' },
        mimeType: 'text/plain',
        aiGenerated: false,
        preview: { kind: 'text', text: 'Flooding downtown #news' },
      });
      expect([signedBy(first, read), signedBy(second, read)]).toEqual([true, false]);
      // An image's says what file it is, and not where: that is the post's address.
      const mp = multipart({ ...alice!, type: 'image', text: 'One pixel', tags: 'pics', aiGenerated: 'true' }, { name: 'pixel.png', type: 'image/png', data: PNG });
      const image = ok(await ctx.app.inject({ method: 'POST', url: '/store', payload: mp.payload, headers: mp.headers }), 201).contentId;
      expect(readAttestation(ok(await attestation(image)).attestation)!.payload).toMatchObject({ mimeType: 'image/png', aiGenerated: true, preview: { kind: 'image', text: 'One pixel' } });
      // An update shows in the next one.
      ok(await storeText(alice!, 'Flooding downtown, roads closed #news', { contentId }));
      expect(readAttestation(ok(await attestation(contentId)).attestation)!.payload).toMatchObject({ preview: { kind: 'text', text: 'Flooding downtown, roads closed #news' } });

      // Only of what is published: not of what waits in the moderation queue, even to its publisher, nor of what is being deleted.
      const held = ok(await storeText(alice!, 'A scam, surely #news'), 202).contentId;
      expect(refused(await attestation(held, alice!))).toEqual([404, 'content not found']);
      expect(refused(await attestation(NO_CONTENT))).toEqual([404, 'content not found']);
      ok(await req(alice!, 'DELETE', `/content/${image}`), 202);
      const deleted = await attestation(image);
      expect(refused(deleted)).toEqual([404, 'content not found']);
      // That there is no post there is signed too, for the servers that hold a repost of one that was: the same of all three, which says no more than the 404 does.
      const said = readAttestation(deleted.json().gone)!;
      expect(said.payload).toEqual({ v: 1, kid: first.id, issuedAt: ctx.clock.now, url: `https://api.example.com/content/${image}`, gone: true });
      expect([signedBy(first, said), deleted.headers['cache-control']]).toEqual([true, 'no-store']);
      for (const res of [await attestation(held, alice!), await attestation('ABCDEF00-0000-4000-8000-000000000000')]) {
        expect(Object.keys(res.json()).sort()).toEqual(['error', 'gone']);
        expect(readAttestation(res.json().gone)!.payload).toMatchObject({ url: expect.stringMatching(/^https:\/\/api\.example\.com\/content\/[0-9a-f-]{36}$/), gone: true });
      }

      // And only of what is this server's to speak for: its entry for a post on another server names the original instead.
      const entry = ok(await repost(bob!, { origin: origin(), tags: 'news' }), 201).contentId;
      const not = await attestation(entry);
      expect(not.statusCode, not.body).toBe(409);
      expect(not.json()).toMatchObject({
        error: `this is a repost of a post on another server, which is the one to repost: ${OTHER}/content/${ORIGINAL}`,
        origin: { url: `${OTHER}/content/${ORIGINAL}` },
      });
      await ctx.close();

      // A server with no key signs nothing: it has no keys to publish, and still says where the original of its entry is.
      const OFF = "this server doesn't sign its posts, so they can't be reposted on other servers";
      ctx = await createTestContext(target, { publicBaseUrl: 'https://api.example.com', keyFetcher });
      const [carol, dave] = await Promise.all(['carol', 'dave'].map((name) => ctx.register(name)));
      const plain = await post(carol!, 'Flooding downtown #news');
      expect(ok(await req(null, 'GET', '/repost/keys'))).toEqual({ keys: [] });
      expect(refused(await attestation(plain))).toEqual([400, OFF]);
      expect((await attestation(NO_CONTENT)).json()).toEqual({ error: 'content not found' });
      expect((await attestation(ok(await repost(dave!, { origin: origin(), tags: 'news' }), 201).contentId)).statusCode).toBe(409);
      // It still takes reposts from servers that do sign. Nothing signs for its own address, though.
      expect(refused(await repost(dave!, { origin: origin({ url: `https://api.example.com/content/${plain}` }), tags: 'local' }))).toEqual([400, UNSIGNED]);
      await ctx.close();
      // Nor does one that has a key and no address to say its posts are at.
      ctx = await createTestContext(target, { reposts: { signingKeys: OWN_SEEDS } });
      expect(refused(await attestation(await post(await ctx.register('erin'), 'Flooding downtown #news')))).toEqual([400, OFF]);
    });

    it('reposts an image, whose bytes stay the one file', async () => {
      ctx = await createTestContext(target);
      const [alice, bob] = await Promise.all(['alice', 'bob'].map((name) => ctx.register(name)));
      const mp = multipart({ ...alice!, type: 'image', text: 'One pixel', tags: 'pics' }, { name: 'pixel.png', type: 'image/png', data: PNG });
      const { contentId } = ok(await ctx.app.inject({ method: 'POST', url: '/store', payload: mp.payload, headers: mp.headers }), 201);
      ok(await repost(bob!, { contentId, tags: 'art' }), 201);
      await ctx.compact();
      const [record] = await feedOf('art');
      expect(record).toMatchObject({ contentId, preview: { kind: 'image', url: `/content/${contentId}/raw`, text: 'One pixel' }, tags: ['pics', 'art'] });
      expect((await req(null, 'GET', `/content/${contentId}/raw`)).rawPayload).toEqual(PNG);
      expect(await content(contentId)).toMatchObject({ size: PNG.length, tags: ['pics', 'art'] });
      expect((await readdir(join(ctx.dir, 'content', 'content'))).filter((name) => !name.endsWith('.meta.json'))).toEqual([contentId]);
    });
  });
}
