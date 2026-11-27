import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { attest, readAttestation, signingKeys } from '../src/attestation.js';
import type { Attestable, SigningKey } from '../src/attestation.types.js';
import { renderRss } from '../src/feed/rss.js';
import type { TestPlugin } from '../src/moderation/trust.types.js';
import { MAX_TITLE_CHARS, shownTitle, titleLine } from '../src/posts.js';
import type { Summary } from '../src/storage/index.js';
import { decodeSummary, encodeSummary } from '../src/storage/summaryStore.js';
import type { FeedRecord } from '../src/tagfeed/layout.types.js';
import { HOUR, MINUTE } from '../src/time.js';
import { as, createTestContext, multipart, PNG, requests, TARGETS, type FeedItem, type TestContext, type User } from './helpers.js';

const REQUIRED = 'title is required: on this server, every post has a title';
const TOO_LONG = 'title can be at most 200 characters';
const OFF = "this server doesn't take titles: leave title out";

const OTHER = 'https://other.example';
const ORIGINAL = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
const DANA = { userId: '11111111-1111-4111-8111-111111111111', username: 'Dana of the North' };
/** A signing key as a setting writes it: 32 bytes, here all the same one. */
const seed = (byte: number) => Buffer.alloc(32, byte).toString('base64');
/** The key the other server signs with. */
const [KEY] = signingKeys([seed(1)]) as [SigningKey];
/** What answers for the other server when this one asks for its keys. */
const keyFetcher = async (address: string) => {
  if (address !== `${OTHER}/repost/keys`) throw new Error('no answer');
  return { keys: [{ id: KEY.id, publicKey: KEY.publicKey, algorithm: 'ed25519' }] };
};

describe('a title', () => {
  it('is kept on one line, with one space wherever it was sent with white space, and is none where nothing is left', () => {
    expect(MAX_TITLE_CHARS).toBe(200);
    expect(titleLine('Coast road closed')).toBe('Coast road closed');
    expect(titleLine('  Coast \n road\t\tclosed\r\n ')).toBe('Coast road closed');
    expect(titleLine('Coast\u0000road\u0085closed\u007f')).toBe('Coast road closed');
    // It is plain text: what would format a text is the title's own characters.
    expect(titleLine('**Coast** road @alice #news')).toBe('**Coast** road @alice #news');
    for (const none of [undefined, '', '   ', '\n\t ']) expect(titleLine(none)).toBeUndefined();
  });

  it('is shown where titles are on, and to nobody where they are off', () => {
    expect(shownTitle({ title: 'Coast road closed' }, 'on_required')).toEqual({ title: 'Coast road closed' });
    expect(shownTitle({ title: 'Coast road closed' }, 'on_optional')).toEqual({ title: 'Coast road closed' });
    expect(shownTitle({ title: 'Coast road closed' }, 'off')).toBeUndefined();
    for (const setting of ['on_required', 'on_optional', 'off'] as const) {
      expect(shownTitle({}, setting)).toBeUndefined();
      expect(shownTitle({ title: '' }, setting)).toBeUndefined();
    }
  });

  it('is kept in a summary on its line of extras, before whatever else is there, and a summary without one is written as it was', () => {
    const summary = (o: Partial<Summary> = {}): Summary => ({
      contentId: '0f8fad5b-d9cb-469f-a165-70867728950e',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_500,
      userId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      mimeType: 'text/plain',
      aiGenerated: false,
      comments: true,
      tags: ['news'],
      preview: { kind: 'text', text: 'first line\nsecond line' },
      ...o,
    });
    const through = (s: Summary) => decodeSummary(s.contentId, encodeSummary(s), '');
    const header = '1700000000000 1700000000500 0 1';
    const rest = '7c9e6679-7425-40de-944b-e07fc1f90ae7\ntext/plain\nnews\ntext\n';

    const titled = summary({ title: 'Coast road "closed"' });
    expect(encodeSummary(titled)).toBe(`${header} 0 0 1\n${rest}{"title":"Coast road \\"closed\\""}\nfirst line\nsecond line`);
    expect(through(titled)).toEqual(titled);
    // No title, or an empty one, is no line of extras: the summary is the one it always was.
    expect(encodeSummary(summary())).toBe(`${header}\n${rest}first line\nsecond line`);
    expect(encodeSummary(summary({ title: '' }))).toBe(encodeSummary(summary()));
    expect(through(summary())).not.toHaveProperty('title');

    // Beside what else the line keeps: the title first, the mentions last.
    const mentions = [{ userId: '7d2b8e4f-9c3a-4e1b-8f6d-5a4c3b2e1d0f', username: 'Ann Lee' }];
    const mentioning = summary({ title: 'Coast road closed', mentions });
    expect(encodeSummary(mentioning).split('\n')[5]).toBe(JSON.stringify({ title: 'Coast road closed', mentions }));
    expect(through(mentioning)).toEqual(mentioning);
    const album = summary({ title: 'Coast road closed', mimeType: 'image/png', preview: { kind: 'image', url: '/content/0f8fad5b-d9cb-469f-a165-70867728950e/raw', text: 'the road', imageCount: 2, alt: ['a road', ''] } });
    expect(encodeSummary(album).split('\n')[5]).toBe(JSON.stringify({ title: 'Coast road closed', alt: ['a road', ''] }));
    expect(through(album)).toEqual(album);
    const repost = summary({ title: 'Coast road closed', origin: { url: `${OTHER}/content/${ORIGINAL}`, publisher: DANA } });
    expect(through(repost)).toEqual(repost);
  });

  it("titles a post's item in a feed read as RSS, in place of how its text starts", () => {
    const record = (over: Partial<FeedRecord> = {}): FeedRecord => ({
      contentId: '00000000-0000-4000-8000-000000000001',
      publisher: { userId: '0a6f1c9e-3b1d-4c55-9a0e-1f2d3c4b5a69', username: 'alice' },
      mimeType: 'text/plain',
      aiGenerated: false,
      comments: false,
      commentCount: 0,
      preview: { kind: 'text', text: 'A quiet morning in #news' },
      tags: ['news'],
      likes: 0,
      views: 0,
      dislikes: null,
      createdAt: '2026-11-06T12:00:00.000Z',
      updatedAt: '2026-11-06T12:00:00.000Z',
      ...over,
    });
    const item = (r: FeedRecord) =>
      Buffer.concat([...renderRss({ title: '#news', description: 'Posts under #news', url: 'https://api.example/feed?tags=news&format=rss', next: null, language: 'en' }, [r], [], 'https://api.example')])
        .toString('utf8')
        .match(/<item>(.*?)<\/item>/s)![1]!;
    const titleOf = (r: FeedRecord) => item(r).match(/<title>(.*?)<\/title>/s)?.[1];

    expect(titleOf(record())).toBe('A quiet morning in #news');
    expect(titleOf(record({ title: 'Coast road closed' }))).toBe('Coast road closed');
    // As it is written: a title is not formatted, and is escaped as any text of the document is.
    expect(titleOf(record({ title: '**Tom & Jerry** <live>' }))).toBe('**Tom &amp; Jerry** &lt;live&gt;');
    // A post with no text has a title of its own or none.
    const picture = { mimeType: 'image/png', preview: { kind: 'image' as const, url: 'https://api.example/content/00000000-0000-4000-8000-000000000001/raw' } };
    expect(titleOf(record(picture))).toBeUndefined();
    expect(titleOf(record({ ...picture, title: 'The harbour at dawn' }))).toBe('The harbour at dawn');
  });
});

for (const target of TARGETS) {
  describe(`post titles (${target.name})`, () => {
    let ctx: TestContext;
    afterEach(() => ctx.close());

    /** A server whose index of users' comments holds everything, as one is once its compactor has started: it gives exports from then on. */
    const setup = async (opts: Parameters<typeof createTestContext>[1]) => {
      const made = await createTestContext(target, opts);
      await made.comments.indexAuthors();
      return made;
    };
    const { post, store, storeText, read, feedItems } = requests(() => ctx);
    const req = (u: User | null, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
      ctx.app.inject({ method, url, headers: u ? as(u) : {}, ...(payload && { payload }) });
    const ok = (res: LightMyRequestResponse, status = 200) => {
      expect(res.statusCode, res.body).toBe(status);
      return res.json();
    };
    /** What a refused request was answered: its status, and what it says. */
    const refused = async (res: Promise<LightMyRequestResponse>) => {
      const r = await res;
      return [r.statusCode, r.json().error];
    };
    /** The title the post's meta file keeps, whatever the server shows of it; null where it keeps none. */
    const kept = async (contentId: string) => (await ctx.content.getMeta(contentId))?.title ?? null;
    /**
     * The title each place a post is read gives it: by its id, in its hashtag's feed, in a
     * following feed, on its publisher's profile, in a search and in its publisher's export.
     * Null where the post is there without one, and undefined where the post isn't.
     */
    const shown = async (reader: User, publisher: User, contentId: string, tag: string, word: string) => {
      const of = (records: { contentId?: unknown; title?: unknown }[]) => {
        const record = records.find((r) => r.contentId === contentId);
        return record && (record.title ?? null);
      };
      return {
        content: ok(await read(contentId)).title ?? null,
        feed: of(await feedItems(tag)),
        following: of(ok(await req(reader, 'GET', `/feed/following?userId=${reader.userId}`)).records as FeedItem[]),
        profile: of(ok(await req(null, 'GET', `/users/${publisher.userId}/posts`)).posts as FeedItem[]),
        search: of(ok(await req(null, 'GET', `/search?type=content&q=${word}`)).results as FeedItem[]),
        export: of((ok(await req(publisher, 'GET', `/users/${publisher.userId}/export`)).records as { type: string; contentId?: string; title?: string }[]).filter((r) => r.type === 'post')),
      };
    };
    const everywhere = (title: string | null) => ({ content: title, feed: title, following: title, profile: title, search: title, export: title });
    const follow = async (user: User, whom: User) => ok(await req(user, 'PUT', `/users/${user.userId}/following/${whom.userId}`), 201);

    /** The attestation of a post on another server, signed by that server just now. */
    const attested = (o: Record<string, unknown> = {}) =>
      attest(KEY, { url: `${OTHER}/content/${ORIGINAL}`, publisher: DANA, aiGenerated: false, preview: { kind: 'text', text: 'Flooding closes the coast road.' }, ...o } as Attestable, ctx.clock.now);
    /** POST /repost as `user`, of the post on the other server, as its attestation says it. */
    const repost = (user: User, o: Record<string, unknown> = {}, tags = 'news') => ctx.app.inject({ method: 'POST', url: '/repost', payload: { ...user, origin: { attestation: attested(o) }, tags } });
    const refresh = (user: User, o: Record<string, unknown> = {}) => ctx.app.inject({ method: 'POST', url: '/repost/refresh', payload: { ...user, origin: { attestation: attested(o) } } });

    it('has every post titled where titles are required: one without is refused, new or an update, and the title is shown wherever the post is', async () => {
      ctx = await setup({ postTitles: 'on_required' });
      const [alice, bob] = [await ctx.register('alice'), await ctx.register('bob')];
      await follow(bob, alice);
      expect(ok(await req(null, 'GET', '/rules')).postTitles).toBe('on_required');

      // Without one, or with one that says nothing, a post is refused, and nothing of it is stored.
      expect(await refused(storeText(alice, 'Flooding downtown #news'))).toEqual([400, REQUIRED]);
      for (const blank of ['', '   ', '\n\t']) expect(await refused(storeText(alice, 'Flooding downtown #news', { title: blank }))).toEqual([400, REQUIRED]);
      expect(await refused(store(alice, { type: 'link', url: 'https://example.com/tides', tags: ['news'] }))).toEqual([400, REQUIRED]);
      expect(await ctx.db.selectFrom('content').select('id').execute()).toEqual([]);

      const stored = await storeText(alice, 'Flooding downtown #news', { title: 'Coast road closed' });
      expect(stored.statusCode, stored.body).toBe(201);
      const { contentId } = stored.json();
      expect(stored.json()).toEqual({ contentId, tags: ['news'], title: 'Coast road closed', preview: { kind: 'text', text: 'Flooding downtown #news' }, aiGenerated: false, comments: false });
      expect(await kept(contentId)).toBe('Coast road closed');
      await ctx.compact();
      expect(await shown(bob, alice, contentId, 'news', 'flooding')).toEqual(everywhere('Coast road closed'));

      // An update says the title again, as it says all of the post: one that leaves it out is refused, and changes nothing.
      expect(await refused(storeText(alice, 'Flooding downtown, still #news', { contentId }))).toEqual([400, REQUIRED]);
      expect(ok(await read(contentId))).toMatchObject({ title: 'Coast road closed', text: 'Flooding downtown #news' });
      // The same post with the same title is no update, and another title alone is one.
      expect(ok(await storeText(alice, 'Flooding downtown #news', { contentId, title: 'Coast road closed' }))).toEqual({ contentId, unchanged: true });
      expect(ok(await storeText(alice, 'Flooding downtown #news', { contentId, title: ' Coast  road closed\n' }))).toEqual({ contentId, unchanged: true });
      ctx.clock.now += 1000;
      expect(ok(await storeText(alice, 'Flooding downtown #news', { contentId, title: 'Coast road open again' }))).toMatchObject({ contentId, title: 'Coast road open again' });
      expect(await kept(contentId)).toBe('Coast road open again');
      await ctx.compact();
      expect(await shown(bob, alice, contentId, 'news', 'flooding')).toEqual(everywhere('Coast road open again'));
    });

    it('takes a post with a title or without where titles are optional, and an update that leaves the title out takes it off', async () => {
      ctx = await setup({ postTitles: 'on_optional' });
      const [alice, bob] = [await ctx.register('alice'), await ctx.register('bob')];
      await follow(bob, alice);
      expect(ok(await req(null, 'GET', '/rules')).postTitles).toBe('on_optional');

      const plain = ok(await storeText(alice, 'Sunny all week #weather'), 201);
      expect(plain).not.toHaveProperty('title');
      // A title that says nothing is none.
      expect(ok(await storeText(alice, 'Rain on Sunday #weather', { title: '  ' }), 201)).not.toHaveProperty('title');
      const titled = ok(await storeText(alice, 'Flooding downtown #news', { title: 'Coast road closed' }), 201);
      expect(titled.title).toBe('Coast road closed');
      expect([await kept(plain.contentId), await kept(titled.contentId)]).toEqual([null, 'Coast road closed']);
      await ctx.compact();
      expect(await shown(bob, alice, plain.contentId, 'weather', 'sunny')).toEqual(everywhere(null));
      expect(await shown(bob, alice, titled.contentId, 'news', 'flooding')).toEqual(everywhere('Coast road closed'));

      // A post is given a title by an update, and loses it to one that says none. Either is an update, of the title alone.
      ctx.clock.now += 1000;
      expect(ok(await storeText(alice, 'Sunny all week #weather', { contentId: plain.contentId, title: 'The week ahead' })).title).toBe('The week ahead');
      expect(ok(await storeText(alice, 'Sunny all week #weather', { contentId: plain.contentId, title: 'The week ahead' }))).toEqual({ contentId: plain.contentId, unchanged: true });
      const untitled = ok(await storeText(alice, 'Flooding downtown #news', { contentId: titled.contentId }));
      expect(untitled).toMatchObject({ contentId: titled.contentId, tags: ['news'] });
      expect(untitled).not.toHaveProperty('title');
      expect(ok(await storeText(alice, 'Flooding downtown #news', { contentId: titled.contentId }))).toEqual({ contentId: titled.contentId, unchanged: true });
      expect([await kept(plain.contentId), await kept(titled.contentId)]).toEqual(['The week ahead', null]);
      await ctx.compact();
      expect(await shown(bob, alice, plain.contentId, 'weather', 'sunny')).toEqual(everywhere('The week ahead'));
      expect(await shown(bob, alice, titled.contentId, 'news', 'flooding')).toEqual(everywhere(null));
    });

    it('takes a title of up to 200 characters, counted as it is kept: on one line, without the white space around it', async () => {
      ctx = await setup({ postTitles: 'on_optional' });
      const alice = await ctx.register('alice');
      const titleOf = async (title: unknown) => ok(await storeText(alice, 'Flooding downtown #news', { title }), 201).title;

      expect(await titleOf('a'.repeat(200))).toBe('a'.repeat(200));
      expect(await refused(storeText(alice, 'Flooding downtown #news', { title: 'a'.repeat(201) }))).toEqual([400, TOO_LONG]);
      // What it is sent with around it, and between its words, isn't counted past the one space it leaves.
      expect(await titleOf(`  ${'a'.repeat(100)} \n\t ${'b'.repeat(99)}\n\n`)).toBe(`${'a'.repeat(100)} ${'b'.repeat(99)}`);
      expect(await refused(storeText(alice, 'Flooding downtown #news', { title: `${'a'.repeat(100)} \n ${'b'.repeat(100)}` }))).toEqual([400, TOO_LONG]);
      // In UTF-16 units, as a text's length is: a character past the basic plane counts two.
      expect(await titleOf('😀'.repeat(100))).toBe('😀'.repeat(100));
      expect(await refused(storeText(alice, 'Flooding downtown #news', { title: `${'😀'.repeat(100)}a` }))).toEqual([400, TOO_LONG]);
      // Plain text: it is kept as written, whatever a text would make of it.
      expect(await titleOf('**Coast** road _closed_ @alice #news')).toBe('**Coast** road _closed_ @alice #news');
      // And text: nothing else is a title.
      for (const title of [5, true, ['Coast road closed'], { text: 'Coast road closed' }]) expect((await storeText(alice, 'Flooding downtown #news', { title })).statusCode).toBe(400);
      // An update is held to the same.
      const contentId = await post(alice, 'Sunny all week #weather');
      expect(await refused(storeText(alice, 'Sunny all week #weather', { contentId, title: 'a'.repeat(201) }))).toEqual([400, TOO_LONG]);
      expect(await kept(contentId)).toBeNull();
    });

    it('titles a post of any type, however it is sent', async () => {
      ctx = await setup({ postTitles: 'on_required' });
      const alice = await ctx.register('alice');

      const link = ok(await store(alice, { type: 'link', url: 'https://example.com/tides', tags: ['harbour'], title: 'Tide tables for the week' }), 201);
      expect(link).toMatchObject({ title: 'Tide tables for the week', preview: { kind: 'link', url: 'https://example.com/tides' } });
      const inline = ok(await store(alice, { type: 'image', content: PNG.toString('base64'), contentEncoding: 'base64', contentType: 'image/png', tags: ['harbour'], title: 'The harbour at dawn' }), 201);
      expect(inline.title).toBe('The harbour at dawn');
      // As a field of a form, beside the file.
      const form = (fields: Record<string, string>) => ctx.app.inject({ method: 'POST', url: '/store', ...multipart({ ...alice, type: 'image', tags: 'harbour', ...fields }, { name: 'dusk.png', type: 'image/png', data: PNG }) });
      expect(await refused(form({}))).toEqual([400, REQUIRED]);
      const sent = ok(await form({ title: ' The harbour\nat dusk ' }), 201);
      expect(sent.title).toBe('The harbour at dusk');
      expect(ok(await read(sent.contentId))).toMatchObject({ title: 'The harbour at dusk', preview: { kind: 'image' } });

      // A post with no text of its own is found by the words of its title.
      await ctx.compact();
      const found = async (q: string) => (ok(await req(null, 'GET', `/search?type=content&q=${q}`)).results as FeedItem[]).map((r) => r.contentId);
      expect(await found('tables')).toEqual([link.contentId]);
      expect([await found('dawn'), await found('dusk')]).toEqual([[inline.contentId], [sent.contentId]]);
      // And its item in the feed as RSS is titled with it.
      const rss = await ctx.app.inject({ method: 'GET', url: '/feed?tags=harbour&format=rss' });
      expect(rss.statusCode, rss.body).toBe(200);
      const titles = [...rss.body.matchAll(/<item>.*?<title>(.*?)<\/title>.*?<\/item>/gs)].map((m) => m[1]);
      expect(titles.sort()).toEqual(['The harbour at dawn', 'The harbour at dusk', 'Tide tables for the week']);
    });

    it('has moderation read the title as it reads the text', async () => {
      const wary: TestPlugin = { name: 'wary', rules: [{ includes: 'scam', set: 50 }, { includes: 'malware', set: 0 }] };
      ctx = await setup({ postTitles: 'on_optional', trustPlugins: [wary] });
      const alice = await ctx.register('alice');

      expect((await storeText(alice, 'Flooding downtown #news', { title: 'Free malware' })).statusCode).toBe(422);
      const held = ok(await storeText(alice, 'Flooding downtown #news', { title: 'Not a scam' }), 202);
      expect(held).toMatchObject({ status: 'pending_review', title: 'Not a scam' });
      // With another title, the same post is published.
      expect(ok(await storeText(alice, 'Flooding downtown #news', { contentId: held.contentId, title: 'Coast road closed' }))).not.toHaveProperty('status');
    });

    it('takes no title where titles are off, shows none, and keeps the ones posts were given before', async () => {
      ctx = await setup({ postTitles: 'off', publicBaseUrl: 'https://api.example.com', reposts: { signingKeys: [seed(3)] } });
      const [alice, bob] = [await ctx.register('alice'), await ctx.register('bob')];
      await follow(bob, alice);
      expect(ok(await req(null, 'GET', '/rules')).postTitles).toBe('off');

      // A post with a title is refused, whatever else it is, and one with a title that says nothing has none.
      expect(await refused(storeText(alice, 'Flooding downtown #news', { title: 'Coast road closed' }))).toEqual([400, OFF]);
      expect(await refused(storeText(alice, 'Flooding downtown #news', { title: 'a'.repeat(201) }))).toEqual([400, OFF]);
      const stored = ok(await storeText(alice, 'Flooding downtown #news', { title: '  ' }), 201);
      const { contentId } = stored;
      expect(stored).not.toHaveProperty('title');
      expect(await kept(contentId)).toBeNull();

      // The post as it would be had it been stored while titles were on: its meta file has its title.
      await ctx.content.putMeta({ ...(await ctx.content.getMeta(contentId))!, title: 'Coast road closed' });
      await ctx.compact();
      expect(await shown(bob, alice, contentId, 'news', 'flooding')).toEqual(everywhere(null));
      expect(readAttestation(ok(await req(null, 'GET', `/content/${contentId}/attestation`)).attestation)!.payload).not.toHaveProperty('title');

      // An update can't say a title, and keeps the one the post has: it is there when titles are on again.
      expect(await refused(storeText(alice, 'Flooding downtown, still #news', { contentId, title: 'Coast road closed' }))).toEqual([400, OFF]);
      expect(ok(await storeText(alice, 'Flooding downtown #news', { contentId }))).toEqual({ contentId, unchanged: true });
      ctx.clock.now += 1000;
      const updated = ok(await storeText(alice, 'Flooding downtown, still #news', { contentId }));
      expect(updated).toMatchObject({ contentId, preview: { kind: 'text', text: 'Flooding downtown, still #news' } });
      expect(updated).not.toHaveProperty('title');
      expect(await kept(contentId)).toBe('Coast road closed');
      await ctx.compact();
      expect(await shown(bob, alice, contentId, 'news', 'downtown')).toEqual(everywhere(null));
    });

    it("says a post's title in its attestation, and shows the title of a post on another server on a repost of it", async () => {
      ctx = await setup({ postTitles: 'on_required', publicBaseUrl: 'https://api.example.com', reposts: { signingKeys: [seed(3)] }, keyFetcher });
      const [alice, bob] = [await ctx.register('alice'), await ctx.register('bob')];
      await follow(bob, alice);

      // This server's own post, as it signs it for another to repost.
      const own = ok(await storeText(alice, 'Sunny all week #weather', { title: 'The week ahead' }), 201).contentId;
      expect(readAttestation(ok(await req(null, 'GET', `/content/${own}/attestation`)).attestation)!.said).toMatchObject({ url: `https://api.example.com/content/${own}`, title: 'The week ahead' });

      // A post on another server, with the title its server signed.
      const made = ok(await repost(alice, { title: 'Coast road closed' }), 201);
      const { contentId } = made;
      expect(made).toMatchObject({ title: 'Coast road closed', preview: { kind: 'text', text: 'Flooding closes the coast road.' } });
      expect(await kept(contentId)).toBe('Coast road closed');
      await ctx.compact();
      expect(await shown(bob, alice, contentId, 'news', 'coast')).toEqual(everywhere('Coast road closed'));

      // A later attestation says what the title became, and the same one again changes nothing.
      ctx.clock.now += HOUR;
      expect(ok(await refresh(bob, { title: 'Coast road open again' }))).toMatchObject({ contentId, title: 'Coast road open again' });
      ctx.clock.now += MINUTE;
      expect(ok(await refresh(bob, { title: 'Coast road open again' }))).toEqual({ contentId, unchanged: true });
      expect(await kept(contentId)).toBe('Coast road open again');
      // And one with none takes the title off: the original has none now.
      ctx.clock.now += HOUR;
      const untitled = ok(await refresh(bob));
      expect(untitled).toMatchObject({ contentId });
      expect(untitled).not.toHaveProperty('title');
      expect(await kept(contentId)).toBeNull();
      await ctx.compact();
      expect(await shown(bob, alice, contentId, 'news', 'coast')).toEqual(everywhere(null));

      // A repost isn't held to this server's setting: a post that has no title where it is has none here, though titles are required.
      const other = `${OTHER}/content/${ORIGINAL.slice(0, -1)}7`;
      expect(ok(await repost(bob, { url: other }), 201)).not.toHaveProperty('title');
      // But a title is one as this server keeps them: a line, of 200 characters at most.
      const next = `${OTHER}/content/${ORIGINAL.slice(0, -1)}8`;
      expect((await repost(bob, { url: next, title: 'a'.repeat(201) })).statusCode).toBe(400);
      expect((await repost(bob, { url: next, title: 'Coast road\nclosed' })).statusCode).toBe(400);
      expect((await repost(bob, { url: next, title: 5 })).statusCode).toBe(400);
      expect(ok(await repost(bob, { url: next, title: 'a'.repeat(200) }), 201).title).toBe('a'.repeat(200));
    });

    it('keeps the title of a post on another server where titles are off, and shows it to nobody', async () => {
      ctx = await setup({ postTitles: 'off', keyFetcher });
      const [alice, bob] = [await ctx.register('alice'), await ctx.register('bob')];
      await follow(bob, alice);

      const made = ok(await repost(alice, { title: 'Coast road closed' }), 201);
      expect(made).not.toHaveProperty('title');
      expect(await kept(made.contentId)).toBe('Coast road closed');
      await ctx.compact();
      expect(await shown(bob, alice, made.contentId, 'news', 'coast')).toEqual(everywhere(null));
      ctx.clock.now += HOUR;
      const refreshed = ok(await refresh(bob, { title: 'Coast road open again' }));
      expect(refreshed).toMatchObject({ contentId: made.contentId });
      expect(refreshed).not.toHaveProperty('title');
      expect(await kept(made.contentId)).toBe('Coast road open again');
    });
  });
}
