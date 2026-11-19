import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { setAdmin } from '../src/moderation/policy.js';
import { loadTrustPlugins } from '../src/moderation/trust.js';
import { pdqHash, toHex } from '../src/plugins/trust/pdq/hash.js';
import { framesOf } from '../src/plugins/trust/pdq/image.js';
import { pdq } from '../src/plugins/trust/pdq/index.js';
import { DAY } from '../src/time.js';
import { as, createTestContext, multipart, sha256, TARGETS, type FilePart, type TestContext, type User } from './helpers.js';

/** Whether this machine has the ffmpeg the server processes videos with: the tests that process one are skipped where it hasn't. */
const FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

/**
 * A picture of soft light and dark patches, as a photo out of focus has, 320 by 240: a grey for
 * each pixel. `seed` chooses the patches: another seed is another picture.
 */
function grey(seed: number, cols = 320, rows = 240, block = 20): Buffer {
  const corner = (i: number, j: number) => {
    let h = (Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(seed, 83492791)) >>> 0;
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35) >>> 0;
    h ^= h >>> 16;
    return h >>> 24;
  };
  const pixels = Buffer.alloc(rows * cols);
  for (let y = 0; y < rows; y++) {
    const [j, fy] = [Math.floor(y / block), y % block];
    for (let x = 0; x < cols; x++) {
      const [i, fx] = [Math.floor(x / block), x % block];
      pixels[y * cols + x] = Math.floor(
        (corner(i, j) * (block - fx) * (block - fy) + corner(i + 1, j) * fx * (block - fy) + corner(i, j + 1) * (block - fx) * fy + corner(i + 1, j + 1) * fx * fy) / (block * block),
      );
    }
  }
  return pixels;
}
const drawn = (seed: number) => sharp(grey(seed), { raw: { width: 320, height: 240, channels: 1 } });
const png = (seed: number) => drawn(seed).png().toBuffer();
/** The picture as a copy of it goes round: at another size, and compressed until it shows. */
const copy = (seed: number, width = 200, quality = 60) => drawn(seed).resize({ width }).jpeg({ quality }).toBuffer();
/** The picture on the list, and one that isn't. */
const [LISTED, OTHER] = [1, 2];
/** Two hashes that are on the list beside the picture's, of nothing the tests send: half their bits are set, as a PDQ hash's are. */
const FILLERS = ['0f'.repeat(32), '33'.repeat(32)];

describe('QUARANTINE_SCHEME and the other settings of the quarantine', () => {
  const load = (env: Record<string, string>) => loadConfig({}, { EVIEVERSE_CONFIG: '/nonexistent', ...env }).quarantine;

  it('are no store, and a year, unless set', () => {
    expect(load({})).toEqual({ retentionDays: 365 });
    expect(load({ QUARANTINE_SCHEME: 's3', QUARANTINE_OPTIONS: '{"bucket":"held","region":"eu-west-1"}', QUARANTINE_RETENTION_DAYS: '400' })).toEqual({
      scheme: 's3',
      options: { bucket: 'held', region: 'eu-west-1' },
      retentionDays: 400,
    });
  });

  it('refuse the store of anything else: the posts, the summaries or the audit log', () => {
    const shared = /the quarantine needs a store of its own/;
    expect(() => load({ QUARANTINE_SCHEME: 'fs', QUARANTINE_OPTIONS: '{"root":"./data/content"}' })).toThrow(shared);
    expect(() => load({ CONTENT_SCHEME: 's3', CONTENT_OPTIONS: '{"bucket":"posts","region":"x"}', QUARANTINE_SCHEME: 's3', QUARANTINE_OPTIONS: '{"region":"x","bucket":"posts"}' })).toThrow(shared);
    expect(() => load({ SUMMARY_SCHEME: 'fs', SUMMARY_OPTIONS: '{"root":"/data/summaries"}', QUARANTINE_SCHEME: 'fs', QUARANTINE_OPTIONS: '{"root":"/data/summaries/"}' })).toThrow(shared);
    expect(() => load({ AUDIT_SCHEME: 'fs', AUDIT_OPTIONS: '{"root":"/data/audit"}', QUARANTINE_SCHEME: 'fs', QUARANTINE_OPTIONS: '{"root":"/data/audit"}' })).toThrow(shared);
    expect(load({ AUDIT_SCHEME: 'fs', AUDIT_OPTIONS: '{"root":"/data/audit"}', QUARANTINE_SCHEME: 'fs', QUARANTINE_OPTIONS: '{"root":"/data/quarantine"}' }).scheme).toBe('fs');
  });
});

for (const target of TARGETS) {
  /** What the tests of this file share: a list with the picture's hash on it, and a server that runs the plugin with it. */
  const shared = () => {
    const state = { dir: '', list: '', hash: '' };
    beforeAll(async () => {
      state.dir = mkdtempSync(join(tmpdir(), 'evieverse-quarantine-'));
      // The picture's hash, as the plugin itself reads and hashes it.
      const picture = join(state.dir, 'listed.png');
      await writeFile(picture, await png(LISTED));
      for await (const { luma, rows, cols } of framesOf(picture)) state.hash = toHex(pdqHash(luma, rows, cols).words);
      state.list = join(state.dir, 'pdq.txt');
      await writeFile(state.list, [state.hash, ...FILLERS, ''].join('\n'));
    });
    afterAll(() => rmSync(state.dir, { recursive: true, force: true }));
    return state;
  };
  const answer = (res: LightMyRequestResponse) => [res.statusCode, res.json()];
  const ok = (res: LightMyRequestResponse, status = 200) => {
    expect(res.statusCode, res.body).toBe(status);
    return res.json();
  };
  type Notice = { kind: string; contentId?: string; excerpt?: string; details?: Record<string, string | number>; text: string };

  describe(`the quarantine (${target.name})`, () => {
    let ctx: TestContext;
    const state = shared();
    afterEach(() => ctx.close());

    /** A server that runs the plugin with the test's list, and keeps what matches unless `quarantine` is false. */
    const server = async (opts: Parameters<typeof createTestContext>[1] = {}) => {
      ctx = await createTestContext(target, { quarantine: true, ...opts, pdq: { hashList: state.list }, trustPlugins: [...(await loadTrustPlugins()), { name: 'pdq', ...pdq() }] });
    };
    const admin = async (name = 'root') => {
      const user = await ctx.register(name);
      await setAdmin(ctx.db, name, true);
      return user;
    };
    const sendImage = (user: User, data: Buffer, name = 'holiday.jpg', headers: Record<string, string> = {}) => {
      const form = multipart({ ...user, type: 'image', tags: 'pics' }, { name, type: 'image/jpeg', data });
      return ctx.app.inject({ method: 'POST', url: '/store', remoteAddress: '203.0.113.9', payload: form.payload, headers: { ...form.headers, ...headers } });
    };
    const inbox = async (user: User): Promise<Notice[]> => (ok(await ctx.app.inject({ method: 'GET', url: `/users/${user.userId}/inbox`, headers: as(user) })).inbox as Notice[]).reverse();
    const get = (url: string, user?: User) => ctx.app.inject({ method: 'GET', url, remoteAddress: '198.51.100.7', headers: { 'user-agent': 'AdminClient/2.0', ...(user && as(user)) } });
    /** The files the quarantine's store holds. */
    const kept = async () => (await readdir(join(ctx.dir, 'quarantine', 'files')).catch(() => [])).sort();
    const access = async (id: string) => (await ctx.db.selectFrom('quarantine_access').select(['action', 'user_id', 'ip']).where('quarantine_id', '=', id).orderBy('created_at').execute()).map((a) => [a.action, a.user_id, a.ip]);
    const NOT_TRUSTED = { error: "this server doesn't trust the post enough to keep it, so it wasn't published" };
    const ADMIN_ONLY = { error: 'only an admin can do this' };
    const NO_ITEM = { error: 'the quarantine has no such file' };

    it('keeps a file that matches, once, where only an admin reads it, and records each time one does', async () => {
      await server();
      const root = await admin();
      const alice = await ctx.register('alice');
      const bytes = await copy(LISTED);

      expect(answer(await sendImage(alice, bytes, 'holiday.jpg', { 'user-agent': 'TestClient/1.0' }))).toEqual([422, NOT_TRUSTED]);
      // Nothing of it is a post, or among the posts' files.
      expect(await ctx.db.selectFrom('content').select('id').execute()).toEqual([]);
      expect(await readdir(join(ctx.dir, 'content', 'content')).catch(() => [])).toEqual([]);

      // The admin is told where the file is kept, and what to do with it.
      const [notice] = await inbox(root);
      const { details } = notice!;
      const id = String(details!.quarantineId);
      expect(notice).toMatchObject({ kind: 'csam_match_refused', details: { userId: alice.userId, username: 'alice', listed: state.hash, ip: '203.0.113.9', outcome: 'refused' } });
      expect(notice!.text).toContain("An image that alice sent matches this server's list of hashes of known child sexual abuse material. It was refused");
      expect(notice!.text).toMatch(
        new RegExp(
          ` The file is kept in this server's quarantine, as ${id}, where only an admin can read it: GET /moderation/quarantine/${id}/file gives it to you, to send with a report\\. Once you have made the report, record it with POST /moderation/quarantine/${id}/report: .* Until a report is recorded it is not deleted\\.$`,
        ),
      );
      // Who sent it is told nothing of it.
      expect(await inbox(alice)).toEqual([]);

      // The file is kept as the server read it, which is without its metadata: it is the one the notice's SHA-256 is of.
      expect(await kept()).toEqual([id]);
      const file = await readFile(join(ctx.dir, 'quarantine', 'files', id));
      expect(sha256(file)).toBe(details!.sha256);

      // Sent again, it is the same item, counted; another copy of the picture is another file.
      ctx.clock.now += 1000;
      expect((await sendImage(alice, bytes, 'again.jpg')).statusCode).toBe(422);
      expect(await kept()).toEqual([id]);
      ctx.clock.now += 1000;
      expect((await sendImage(alice, await copy(LISTED, 300, 80))).statusCode).toBe(422);
      expect(await kept()).toHaveLength(2);

      // Only an admin is answered: not who sent it, and nobody without a key.
      for (const url of ['/moderation/quarantine', `/moderation/quarantine/${id}`, `/moderation/quarantine/${id}/file`]) {
        expect(answer(await get(url, alice)), url).toEqual([403, ADMIN_ONLY]);
        expect((await get(url)).statusCode, url).toBe(401);
      }
      expect(answer(await ctx.app.inject({ method: 'POST', url: `/moderation/quarantine/${id}/report`, payload: { ...alice } }))).toEqual([403, ADMIN_ONLY]);
      expect(answer(await ctx.app.inject({ method: 'DELETE', url: `/moderation/quarantine/${id}`, headers: as(alice) }))).toEqual([403, ADMIN_ONLY]);

      // The list, newest first, without the files.
      const { items, nextCursor } = ok(await get('/moderation/quarantine', root));
      expect(nextCursor).toBeNull();
      expect(items).toHaveLength(2);
      const { quarantineId: _, ...facts } = details!;
      expect(items[1]).toEqual({
        quarantineId: id,
        userId: alice.userId,
        sha256: details!.sha256,
        mimeType: 'image/jpeg',
        size: file.length,
        matches: 2,
        storedAt: details!.at,
        lastMatchedAt: new Date(ctx.clock.now - 1000).toISOString(),
        facts,
        report: null,
      });
      expect(ok(await get('/moderation/quarantine?reported=false&limit=1', root)).items).toHaveLength(1);
      expect(ok(await get('/moderation/quarantine?reported=true', root)).items).toEqual([]);

      // The file itself, as bytes to save, which nothing shows or keeps.
      const read = await get(`/moderation/quarantine/${id}/file`, root);
      expect(read.statusCode, read.body).toBe(200);
      expect(read.rawPayload.equals(file)).toBe(true);
      expect(read.headers).toMatchObject({
        'content-type': 'application/octet-stream',
        'content-length': String(file.length),
        'content-disposition': `attachment; filename="${details!.sha256}.bin"`,
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
      });
      expect(read.headers).not.toHaveProperty('content-encoding');

      // Each reading of it is in the item's log, with who read it and from where.
      const item = ok(await get(`/moderation/quarantine/${id}`, root));
      expect(item).toMatchObject({ quarantineId: id, matches: 2, report: null });
      expect(item.access).toEqual([
        { action: 'downloaded', by: root.userId, ip: '198.51.100.7', userAgent: 'AdminClient/2.0', at: new Date(ctx.clock.now).toISOString() },
        { action: 'stored', by: null, ip: null, userAgent: null, at: details!.at },
      ]);
      expect(answer(await get(`/moderation/quarantine/${alice.userId}`, root))).toEqual([404, NO_ITEM]);
      expect(answer(await get(`/moderation/quarantine/${alice.userId}/file`, root))).toEqual([404, NO_ITEM]);
    });

    it('keeps a reported file for its time after the report, and deletes it then', async () => {
      await server();
      const root = await admin();
      const alice = await ctx.register('alice');
      expect((await sendImage(alice, await copy(LISTED))).statusCode).toBe(422);
      const [id] = await kept();
      const storedAt = ctx.clock.now;
      const report = (payload: Record<string, unknown>) => ctx.app.inject({ method: 'POST', url: `/moderation/quarantine/${id}/report`, remoteAddress: '198.51.100.7', payload: { ...root, ...payload } });

      // A file nobody reported stays, however long.
      await ctx.compact(400 * DAY);
      expect(await kept()).toEqual([id]);

      // A report's time is neither before the file was kept nor yet to come.
      const REPORT_TIME = { error: 'the time of a report is no earlier than when the file was kept, and no later than now' };
      expect(answer(await report({ reportedAt: new Date(storedAt - 1).toISOString() }))).toEqual([400, REPORT_TIME]);
      expect(answer(await report({ reportedAt: new Date(ctx.clock.now + 60_000).toISOString() }))).toEqual([400, REPORT_TIME]);

      const reportedAt = ctx.clock.now;
      const reported = ok(await report({ reportId: 'CT-123456' }));
      expect(reported).toMatchObject({
        quarantineId: id,
        report: { reportedAt: new Date(reportedAt).toISOString(), reportedBy: root.userId, reportId: 'CT-123456', deleteAfter: new Date(reportedAt + 365 * DAY).toISOString() },
      });
      expect(ok(await get('/moderation/quarantine?reported=true', root)).items).toMatchObject([{ quarantineId: id, report: { reportId: 'CT-123456' } }]);
      expect(ok(await get('/moderation/quarantine?reported=false', root)).items).toEqual([]);
      // It is no admin's to delete any more.
      expect(answer(await ctx.app.inject({ method: 'DELETE', url: `/moderation/quarantine/${id}`, headers: as(root) }))).toEqual([
        409,
        { error: "a report of the file was recorded, so it is kept for its time and can't be deleted before" },
      ]);

      // Kept for the year, and deleted once it is over: the file, and what the server knew of it, but not the log.
      await ctx.compact(364 * DAY);
      expect(await kept()).toEqual([id]);
      await ctx.compact(2 * DAY);
      expect(await kept()).toEqual([]);
      expect(await ctx.db.selectFrom('quarantine').select('id').execute()).toEqual([]);
      expect(answer(await get(`/moderation/quarantine/${id}`, root))).toEqual([404, NO_ITEM]);
      expect(await access(id!)).toEqual([
        ['stored', null, null],
        ['reported', root.userId, '198.51.100.7'],
        ['expired', null, null],
      ]);
    });

    it('keeps a reported file for as long as the server is set to', async () => {
      await server({ quarantine: { retentionDays: 30 } });
      const root = await admin();
      expect((await sendImage(await ctx.register('alice'), await copy(LISTED))).statusCode).toBe(422);
      const [id] = await kept();
      const reportedAt = new Date(ctx.clock.now).toISOString();
      ctx.clock.now += 5 * DAY;
      // Recorded later than it was made, with when it was.
      const reported = ok(await ctx.app.inject({ method: 'POST', url: `/moderation/quarantine/${id}/report`, payload: { ...root, reportedAt } }));
      expect(reported.report).toEqual({ reportedAt, reportedBy: root.userId, deleteAfter: new Date(Date.parse(reportedAt) + 30 * DAY).toISOString() });
      await ctx.compact(24 * DAY);
      expect(await kept()).toEqual([id]);
      await ctx.compact(2 * DAY);
      expect(await kept()).toEqual([]);
    });

    it('deletes a file that was never reported when an admin says it is not what the list took it for', async () => {
      await server();
      const root = await admin();
      expect((await sendImage(await ctx.register('alice'), await copy(LISTED))).statusCode).toBe(422);
      const [id] = await kept();
      const dismissed = await ctx.app.inject({ method: 'DELETE', url: `/moderation/quarantine/${id}`, remoteAddress: '198.51.100.7', headers: as(root) });
      expect(dismissed.statusCode, dismissed.body).toBe(204);
      expect(await kept()).toEqual([]);
      expect(ok(await get('/moderation/quarantine', root)).items).toEqual([]);
      expect(answer(await get(`/moderation/quarantine/${id}/file`, root))).toEqual([404, NO_ITEM]);
      // That it was there, and who deleted it, is still known.
      expect(await access(id!)).toEqual([
        ['stored', null, null],
        ['dismissed', root.userId, '198.51.100.7'],
      ]);
    });

    it('is off unless the server names a store for it: a file that matches is refused, and nothing of it is kept', async () => {
      await server({ quarantine: false });
      const root = await admin();
      expect(answer(await sendImage(await ctx.register('alice'), await copy(LISTED)))).toEqual([422, NOT_TRUSTED]);
      const [notice] = await inbox(root);
      expect(notice!.details).not.toHaveProperty('quarantineId');
      expect(notice!.text).not.toContain('quarantine');
      expect(await kept()).toEqual([]);
      expect(await ctx.db.selectFrom('quarantine').select('id').execute()).toEqual([]);
      expect(answer(await get('/moderation/quarantine', root))).toEqual([404, NO_ITEM]);
    });

    it('leaves a picture that is not on the list alone', async () => {
      await server();
      await admin();
      expect((await sendImage(await ctx.register('alice'), await copy(OTHER))).statusCode).toBe(201);
      expect(await kept()).toEqual([]);
    });
  });

  describe.skipIf(!FFMPEG)(`videos of known child sexual abuse material (${target.name})`, () => {
    let ctx: TestContext;
    const state = shared();
    /** A video that shows the listed picture for three seconds, and one of another picture. */
    let LISTED_CLIP: Buffer;
    let OTHER_CLIP: Buffer;
    /** A video that shows another picture for three seconds, and then the listed one for three. */
    let LATER_CLIP: Buffer;

    beforeAll(async () => {
      const ffmpeg = (...args: string[]) => execFileSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args]);
      const encode = ['-r', '15', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];
      const still = (seed: number) => ['-loop', '1', '-t', '3', '-i', join(state.dir, `${seed}.png`)];
      for (const seed of [LISTED, OTHER]) writeFileSync(join(state.dir, `${seed}.png`), await png(seed));
      ffmpeg(...still(LISTED), ...encode, join(state.dir, 'listed.mp4'));
      ffmpeg(...still(OTHER), ...encode, join(state.dir, 'other.mp4'));
      ffmpeg(...still(OTHER), ...still(LISTED), '-filter_complex', '[0:v][1:v]concat=n=2:v=1[v]', '-map', '[v]', ...encode, join(state.dir, 'later.mp4'));
      LISTED_CLIP = readFileSync(join(state.dir, 'listed.mp4'));
      OTHER_CLIP = readFileSync(join(state.dir, 'other.mp4'));
      LATER_CLIP = readFileSync(join(state.dir, 'later.mp4'));
    });
    afterEach(async () => {
      // Nothing is left of the folders videos were processed in.
      expect(await readdir(join(ctx.dir, 'tmp')).catch(() => [])).toEqual([]);
      await ctx.close();
    });

    /** A server that processes videos and runs the plugin, as its settings say, with the test's list. */
    const server = async (opts: Parameters<typeof createTestContext>[1] = {}) => {
      ctx = await createTestContext(target, {
        quarantine: true,
        video: { processing: true, heights: [240, 144], commentHeight: 144 },
        trust: { optionalPlugins: ['pdq'] },
        pdq: { hashList: state.list },
        trustPlugins: [...(await loadTrustPlugins()), { name: 'pdq', ...pdq() }],
        ...opts,
      });
    };
    const admin = async () => {
      const user = await ctx.register('root');
      await setAdmin(ctx.db, 'root', true);
      return user;
    };
    const clip = (data: Buffer, name = 'clip.mp4'): FilePart => ({ name, type: 'video/mp4', data });
    const send = (user: User, file: FilePart, fields: Record<string, string> = {}) => {
      const form = multipart({ ...user, type: 'video', tags: 'clips', ...fields }, file);
      return ctx.app.inject({ method: 'POST', url: '/store', remoteAddress: '203.0.113.9', payload: form.payload, headers: { ...form.headers, 'user-agent': 'TestClient/1.0' } });
    };
    const get = (url: string, user?: User) => ctx.app.inject({ method: 'GET', url, ...(user && { headers: as(user) }) });
    const inbox = async (user: User): Promise<Notice[]> => (ok(await get(`/users/${user.userId}/inbox`, user)).inbox as Notice[]).reverse();
    const kept = async () => (await readdir(join(ctx.dir, 'quarantine', 'files')).catch(() => [])).sort();
    const staged = async () => (await readdir(join(ctx.dir, 'content', 'staged')).catch(() => [])).sort();
    const media = async (contentId: string) => (await readdir(join(ctx.dir, 'content', 'media', contentId)).catch(() => [])).sort();
    const jobs = async () => ctx.db.selectFrom('media_jobs').select(['attempts', 'client_ip', 'client_user_agent']).execute();

    it('are refused once the video is processed: the post is deleted, the admins are told, and the file is kept as it was sent', async () => {
      await server();
      const root = await admin();
      const alice = await ctx.register('alice');

      const sentAt = ctx.clock.now;
      const { contentId } = ok(await send(alice, clip(LISTED_CLIP, 'holiday.mp4'), { text: 'At the beach' }), 201);
      // Who sent it waits with the job, for the notice.
      expect(await jobs()).toEqual([{ attempts: 0, client_ip: '203.0.113.9', client_user_agent: 'TestClient/1.0' }]);
      ctx.clock.now += 30_000;
      expect(await ctx.processVideo()).toBe(true);

      // Nothing of it is published, and nothing of it is left among the posts' files.
      expect((await get(`/content/${contentId}`)).statusCode).toBe(404);
      expect(await staged()).toEqual([]);
      expect(await media(contentId)).toEqual([]);
      expect(await jobs()).toEqual([]);
      await ctx.compact();
      expect(await ctx.db.selectFrom('content').select('id').execute()).toEqual([]);

      // Its publisher is told that it wasn't trusted, and not why.
      expect(await inbox(alice)).toMatchObject([{ kind: 'video_refused', contentId, text: "This server doesn't trust the video of your post enough to keep it. The post was not published, and was deleted." }]);

      // The admin is told as of an image, with when and from where it was sent, and where in the video the picture is.
      const [notice, ...more] = await inbox(root);
      expect(more).toEqual([]);
      const { details } = notice!;
      expect(notice).toMatchObject({
        kind: 'csam_video_refused',
        contentId,
        details: {
          userId: alice.userId,
          username: 'alice',
          listed: state.hash,
          at: new Date(sentAt).toISOString(),
          ip: '203.0.113.9',
          userAgent: 'TestClient/1.0',
          sentAs: 'post',
          contentId,
          mimeType: 'video/mp4',
          sha256: sha256(LISTED_CLIP),
          media: 'video',
          seconds: 0,
          frame: 0,
          outcome: 'refused',
        },
      });
      expect(details!.distance).toBeLessThanOrEqual(31);
      expect(notice!.text).toContain(`A video that alice sent matches this server's list of hashes of known child sexual abuse material: the picture it shows 0 seconds in. It was refused`);
      expect(notice!.text).toContain(`The file is kept in this server's quarantine, as ${details!.quarantineId}`);

      // The file as it was sent is what is kept, for the admin to read.
      const id = String(details!.quarantineId);
      expect(await kept()).toEqual([id]);
      const read = await get(`/moderation/quarantine/${id}/file`, root);
      expect(read.rawPayload.equals(LISTED_CLIP)).toBe(true);
      expect(ok(await get(`/moderation/quarantine/${id}`, root))).toMatchObject({ mimeType: 'video/mp4', size: LISTED_CLIP.length, sha256: sha256(LISTED_CLIP), facts: { media: 'video' } });
    });

    it('are found wherever in the video the picture is, and a video without it is published', async () => {
      await server();
      const root = await admin();
      const alice = await ctx.register('alice');

      const fine = ok(await send(alice, clip(OTHER_CLIP), { text: 'Fine' }), 201);
      expect(await ctx.processVideo()).toBe(true);
      expect(ok(await get(`/content/${fine.contentId}`))).not.toHaveProperty('processing');
      expect(await inbox(root)).toEqual([]);
      expect(await kept()).toEqual([]);
      // Nothing is kept of who sent it once it is processed.
      expect(await jobs()).toEqual([]);

      ctx.clock.now += 1000;
      const later = ok(await send(alice, clip(LATER_CLIP), { text: 'Later' }), 201);
      expect(await ctx.processVideo()).toBe(true);
      expect((await get(`/content/${later.contentId}`)).statusCode).toBe(404);
      const [notice] = await inbox(root);
      expect(notice).toMatchObject({ kind: 'csam_video_refused', details: { media: 'video', sentAs: 'post', sha256: sha256(LATER_CLIP) } });
      // The first of the pictures that are checked, one every two seconds, to show it.
      expect(notice!.details!.seconds).toBe(4);
      expect(await kept()).toHaveLength(1);
    });

    it('are refused as an update, which leaves the post the video it had, and with a comment, which is not published', async () => {
      await server();
      const root = await admin();
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');

      const { contentId } = ok(await send(alice, clip(OTHER_CLIP), { text: 'A video', comments: 'true' }), 201);
      expect(await ctx.processVideo()).toBe(true);
      const had = ok(await get(`/content/${contentId}`));
      ctx.clock.now += 1000;
      ok(await send(alice, clip(LISTED_CLIP), { contentId, text: 'A video', comments: 'true' }), 200);
      expect(await ctx.processVideo()).toBe(true);
      const has = ok(await get(`/content/${contentId}`));
      expect(has).not.toHaveProperty('processing');
      expect(has).toMatchObject({ size: had.size, preview: { video: had.preview.video } });
      expect((await inbox(alice)).map(({ kind }) => kind)).toEqual(['video_update_refused']);
      expect(await inbox(root)).toMatchObject([{ kind: 'csam_video_refused', contentId, details: { username: 'alice', sentAs: 'update', contentId } }]);

      // With a comment: nothing of the comment is published, its text neither, as with an image that matches.
      ctx.clock.now += 1000;
      const form = multipart({ text: 'Look at this' }, clip(LISTED_CLIP));
      const { commentId } = ok(await ctx.app.inject({ method: 'POST', url: `/content/${contentId}/comments`, remoteAddress: '203.0.113.77', payload: form.payload, headers: { ...form.headers, ...as(bob) } }), 201);
      expect(await ctx.processVideo()).toBe(true);
      expect((await get(`/content/${contentId}/comments/${commentId}`)).statusCode).toBe(404);
      expect(ok(await get(`/content/${contentId}/comments`)).comments).toEqual([]);
      expect(await inbox(bob)).toMatchObject([{ kind: 'comment_video_refused', contentId, excerpt: 'Look at this' }]);
      expect((await inbox(root))[1]).toMatchObject({ kind: 'csam_video_refused', details: { username: 'bob', sentAs: 'comment', contentId, ip: '203.0.113.77', sha256: sha256(LISTED_CLIP) } });
      // The same file from two users is two items.
      expect(await kept()).toHaveLength(2);
      expect(await staged()).toEqual([]);
      expect(await jobs()).toEqual([]);
    });

    it('wait unpublished while there is no list to check them against, without that counting against the video', async () => {
      const missing = join(state.dir, 'not-there-yet.txt');
      await server({ pdq: { hashList: missing } });
      const alice = await ctx.register('alice');
      const { contentId } = ok(await send(alice, clip(OTHER_CLIP)), 201);
      for (let tries = 0; tries < 5; tries++) {
        expect(await ctx.processVideo()).toBe(true);
        expect(ok(await get(`/content/${contentId}`))).toMatchObject({ processing: true });
        expect((await jobs()).map(({ attempts }) => attempts)).toEqual([0]);
        ctx.clock.now += 61_000;
      }
      expect(await inbox(alice)).toEqual([]);
      // Once the list is there, the video is checked and published.
      await writeFile(missing, [state.hash, ...FILLERS, ''].join('\n'));
      try {
        expect(await ctx.processVideo()).toBe(true);
        expect(ok(await get(`/content/${contentId}`))).not.toHaveProperty('processing');
      } finally {
        rmSync(missing, { force: true });
      }
    });

    it('are not checked on a server that does not run the plugin, which keeps nothing of who sent a video', async () => {
      await server({ trust: {}, trustPlugins: undefined });
      const alice = await ctx.register('alice');
      const { contentId } = ok(await send(alice, clip(LISTED_CLIP)), 201);
      expect(await jobs()).toEqual([{ attempts: 0, client_ip: null, client_user_agent: null }]);
      expect(await ctx.processVideo()).toBe(true);
      expect(ok(await get(`/content/${contentId}`))).not.toHaveProperty('processing');
      expect(await kept()).toEqual([]);
    });
  });
}
