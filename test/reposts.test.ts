import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attest, readAttestation, signedBy, signingKeys, type Attestable } from '../src/attestation.js';
import type { PublishedKey, SigningKey } from '../src/attestation.types.js';
import { setAdmin } from '../src/moderation/policy.js';
import type { TrustPlugin } from '../src/moderation/trust.types.js';
import { authorIndex } from '../src/tagfeed/layout.js';
import { DAY, HOUR, MINUTE, utcDay } from '../src/time.js';
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
const NO_TAGS_LEFT = "none of the repost's hashtags is one the post can have and doesn't have already, so it wasn't reposted";
const ALREADY = 'you already reposted this post';

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

    const { post, store, storeText, like, feed, feedItems: feedOf } = requests(() => ctx);
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

    it('holds a repost to what a post is held to: challenges, the server\'s hashtags, and whether the server takes reposts', async () => {
      ctx = await createTestContext(target, { challenge: { postWindowSeconds: 60 }, tagging: { mode: 'server', serverTags: ['news', 'weather', 'local'] } });
      const [alice, bob] = await Promise.all(['alice', 'bob'].map((name) => ctx.register(name)));
      const contentId = await post(alice!, 'Flooding downtown #news');
      const second = await post(bob!, 'Bob was here #local');

      // In server tagging mode a repost gives only the server's hashtags, and is refused before any challenge.
      expect(refused(await repost(bob!, { contentId, tags: ['weather', 'sports'] }))).toEqual([400, "#sports is not one of this server's hashtags, which GET /tagging lists"]);
      // Bob posted a moment ago, so his repost is challenged like a post would be, and goes through once it is solved.
      const asked = await repost(bob!, { contentId, tags: 'weather' });
      expect(asked.statusCode, asked.body).toBe(428);
      expect(asked.json().error).toBe('you posted or were challenged less than 60 seconds ago; solve the challenge to post');
      expect(await places(contentId)).toEqual([]);
      ok(await repost(bob!, { contentId, tags: 'weather', ...(await ctx.solve(asked.json().challenge)) }), 201);
      // And a post straight after a repost is challenged in turn.
      expect((await storeText(bob!, 'Again #local')).statusCode).toBe(428);
      // One refused for what it is costs no challenge.
      expect(refused(await repost(alice!, { contentId: second, tags: 'local' }))).toEqual([422, NO_TAGS_LEFT]);
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
      // Keys are asked for over https, so a post is reposted from an https address.
      expect(await send(bob!, attested({ url: `http://other.example/content/${ORIGINAL}` }))).toEqual([400, 'a post on another server is reposted from an https address']);
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
      expect(refused(await attestation(image))).toEqual([404, 'content not found']);

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
      expect(refused(await attestation(NO_CONTENT))).toEqual([404, 'content not found']);
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
