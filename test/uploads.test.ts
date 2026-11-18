import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Operator } from 'opendal';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { as, createTestContext, PNG, requests, sha256, TARGETS, type TestContext, type User } from './helpers.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

for (const target of TARGETS) {
  describe(`uploads (${target.name})`, () => {
    let ctx: TestContext;
    afterEach(async () => {
      vi.restoreAllMocks();
      await ctx.close();
    });

    const { store } = requests(() => ctx);
    const askLink = (user: User, body: Record<string, unknown>) => ctx.app.inject({ method: 'POST', url: '/uploads', payload: { ...user, ...body } });
    /** What a client does with an upload link: puts the file in the content store, here a directory. */
    const put = async (user: User, uploadId: string, bytes: Buffer) => {
      const dir = join(ctx.dir, 'content', 'uploads', user.userId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, uploadId), bytes);
    };
    const uploads = (user: User) => readdir(join(ctx.dir, 'content', 'uploads', user.userId)).catch(() => []);
    const raw = (contentId: string) => ctx.app.inject({ method: 'GET', url: `/content/${contentId}/raw` });
    const meta = (contentId: string) => ctx.content.getMeta(contentId);
    /** The files kept under content/: each post's bytes and its meta file. */
    const kept = async () => (await readdir(join(ctx.dir, 'content', 'content'))).sort();
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    /** A video's or audio's bytes are stored as they came, whatever they are. An image's aren't: see images.test.ts. */
    const CLIP = Buffer.from('a video, as far as anyone checks');

    it('gives a link to send a file straight to the content store, to its user alone and for files it would store', async () => {
      // Signing a link needs no connection, so a bucket that isn't there will do.
      const s3 = { bucket: 'media', region: 'us-east-1', endpoint: 'https://s3.example.com', access_key_id: 'key', secret_access_key: 'secret', disable_config_load: 'true', disable_ec2_metadata: 'true' };
      ctx = await createTestContext(target, { content: { scheme: 's3', options: s3 }, maxUploadBytes: 1000, uploadLinksPerMinute: 2 });
      const alice = await ctx.register('alice');

      const res = await askLink(alice, { type: 'image', filename: 'pixel.png', size: PNG.length });
      expect(res.statusCode, res.body).toBe(201);
      const { uploadId, upload, expiresAt, maxBytes } = res.json();
      expect(uploadId).toMatch(UUID);
      expect(upload.method).toBe('PUT');
      const url = new URL(upload.url);
      expect(url.host).toBe('s3.example.com');
      expect(url.pathname).toBe(`/media/uploads/${alice.userId}/${uploadId}`);
      expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
      expect(url.searchParams.get('X-Amz-Expires')).toBe(String(ctx.config.storage.content.signedUrlSeconds));
      expect(upload.headers).toEqual({ 'content-type': 'image/png' });
      expect(Date.parse(expiresAt)).toBe(ctx.clock.now + ctx.config.storage.content.signedUrlSeconds * 1000);
      expect(maxBytes).toBe(1000);

      // Refused before anything is sent: what /store would refuse once it was.
      expect((await askLink(alice, { type: 'image', filename: 'notes.pdf', contentType: 'application/pdf', size: 10 })).statusCode).toBe(400);
      expect((await askLink(alice, { type: 'text', size: 10 })).statusCode).toBe(400);
      expect((await askLink(alice, { type: 'video', filename: 'clip.mp4', size: 1001 })).statusCode).toBe(413);
      expect((await askLink(alice, { type: 'video', filename: 'clip.mp4' })).statusCode).toBe(400);
      expect((await askLink({ userId: alice.userId, apiKey: 'ev_wrong' }, { type: 'image', filename: 'pixel.png', size: 10 })).statusCode).toBe(401);
      // Each link is room in the bucket, so a user gets only so many a minute. Credentials go in headers too.
      const second = await ctx.app.inject({ method: 'POST', url: '/uploads', headers: as(alice), payload: { type: 'audio', contentType: 'audio/mpeg', size: 10 } });
      expect(second.statusCode, second.body).toBe(201);
      expect(second.json().upload.headers).toEqual({ 'content-type': 'audio/mpeg' });
      const third = await askLink(alice, { type: 'image', filename: 'pixel.png', size: 10 });
      expect(third.statusCode).toBe(429);
      expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
      expect((await askLink(await ctx.register('bob'), { type: 'image', filename: 'pixel.png', size: 10 })).statusCode).toBe(201);
    });

    it('gives no link for a file of a type of post the server has turned off', async () => {
      const s3 = { bucket: 'media', region: 'us-east-1', endpoint: 'https://s3.example.com', access_key_id: 'key', secret_access_key: 'secret', disable_config_load: 'true', disable_ec2_metadata: 'true' };
      ctx = await createTestContext(target, { content: { scheme: 's3', options: s3 }, postTypes: { video: false, audio: false } });
      const alice = await ctx.register('alice');
      expect((await askLink(alice, { type: 'image', filename: 'pixel.png', size: PNG.length })).statusCode).toBe(201);
      for (const [type, filename] of [['video', 'clip.mp4'], ['audio', 'song.mp3']]) {
        const res = await askLink(alice, { type, filename, size: 10 });
        expect([res.statusCode, res.json().error]).toEqual([400, `this server doesn't take ${type} posts: the types it takes are image, text, link`]);
      }
      // Only to a user, as ever.
      expect((await askLink({ userId: alice.userId, apiKey: 'ev_wrong' }, { type: 'video', filename: 'clip.mp4', size: 10 })).statusCode).toBe(401);
    });

    it('gives no link where the content store signs none: files then go in the request to /store', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const res = await askLink(alice, { type: 'image', filename: 'pixel.png', size: PNG.length });
      expect(res.statusCode, res.body).toBe(501);
    });

    it('stores an uploaded file by its uploadId, recording the bytes as stored, and then drops the upload', async () => {
      ctx = await createTestContext(target, { publicBaseUrl: 'https://api.example.com' });
      const alice = await ctx.register('alice');
      await put(alice, id(1), CLIP);

      const res = await store(alice, { type: 'video', uploadId: id(1), filename: 'clip.mp4', text: 'One clip', tags: ['clips'] });
      expect(res.statusCode, res.body).toBe(201);
      const { contentId } = res.json();
      expect(res.json().preview).toEqual({ kind: 'video', url: `https://api.example.com/content/${contentId}/raw`, text: 'One clip' });
      const bytes = await raw(contentId);
      expect(bytes.rawPayload.equals(CLIP)).toBe(true);
      expect(bytes.headers['content-type']).toBe('video/mp4');
      expect(bytes.headers['content-length']).toBe(String(CLIP.length));
      // The row says whose the post is; what it is, is in the meta file beside its bytes.
      expect(await ctx.db.selectFrom('content').selectAll().where('id', '=', contentId).executeTakeFirstOrThrow()).toEqual({
        id: contentId,
        user_id: alice.userId,
        ai_generated: 0,
        like_count: 0,
        unliked_at: null,
        created_at: ctx.clock.now,
        delete_requested_at: null,
        origin_hash: null,
        origin_gone_at: null,
        origin_check_at: null,
        seq: 1,
      });
      expect(await meta(contentId)).toEqual({
        contentId,
        mimeType: 'video/mp4',
        size: CLIP.length,
        aiGenerated: false,
        comments: false,
        preview: res.json().preview,
        text: 'One clip',
        tags: ['clips'],
        updatedAt: ctx.clock.now,
      });
      expect(await kept()).toEqual([contentId, `${contentId}.meta.json`]);
      expect(await uploads(alice)).toEqual([]);
      // An upload is stored once.
      expect((await store(alice, { type: 'video', uploadId: id(1), filename: 'clip.mp4', tags: ['clips'] })).statusCode).toBe(400);

      // The server never read the file, which the content store copied itself, so the meta file above has no
      // hash of it: a video or audio file sent this way is written over the post's, whether it is the same file or not.
      ctx.clock.now += 1000;
      await put(alice, id(2), CLIP);
      const same = await store(alice, { contentId, type: 'video', uploadId: id(2), filename: 'clip.mp4', text: 'One clip', tags: ['clips'] });
      expect(same.statusCode, same.body).toBe(200);
      expect(same.json()).not.toHaveProperty('unchanged');
      expect(await meta(contentId)).toMatchObject({ size: CLIP.length, updatedAt: ctx.clock.now });
      expect(await uploads(alice)).toEqual([]);
      const other = Buffer.concat([CLIP, Buffer.from('more')]);
      await put(alice, id(3), other);
      const next = await store(alice, { contentId, type: 'video', uploadId: id(3), filename: 'clip.mp4', text: 'One clip', tags: ['clips'] });
      expect(next.statusCode, next.body).toBe(200);
      expect(await meta(contentId)).toMatchObject({ size: other.length });
      const updated = await raw(contentId);
      expect(updated.rawPayload.equals(other)).toBe(true);
      expect(updated.headers['content-length']).toBe(String(other.length));
      expect(await kept()).toEqual([contentId, `${contentId}.meta.json`]);

      // Sent in a request, the file is hashed, and told from then on. Sent with a link after that, it is stored
      // again, and the hash goes: it would be of bytes the server didn't see stored.
      const inline = { contentId, type: 'video', content: CLIP.toString('base64'), contentEncoding: 'base64', contentType: 'video/mp4', text: 'One clip', tags: ['clips'] };
      expect((await store(alice, inline)).json()).not.toHaveProperty('unchanged');
      expect(await meta(contentId)).toMatchObject({ sha256: sha256(CLIP) });
      expect((await store(alice, inline)).json()).toEqual({ contentId, unchanged: true });
      await put(alice, id(4), CLIP);
      const linked = await store(alice, { contentId, type: 'video', uploadId: id(4), filename: 'clip.mp4', text: 'One clip', tags: ['clips'] });
      expect(linked.json()).not.toHaveProperty('unchanged');
      expect(await meta(contentId)).not.toHaveProperty('sha256');
      expect(await uploads(alice)).toEqual([]);
    });

    it('refuses an upload that is missing, empty, too large, another user’s or not what the post says', async () => {
      ctx = await createTestContext(target, { maxUploadBytes: 100 });
      const alice = await ctx.register('alice');
      const mallory = await ctx.register('mallory');
      const image = (user: User, uploadId: string, extra: Record<string, unknown> = {}) => store(user, { type: 'image', uploadId, filename: 'pixel.png', tags: ['pics'], ...extra });

      const missing = await image(alice, id(1));
      expect(missing.statusCode).toBe(400);
      expect(missing.json().error).toMatch(/upload not found/);

      await put(alice, id(2), PNG);
      expect((await image(mallory, id(2))).statusCode).toBe(400);
      expect((await image({ userId: alice.userId, apiKey: 'ev_wrong' }, id(2))).statusCode).toBe(401);
      expect((await store(alice, { type: 'text', text: 'words #pics', uploadId: id(2), tags: ['pics'] })).statusCode).toBe(400);
      expect((await image(alice, id(2), { content: PNG.toString('base64'), contentEncoding: 'base64' })).statusCode).toBe(400);
      // A directory keeps no content types, so the type comes from the request: here from neither.
      const untyped = await store(alice, { type: 'image', uploadId: id(2), tags: ['pics'] });
      expect(untyped.json().error).toMatch(/image posts take image\/\* files, got application\/octet-stream/);
      // None of which used the upload up.
      expect(await uploads(alice)).toEqual([id(2)]);
      expect((await image(alice, id(2), { filename: undefined, contentType: 'image/png' })).statusCode).toBe(201);

      await put(alice, id(3), Buffer.alloc(0));
      expect((await image(alice, id(3))).json().error).toBe('content is empty');
      await put(alice, id(4), Buffer.alloc(101));
      expect((await image(alice, id(4))).statusCode).toBe(413);
      expect(await uploads(alice)).toEqual([id(3)]);
    });

    it('records and limits what it stored, not what it first saw, when the upload is replaced meanwhile', async () => {
      ctx = await createTestContext(target, { maxUploadBytes: 100 });
      const alice = await ctx.register('alice');
      const swapped = Buffer.concat([CLIP, Buffer.from('swapped')]);
      const adopt = ctx.content.adoptUpload.bind(ctx.content);
      // Whoever holds the link can use it again, up to the moment the upload is stored.
      const replaceWith = (bytes: Buffer) =>
        vi.spyOn(ctx.content, 'adoptUpload').mockImplementationOnce(async (...args) => {
          await put(alice, args[1], bytes);
          return adopt(...args);
        });

      await put(alice, id(1), CLIP);
      replaceWith(swapped);
      const res = await store(alice, { type: 'video', uploadId: id(1), filename: 'clip.mp4', tags: ['clips'] });
      expect(res.statusCode, res.body).toBe(201);
      const { contentId } = res.json();
      expect(await meta(contentId)).toMatchObject({ size: swapped.length });
      expect((await raw(contentId)).rawPayload.equals(swapped)).toBe(true);

      await put(alice, id(2), CLIP);
      replaceWith(Buffer.alloc(101));
      const large = await store(alice, { type: 'video', uploadId: id(2), filename: 'clip.mp4', tags: ['clips'] });
      expect(large.statusCode, large.body).toBe(413);
      expect(await ctx.db.selectFrom('content').select('id').execute()).toEqual([{ id: contentId }]);
      // Nothing of the refused post is kept under content/.
      expect(await kept()).toEqual([contentId, `${contentId}.meta.json`]);
    });

    it('stores an upload through the server where the content store can’t copy it, with the same checks', async () => {
      ctx = await createTestContext(target, { maxUploadBytes: 100 });
      const alice = await ctx.register('alice');
      const { op } = ctx.content as unknown as { op: Operator };
      vi.spyOn(op, 'copy').mockRejectedValue(new Error('Unsupported'));

      await put(alice, id(1), CLIP);
      const res = await store(alice, { type: 'video', uploadId: id(1), filename: 'clip.mp4', tags: ['clips'] });
      expect(res.statusCode, res.body).toBe(201);
      const { contentId } = res.json();
      expect(await meta(contentId)).toMatchObject({ size: CLIP.length });
      expect((await raw(contentId)).rawPayload.equals(CLIP)).toBe(true);
      expect(await uploads(alice)).toEqual([]);

      // Replaced by a larger file after it was first seen.
      await put(alice, id(2), CLIP);
      const adopt = ctx.content.adoptUpload.bind(ctx.content);
      vi.spyOn(ctx.content, 'adoptUpload').mockImplementationOnce(async (...args) => {
        await put(alice, id(2), Buffer.alloc(101));
        return adopt(...args);
      });
      expect((await store(alice, { type: 'video', uploadId: id(2), filename: 'clip.mp4', tags: ['clips'] })).statusCode).toBe(413);
      expect(await kept()).toEqual([contentId, `${contentId}.meta.json`]);
    });

    it('keeps an upload for a request the limit on posts a minute refused, to be sent again', async () => {
      ctx = await createTestContext(target, { postRateLimitPerMinute: 1 });
      const alice = await ctx.register('alice');
      expect((await store(alice, { type: 'text', text: 'first #pics', tags: ['pics'] })).statusCode).toBe(201);

      await put(alice, id(1), PNG);
      const post = { type: 'image', uploadId: id(1), filename: 'pixel.png', tags: ['pics'] };
      const limited = await store(alice, post);
      expect(limited.statusCode).toBe(429);
      expect(await uploads(alice)).toEqual([id(1)]);
      ctx.clock.now += 60_000;
      const sent = await store(alice, post);
      expect(sent.statusCode, sent.body).toBe(201);
      expect(await uploads(alice)).toEqual([]);
    });
  });
}
