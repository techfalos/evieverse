import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { setAdmin } from '../src/moderation/policy.js';
import { AD_POSITIONS, adStatus, eligibleAds, MAX_OPEN_ADS, orderAds, placeAds } from '../src/monetization.js';
import type { PublishedAd } from '../src/monetization.types.js';
import { as, createTestContext, JPEG, multipart, PNG, readAudit, requests, TARGETS, type FeedAdItem, type TestContext, type User } from './helpers.js';

const NO_AD = '00000000-0000-4000-8000-000000000000';
const ADMIN_ONLY = 'only an admin can do this';
const HOUR = 3_600_000;

/** An ad as the admin routes give it. */
type Ad = {
  adId: string;
  kind: 'text' | 'image';
  imageUrl?: string;
  text?: string;
  url?: string;
  tags: string[] | null;
  startsAt: string;
  endsAt: string | null;
  status: 'scheduled' | 'live' | 'ended';
  clicks: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

const published = (adId: string, extra: Partial<PublishedAd> = {}): PublishedAd => ({ adId, kind: 'text', text: adId, tags: null, startsAt: 0, endsAt: null, ...extra });

describe('ads', () => {
  it('are shown from their start until their end', () => {
    const ad = { startsAt: 100, endsAt: 200 };
    expect([99, 100, 199, 200].map((at) => adStatus(ad, at))).toEqual(['scheduled', 'live', 'live', 'ended']);
    expect([99, 100, 1e15].map((at) => adStatus({ startsAt: 100, endsAt: null }, at))).toEqual(['scheduled', 'live', 'live']);
  });

  it('are chosen from those that appear all the time and those targeted at a hashtag shown', () => {
    const ads = [published('always'), published('cats', { tags: ['cats', 'pets'] }), published('dogs', { tags: ['dogs'] }), published('later', { startsAt: 500 }), published('over', { endsAt: 50 })];
    const ids = (tags: string[], at = 100) => eligibleAds(ads, tags, at).map((ad) => ad.adId);
    expect(ids(['news'])).toEqual(['always']);
    expect(ids(['pets'])).toEqual(['always', 'cats']);
    expect(ids(['news', 'dogs', 'cats'])).toEqual(['always', 'cats', 'dogs']);
    expect(ids([])).toEqual(['always']);
    expect(ids(['news'], 500)).toEqual(['always', 'later']);
    expect(ids(['news'], 49)).toEqual(['always', 'over']);
  });

  it('go before the 3rd, 10th and 17th post of a page, as far as the page has them', () => {
    expect(AD_POSITIONS).toEqual([3, 10, 17]);
    const positions = (count: number, ads = ['a', 'b', 'c', 'd']) => placeAds(ads, count).map(({ ad, position }) => `${ad}@${position}`);
    expect(positions(0)).toEqual([]);
    expect(positions(2)).toEqual([]);
    expect(positions(3)).toEqual(['a@3']);
    expect(positions(9)).toEqual(['a@3']);
    expect(positions(10)).toEqual(['a@3', 'b@10']);
    expect(positions(16)).toEqual(['a@3', 'b@10']);
    expect(positions(17)).toEqual(['a@3', 'b@10', 'c@17']);
    expect(positions(100)).toEqual(['a@3', 'b@10', 'c@17']);
    // Fewer ads than places: they take turns.
    expect(positions(100, ['a', 'b'])).toEqual(['a@3', 'b@10', 'a@17']);
    expect(positions(100, ['a'])).toEqual(['a@3', 'a@10', 'a@17']);
    expect(positions(100, [])).toEqual([]);
  });

  it('are in the same order on the same page, and in other orders on other pages', () => {
    const ads = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => published(id));
    const order = (page: string) => orderAds(ads, page).map((ad) => ad.adId).join('');
    expect(order('7 ')).toBe(order('7 '));
    expect(order('7 ').split('').sort().join('')).toBe('abcdef');
    // Whatever order they were published in.
    expect(orderAds([...ads].reverse(), '7 ').map((ad) => ad.adId).join('')).toBe(order('7 '));
    const orders = new Set(Array.from({ length: 50 }, (_, page) => order(`7 cursor${page}`)));
    expect(orders.size).toBeGreaterThan(10);
    // Each ad comes first on some page: none is left behind the others.
    expect(new Set([...orders].map((o) => o[0])).size).toBe(6);
  });

  it('are shown nowhere unless the server turns them on', () => {
    const load = (env: Record<string, string> = {}) => loadConfig({}, { EVIEVERSE_CONFIG: '/nonexistent.json', ...env }).monetization;
    expect(load()).toEqual({ feedAds: false, postAds: false });
    expect(load({ MONETIZATION_FEED_ADS: 'true' })).toEqual({ feedAds: true, postAds: false });
    expect(load({ MONETIZATION_POST_ADS: 'true' })).toEqual({ feedAds: false, postAds: true });
  });
});

for (const target of TARGETS) {
  describe(`monetization (${target.name})`, () => {
    let ctx: TestContext;
    afterEach(() => ctx.close());

    const { post, feed } = requests(() => ctx);
    const req = (u: User | null, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
      ctx.app.inject({ method, url, headers: u ? as(u) : {}, ...(payload && { payload }) });
    /** A multipart request as `u`, with `file` as its file part. */
    const upload = (u: User, method: 'POST' | 'PATCH', url: string, fields: Record<string, string>, file?: { name: string; type: string; data: Buffer }) => {
      const body = multipart(fields, file);
      return ctx.app.inject({ method, url, payload: body.payload, headers: { ...body.headers, ...as(u) } });
    };
    const ok = (res: LightMyRequestResponse, status = 200) => {
      expect(res.statusCode, res.body).toBe(status);
      return res.json();
    };
    /** What a refused request was told. */
    const refused = async (res: Promise<LightMyRequestResponse>) => {
      const r = await res;
      return [r.statusCode, r.json().error];
    };
    const iso = (at: number) => new Date(at).toISOString();
    const now = () => iso(ctx.clock.now);

    /** A server that shows ads in feeds and at the end of posts, unless `monetization` says otherwise, with an admin and a user. */
    const setup = async (opts: Parameters<typeof createTestContext>[1] = {}) => {
      ctx = await createTestContext(target, { monetization: { feedAds: true, postAds: true }, ...opts });
      const root = await ctx.register('root');
      await setAdmin(ctx.db, 'root', true);
      return { root, alice: await ctx.register('alice') };
    };
    const create = async (by: User, fields: Record<string, unknown>): Promise<Ad> => ok(await req(by, 'POST', '/monetization/ads', fields), 201);
    const textAd = (by: User, text: string, extra: Record<string, unknown> = {}) => create(by, { kind: 'text', text, ...extra });
    const read = async (by: User, adId: string): Promise<Ad> => ok(await req(by, 'GET', `/monetization/ads/${adId}`));
    const list = async (by: User, query = ''): Promise<{ ads: Ad[]; nextCursor: string | null }> => ok(await req(by, 'GET', `/monetization/ads${query}`));
    const patch = (by: User | null, adId: string, fields: Record<string, unknown>) => req(by, 'PATCH', `/monetization/ads/${adId}`, fields);
    const image = (adId: string) => ctx.app.inject({ method: 'GET', url: `/monetization/ads/${adId}/image` });
    /** Follows an ad's link as its reader does, with no credentials: `url` is what the ad was shown with. */
    const follow = (url: string, method: 'GET' | 'HEAD' = 'GET') => ctx.app.inject({ method, url });
    const clickUrl = (adId: string) => `/monetization/ads/${adId}/click`;
    /** `count` posts under #`tag`, in feeds. */
    const posts = async (user: User, count: number, tag = 'news') => {
      const ids: string[] = [];
      for (let i = 0; i < count; i++) ids.push(await post(user, `Post ${i} #${tag}`));
      await ctx.compact();
      return ids;
    };
    /** The ads of a feed's first page, as "<text>@<position>". */
    const adsOf = async (query: string) => ((await feed(query)).ads ?? []).map((ad) => `${ad.text}@${ad.position}`);

    it('has admins, and nobody else, keep the ads', async () => {
      const { root, alice } = await setup();
      const fields = { kind: 'text', text: 'Buy more' };
      expect(await refused(req(alice, 'POST', '/monetization/ads', fields))).toEqual([403, ADMIN_ONLY]);
      expect((await req(null, 'POST', '/monetization/ads', fields)).statusCode).toBe(401);
      const { adId } = await textAd(root, 'Buy more');

      for (const [method, url, payload] of [
        ['GET', '/monetization/ads', undefined],
        ['GET', `/monetization/ads/${adId}`, undefined],
        ['PATCH', `/monetization/ads/${adId}`, { text: 'Buy less' }],
        ['DELETE', `/monetization/ads/${adId}`, undefined],
      ] as const) {
        expect(await refused(req(alice, method, url, payload)), `${method} ${url}`).toEqual([403, ADMIN_ONLY]);
        expect((await req(null, method, url, payload)).statusCode, `${method} ${url}`).toBe(401);
        expect((await req({ userId: root.userId, apiKey: alice.apiKey }, method, url, payload)).statusCode, `${method} ${url}`).toBe(401);
      }
      // Nothing was changed by any of it.
      expect((await list(root)).ads).toMatchObject([{ adId, text: 'Buy more' }]);
      // Credentials are taken in the body too, as everywhere.
      expect(ok(await ctx.app.inject({ method: 'POST', url: '/monetization/ads', payload: { ...root, ...fields } }), 201)).toMatchObject({ text: 'Buy more' });
    });

    it('creates a text ad, which appears all the time from now on unless the request says otherwise', async () => {
      const { root } = await setup();
      const ad = await textAd(root, '  Fresh coffee, two streets away  ');
      expect(ad).toEqual({
        adId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        kind: 'text',
        text: 'Fresh coffee, two streets away',
        tags: null,
        startsAt: now(),
        endsAt: null,
        status: 'live',
        clicks: 0,
        createdBy: root.userId,
        createdAt: now(),
        updatedAt: now(),
      });
      expect(await read(root, ad.adId)).toEqual(ad);

      // With everything an ad can have: a link, hashtags as posts take them, and a schedule, in any offset from UTC.
      ctx.clock.now += 1000;
      const startsAt = ctx.clock.now + 24 * HOUR;
      const full = await textAd(root, 'Winter sale', {
        url: 'https://shop.example/winter?ref=evieverse',
        tags: '#Cats, dogs  #CATS',
        startsAt: iso(startsAt).replace('Z', '+00:00'),
        endsAt: iso(startsAt + 48 * HOUR),
      });
      expect(full).toMatchObject({
        text: 'Winter sale',
        url: 'https://shop.example/winter?ref=evieverse',
        tags: ['cats', 'dogs'],
        startsAt: iso(startsAt),
        endsAt: iso(startsAt + 48 * HOUR),
        status: 'scheduled',
      });
      expect((await textAd(root, 'A list of hashtags', { tags: ['News', '#mumbai'] })).tags).toEqual(['news', 'mumbai']);
      // No hashtags is all the time, however it is said.
      for (const tags of [null, '', []]) expect((await textAd(root, 'Everywhere', { tags })).tags).toBeNull();
      // An ad can be created already over: it is kept, and never shown.
      expect((await textAd(root, 'Last year', { startsAt: iso(ctx.clock.now - 2 * HOUR), endsAt: iso(ctx.clock.now - HOUR) })).status).toBe('ended');

      // The row is what the response says.
      expect(await ctx.db.selectFrom('monetization').selectAll().where('id', '=', full.adId).executeTakeFirst()).toEqual({
        id: full.adId,
        kind: 'text',
        text: 'Winter sale',
        url: 'https://shop.example/winter?ref=evieverse',
        clicks: 0,
        image_type: null,
        image_alt: null,
        tags: 'cats dogs',
        starts_at: startsAt,
        ends_at: startsAt + 48 * HOUR,
        created_by: root.userId,
        created_at: ctx.clock.now,
        updated_at: ctx.clock.now,
      });
    });

    it('lists the ads newest first, a page at a time, and says there is no ad where there is none', async () => {
      const { root } = await setup();
      const ids: string[] = [];
      for (const text of ['one', 'two', 'three']) {
        ctx.clock.now += 1000;
        ids.unshift((await textAd(root, text)).adId);
      }
      expect((await list(root)).ads.map((ad) => ad.adId)).toEqual(ids);
      const first = await list(root, '?limit=2');
      expect(first.ads.map((ad) => ad.text)).toEqual(['three', 'two']);
      const second = await list(root, `?limit=2&cursor=${first.nextCursor}`);
      expect(second.ads.map((ad) => ad.text)).toEqual(['one']);
      expect(second.nextCursor).toBeNull();

      expect(await refused(req(root, 'GET', `/monetization/ads/${NO_AD}`))).toEqual([404, 'ad not found']);
      expect(await refused(patch(root, NO_AD, { text: 'x' }))).toEqual([404, 'ad not found']);
      expect(await refused(req(root, 'DELETE', `/monetization/ads/${NO_AD}`))).toEqual([404, 'ad not found']);
      expect((await req(root, 'GET', '/monetization/ads/not-an-id')).statusCode).toBe(400);
    });

    it('refuses an ad that is not one', async () => {
      const { root } = await setup();
      const bad = (fields: Record<string, unknown>) => refused(req(root, 'POST', '/monetization/ads', fields));
      const at = (ms: number) => iso(ctx.clock.now + ms);

      expect((await bad({ text: 'No kind' }))[0]).toBe(400);
      expect((await bad({ kind: 'video', text: 'No such kind' }))[0]).toBe(400);
      expect(await bad({ kind: 'text' })).toEqual([400, 'text is required: a text ad is its text']);
      expect(await bad({ kind: 'text', text: '   ' })).toEqual([400, 'text is required: a text ad is its text']);
      expect((await bad({ kind: 'text', text: 'x'.repeat(501) }))[0]).toBe(400);
      expect((await textAd(root, 'x'.repeat(500))).text).toHaveLength(500);
      expect(await bad({ kind: 'text', text: 'With a picture', content: PNG.toString('base64') })).toEqual([400, 'a text ad has no image']);
      expect(await bad({ kind: 'image', text: 'No picture' })).toEqual([400, 'content is required: the image of the ad']);
      expect(await bad({ kind: 'image', content: Buffer.from('just some text').toString('base64') })).toEqual([
        400,
        'ads take JPEG, PNG, GIF and WebP images, and the file is none of them',
      ]);
      expect((await bad({ kind: 'image', content: PNG.subarray(0, 40).toString('base64') }))[0]).toBe(400);

      expect((await bad({ kind: 'text', text: 'x', url: 'ftp://example.com/ad' }))[0]).toBe(400);
      expect((await bad({ kind: 'text', text: 'x', url: 'not a link' }))[0]).toBe(400);
      expect(await bad({ kind: 'text', text: 'x', tags: 'cats, !!!' })).toEqual([400, '"!!!" is not a usable hashtag: hashtags are letters, digits and underscores']);
      expect(await bad({ kind: 'text', text: 'x', tags: Array.from({ length: 11 }, (_, i) => `tag${i}`) })).toEqual([400, 'at most 10 hashtags are allowed, got 11']);

      expect((await bad({ kind: 'text', text: 'x', startsAt: 'tomorrow' }))[0]).toBe(400);
      // An instant says its offset from UTC.
      expect((await bad({ kind: 'text', text: 'x', startsAt: '2026-12-01T00:00:00' }))[0]).toBe(400);
      expect(await bad({ kind: 'text', text: 'x', startsAt: at(HOUR), endsAt: at(HOUR) })).toEqual([400, 'endsAt must be after startsAt']);
      expect(await bad({ kind: 'text', text: 'x', startsAt: at(2 * HOUR), endsAt: at(HOUR) })).toEqual([400, 'endsAt must be after startsAt']);
      // With no startsAt the ad starts now, which an end in the past is before.
      expect(await bad({ kind: 'text', text: 'x', endsAt: at(-HOUR) })).toEqual([400, 'endsAt must be after startsAt']);

      // None of it left anything behind but the one ad that was fine.
      expect((await list(root)).ads).toHaveLength(1);
    });

    it('takes the image of an image ad as a file or inline, by its bytes, and gives it to anyone', async () => {
      const { root, alice } = await setup({ publicBaseUrl: 'https://api.example.com' });
      // As a file part, with a caption and whatever name and type it was sent with.
      const sent = ok(await upload(root, 'POST', '/monetization/ads', { kind: 'image', text: 'Shoes that last', url: 'https://shoes.example/', tags: 'fashion' }, { name: 'ad.bin', type: 'application/octet-stream', data: PNG }), 201) as Ad;
      expect(sent).toMatchObject({
        kind: 'image',
        imageUrl: `https://api.example.com/monetization/ads/${sent.adId}/image`,
        text: 'Shoes that last',
        url: 'https://shoes.example/',
        tags: ['fashion'],
        status: 'live',
      });
      expect((await ctx.db.selectFrom('monetization').select('image_type').where('id', '=', sent.adId).executeTakeFirstOrThrow()).image_type).toBe('image/png');

      // Anyone reads it, with no credentials: it is what a feed tells its readers to show.
      const png = await image(sent.adId);
      expect(png.statusCode).toBe(200);
      expect(png.headers['content-type']).toBe('image/png');
      expect(png.headers['x-content-type-options']).toBe('nosniff');
      expect(png.rawPayload.equals(PNG)).toBe(true);

      // Inline, in base64, with no caption: an image ad needs none.
      const inline = await create(root, { kind: 'image', content: JPEG.toString('base64'), contentEncoding: 'base64' });
      expect(inline).not.toHaveProperty('text');
      const jpeg = await image(inline.adId);
      expect(jpeg.headers['content-type']).toBe('image/jpeg');
      expect(jpeg.rawPayload.equals(JPEG)).toBe(true);

      // One or the other, and an image at that, whatever it claims to be.
      expect(await refused(upload(root, 'POST', '/monetization/ads', { kind: 'image', content: PNG.toString('base64') }, { name: 'ad.png', type: 'image/png', data: PNG }))).toEqual([
        400,
        'Send content either as a file or as a field, not both',
      ]);
      expect(await refused(upload(root, 'POST', '/monetization/ads', { kind: 'image' }, { name: 'ad.png', type: 'image/png', data: Buffer.from('<svg/>') }))).toEqual([
        400,
        'ads take JPEG, PNG, GIF and WebP images, and the file is none of them',
      ]);
      expect((await upload(alice, 'POST', '/monetization/ads', { kind: 'image' }, { name: 'ad.png', type: 'image/png', data: PNG })).statusCode).toBe(403);

      // A text ad has no image to read, and neither has an ad that isn't there.
      const text = await textAd(root, 'Words only');
      expect(text).not.toHaveProperty('imageUrl');
      expect(await refused(image(text.adId))).toEqual([404, 'ad not found']);
      expect(await refused(image(NO_AD))).toEqual([404, 'ad not found']);

      // An update replaces the image, at the same address, and can clear the caption.
      ctx.clock.now += 1000;
      const replaced = ok(await upload(root, 'PATCH', `/monetization/ads/${sent.adId}`, { text: '' }, { name: 'ad.jpg', type: 'image/jpeg', data: JPEG })) as Ad;
      expect(replaced).toEqual({ ...sent, text: undefined, updatedAt: now() });
      expect(replaced).not.toHaveProperty('text');
      const after = await image(sent.adId);
      expect(after.headers['content-type']).toBe('image/jpeg');
      expect(after.rawPayload.equals(JPEG)).toBe(true);

      // Deleting the ad deletes its image.
      expect(ok(await req(root, 'DELETE', `/monetization/ads/${sent.adId}`))).toEqual({ adId: sent.adId, status: 'deleted' });
      expect((await image(sent.adId)).statusCode).toBe(404);
      await expect(ctx.content.stat({ adId: sent.adId })).rejects.toThrow();
      // The other ad's is still there.
      expect((await image(inline.adId)).statusCode).toBe(200);
    });

    it('refuses an image larger than an ad can have', async () => {
      const { root } = await setup({ maxUploadBytes: 64 });
      const big = Buffer.concat([PNG, Buffer.alloc(64)]);
      expect((await upload(root, 'POST', '/monetization/ads', { kind: 'image' }, { name: 'ad.png', type: 'image/png', data: big })).statusCode).toBe(413);
      expect((await req(root, 'POST', '/monetization/ads', { kind: 'image', content: big.toString('base64') })).statusCode).toBe(413);
      expect((await list(root)).ads).toEqual([]);
    });

    it('shows a feed its ads before the 3rd, 10th and 17th post of each page, once the compactor has run', async () => {
      const { root, alice } = await setup();
      await posts(alice, 20);
      // The server shows ads, and has none: every page says so.
      expect((await feed('tags=news&limit=20')).ads).toEqual([]);

      const ad = await textAd(root, 'Fresh coffee', { url: 'https://coffee.example/' });
      // Feeds read no database: the ad is in them after the compactor's next run.
      expect((await feed('tags=news&limit=20')).ads).toEqual([]);
      await ctx.compact();
      const page = await feed('tags=news&limit=20');
      expect(page.count).toBe(20);
      // Its link is the server's, which counts the click, not the one its admin gave it.
      const shown: FeedAdItem = { adId: ad.adId, label: 'Sponsored', kind: 'text', text: 'Fresh coffee', url: clickUrl(ad.adId), position: 3 };
      // One ad for three places: it takes each of them.
      expect(page.ads).toEqual([shown, { ...shown, position: 10 }, { ...shown, position: 17 }]);
      // The records are the ones the feed has without ads.
      expect(page.tags.news).toHaveLength(20);

      // A page has the places it has posts for.
      expect(await adsOf('tags=news&limit=2')).toEqual([]);
      expect(await adsOf('tags=news&limit=3')).toEqual(['Fresh coffee@3']);
      expect(await adsOf('tags=news&limit=9')).toEqual(['Fresh coffee@3']);
      expect(await adsOf('tags=news&limit=10')).toEqual(['Fresh coffee@3', 'Fresh coffee@10']);
      expect(await adsOf('tags=news&limit=16')).toEqual(['Fresh coffee@3', 'Fresh coffee@10']);
      expect(await adsOf('tags=news&limit=17')).toEqual(['Fresh coffee@3', 'Fresh coffee@10', 'Fresh coffee@17']);
      // A feed with no posts has no place for one.
      expect((await feed('tags=empty')).ads).toEqual([]);

      // Every page has its own: positions count the page's posts, not the session's.
      const first = await feed('tags=news&limit=12&algorithm=chronological');
      expect(first.ads?.map((a) => a.position)).toEqual([3, 10]);
      const second = await feed(`tags=news&limit=12&algorithm=chronological&cursor=${first.nextCursor}`);
      expect(second.count).toBe(8);
      expect(second.ads?.map((a) => a.position)).toEqual([3]);

      // The following feed has none.
      ok(await req(alice, 'PUT', `/users/${alice.userId}/following/${root.userId}`), 201);
      expect(ok(await req(alice, 'GET', `/feed/following?userId=${alice.userId}`))).not.toHaveProperty('ads');
    });

    it('gives a page as many different ads as it has places, and the same ones when it is asked for again', async () => {
      const { root, alice } = await setup();
      await posts(alice, 40);
      for (const text of ['a', 'b', 'c', 'd', 'e']) await textAd(root, text);
      await ctx.compact();

      const texts = (ads: FeedAdItem[] = []) => ads.map((ad) => ad.text);
      const first = await feed('tags=news&limit=20&algorithm=chronological');
      expect(first.ads?.map((ad) => ad.position)).toEqual([3, 10, 17]);
      expect(new Set(texts(first.ads)).size).toBe(3);

      // A page asked for again is the same page, ads and all.
      const again = () => feed(`tags=news&limit=20&algorithm=chronological&cursor=${first.nextCursor}`);
      const second = await again();
      expect(new Set(texts(second.ads)).size).toBe(3);
      expect((await again()).ads).toEqual(second.ads);

      // Over many sessions every ad is shown, and each of them first somewhere.
      const firsts = new Set<string>();
      for (let i = 0; i < 60; i++) firsts.add(texts((await feed('tags=news&limit=3')).ads)[0]!);
      expect([...firsts].sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('shows a targeted ad only under its hashtags, and one that is not targeted under all of them', async () => {
      const { root, alice } = await setup();
      await posts(alice, 3, 'cats');
      await posts(alice, 3, 'dogs');
      await posts(alice, 3, 'news');
      await textAd(root, 'Cat food', { tags: ['cats', 'pets'] });
      await ctx.compact();

      expect(await adsOf('tags=cats')).toEqual(['Cat food@3']);
      expect(await adsOf('tags=dogs')).toEqual([]);
      // A feed of several hashtags has the ads of any of them.
      expect(await adsOf('tags=dogs,cats')).toEqual(['Cat food@3']);
      expect(await adsOf('tags=news,dogs')).toEqual([]);

      const always = await textAd(root, 'Everywhere');
      await ctx.compact();
      expect(await adsOf('tags=dogs')).toEqual(['Everywhere@3']);
      expect(await adsOf('tags=news')).toEqual(['Everywhere@3']);
      const both = new Set<string>();
      for (let i = 0; i < 40; i++) for (const ad of await adsOf('tags=cats')) both.add(ad);
      expect([...both].sort()).toEqual(['Cat food@3', 'Everywhere@3']);

      // Targeting is changed like anything else of an ad, and cleared by null.
      ok(await patch(root, always.adId, { tags: 'dogs' }));
      await ctx.compact();
      expect(await adsOf('tags=news')).toEqual([]);
      expect(await adsOf('tags=dogs')).toEqual(['Everywhere@3']);
      ok(await patch(root, always.adId, { tags: null }));
      await ctx.compact();
      expect(await adsOf('tags=news')).toEqual(['Everywhere@3']);
    });

    it('shows an ad targeted at a hashtag the feed added as related', async () => {
      const { root, alice } = await setup({ feed: { relatedMinPosts: 2, relatedMinPercent: 20, relatedTags: 2 } });
      for (let i = 0; i < 3; i++) await post(alice, `Kittens ${i} #cats #pets`);
      await ctx.compact();
      await textAd(root, 'Pet insurance', { tags: 'pets' });
      await ctx.compact();

      expect(await adsOf('tags=cats')).toEqual([]);
      const related = await feed('tags=cats&addRelated=true');
      expect(related.related).toEqual(['pets']);
      expect(related.ads?.map((ad) => ad.text)).toEqual(['Pet insurance']);
    });

    it('starts and ends an ad on its schedule, whenever the compactor last ran', async () => {
      const { root, alice } = await setup();
      await posts(alice, 3);
      // Within the day the feed is of, so its posts are there throughout.
      const startsAt = ctx.clock.now + 2 * HOUR;
      const endsAt = startsAt + 2 * HOUR;
      const ad = await textAd(root, 'One night only', { startsAt: iso(startsAt), endsAt: iso(endsAt) });
      expect(ad.status).toBe('scheduled');
      await ctx.compact();
      // Published with its schedule, and not shown before it starts.
      expect((await ctx.ads.get()).map((a) => a.adId)).toEqual([ad.adId]);
      expect(await adsOf('tags=news')).toEqual([]);

      // No run from here on: the feed holds the ad to its schedule by its own clock.
      ctx.clock.now = startsAt - 1;
      expect(await adsOf('tags=news')).toEqual([]);
      ctx.clock.now = startsAt;
      expect(await adsOf('tags=news')).toEqual(['One night only@3']);
      expect((await read(root, ad.adId)).status).toBe('live');
      ctx.clock.now = endsAt - 1;
      expect(await adsOf('tags=news')).toEqual(['One night only@3']);
      ctx.clock.now = endsAt;
      expect(await adsOf('tags=news')).toEqual([]);
      expect((await read(root, ad.adId)).status).toBe('ended');

      // The next run stops publishing it; the ad itself is kept until an admin deletes it.
      await ctx.compact();
      expect(await ctx.ads.get()).toEqual([]);
      expect((await list(root)).ads.map((a) => a.adId)).toEqual([ad.adId]);

      // An admin can end an ad that has no end, or give one more time.
      ok(await patch(root, ad.adId, { endsAt: null }));
      await ctx.compact();
      expect(await adsOf('tags=news')).toEqual(['One night only@3']);
      ok(await patch(root, ad.adId, { endsAt: now() }));
      await ctx.compact();
      expect(await adsOf('tags=news')).toEqual([]);
    });

    it('shows a post an ad at its end: one that appears all the time, or is targeted at one of its hashtags', async () => {
      const { root, alice } = await setup({ trust: { deleteBelow: 0 } });
      const cats = await post(alice, 'A cat #cats');
      const dogs = await post(alice, 'A dog #dogs');
      const content = async (contentId: string, u: User | null = null) => ok(await req(u, 'GET', `/content/${contentId}`));
      // No ad to show: the post is as it ever was.
      expect(await content(cats)).not.toHaveProperty('ad');

      const ad = await create(root, { kind: 'image', content: PNG.toString('base64'), text: 'Cat food', url: 'https://cats.example/', tags: 'cats' });
      expect(await content(cats)).not.toHaveProperty('ad');
      await ctx.compact();
      const shown = await content(cats);
      // The ad is the last thing of the post, and has no position: it goes at the end.
      expect(shown.ad).toEqual({ adId: ad.adId, label: 'Sponsored', kind: 'image', imageUrl: `/monetization/ads/${ad.adId}/image`, text: 'Cat food', url: clickUrl(ad.adId) });
      expect(Object.keys(shown).at(-1)).toBe('ad');
      expect(shown).toMatchObject({ contentId: cats, text: 'A cat #cats', tags: ['cats'] });
      expect(await content(dogs)).not.toHaveProperty('ad');

      const always = await textAd(root, 'Everywhere');
      await ctx.compact();
      expect((await content(dogs)).ad).toEqual({ adId: always.adId, label: 'Sponsored', kind: 'text', text: 'Everywhere' });
      const seen = new Set<string>();
      for (let i = 0; i < 40; i++) seen.add((await content(cats)).ad.text);
      expect([...seen].sort()).toEqual(['Cat food', 'Everywhere']);

      // A post that waits in the moderation queue is shown with none.
      ok(await req(root, 'POST', '/moderation/blocked-words', { words: ['spam'] }));
      const held = ok(await req(alice, 'POST', '/store', { type: 'text', text: 'Spam about cats #cats', tags: ['cats'] }), 202).contentId;
      const waiting = await content(held, alice);
      expect(waiting.status).toBe('pending_review');
      expect(waiting).not.toHaveProperty('ad');
    });

    it('counts a click each time the link an ad is shown with is followed, then sends the reader where the ad leads', async () => {
      const { root, alice } = await setup({ trust: { deleteBelow: 0 } });
      const [contentId] = await posts(alice, 3);
      const ad = await textAd(root, 'Fresh coffee', { url: 'https://coffee.example/menu?ref=evieverse#today' });
      // Its admins read where it leads, as they gave it, and how often it was followed.
      expect(ad).toMatchObject({ url: 'https://coffee.example/menu?ref=evieverse#today', clicks: 0 });
      await ctx.compact();

      // A feed and a post show it with the same link, which names the ad and not where it leads.
      const [inFeed] = (await feed('tags=news')).ads!;
      const atEnd = ok(await req(null, 'GET', `/content/${contentId}`)).ad;
      expect(inFeed!.url).toBe(clickUrl(ad.adId));
      expect(atEnd.url).toBe(clickUrl(ad.adId));
      // Being shown is no click.
      expect((await read(root, ad.adId)).clicks).toBe(0);

      // Followed by anyone, with no credentials: counted, and sent on.
      const followed = await follow(inFeed!.url!);
      expect(followed.statusCode).toBe(302);
      expect(followed.headers.location).toBe('https://coffee.example/menu?ref=evieverse#today');
      // Not a redirect to keep: the next click has to be asked for too.
      expect(followed.headers['cache-control']).toBe('no-store');
      expect((await read(root, ad.adId)).clicks).toBe(1);
      await follow(atEnd.url);
      await follow(atEnd.url);
      expect((await read(root, ad.adId)).clicks).toBe(3);
      expect((await list(root)).ads).toMatchObject([{ adId: ad.adId, clicks: 3 }]);
      // A HEAD request follows nothing.
      expect((await follow(clickUrl(ad.adId), 'HEAD')).statusCode).toBe(302);
      expect((await read(root, ad.adId)).clicks).toBe(3);

      // Each ad has its own count.
      const other = await textAd(root, 'Tea', { url: 'https://tea.example/' });
      expect((await follow(clickUrl(other.adId))).headers.location).toBe('https://tea.example/');
      expect((await read(root, other.adId)).clicks).toBe(1);
      expect((await read(root, ad.adId)).clicks).toBe(3);

      // A link that was changed is the one followed from then on, with no run between, and the clicks are kept.
      ctx.clock.now += 1000;
      expect(ok(await patch(root, ad.adId, { url: 'https://coffee.example/new', text: 'Fresher coffee' }))).toMatchObject({ url: 'https://coffee.example/new', clicks: 3 });
      expect((await follow(clickUrl(ad.adId))).headers.location).toBe('https://coffee.example/new');
      expect((await read(root, ad.adId)).clicks).toBe(4);
      // Nobody sets the count: it isn't a request's to say.
      ok(await patch(root, ad.adId, { text: 'Freshest coffee', clicks: 1000 }));
      expect((await read(root, ad.adId)).clicks).toBe(4);

      // An ad that is over still leads where it did, for whoever has it on a page from before.
      ok(await patch(root, ad.adId, { endsAt: now() }));
      expect((await read(root, ad.adId)).status).toBe('ended');
      expect((await follow(clickUrl(ad.adId))).statusCode).toBe(302);
      expect((await read(root, ad.adId)).clicks).toBe(5);
    });

    it('gives an ad that leads nowhere no link, and follows only the ads there are', async () => {
      const { root, alice } = await setup({ publicBaseUrl: 'https://api.example.com' });
      await posts(alice, 3);
      const plain = await textAd(root, 'Just words');
      await ctx.compact();
      expect((await feed('tags=news')).ads![0]).not.toHaveProperty('url');
      expect(await refused(follow(clickUrl(plain.adId)))).toEqual([404, 'ad not found']);
      expect((await read(root, plain.adId)).clicks).toBe(0);
      expect(await refused(follow(clickUrl(NO_AD)))).toEqual([404, 'ad not found']);
      expect((await follow('/monetization/ads/not-an-id/click')).statusCode).toBe(400);
      // Where it goes is the ad's to say: a request can't name somewhere else.
      const linked = await textAd(root, 'Linked', { url: 'https://shop.example/' });
      expect((await follow(`${clickUrl(linked.adId)}?url=https://evil.example/`)).headers.location).toBe('https://shop.example/');

      // The link is absolute where the server knows its address, as an image's is.
      await ctx.compact();
      const urls = new Set<string | undefined>();
      for (let i = 0; i < 40; i++) urls.add((await feed('tags=news')).ads![0]!.url);
      expect([...urls].sort()).toEqual([`https://api.example.com${clickUrl(linked.adId)}`, undefined]);

      // Once its link is cleared, the ad is shown without one, and the one it was shown with leads nowhere.
      ok(await patch(root, linked.adId, { url: null }));
      expect(await refused(follow(clickUrl(linked.adId)))).toEqual([404, 'ad not found']);
      expect((await read(root, linked.adId)).clicks).toBe(1);
    });

    it('counts the clicks made while an ad is being changed', async () => {
      const { root } = await setup();
      const ad = await create(root, { kind: 'image', content: PNG.toString('base64'), url: 'https://shoes.example/' });
      await follow(clickUrl(ad.adId));
      // An update reads the ad, stores its new image, and then writes the ad: these clicks come in between.
      const putFile = ctx.content.putFile.bind(ctx.content);
      vi.spyOn(ctx.content, 'putFile').mockImplementationOnce(async (...args) => {
        for (let i = 0; i < 3; i++) await follow(clickUrl(ad.adId));
        return putFile(...args);
      });
      // The update answers with the count it read, and leaves the one there is alone.
      expect(ok(await patch(root, ad.adId, { content: JPEG.toString('base64'), text: 'Shoes that last' }))).toMatchObject({ text: 'Shoes that last', clicks: 1 });
      expect(await read(root, ad.adId)).toMatchObject({ text: 'Shoes that last', clicks: 4 });
    });

    it('shows ads only where the server turns them on, and keeps them either way', async () => {
      // Feeds only.
      const { root, alice } = await setup({ monetization: { feedAds: true } });
      const [contentId] = await posts(alice, 3);
      await textAd(root, 'Fresh coffee');
      await ctx.compact();
      expect(await adsOf('tags=news')).toEqual(['Fresh coffee@3']);
      expect(ok(await req(null, 'GET', `/content/${contentId}`))).not.toHaveProperty('ad');
      await ctx.close();

      // Posts only.
      const posted = await setup({ monetization: { postAds: true } });
      const [shown] = await posts(posted.alice, 3);
      await textAd(posted.root, 'Fresh coffee');
      await ctx.compact();
      expect(await feed('tags=news')).not.toHaveProperty('ads');
      expect(ok(await req(null, 'GET', `/content/${shown}`)).ad).toMatchObject({ label: 'Sponsored', text: 'Fresh coffee' });
      await ctx.close();

      // Neither, which is how a server starts: ads are kept and changed as ever, and none is published or shown.
      const off = await setup({ monetization: {} });
      expect(ctx.config.monetization).toEqual({ feedAds: false, postAds: false });
      const [unsold] = await posts(off.alice, 3);
      const ad = await textAd(off.root, 'Fresh coffee');
      expect(ad.status).toBe('live');
      await ctx.compact();
      expect(await ctx.ads.get()).toEqual([]);
      expect(await feed('tags=news')).not.toHaveProperty('ads');
      expect(ok(await req(null, 'GET', `/content/${unsold}`))).not.toHaveProperty('ad');
      expect((await list(off.root)).ads).toMatchObject([{ adId: ad.adId }]);
    });

    it('changes what an update names, and nothing else of the ad', async () => {
      const { root, alice } = await setup();
      await posts(alice, 3);
      const startsAt = ctx.clock.now - HOUR;
      const ad = await textAd(root, 'Fresh coffee', { url: 'https://coffee.example/', tags: 'news', startsAt: iso(startsAt) });
      await ctx.compact();
      expect(await adsOf('tags=news')).toEqual(['Fresh coffee@3']);

      ctx.clock.now += 1000;
      const updated = ok(await patch(root, ad.adId, { text: '  Fresher coffee ' })) as Ad;
      expect(updated).toEqual({ ...ad, text: 'Fresher coffee', updatedAt: now() });
      // Shown as it was until the compactor's next run.
      expect(await adsOf('tags=news')).toEqual(['Fresh coffee@3']);
      await ctx.compact();
      expect(await adsOf('tags=news')).toEqual(['Fresher coffee@3']);

      // The link is cleared by null or by an empty string, which is all a form can send.
      expect(ok(await patch(root, ad.adId, { url: '' }))).not.toHaveProperty('url');
      expect(ok(await patch(root, ad.adId, { url: 'https://coffee.example/new' })).url).toBe('https://coffee.example/new');
      expect(ok(await patch(root, ad.adId, { url: null }))).not.toHaveProperty('url');
      // Naming the kind it has changes nothing, and is no update on its own.
      expect(await refused(patch(root, ad.adId, { kind: 'text' }))).toEqual([400, 'nothing to update: provide text, url, tags, startsAt, endsAt or an image']);
      expect(await refused(patch(root, ad.adId, {}))).toEqual([400, 'nothing to update: provide text, url, tags, startsAt, endsAt or an image']);
      expect(await refused(patch(root, ad.adId, { kind: 'image' }))).toEqual([400, 'an ad keeps its kind (text): create another ad instead']);
      expect(await refused(patch(root, ad.adId, { text: '' }))).toEqual([400, 'text is required: a text ad is its text']);
      expect(await refused(patch(root, ad.adId, { text: null }))).toEqual([400, 'text is required: a text ad is its text']);
      expect(await refused(patch(root, ad.adId, { content: PNG.toString('base64') }))).toEqual([400, 'a text ad has no image']);
      // The schedule is held to what it would be with the change.
      expect(await refused(patch(root, ad.adId, { endsAt: iso(startsAt) }))).toEqual([400, 'endsAt must be after startsAt']);
      ok(await patch(root, ad.adId, { endsAt: iso(startsAt + 10 * HOUR) }));
      expect(await refused(patch(root, ad.adId, { startsAt: iso(startsAt + 10 * HOUR) }))).toEqual([400, 'endsAt must be after startsAt']);
      expect(ok(await patch(root, ad.adId, { startsAt: iso(startsAt + 5 * HOUR) }))).toMatchObject({ startsAt: iso(startsAt + 5 * HOUR), endsAt: iso(startsAt + 10 * HOUR), status: 'scheduled' });

      expect(await read(root, ad.adId)).toMatchObject({ kind: 'text', text: 'Fresher coffee', tags: ['news'], createdAt: ad.createdAt, createdBy: root.userId });
    });

    it('deletes an ad, which is shown until the compactor has run', async () => {
      const { root, alice } = await setup();
      await posts(alice, 3);
      const ad = await textAd(root, 'Fresh coffee');
      await ctx.compact();
      expect(await adsOf('tags=news')).toEqual(['Fresh coffee@3']);

      expect(ok(await req(root, 'DELETE', `/monetization/ads/${ad.adId}`))).toEqual({ adId: ad.adId, status: 'deleted' });
      expect(await refused(req(root, 'GET', `/monetization/ads/${ad.adId}`))).toEqual([404, 'ad not found']);
      expect(await refused(req(root, 'DELETE', `/monetization/ads/${ad.adId}`))).toEqual([404, 'ad not found']);
      expect(await adsOf('tags=news')).toEqual(['Fresh coffee@3']);
      await ctx.compact();
      expect(await adsOf('tags=news')).toEqual([]);
      expect(await ctx.ads.get()).toEqual([]);
    });

    it('keeps the ads of an admin whose account is gone, and publishes the same ads only once', async () => {
      const { root } = await setup();
      const other = await ctx.register('other');
      await setAdmin(ctx.db, 'other', true);
      const ad = await textAd(other, 'Fresh coffee');
      await ctx.compact();
      const before = await ctx.hot.get('ads');
      expect(JSON.parse(before!.toString('utf8'))).toEqual({ v: 1, ads: [{ adId: ad.adId, kind: 'text', text: 'Fresh coffee', tags: null, startsAt: ctx.clock.now - (ctx.config.compact.graceSeconds * 1000 + 1000), endsAt: null }] });
      // A run with nothing new to say of the ads writes nothing.
      expect(await ctx.ads.sync(await ctx.ads.get())).toBe(false);

      await ctx.db.deleteFrom('users').where('id', '=', other.userId).execute();
      expect(await read(root, ad.adId)).toMatchObject({ adId: ad.adId, createdBy: null, status: 'live' });
    });

    it('holds at most a hundred ads that have not ended', async () => {
      const { root } = await setup();
      const t = ctx.clock.now;
      const row = (ends_at: number | null) => ({ id: randomUUID(), kind: 'text' as const, text: 'Filler', url: null, image_type: null, tags: null, starts_at: t - 2 * HOUR, ends_at, created_by: null, created_at: t, updated_at: t });
      // Ads that are over take no room, however many there are.
      await ctx.db.insertInto('monetization').values(Array.from({ length: 20 }, () => row(t - HOUR))).execute();
      await ctx.db.insertInto('monetization').values(Array.from({ length: MAX_OPEN_ADS - 1 }, (_, i) => row(i % 2 ? null : t + HOUR))).execute();

      const last = await textAd(root, 'The hundredth');
      const FULL = "the server holds at most 100 ads that haven't ended: delete one, or end one, first";
      expect(await refused(req(root, 'POST', '/monetization/ads', { kind: 'text', text: 'One too many' }))).toEqual([409, FULL]);
      // One that is over already is no more to hold, and neither is a change to one that is there.
      const over = await textAd(root, 'Over', { startsAt: iso(t - 2 * HOUR), endsAt: iso(t - HOUR) });
      ok(await patch(root, last.adId, { text: 'Still the hundredth' }));
      // Bringing one back is.
      expect(await refused(patch(root, over.adId, { endsAt: null }))).toEqual([409, FULL]);

      // Ending one, or deleting one, makes room.
      ctx.clock.now += 1000;
      ok(await patch(root, last.adId, { endsAt: now() }));
      ok(await patch(root, over.adId, { endsAt: null }));
      expect(await refused(req(root, 'POST', '/monetization/ads', { kind: 'text', text: 'One too many' }))).toEqual([409, FULL]);
      ok(await req(root, 'DELETE', `/monetization/ads/${over.adId}`));
      await textAd(root, 'Room again');
    });

    it('names the ad in the audit log of each change to it', async () => {
      const { root } = await setup({ audit: true });
      // A second apart, as the log is read here in the order of its records' times.
      const ad = await textAd(root, 'Fresh coffee');
      ctx.clock.now += 1000;
      const pictured = ok(await upload(root, 'POST', '/monetization/ads', { kind: 'image' }, { name: 'ad.png', type: 'image/png', data: PNG }), 201) as Ad;
      ctx.clock.now += 1000;
      ok(await patch(root, ad.adId, { text: 'Fresher coffee' }));
      ctx.clock.now += 1000;
      ok(await req(root, 'DELETE', `/monetization/ads/${ad.adId}`));
      // Reads leave nothing, and neither does a request that was refused.
      await list(root);
      await req(root, 'POST', '/monetization/ads', { kind: 'text' });

      const records = (await readAudit(ctx)).filter((r) => r.route?.startsWith('/monetization'));
      expect(records.map((r) => [r.method, r.route, r.status, r.userId, r.result])).toEqual([
        ['POST', '/monetization/ads', 201, root.userId, { adId: ad.adId }],
        ['POST', '/monetization/ads', 201, root.userId, { adId: pictured.adId }],
        ['PATCH', '/monetization/ads/:adId', 200, root.userId, { adId: ad.adId }],
        ['DELETE', '/monetization/ads/:adId', 200, root.userId, { adId: ad.adId }],
      ]);
      expect(records[0]!.body).toEqual({ kind: 'text', text: 'Fresh coffee' });
      // The image's bytes aren't in the log: what it was, is.
      expect(records[1]!.body).toEqual({ multipart: true, fields: { kind: 'image' }, file: { filename: 'ad.png', mimeType: 'image/png', size: PNG.length } });
    });
  });
}
