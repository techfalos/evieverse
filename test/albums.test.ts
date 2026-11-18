import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attest, readAttestation, signingKeys } from '../src/attestation.js';
import type { SigningKey } from '../src/attestation.types.js';
import { MAX_POST_IMAGES } from '../src/posts.js';
import { createTestContext, feedItems, JPEG, multipart, PNG, readAudit, sha256, store, TARGETS, type FilePart, type TestContext, type User } from './helpers.js';

// 1x1 GIF and 1x1 lossless WebP, with nothing in them but the image
const GIF = Buffer.from('R0lGODdhAQABAIAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw==', 'base64');
const WEBP = Buffer.from('UklGRhwAAABXRUJQVlA4TA8AAAAvAAAAAAcQ/Y/+ByKi/wEA', 'base64');
/** The JPEG with a comment in it, after its JFIF header: stored, it is the JPEG. */
const COMMENTED = Buffer.concat([JPEG.subarray(0, 20), Buffer.from([0xff, 0xfe, 0, 15]), Buffer.from('taken at home', 'latin1'), JPEG.subarray(20)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>');

const jpeg = (data = JPEG): FilePart => ({ name: 'photo.jpg', type: 'image/jpeg', data });
const png: FilePart = { name: 'pixel.png', type: 'image/png', data: PNG };
const gif: FilePart = { name: 'anim.gif', type: 'image/gif', data: GIF };
const webp: FilePart = { name: 'pixel.webp', type: 'image/webp', data: WEBP };

/**
 * Image posts of several images (albums): how they are sent, stored, read and updated. Each
 * image is held to what the one image of a post is, which test/images.test.ts covers.
 */
for (const target of TARGETS) {
  describe(`albums (${target.name})`, () => {
    let ctx: TestContext;
    afterEach(async () => {
      vi.restoreAllMocks();
      // Nothing is left of the files a request spooled.
      expect(await readdir(join(ctx.dir, 'tmp')).catch(() => [])).toEqual([]);
      await ctx.close();
    });

    const ok = (res: LightMyRequestResponse, status = 201) => {
      expect(res.statusCode, res.body).toBe(status);
      return res.json();
    };
    const refusal = (res: LightMyRequestResponse) => [res.statusCode, res.json().error];
    /** POST /store as a multipart form, with these files as its "content" parts, in this order. */
    const send = (user: User, files: FilePart[], fields: Record<string, string> = {}) => {
      const mp = multipart({ ...user, type: 'image', tags: 'pics', ...fields }, files);
      return ctx.app.inject({ method: 'POST', url: '/store', payload: mp.payload, headers: mp.headers });
    };
    /** POST /store as JSON, with these images in `images`: each inline, or an uploadId (with a name: a directory keeps no content types). */
    const listed = (user: User, images: (Buffer | string)[], fields: Record<string, unknown> = {}) =>
      store(ctx, user, {
        type: 'image',
        tags: ['pics'],
        contentEncoding: 'base64',
        images: images.map((image) => (typeof image === 'string' ? { uploadId: image, filename: 'upload.png' } : { content: image.toString('base64') })),
        ...fields,
      });
    /** What a client does with an upload link: puts the file in the content store, here a directory. */
    const put = async (user: User, uploadId: string, bytes: Buffer) => {
      const dir = join(ctx.dir, 'content', 'uploads', user.userId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, uploadId), bytes);
    };
    const uploads = (user: User) => readdir(join(ctx.dir, 'content', 'uploads', user.userId)).catch(() => []);
    const get = (url: string) => ctx.app.inject({ method: 'GET', url });
    /** The image at `place` among the post's, counted from 1: its content type and whether its bytes are `image`. */
    const shows = async (contentId: string, place: number | '', image: Buffer) => {
      const res = await get(`/content/${contentId}/raw${place === '' ? '' : `/${place}`}`);
      return [res.statusCode, res.headers['content-type'], res.rawPayload.equals(image)];
    };
    /** The files the content store holds of a post: its images and its meta file. */
    const kept = async (contentId: string) => (await readdir(join(ctx.dir, 'content', 'content')).catch(() => [])).filter((f) => f.startsWith(contentId)).sort();
    const staged = async () => (await readdir(join(ctx.dir, 'content', 'staged')).catch(() => [])).sort();
    const pending = async () =>
      (await ctx.db.selectFrom('pending_writes').select(['seq', 'kind', 'write_key']).orderBy('seq').orderBy('write_key').execute()).map((r) => `${Number(r.seq)} ${r.kind}${r.write_key && ` ${r.write_key}`}`);
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const NO_IMAGE = [404, 'the post has no such image'];

    it('stores the images of a post in the order they were sent, each without its metadata, and serves each at its place', async () => {
      ctx = await createTestContext(target, { maxUploadBytes: 1000 });
      const alice = await ctx.register('alice');

      const res = await send(alice, [jpeg(COMMENTED), png, gif], { text: 'Three of them' });
      const { contentId } = ok(res);
      expect(res.json().preview).toEqual({ kind: 'image', url: `/content/${contentId}/raw`, text: 'Three of them', imageCount: 3 });

      // The first is the post's bytes, as the one image of a post is; the others follow it.
      expect(await shows(contentId, '', JPEG)).toEqual([200, 'image/jpeg', true]);
      expect(await shows(contentId, 1, JPEG)).toEqual([200, 'image/jpeg', true]);
      expect(await shows(contentId, 2, PNG)).toEqual([200, 'image/png', true]);
      expect(await shows(contentId, 3, GIF)).toEqual([200, 'image/gif', true]);
      expect(refusal(await get(`/content/${contentId}/raw/4`))).toEqual(NO_IMAGE);
      for (const place of ['0', '-1', '1.5', 'two']) expect((await get(`/content/${contentId}/raw/${place}`)).statusCode, place).toBe(400);
      expect((await get(`/content/${contentId}/raw/2`)).headers).toMatchObject({ 'x-content-type-options': 'nosniff', 'content-length': String(PNG.length) });

      const images = [
        { url: `/content/${contentId}/raw`, mimeType: 'image/jpeg', size: JPEG.length },
        { url: `/content/${contentId}/raw/2`, mimeType: 'image/png', size: PNG.length },
        { url: `/content/${contentId}/raw/3`, mimeType: 'image/gif', size: GIF.length },
      ];
      expect(ok(await get(`/content/${contentId}`), 200)).toMatchObject({
        preview: { kind: 'image', url: `/content/${contentId}/raw`, text: 'Three of them', imageCount: 3 },
        mimeType: 'image/jpeg',
        size: JPEG.length,
        contentUrl: `/content/${contentId}/raw`,
        images,
      });
      expect(await ctx.content.getMeta(contentId)).toMatchObject({
        mimeType: 'image/jpeg',
        size: JPEG.length,
        sha256: sha256(JPEG),
        images: [JPEG, PNG, GIF].map((image, i) => ({ mimeType: images[i]!.mimeType, size: image.length, sha256: sha256(image) })),
      });
      expect(await kept(contentId)).toEqual([contentId, `${contentId}.2`, `${contentId}.3`, `${contentId}.meta.json`]);

      // In a feed, the preview says how many there are: each is read at its place after the first's address.
      await ctx.compact();
      expect((await feedItems(ctx, 'pics')).map((item) => item.preview)).toEqual([{ kind: 'image', url: `/content/${contentId}/raw`, text: 'Three of them', imageCount: 3 }]);
    });

    it('takes the images in a JSON request too, each inline or as an upload of its own', async () => {
      ctx = await createTestContext(target, { maxUploadBytes: 1000 });
      const alice = await ctx.register('alice');
      await put(alice, id(1), GIF);
      await put(alice, id(2), COMMENTED);

      const { contentId } = ok(await listed(alice, [PNG, id(1), id(2), WEBP]));
      expect(await shows(contentId, '', PNG)).toEqual([200, 'image/png', true]);
      expect(await shows(contentId, 2, GIF)).toEqual([200, 'image/gif', true]);
      expect(await shows(contentId, 3, JPEG)).toEqual([200, 'image/jpeg', true]);
      expect(await shows(contentId, 4, WEBP)).toEqual([200, 'image/webp', true]);
      expect((await ctx.content.getMeta(contentId))!.images!.map((image) => image.sha256)).toEqual([PNG, GIF, JPEG, WEBP].map(sha256));
      // The server has the post, so its uploads go.
      expect(await uploads(alice)).toEqual([]);

      // One image in `images` is a post of one image, as one sent any other way is.
      const one = ok(await listed(alice, [PNG]));
      expect(one.preview).toEqual({ kind: 'image', url: `/content/${one.contentId}/raw` });
      expect(await ctx.content.getMeta(one.contentId)).not.toHaveProperty('images');
      expect(ok(await get(`/content/${one.contentId}`), 200).images).toEqual([{ url: `/content/${one.contentId}/raw`, mimeType: 'image/png', size: PNG.length }]);
      expect(await shows(one.contentId, 1, PNG)).toEqual([200, 'image/png', true]);
      expect(refusal(await get(`/content/${one.contentId}/raw/2`))).toEqual(NO_IMAGE);
      expect(await kept(one.contentId)).toEqual([one.contentId, `${one.contentId}.meta.json`]);

      // A post that isn't an image post has its bytes, and no images.
      const text = ok(await store(ctx, alice, { type: 'text', text: 'No pictures', tags: ['news'] }));
      expect(ok(await get(`/content/${text.contentId}`), 200)).not.toHaveProperty('images');
      expect((await get(`/content/${text.contentId}/raw/1`)).body).toBe('No pictures');
      expect(refusal(await get(`/content/${text.contentId}/raw/2`))).toEqual(NO_IMAGE);
    });

    it('takes as many images as a post can have, each as large as a file may be, and no more', async () => {
      ctx = await createTestContext(target, { maxUploadBytes: 1000 });
      const alice = await ctx.register('alice');
      const full = Array.from({ length: MAX_POST_IMAGES }, () => jpeg());
      // Together they are more than one file may be: the limit is on each.
      expect(full.length * JPEG.length).toBeGreaterThan(1000);

      const { contentId } = ok(await send(alice, full));
      expect(await shows(contentId, MAX_POST_IMAGES, JPEG)).toEqual([200, 'image/jpeg', true]);
      expect(await kept(contentId)).toHaveLength(MAX_POST_IMAGES + 1);

      const tooMany = [400, `an image post takes at most ${MAX_POST_IMAGES} images`];
      expect(refusal(await send(alice, [...full, png]))).toEqual(tooMany);
      expect(refusal(await send(alice, [...full, png, gif, webp]))).toEqual(tooMany);
      expect(refusal(await listed(alice, [...full.map((file) => file.data), PNG]))).toEqual(tooMany);
      expect((await send(alice, [png, jpeg(Buffer.concat([JPEG, Buffer.alloc(1000)]))])).statusCode).toBe(413);
      expect(await ctx.db.selectFrom('content').select('id').execute()).toEqual([{ id: contentId }]);
    });

    it('refuses a post if any of its images is refused, and files sent in a way a post takes none', async () => {
      ctx = await createTestContext(target, { maxUploadBytes: 1000 });
      const alice = await ctx.register('alice');
      const notAnImage = [400, 'image posts take JPEG, PNG, GIF and WebP files, and the file is none of them'];
      const clip: FilePart = { name: 'clip.mp4', type: 'video/mp4', data: Buffer.from('a video, as far as anyone checks') };
      await put(alice, id(1), PNG);
      await put(alice, id(2), SVG);

      // No image, cut short, or no image file at all: wherever it is among them.
      expect(refusal(await send(alice, [png, { ...png, data: SVG }, gif]))).toEqual(notAnImage);
      expect(refusal(await send(alice, [png, gif, jpeg(JPEG.subarray(0, 40))]))).toEqual([400, 'the file is not a complete, well-formed image/jpeg image']);
      expect(refusal(await send(alice, [png, clip]))).toEqual([400, 'image posts take image/* files, got video/mp4; post other files as a link']);
      expect(refusal(await listed(alice, [PNG, SVG]))).toEqual(notAnImage);
      expect(refusal(await listed(alice, [PNG, Buffer.alloc(0)]))).toEqual([400, 'content is empty']);
      expect(refusal(await listed(alice, [id(1), id(2)]))).toEqual(notAnImage);
      // An image that is said to be something else is refused for that, before any is read.
      expect(
        refusal(await store(ctx, alice, { type: 'image', tags: ['pics'], contentEncoding: 'base64', images: [{ content: PNG.toString('base64') }, { content: PNG.toString('base64'), filename: 'clip.mp4' }] })),
      ).toEqual([
        400,
        'image posts take image/* files, got video/mp4; post other files as a link',
      ]);
      expect(refusal(await listed(alice, [id(1), id(3)]))).toEqual([400, 'upload not found: send the file to the link POST /uploads gave before storing it; links and uploads expire']);
      // The uploads of a post that was refused are kept, for it to be sent again.
      expect((await uploads(alice)).sort()).toEqual([id(1), id(2)]);

      // Only an image post has several files.
      const video = { type: 'video', tags: 'clips' };
      expect(refusal(await send(alice, [clip, clip], video))).toEqual([400, 'a video post takes one file: only an image post takes several']);
      expect(refusal(await listed(alice, [PNG], { type: 'video' }))).toEqual([400, 'images is only for image posts']);
      expect(refusal(await send(alice, [png], { type: 'text', text: 'A note' }))).toEqual([400, 'a text post has no file']);

      // The images are sent one way: as files, in `images`, or one in `content` or as an uploadId.
      const oneWay = [400, 'Send the images of a post in images, or as files, or one as content or an uploadId: one of them'];
      expect(refusal(await listed(alice, [PNG], { content: PNG.toString('base64') }))).toEqual(oneWay);
      expect(refusal(await listed(alice, [PNG], { uploadId: id(1) }))).toEqual(oneWay);
      expect(refusal(await send(alice, [png, gif], { content: PNG.toString('base64') }))).toEqual([400, 'Send content either as a file or as a field, not both']);
      expect(refusal(await send(alice, [png, { ...gif, field: 'second' }]))).toEqual([400, 'File parts must be named "content": one, or for an image post of several images, one for each']);
      // Each of `images` is one or the other, and there is at least one.
      expect((await store(ctx, alice, { type: 'image', tags: ['pics'], images: [{ content: PNG.toString('base64'), uploadId: id(1) }] })).statusCode).toBe(400);
      expect((await store(ctx, alice, { type: 'image', tags: ['pics'], images: [{ filename: 'pixel.png' }] })).statusCode).toBe(400);
      expect((await store(ctx, alice, { type: 'image', tags: ['pics'], images: [] })).statusCode).toBe(400);

      expect(await ctx.db.selectFrom('content').select('id').execute()).toEqual([]);
      expect(await kept('')).toEqual([]);
      expect(await staged()).toEqual([]);
    });

    it('updates a post with the images it is sent: the same ones in the same order change nothing, and the ones left out are deleted', async () => {
      ctx = await createTestContext(target, { maxUploadBytes: 1000 });
      const alice = await ctx.register('alice');
      const { contentId } = ok(await send(alice, [png, gif, webp], { text: 'Three' }));
      const before = await ctx.content.getMeta(contentId);
      const update = (files: FilePart[], fields: Record<string, string> = {}) => send(alice, files, { contentId, text: 'Three', ...fields });
      ctx.clock.now += 1000;

      // The same images, however they are sent.
      await put(alice, id(1), GIF);
      expect(ok(await update([png, gif, webp]), 200)).toEqual({ contentId, unchanged: true });
      expect(ok(await listed(alice, [PNG, id(1), WEBP], { contentId, text: 'Three' }), 200)).toEqual({ contentId, unchanged: true });
      expect(await ctx.content.getMeta(contentId)).toEqual(before);

      // In another order, they are another post.
      expect(ok(await update([png, webp, gif]), 200)).not.toHaveProperty('unchanged');
      expect(await shows(contentId, 2, WEBP)).toEqual([200, 'image/webp', true]);
      expect(await shows(contentId, 3, GIF)).toEqual([200, 'image/gif', true]);
      expect(await ctx.content.getMeta(contentId)).toMatchObject({ updatedAt: ctx.clock.now, images: [{ sha256: sha256(PNG) }, { sha256: sha256(WEBP) }, { sha256: sha256(GIF) }] });

      // One more.
      ctx.clock.now += 1000;
      expect(ok(await update([png, webp, gif, jpeg()]), 200).preview).toMatchObject({ imageCount: 4 });
      expect(await kept(contentId)).toEqual([contentId, `${contentId}.2`, `${contentId}.3`, `${contentId}.4`, `${contentId}.meta.json`]);

      // Fewer: the files of the ones it no longer has are gone.
      ctx.clock.now += 1000;
      expect(ok(await update([png, jpeg()]), 200).preview).toMatchObject({ imageCount: 2 });
      expect(await kept(contentId)).toEqual([contentId, `${contentId}.2`, `${contentId}.meta.json`]);
      expect(await shows(contentId, 2, JPEG)).toEqual([200, 'image/jpeg', true]);
      expect(refusal(await get(`/content/${contentId}/raw/3`))).toEqual(NO_IMAGE);

      // One: a post of one image, as if it had never been more.
      ctx.clock.now += 1000;
      expect(ok(await update([png]), 200).preview).toEqual({ kind: 'image', url: `/content/${contentId}/raw`, text: 'Three' });
      expect(await kept(contentId)).toEqual([contentId, `${contentId}.meta.json`]);
      expect(await ctx.content.getMeta(contentId)).not.toHaveProperty('images');
      expect(ok(await update([png]), 200)).toEqual({ contentId, unchanged: true });
      // And an album again.
      ctx.clock.now += 1000;
      ok(await update([png, gif]), 200);
      expect(await shows(contentId, 2, GIF)).toEqual([200, 'image/gif', true]);

      // The content's type is its first image's, which an update keeps.
      expect(refusal(await update([gif, png]))).toEqual([400, 'an update must have the same content type as the original (image/png), got image/gif']);

      // Deleted, all of its files go.
      ok(await ctx.app.inject({ method: 'DELETE', url: `/content/${contentId}`, payload: alice }), 202);
      await ctx.compact();
      expect(await kept(contentId)).toEqual([]);
    });

    it('serves each image of a write from where it is staged until the compactor has applied it', async () => {
      ctx = await createTestContext(target, { settle: false });
      const alice = await ctx.register('alice');

      // Each image is staged, and the ones after the first have a row of their own, under the write's number.
      const { contentId } = ok(await send(alice, [png, gif]));
      expect(await pending()).toEqual(['1 post', '1 post_file 2']);
      expect(await staged()).toHaveLength(2);
      expect(await kept(contentId)).toEqual([]);
      expect(await shows(contentId, '', PNG)).toEqual([200, 'image/png', true]);
      expect(await shows(contentId, 2, GIF)).toEqual([200, 'image/gif', true]);
      expect(refusal(await get(`/content/${contentId}/raw/3`))).toEqual(NO_IMAGE);
      expect(ok(await get(`/content/${contentId}`), 200).images).toHaveLength(2);

      // An update before the first write is applied: the post is read as the newest write has it.
      ctx.clock.now += 1000;
      ok(await send(alice, [png, webp, gif], { contentId }), 200);
      expect(await pending()).toEqual(['1 post', '1 post_file 2', '2 post', '2 post_file 2', '2 post_file 3']);
      expect(await staged()).toHaveLength(5);
      expect(await shows(contentId, 2, WEBP)).toEqual([200, 'image/webp', true]);
      expect(await shows(contentId, 3, GIF)).toEqual([200, 'image/gif', true]);

      // The run applies the newest, and deletes the rows and the staged files of both.
      await ctx.compactor.runOnce();
      expect(await pending()).toEqual([]);
      expect(await staged()).toEqual([]);
      expect(await kept(contentId)).toEqual([contentId, `${contentId}.2`, `${contentId}.3`, `${contentId}.meta.json`]);
      expect(await shows(contentId, 2, WEBP)).toEqual([200, 'image/webp', true]);
      expect(await shows(contentId, 3, GIF)).toEqual([200, 'image/gif', true]);

      // An update with fewer: the images it leaves out are gone to readers at once, and from the store once it is applied.
      ctx.clock.now += 1000;
      ok(await send(alice, [png, jpeg()], { contentId }), 200);
      expect(await shows(contentId, 2, JPEG)).toEqual([200, 'image/jpeg', true]);
      expect(refusal(await get(`/content/${contentId}/raw/3`))).toEqual(NO_IMAGE);
      expect(await kept(contentId)).toHaveLength(4);
      await ctx.apply();
      expect(await kept(contentId)).toEqual([contentId, `${contentId}.2`, `${contentId}.meta.json`]);
      expect(await shows(contentId, 2, JPEG)).toEqual([200, 'image/jpeg', true]);

      // A post deleted before its write is applied: nothing of it is written, and what it staged goes.
      const other = ok(await send(alice, [png, gif, webp])).contentId;
      expect(await staged()).toHaveLength(3);
      ok(await ctx.app.inject({ method: 'DELETE', url: `/content/${other}`, payload: alice }), 202);
      ok(await ctx.app.inject({ method: 'DELETE', url: `/content/${contentId}`, payload: alice }), 202);
      expect((await ctx.compactor.runOnce()).deleted.sort()).toEqual([contentId, other].sort());
      expect(await staged()).toEqual([]);
      expect([...(await kept(contentId)), ...(await kept(other))]).toEqual([]);
    });

    it('attests how many images a post has, and links a repost of an album on another server to each of them there', async () => {
      const other = 'https://other.example';
      const address = `${other}/content/3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b`;
      const [key] = signingKeys([Buffer.alloc(32, 1).toString('base64')]) as [SigningKey];
      const keyFetcher = async () => ({ keys: [{ id: key.id, publicKey: key.publicKey, algorithm: 'ed25519' }] });
      ctx = await createTestContext(target, { publicBaseUrl: 'https://api.example.com', reposts: { signingKeys: [Buffer.alloc(32, 3).toString('base64')] }, keyFetcher });
      const alice = await ctx.register('alice');

      // Its own album: the attestation says how many images there are, and of a post of one image, nothing.
      const album = ok(await send(alice, [png, gif, webp], { text: 'Three' })).contentId;
      const one = ok(await send(alice, [png])).contentId;
      const attested = async (contentId: string) => readAttestation(ok(await get(`/content/${contentId}/attestation`), 200).attestation)!.payload as { preview: unknown };
      expect((await attested(album)).preview).toEqual({ kind: 'image', text: 'Three', imageCount: 3 });
      expect((await attested(one)).preview).toEqual({ kind: 'image' });

      // An album on another server, reposted here: a link to it, whose images are read there, each at its place.
      const publisher = { userId: '11111111-1111-4111-8111-111111111111', username: 'Dana' };
      const attestation = attest(key, { url: address, publisher, mimeType: 'image/png', aiGenerated: false, preview: { kind: 'image', text: 'Two of theirs', imageCount: 2 } }, ctx.clock.now);
      const res = ok(await ctx.app.inject({ method: 'POST', url: '/repost', payload: { ...alice, origin: { attestation }, tags: ['pics'] } }));
      const preview = { kind: 'image', url: `${address}/raw`, text: 'Two of theirs', imageCount: 2 };
      expect(res.preview).toEqual(preview);
      const read = ok(await get(`/content/${res.contentId}`), 200);
      expect(read.preview).toEqual(preview);
      // The images aren't this server's to list: the preview says how many there are, and where the first is.
      expect(read).not.toHaveProperty('images');
      const sentTo = async (place: string) => {
        const raw = await get(`/content/${res.contentId}/raw${place}`);
        return [raw.statusCode, raw.headers.location];
      };
      expect(await sentTo('')).toEqual([302, `${address}/raw`]);
      expect(await sentTo('/1')).toEqual([302, `${address}/raw`]);
      expect(await sentTo('/2')).toEqual([302, `${address}/raw/2`]);
      expect(refusal(await get(`/content/${res.contentId}/raw/3`))).toEqual(NO_IMAGE);
      await ctx.compact();
      expect((await feedItems(ctx, 'pics')).find((item) => item.contentId === res.contentId)!.preview).toEqual(preview);
    });

    it('writes down each file of a multipart post in the audit log, and not the files', async () => {
      ctx = await createTestContext(target, { audit: true });
      const alice = await ctx.register('alice');
      ok(await send(alice, [png, gif]));
      // A while later: records of one moment are in no order of their own.
      ctx.clock.now += 1000;
      ok(await send(alice, [png]));

      const [album, one] = (await readAudit(ctx)).filter((r) => r.route === '/store');
      const described = [
        { filename: 'pixel.png', mimeType: 'image/png', size: PNG.length },
        { filename: 'anim.gif', mimeType: 'image/gif', size: GIF.length },
      ];
      expect(album!.body).toMatchObject({ multipart: true, file: described[0], files: described });
      expect(one!.body).toMatchObject({ multipart: true, file: described[0] });
      expect(one!.body).not.toHaveProperty('files');
      expect(JSON.stringify(album)).not.toContain(GIF.toString('base64'));
    });

    it('deletes what a write staged if one of its images cannot be staged, and leaves the post as it was', async () => {
      ctx = await createTestContext(target, { maxUploadBytes: 1000 });
      const alice = await ctx.register('alice');
      const stage = ctx.content.stageFile.bind(ctx.content);
      let calls = 0;
      vi.spyOn(ctx.content, 'stageFile').mockImplementation(async (...args) => {
        if (++calls === 3) throw new Error('the store is down');
        return stage(...args);
      });

      expect((await send(alice, [png, gif, webp])).statusCode).toBe(500);
      expect(await staged()).toEqual([]);
      expect(await pending()).toEqual([]);
      expect(await ctx.db.selectFrom('content').select('id').execute()).toEqual([]);
    });
  });
}
