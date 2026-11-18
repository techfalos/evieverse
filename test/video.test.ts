import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { masterPlaylist, probeVideo, renditionSizes } from '../src/video/ffmpeg.js';
import { createVideoWorker } from '../src/video/worker.js';
import { as, createTestContext, feedItems, multipart, sha256, TARGETS, type FilePart, type TestContext, type User } from './helpers.js';

/** Whether this machine has the ffmpeg the server processes videos with: the tests that process one are skipped where it hasn't. */
const FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const TOOLS = { ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' };

/** What the test videos say of themselves, which nothing the server publishes may: where they were filmed, and what they are called. */
const PLACE = '+48.8584+002.2945/';
const TITLE = 'Holiday with the family';

describe('video renditions', () => {
  it('makes a video at each of the sizes it is large enough for, by its shorter side, and at its own if it is smaller than all', () => {
    const heights = [1080, 720, 480, 240];
    expect(renditionSizes({ width: 1920, height: 1080 }, heights)).toEqual([1080, 720, 480, 240]);
    // Filmed upright: it is as large as its width.
    expect(renditionSizes({ width: 720, height: 1280 }, heights)).toEqual([720, 480, 240]);
    expect(renditionSizes({ width: 640, height: 361 }, heights)).toEqual([240]);
    // Smaller than the smallest, with a side that is odd: its own size, made even.
    expect(renditionSizes({ width: 320, height: 181 }, heights)).toEqual([180]);
    expect(renditionSizes({ width: 3840, height: 2160 }, [720])).toEqual([720]);
  });

  it('lists the renditions in the master playlist, each with its bitrate and its size', () => {
    const rendition = (short: number, width: number, bitrate: number) => ({ short, name: `${short}p`, path: '', width, height: short, size: 1, bitrate });
    expect(masterPlaylist([rendition(720, 1280, 2_928_000), rendition(240, 426, 528_000)]).split('\n')).toEqual([
      '#EXTM3U',
      '#EXT-X-VERSION:6',
      '#EXT-X-INDEPENDENT-SEGMENTS',
      '#EXT-X-STREAM-INF:BANDWIDTH=2928000,RESOLUTION=1280x720',
      '720p.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=528000,RESOLUTION=426x240',
      '240p.m3u8',
      '',
    ]);
  });
});

/**
 * Videos as the server processes them (src/video): a post's, and a comment's. With ffmpeg, which
 * the tests make their videos with too.
 */
for (const target of TARGETS) {
  describe.skipIf(!FFMPEG)(`video processing (${target.name})`, () => {
    let ctx: TestContext;
    /** Where the test videos are made. */
    let made: string;
    /** A phone's clip: a MOV of 320x240, two seconds, with sound, which says where it was filmed and what it is called. */
    let CLIP: Buffer;
    /** Another, of another picture: an MP4 of 240x320, filmed upright. */
    let OTHER: Buffer;
    /** A file that says it is a video, and is a playlist that names a file of the server's. */
    const PLAYLIST = Buffer.from('#EXTM3U\n#EXTINF:1,\n/etc/passwd\n#EXT-X-ENDLIST\n');

    beforeAll(() => {
      made = mkdtempSync(join(tmpdir(), 'evieverse-video-'));
      const ffmpeg = (...args: string[]) => execFileSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args]);
      const encode = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac'];
      ffmpeg(
        ...['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2'],
        ...encode,
        ...['-metadata', `title=${TITLE}`, '-metadata', `location=${PLACE}`, '-metadata', `com.apple.quicktime.location.ISO6709=${PLACE}`, '-metadata', 'creation_time=2026-01-01T10:00:00Z'],
        ...['-movflags', 'use_metadata_tags', '-f', 'mov', join(made, 'clip.mov')],
      );
      ffmpeg(...['-f', 'lavfi', '-i', 'testsrc2=size=240x320:rate=15:duration=1'], ...encode, ...['-metadata', `title=${TITLE}`, '-f', 'mp4', join(made, 'other.mp4')]);
      CLIP = readFileSync(join(made, 'clip.mov'));
      OTHER = readFileSync(join(made, 'other.mp4'));
    });
    afterAll(() => rmSync(made, { recursive: true, force: true }));
    afterEach(async () => {
      // Nothing is left of the folders videos were processed in, nor of the files a request spooled.
      expect(await readdir(join(ctx.dir, 'tmp')).catch(() => [])).toEqual([]);
      await ctx.close();
    });

    const start = async (opts: Parameters<typeof createTestContext>[1] = {}) => {
      ctx = await createTestContext(target, { video: { processing: true, heights: [240, 144], commentHeight: 144 }, ...opts });
    };
    const ok = (res: LightMyRequestResponse, status = 201) => {
      expect(res.statusCode, res.body).toBe(status);
      return res.json();
    };
    const refusal = (res: LightMyRequestResponse) => [res.statusCode, res.json().error];
    const clip = (data = CLIP, name = 'clip.mov', type = 'video/quicktime'): FilePart => ({ name, type, data });
    /** POST /store with a video as the form's file. */
    const send = (user: User, file: FilePart, fields: Record<string, string> = {}) => {
      const mp = multipart({ ...user, type: 'video', tags: 'clips', ...fields }, file);
      return ctx.app.inject({ method: 'POST', url: '/store', payload: mp.payload, headers: mp.headers });
    };
    const get = (url: string, user?: User) => ctx.app.inject({ method: 'GET', url, ...(user && { headers: as(user) }) });
    const read = async (contentId: string) => ok(await get(`/content/${contentId}`), 200);
    const inbox = async (user: User) => ok(await get(`/users/${user.userId}/inbox`, user), 200).inbox.map((m: Record<string, unknown>) => [m.kind, m.contentId, m.excerpt ?? null]);
    const staged = async () => (await readdir(join(ctx.dir, 'content', 'staged')).catch(() => [])).sort();
    /** The versions of a post's video whose poster and stream the content store holds. */
    const versions = async (contentId: string) => (await readdir(join(ctx.dir, 'content', 'media', contentId)).catch(() => [])).sort();
    const files = async (contentId: string, videoId: string) => (await readdir(join(ctx.dir, 'content', 'media', contentId, videoId)).catch(() => [])).sort();
    const jobs = async () => (await ctx.db.selectFrom('media_jobs').select('id').execute()).length;
    /** What ffprobe says of bytes the server served: written to a file first, as it reads files. */
    const probe = async (bytes: Buffer, name: string) => {
      const path = join(made, name);
      await writeFile(path, bytes);
      return probeVideo(TOOLS, path);
    };
    /** Whether bytes say anything of what the test videos say of themselves. */
    const tells = (bytes: Buffer) => bytes.includes(PLACE) || bytes.includes(TITLE);
    const NOT_READY = [404, 'the video is still being processed: it is there to read once the post no longer says processing'];
    const NO_FILE = [404, 'the post has no such video file'];

    it('publishes a video once it is processed: an MP4 without its metadata, with a poster and a stream at each size', async () => {
      await start();
      const alice = await ctx.register('alice');
      expect(tells(CLIP)).toBe(true);

      const sent = ok(await send(alice, clip(), { text: 'At the tower' }));
      const { contentId } = sent;
      expect(sent).toMatchObject({ processing: true, preview: { kind: 'video', url: `/content/${contentId}/raw`, text: 'At the tower' } });

      // Until it is processed it is read by its id, as written, and nothing of the file that was sent is served.
      expect(await read(contentId)).toMatchObject({ processing: true, mimeType: 'video/quicktime', preview: { kind: 'video', url: `/content/${contentId}/raw`, text: 'At the tower' } });
      expect(refusal(await get(`/content/${contentId}/raw`))).toEqual(NOT_READY);
      // The compactor leaves it, and the rows that put it in feeds, however often it runs.
      await ctx.compact();
      await ctx.compact();
      expect(await feedItems(ctx, 'clips')).toEqual([]);
      expect(await ctx.content.getMeta(contentId)).toBeNull();
      expect(await staged()).toHaveLength(1);
      expect(await jobs()).toBe(1);

      expect(await ctx.processVideo()).toBe(true);
      expect(await ctx.processVideo()).toBe(false);
      expect(await jobs()).toBe(0);
      // The file as it was sent is gone, and the folder it was processed in.
      expect(await staged()).toEqual([]);

      const post = await read(contentId);
      expect(post).not.toHaveProperty('processing');
      const { video } = post.preview;
      expect(post).toMatchObject({
        mimeType: 'video/mp4',
        contentUrl: `/content/${contentId}/raw`,
        preview: {
          kind: 'video',
          url: `/content/${contentId}/raw`,
          text: 'At the tower',
          video: { id: video.id, width: 320, height: 240, poster: `/content/${contentId}/video/${video.id}/poster.jpg`, hls: `/content/${contentId}/video/${video.id}/master.m3u8` },
        },
      });
      expect(video.duration).toBeCloseTo(2, 0);
      // The hash is of the file as it was sent: that file again is no update.
      expect(await ctx.content.getMeta(contentId)).toMatchObject({ sha256: sha256(CLIP), mimeType: 'video/mp4', size: post.size });
      expect((await send(alice, clip(), { contentId, text: 'At the tower' })).json()).toEqual({ contentId, unchanged: true });

      // The post's bytes: an MP4 of H.264 and AAC that says nothing of where it is from.
      const raw = await get(`/content/${contentId}/raw`);
      expect([raw.statusCode, raw.headers['content-type'], raw.rawPayload.length]).toEqual([200, 'video/mp4', post.size]);
      expect(tells(raw.rawPayload)).toBe(false);
      const mp4 = await probe(raw.rawPayload, 'served.mp4');
      expect(mp4).toMatchObject({ width: 320, height: 240, audio: true });
      expect(Object.keys(mp4.tags).filter((tag) => /title|location|creation|date|make|model|comment/.test(tag))).toEqual([]);
      // Its index is at its start, so it plays as it downloads.
      expect(raw.rawPayload.indexOf('moov')).toBeLessThan(raw.rawPayload.indexOf('mdat'));

      // The stream: a master playlist, a playlist for each size, and their segments.
      expect(await files(contentId, video.id)).toEqual(['144p.m3u8', '144p_00000.ts', '240p.m3u8', '240p_00000.ts', 'master.m3u8', 'poster.jpg']);
      const file = (name: string) => get(`/content/${contentId}/video/${video.id}/${name}`);
      const master = await file('master.m3u8');
      expect([master.statusCode, master.headers['content-type'], master.headers['cache-control']]).toEqual([200, 'application/vnd.apple.mpegurl', 'public, max-age=86400']);
      expect(master.body.split('\n').filter((line) => line && !line.startsWith('#'))).toEqual(['240p.m3u8', '144p.m3u8']);
      expect(master.body).toMatch(/RESOLUTION=320x240\n240p\.m3u8\n.*RESOLUTION=192x144\n144p\.m3u8/s);
      const playlist = await file('240p.m3u8');
      expect(playlist.statusCode).toBe(200);
      expect(playlist.body).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
      expect(playlist.body.split('\n').filter((line) => line && !line.startsWith('#'))).toEqual(['240p_00000.ts']);
      const segment = await file('240p_00000.ts');
      expect([segment.statusCode, segment.headers['content-type'], segment.headers['x-content-type-options']]).toEqual([200, 'video/mp2t', 'nosniff']);
      expect(tells(segment.rawPayload)).toBe(false);
      expect(await probe(segment.rawPayload, 'served.ts')).toMatchObject({ width: 320, height: 240, audio: true });

      // The poster: a JPEG, which says nothing either.
      const poster = await file('poster.jpg');
      expect([poster.statusCode, poster.headers['content-type']]).toEqual([200, 'image/jpeg']);
      expect(poster.rawPayload.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
      expect(tells(poster.rawPayload)).toBe(false);

      // Only a video's files are read, by their names, of the version the post has.
      expect(refusal(await file('720p.m3u8'))).toEqual(NO_FILE);
      expect(refusal(await file('240p_00001.ts'))).toEqual(NO_FILE);
      expect(refusal(await get(`/content/${contentId}/video/00000000-0000-4000-8000-000000000001/master.m3u8`))).toEqual(NO_FILE);
      for (const name of ['source', 'poster.png', '..%2F..%2Fcontent', 'master.m3u8.bak', '240p_0.ts']) expect((await file(name)).statusCode, name).toBe(400);

      // And it is in feeds, as it is read.
      await ctx.compact();
      expect((await feedItems(ctx, 'clips')).map((item) => item.preview)).toEqual([post.preview]);
    });

    it('keeps the video a post has until an update with another is processed, and then deletes what was made of the old one', async () => {
      await start();
      const alice = await ctx.register('alice');
      const { contentId } = ok(await send(alice, clip()));
      await ctx.processVideo();
      const first = (await read(contentId)).preview.video;
      const before = (await get(`/content/${contentId}/raw`)).rawPayload;

      // Another caption with the same file: the post keeps the video it has, and nothing is made again.
      ctx.clock.now += 1000;
      expect(ok(await send(alice, clip(), { contentId, text: 'Again' }), 200)).toMatchObject({ processing: true });
      expect(await ctx.processVideo()).toBe(true);
      expect(await read(contentId)).toMatchObject({ text: 'Again', mimeType: 'video/mp4', preview: { text: 'Again', video: first } });
      expect(await read(contentId)).not.toHaveProperty('processing');
      expect(await versions(contentId)).toEqual([first.id]);
      expect((await get(`/content/${contentId}/raw`)).rawPayload.equals(before)).toBe(true);
      expect(await staged()).toEqual([]);

      // Another video, of any type: while it is processed, the post says so and its bytes are the ones it had.
      ctx.clock.now += 1000;
      expect(ok(await send(alice, clip(OTHER, 'other.mp4', 'video/mp4'), { contentId, text: 'Upright' }), 200)).toMatchObject({ processing: true });
      expect(await read(contentId)).toMatchObject({ processing: true, text: 'Upright' });
      expect((await get(`/content/${contentId}/raw`)).rawPayload.equals(before)).toBe(true);
      expect((await get(first.poster)).statusCode).toBe(200);

      expect(await ctx.processVideo()).toBe(true);
      const next = (await read(contentId)).preview.video;
      expect(next.id).not.toBe(first.id);
      // Filmed upright: made at the sizes its shorter side has, and shown upright.
      expect(next).toMatchObject({ width: 240, height: 320 });
      expect(next.duration).toBeCloseTo(1, 0);
      expect(await files(contentId, next.id)).toEqual(['144p.m3u8', '144p_00000.ts', '240p.m3u8', '240p_00000.ts', 'master.m3u8', 'poster.jpg']);
      expect(await versions(contentId)).toEqual([next.id]);
      expect(refusal(await get(first.poster))).toEqual(NO_FILE);
      expect((await get(`/content/${contentId}/raw`)).rawPayload.equals(before)).toBe(false);

      // Deleted, the post takes all of it along.
      ok(await ctx.app.inject({ method: 'DELETE', url: `/content/${contentId}`, payload: alice }), 202);
      await ctx.compact();
      expect(await versions(contentId)).toEqual([]);
      expect(await readdir(join(ctx.dir, 'content', 'content')).catch(() => [])).toEqual([]);
    });

    it('gives up a file that is no video: a new post is deleted, an update keeps the video it had, and the publisher is told', async () => {
      await start();
      const alice = await ctx.register('alice');

      // A playlist that names a file of the server's is no video, whatever it says it is: nothing it names is read.
      const bad = ok(await send(alice, clip(PLAYLIST, 'clip.mp4', 'video/mp4'), { text: 'Not a video' }));
      expect(await ctx.processVideo()).toBe(true);
      expect((await get(`/content/${bad.contentId}`)).statusCode).toBe(404);
      expect(await inbox(alice)).toEqual([['video_failed', bad.contentId, 'Not a video']]);
      expect(await jobs()).toBe(0);
      await ctx.compact();
      expect(await ctx.db.selectFrom('content').select('id').execute()).toEqual([]);
      expect(await staged()).toEqual([]);
      expect(await versions(bad.contentId)).toEqual([]);

      const { contentId } = ok(await send(alice, clip(), { text: 'A video' }));
      await ctx.processVideo();
      const had = await read(contentId);
      ctx.clock.now += 1000;
      ok(await send(alice, clip(Buffer.from('a few bytes'), 'clip.mp4', 'video/mp4'), { contentId, text: 'With a caption that is new', tags: 'clips travel' }), 200);
      expect(await ctx.processVideo()).toBe(true);
      // Everything else the update said is made.
      const kept = await read(contentId);
      expect(kept).not.toHaveProperty('processing');
      expect(kept).toMatchObject({ text: 'With a caption that is new', tags: ['clips', 'travel'], mimeType: 'video/mp4', size: had.size, preview: { video: had.preview.video } });
      expect((await get(`/content/${contentId}/raw`)).headers['content-length']).toBe(String(had.size));
      expect((await get(had.preview.video.hls)).statusCode).toBe(200);
      expect((await inbox(alice))[0]).toEqual(['video_update_failed', contentId, 'With a caption that is new']);
      expect(await staged()).toEqual([]);
      expect(await jobs()).toBe(0);
      // The file it has is still the one it was made from.
      expect((await send(alice, clip(), { contentId, text: 'With a caption that is new', tags: 'clips travel' })).json()).toEqual({ contentId, unchanged: true });
    });

    it('processes the newest of a post\'s writes only, and gives a job back that it could not finish', async () => {
      await start();
      const alice = await ctx.register('alice');
      const { contentId } = ok(await send(alice, clip()));
      ctx.clock.now += 1000;
      ok(await send(alice, clip(OTHER, 'other.mp4', 'video/mp4'), { contentId }), 200);
      expect(await jobs()).toBe(2);

      // The first write is superseded: its job is dropped, with nothing made.
      expect(await ctx.processVideo()).toBe(true);
      expect(await jobs()).toBe(1);
      expect(await versions(contentId)).toEqual([]);
      expect(await read(contentId)).toMatchObject({ processing: true });

      // A worker that has no ffmpeg fails, which is nothing the video did: the job waits, and is taken again later.
      const broken = createVideoWorker({ ...ctx, config: { ...ctx.config, video: { ...ctx.config.video, ffmpegPath: join(made, 'no-ffmpeg') } } }, pino({ level: 'silent' }));
      await expect(broken.check()).rejects.toThrow(/ffmpeg was not found .*VIDEO_PROCESSING=false/s);
      expect(await broken.runOnce()).toBe(true);
      expect(await jobs()).toBe(1);
      expect(await ctx.processVideo()).toBe(false);
      ctx.clock.now += 60_000;

      expect(await ctx.processVideo()).toBe(true);
      expect(await read(contentId)).toMatchObject({ mimeType: 'video/mp4', preview: { video: { width: 240, height: 320 } } });
      expect(await versions(contentId)).toHaveLength(1);
      // Both files that were sent are gone.
      expect(await staged()).toEqual([]);
    });

    it('processes the video of a comment: one MP4, published with the comment once it is made', async () => {
      await start();
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const { contentId } = ok(await ctx.app.inject({ method: 'POST', url: '/store', payload: { ...alice, type: 'text', text: 'Say something #talk', tags: ['talk'], comments: true } }));
      const comment = (fields: Record<string, string>, file: FilePart) => {
        const form = multipart(fields, file);
        return ctx.app.inject({ method: 'POST', url: `/content/${contentId}/comments`, payload: form.payload, headers: { ...form.headers, ...as(bob) } });
      };
      const list = async () => ok(await get(`/content/${contentId}/comments`), 200).comments.map((c: { text: string; media?: unknown }) => [c.text, c.media ?? null]);
      const one = (commentId: string) => get(`/content/${contentId}/comments/${commentId}`);

      const sent = ok(await comment({ text: 'Look at this' }, clip()));
      const { commentId } = sent;
      expect(sent).toMatchObject({ processing: true, media: { kind: 'video', mimeType: 'video/quicktime' } });
      expect(ok(await one(commentId), 200)).toMatchObject({ processing: true, text: 'Look at this' });
      expect(refusal(await get(`/content/${contentId}/comments/${commentId}/raw`))).toEqual(NOT_READY);
      await ctx.compact();
      expect(await list()).toEqual([]);

      expect(await ctx.processVideo()).toBe(true);
      const ready = ok(await one(commentId), 200);
      expect(ready).not.toHaveProperty('processing');
      expect(ready.media).toMatchObject({ kind: 'video', mimeType: 'video/mp4' });
      expect(await list()).toEqual([['Look at this', ready.media]]);
      const raw = await get(`/content/${contentId}/comments/${commentId}/raw`);
      expect([raw.statusCode, raw.headers['content-type'], raw.rawPayload.length]).toEqual([200, 'video/mp4', ready.media.size]);
      expect(tells(raw.rawPayload)).toBe(false);
      // No larger than a comment's video is made: 144 pixels high here.
      expect(await probe(raw.rawPayload, 'comment.mp4')).toMatchObject({ width: 192, height: 144, audio: true });
      expect(await staged()).toEqual([]);

      // One that can't be processed is published with its text alone, and one that was only its video not at all.
      const worded = ok(await comment({ text: 'And this' }, clip(PLAYLIST, 'clip.mp4', 'video/mp4')));
      const bare = ok(await comment({}, clip(Buffer.from('nothing much'), 'clip.mp4', 'video/mp4')));
      expect(await ctx.processVideo()).toBe(true);
      expect(await ctx.processVideo()).toBe(true);
      expect(await ctx.processVideo()).toBe(false);
      expect(await list()).toEqual([
        ['Look at this', ready.media],
        ['And this', null],
      ]);
      expect(ok(await one(worded.commentId), 200)).not.toHaveProperty('processing');
      expect((await one(bare.commentId)).statusCode).toBe(404);
      // Its author is told of each, in whichever order they were processed.
      const told = (await inbox(bob)).map(([kind, , excerpt]: [string, string, string | null]) => `${kind}: ${excerpt}`).sort();
      expect(told).toEqual(['comment_video_failed: And this', 'comment_video_failed: null']);
      expect(await staged()).toEqual([]);
      expect(await jobs()).toBe(0);
    });
  });

  describe(`videos as they are sent (${target.name})`, () => {
    let ctx: TestContext;
    afterEach(() => ctx.close());

    it('stores and serves a video as it was sent where the server processes none', async () => {
      ctx = await createTestContext(target, { video: { processing: false } });
      const alice = await ctx.register('alice');
      const bytes = Buffer.from('a video, as far as anyone checks');
      const mp = multipart({ ...alice, type: 'video', tags: 'clips' }, { name: 'clip.mp4', type: 'video/mp4', data: bytes });
      const res = await ctx.app.inject({ method: 'POST', url: '/store', payload: mp.payload, headers: mp.headers });
      expect(res.statusCode, res.body).toBe(201);
      const { contentId } = res.json();
      expect(res.json()).not.toHaveProperty('processing');
      expect(res.json().preview).toEqual({ kind: 'video', url: `/content/${contentId}/raw` });
      expect((await ctx.app.inject({ method: 'GET', url: `/content/${contentId}/raw` })).rawPayload.equals(bytes)).toBe(true);
      expect(await ctx.db.selectFrom('media_jobs').select('id').execute()).toEqual([]);
      expect(await ctx.processVideo()).toBe(false);
    });
  });
}
