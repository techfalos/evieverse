import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { readAttestation, signingKeys } from '../src/attestation.js';
import type { TestPlugin } from '../src/moderation/trust.types.js';
import { setAdmin } from '../src/moderation/policy.js';
import { MAX_ALT_CHARS } from '../src/posts.js';
import { decodeSummary, encodeSummary } from '../src/storage/summaryStore.js';
import type { Summary } from '../src/storage/index.js';
import { as, createTestContext, feedItems, JPEG, multipart, PNG, store, TARGETS, type FilePart, type TestContext, type User } from './helpers.js';

const jpeg: FilePart = { name: 'photo.jpg', type: 'image/jpeg', data: JPEG };
const png: FilePart = { name: 'pixel.png', type: 'image/png', data: PNG };

describe('summaries with alternative texts and processed videos', () => {
  const summary = (preview: Summary['preview'], more: Partial<Summary> = {}): Summary => ({
    contentId: '00000000-0000-4000-8000-000000000001',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    userId: '00000000-0000-4000-8000-000000000002',
    mimeType: 'image/jpeg',
    aiGenerated: false,
    comments: true,
    tags: ['pics'],
    preview,
    ...more,
  });
  const url = '/content/00000000-0000-4000-8000-000000000001/raw';
  const through = (s: Summary) => decodeSummary(s.contentId, encodeSummary(s), '');

  it('keeps what describes a post\'s images, and what a processed video is, through the summary store', () => {
    const album = summary({ kind: 'image', url, text: 'Two of them', imageCount: 2, alt: ['A grey square\nwith a "border"', ''] });
    expect(through(album).preview).toEqual(album.preview);
    const one = summary({ kind: 'image', url, alt: ['Only one'] });
    expect(through(one).preview).toEqual(one.preview);
    const id = '00000000-0000-4000-8000-000000000003';
    const video = summary(
      { kind: 'video', url, video: { id, width: 1280, height: 720, duration: 12.5, poster: `${url.replace(/\/raw$/, '')}/video/${id}/poster.jpg`, hls: `${url.replace(/\/raw$/, '')}/video/${id}/master.m3u8` } },
      { mimeType: 'video/mp4', origin: { url: 'https://other.example/content/00000000-0000-4000-8000-000000000009', publisher: { userId: '00000000-0000-4000-8000-000000000004', username: 'carol' } } },
    );
    expect(through(video)).toMatchObject({ origin: video.origin, preview: { kind: 'video', video: { id, width: 1280, height: 720, duration: 12.5 } } });
    // One with neither is stored as it always was.
    const plain = summary({ kind: 'image', url, text: 'No words for it', imageCount: 3 });
    expect(through(plain).preview).toEqual(plain.preview);
    expect(encodeSummary(plain).length).toBeLessThan(encodeSummary(album).length);
  });
});

/** The alternative text of images: of a post's, a comment's and an ad's. */
for (const target of TARGETS) {
  describe(`alt text (${target.name})`, () => {
    let ctx: TestContext;
    afterEach(() => ctx.close());

    const ok = (res: LightMyRequestResponse, status = 201) => {
      expect(res.statusCode, res.body).toBe(status);
      return res.json();
    };
    const refusal = (res: LightMyRequestResponse) => [res.statusCode, res.json().error];
    const get = (url: string, user?: User) => ctx.app.inject({ method: 'GET', url, ...(user && { headers: as(user) }) });
    const read = async (contentId: string) => ok(await get(`/content/${contentId}`), 200);
    /** POST /store with one image inline. */
    const image = (user: User, fields: Record<string, unknown> = {}) =>
      store(ctx, user, { type: 'image', tags: ['pics'], content: PNG.toString('base64'), contentEncoding: 'base64', contentType: 'image/png', ...fields });
    /** POST /store as a form: these fields, in this order, and then the files. A field sent twice is given as a list. */
    const form = (user: User, fields: [string, string][], files: FilePart[], url = '/store') => {
      // The helper takes each field once: the ones that repeat are written into the body after it is built.
      const mp = multipart({ ...user, type: 'image', tags: 'pics' }, files);
      const boundary = mp.headers['content-type'].split('boundary=')[1]!;
      const extra = Buffer.concat(fields.map(([name, value]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)));
      return ctx.app.inject({ method: 'POST', url, payload: Buffer.concat([extra, mp.payload]), headers: mp.headers });
    };
    const ONLY_IMAGES = [400, "alt is only for images: it describes an image to those who can't see it"];

    it('keeps the alt text of a post\'s image, gives it wherever the post is read, and takes another with an update', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');

      const sent = ok(await image(alice, { text: 'My desk', alt: '  A laptop on a wooden desk, beside a cup.  ' }));
      const { contentId } = sent;
      const url = `/content/${contentId}/raw`;
      const described = { kind: 'image', url, text: 'My desk', alt: ['A laptop on a wooden desk, beside a cup.'] };
      expect(sent.preview).toEqual(described);
      expect(await read(contentId)).toMatchObject({ preview: described, images: [{ url, mimeType: 'image/png', size: PNG.length, alt: 'A laptop on a wooden desk, beside a cup.' }] });
      await ctx.compact();
      expect((await feedItems(ctx, 'pics')).map((item) => item.preview)).toEqual([described]);

      // The same image described the same way is the post as it is; described another way, or not at all, it is an update.
      expect((await image(alice, { contentId, text: 'My desk', alt: 'A laptop on a wooden desk, beside a cup.' })).json()).toEqual({ contentId, unchanged: true });
      ctx.clock.now += 1000;
      expect(ok(await image(alice, { contentId, text: 'My desk', alt: 'A laptop.' }), 200).preview).toEqual({ ...described, alt: ['A laptop.'] });
      expect((await read(contentId)).images).toEqual([{ url, mimeType: 'image/png', size: PNG.length, alt: 'A laptop.' }]);
      ctx.clock.now += 1000;
      expect(ok(await image(alice, { contentId, text: 'My desk' }), 200).preview).toEqual({ kind: 'image', url, text: 'My desk' });
      expect((await read(contentId)).images).toEqual([{ url, mimeType: 'image/png', size: PNG.length }]);
      await ctx.compact();
      expect((await feedItems(ctx, 'pics')).map((item) => item.preview)).toEqual([{ kind: 'image', url, text: 'My desk' }]);

      // It describes an image, and is no longer than it may be.
      expect((await image(alice, { alt: 'x'.repeat(MAX_ALT_CHARS + 1) })).statusCode).toBe(400);
      ok(await image(alice, { alt: 'x'.repeat(MAX_ALT_CHARS) }));
      expect(refusal(await store(ctx, alice, { type: 'text', text: 'Words', tags: ['pics'], alt: 'Of nothing' }))).toEqual(ONLY_IMAGES);
      expect(refusal(await store(ctx, alice, { type: 'video', tags: ['pics'], content: 'clip', contentType: 'video/mp4', alt: 'Of a video' }))).toEqual(ONLY_IMAGES);
      expect(refusal(await store(ctx, alice, { type: 'link', url: 'https://example.com/', tags: ['pics'], alt: 'Of a link' }))).toEqual(ONLY_IMAGES);
    });

    it('takes an alt text for each image of an album, in the order of the images', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');

      // A form says them in as many `alt` fields as it likes, up to one for each file: an empty one for an image it doesn't describe.
      const sent = ok(
        await form(
          alice,
          [
            ['alt', 'The first'],
            ['alt', ''],
            ['alt', 'The third'],
          ],
          [jpeg, png, jpeg],
        ),
      );
      const { contentId } = sent;
      const url = `/content/${contentId}/raw`;
      expect(sent.preview).toEqual({ kind: 'image', url, imageCount: 3, alt: ['The first', '', 'The third'] });
      expect((await read(contentId)).images).toEqual([
        { url, mimeType: 'image/jpeg', size: JPEG.length, alt: 'The first' },
        { url: `${url}/2`, mimeType: 'image/png', size: PNG.length },
        { url: `${url}/3`, mimeType: 'image/jpeg', size: JPEG.length, alt: 'The third' },
      ]);
      // Fewer of them than images describe the first ones.
      expect(ok(await form(alice, [['alt', 'Only the first']], [jpeg, png])).preview.alt).toEqual(['Only the first', '']);
      expect(ok(await form(alice, [['alt', 'One'], ['alt', 'Two']], [jpeg, png, jpeg])).preview.alt).toEqual(['One', 'Two', '']);
      // None, or only empty ones, is a post whose images nobody described.
      expect(ok(await form(alice, [['alt', ''], ['alt', ' ']], [jpeg, png])).preview).not.toHaveProperty('alt');
      expect(refusal(await form(alice, [['alt', 'One'], ['alt', 'Two'], ['alt', 'Three']], [jpeg, png]))).toEqual([400, '3 alt fields were sent for 2 files: send at most one for each file, in their order']);

      // A JSON request says each image's with the image.
      const listed = (images: Record<string, unknown>[], fields: Record<string, unknown> = {}) =>
        store(ctx, alice, { type: 'image', tags: ['pics'], contentEncoding: 'base64', images, ...fields });
      const inline = (bytes: Buffer, alt?: string) => ({ content: bytes.toString('base64'), ...(alt !== undefined && { alt }) });
      const json = ok(await listed([inline(PNG), inline(JPEG, 'The second')]));
      expect(json.preview.alt).toEqual(['', 'The second']);
      expect(refusal(await listed([inline(PNG), inline(JPEG)], { alt: 'Of which?' }))).toEqual([400, 'with images, each image says its own alt']);

      // An update with the same images and the same words for them changes nothing; with other words it does.
      const again = { contentId: json.contentId };
      expect((await listed([inline(PNG), inline(JPEG, 'The second')], again)).json()).toEqual({ contentId: json.contentId, unchanged: true });
      ctx.clock.now += 1000;
      expect(ok(await listed([inline(PNG, 'The first'), inline(JPEG, 'The second')], again), 200).preview.alt).toEqual(['The first', 'The second']);
      await ctx.compact();
      expect((await feedItems(ctx, 'pics')).find((item) => item.contentId === json.contentId)!.preview).toMatchObject({ imageCount: 2, alt: ['The first', 'The second'] });
    });

    it('gives the alt texts to moderation as text of the post, and attests them to other servers', async () => {
      const wary: TestPlugin = { name: 'wary', record: true, rules: [{ includes: 'scam', set: 0 }] };
      /** The texts of what the plugin was last shown. */
      const lastSeen = async () => (await ctx.trust.seen()).at(-1)!.post.texts;
      const seeds = [Buffer.alloc(32, 7).toString('base64')];
      ctx = await createTestContext(target, { trustPlugins: [wary], publicBaseUrl: 'https://api.example.com', reposts: { signingKeys: seeds } });
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');

      const { contentId } = ok(await image(alice, { text: 'My desk', alt: 'A laptop on a desk' }));
      expect(await lastSeen()).toEqual(expect.arrayContaining(['My desk', 'A laptop on a desk']));
      expect((await image(alice, { alt: 'A scam, in words only a screen reader says' })).statusCode).toBe(422);

      const { attestation } = ok(await get(`/content/${contentId}/attestation`), 200);
      expect(readAttestation(attestation)!.payload).toMatchObject({ kid: signingKeys(seeds)[0]!.id, preview: { kind: 'image', text: 'My desk', alt: ['A laptop on a desk'] } });

      // A comment's image has one too, which goes the same way.
      const post = ok(await store(ctx, alice, { type: 'text', text: 'Say something', tags: ['talk'], comments: true }));
      const comment = (fields: Record<string, string>, file?: FilePart) => {
        const mp = multipart(fields, file);
        return ctx.app.inject({ method: 'POST', url: `/content/${post.contentId}/comments`, payload: mp.payload, headers: { ...mp.headers, ...as(bob) } });
      };
      const sent = ok(await comment({ text: 'Mine looks like this', alt: 'A tidy desk' }, png));
      expect(sent.media).toMatchObject({ kind: 'image', mimeType: 'image/png', alt: 'A tidy desk' });
      expect(await lastSeen()).toEqual(expect.arrayContaining(['Mine looks like this', 'A tidy desk']));
      expect(ok(await get(`/content/${post.contentId}/comments`), 200).comments.map((c: { media?: { alt?: string } }) => c.media?.alt)).toEqual(['A tidy desk']);
      expect((await comment({ text: 'Look', alt: 'A scam' }, png)).statusCode).toBe(422);
      expect(refusal(await comment({ text: 'Words alone', alt: 'Of nothing' }))).toEqual(ONLY_IMAGES);
      expect(refusal(await comment({ alt: 'Of a video' }, { name: 'clip.mp4', type: 'video/mp4', data: Buffer.from('a clip') }))).toEqual(ONLY_IMAGES);
    });

    it('keeps the alt text of an image ad, and shows it with the ad', async () => {
      ctx = await createTestContext(target, { monetization: { postAds: true } });
      const root = await ctx.register('root');
      await setAdmin(ctx.db, 'root', true);
      const alice = await ctx.register('alice');
      const ads = (method: 'POST' | 'PATCH', url: string, payload: Record<string, unknown>) => ctx.app.inject({ method, url, headers: as(root), payload });

      const ad = ok(await ads('POST', '/monetization/ads', { kind: 'image', content: PNG.toString('base64'), text: 'Buy one', alt: 'A red bicycle', url: 'https://shop.example/' }));
      expect(ad).toMatchObject({ kind: 'image', text: 'Buy one', imageAlt: 'A red bicycle' });
      expect(refusal(await ads('POST', '/monetization/ads', { kind: 'text', text: 'Words', alt: 'Of nothing' }))).toEqual(ONLY_IMAGES);

      const { contentId } = ok(await store(ctx, alice, { type: 'text', text: 'A post', tags: ['news'] }));
      await ctx.compact();
      expect((await read(contentId)).ad).toMatchObject({ kind: 'image', imageAlt: 'A red bicycle', text: 'Buy one' });

      // Changed, and then taken away, by an update of the ad.
      expect(ok(await ads('PATCH', `/monetization/ads/${ad.adId}`, { alt: 'A blue bicycle' }), 200).imageAlt).toBe('A blue bicycle');
      await ctx.compact();
      expect((await read(contentId)).ad.imageAlt).toBe('A blue bicycle');
      expect(ok(await ads('PATCH', `/monetization/ads/${ad.adId}`, { alt: '' }), 200)).not.toHaveProperty('imageAlt');
      await ctx.compact();
      expect((await read(contentId)).ad).not.toHaveProperty('imageAlt');
    });
  });
}
