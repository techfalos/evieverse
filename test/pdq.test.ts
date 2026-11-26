import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { setAdmin } from '../src/moderation/policy.js';
import { as, BASE_ENV, createTestContext, multipart, requests, sha256, TARGETS, type TestContext, type User } from './helpers.js';

/**
 * A picture to hash: `rows` by `cols` of soft light and dark patches, as a photo out of focus has,
 * each about `block` across. `seed` chooses the patches: another seed is another picture.
 */
type Picture = { rows: number; cols: number; seed: number; block: number };

/**
 * Pictures, each with the hash and quality that Meta's reference implementation of PDQ gives its
 * pixels (the pdqhash binding of pdq/cpp, which hashes an image at the size it is given). The
 * plugin is the server's own (compactor/crates/trust/src/plugins/pdq), whose tests cover how it
 * hashes a picture, reads a list and finds a hash in one: here is what a server does with it.
 */
const REFERENCE: (Picture & { hash: string; quality: number })[] = [
  { rows: 240, cols: 320, seed: 1, block: 20, hash: '286c319d7379a2467424a3467379799de8ec4bbb981bc672d1e25af2d3121e29', quality: 100 },
  { rows: 150, cols: 200, seed: 2, block: 10, hash: 'c32f04edc31f7c7829b79d603a264cdbef0caa828b39f70650562b5b0786b93c', quality: 100 },
  { rows: 64, cols: 64, seed: 3, block: 8, hash: '903601703aaf0162280da2bb2c8b2ffb9e341ffc8eff2ebb680f41603be70f78', quality: 100 },
  { rows: 480, cols: 640, seed: 1, block: 40, hash: '28ec319c7379a2467424a2467379719de8ec4bbbb81b4672d3e25ef2d3121e29', quality: 100 },
  { rows: 333, cols: 517, seed: 4, block: 23, hash: '730c20fe24be630cb742e2e979cb5c94a8bfab5277501c782c6d97aac9e44a2e', quality: 100 },
];
/** The picture that stands in for one on the list, another picture, and a third that is on the list too. */
const [LISTED, OTHER, , , ALSO_LISTED] = REFERENCE as [(typeof REFERENCE)[0], (typeof REFERENCE)[0], unknown, unknown, (typeof REFERENCE)[0]];
/** A list as an operator would have it: comments, a header, and the hashes one a line or in a column. */
const LIST = ['# Hashes of known material', 'id,pdq,added', LISTED.hash, `"2","${ALSO_LISTED.hash.toUpperCase()}","2026-11-06"`, ''].join('\r\n');

/**
 * The picture's pixels: a grey from 0 to 255 for each, a row after another. Every `block` pixels
 * along and down there is a grey that `seed` chooses, and the pixels between four of them are
 * between their greys. In whole numbers alone, so that it is the same picture wherever it is drawn.
 */
function grey({ rows, cols, seed, block }: Picture): Buffer {
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
    const j = Math.floor(y / block);
    const fy = y % block;
    for (let x = 0; x < cols; x++) {
      const i = Math.floor(x / block);
      const fx = x % block;
      pixels[y * cols + x] = Math.floor(
        (corner(i, j) * (block - fx) * (block - fy) + corner(i + 1, j) * fx * (block - fy) + corner(i, j + 1) * (block - fx) * fy + corner(i + 1, j + 1) * fx * fy) / (block * block),
      );
    }
  }
  return pixels;
}

/** The picture as sharp reads it, to write as a file of any type. */
const drawn = (picture: Picture) => sharp(grey(picture), { raw: { width: picture.cols, height: picture.rows, channels: 1 } });
const png = (picture: Picture) => drawn(picture).png().toBuffer();
/** The picture as a copy of it goes round: at another size, and compressed until it shows. */
const copy = (picture: Picture, width = 200, quality = 60) => drawn(picture).resize({ width }).jpeg({ quality }).toBuffer();

/** How many bits two hashes, as they are written, differ in. */
function apart(a: string, b: string): number {
  let bits = 0;
  for (let i = 0; i < 64; i++) {
    for (let differ = Number.parseInt(a[i]!, 16) ^ Number.parseInt(b[i]!, 16); differ; differ >>= 1) bits += differ & 1;
  }
  return bits;
}

describe('PDQ_HASH_LIST and the other settings of the pdq trust plugin', () => {
  const load = (env: Record<string, string>) => loadConfig({}, { ...BASE_ENV, ...env }).pdq;

  it('are no list, 31 bits, a quality of 50 and an hour, unless set', () => {
    expect(load({})).toEqual({ maxDistance: 31, minQuality: 50, refreshMinutes: 60 });
    expect(load({ PDQ_HASH_LIST: '' }).hashList).toBeUndefined();
    expect(
      load({ PDQ_HASH_LIST: ' /etc/evieverse/pdq.txt ', PDQ_HASH_LIST_AUTHORIZATION: 'Bearer KEY', PDQ_MAX_DISTANCE: '20', PDQ_MIN_QUALITY: '80', PDQ_REFRESH_MINUTES: '5' }),
    ).toEqual({ hashList: '/etc/evieverse/pdq.txt', authorization: 'Bearer KEY', maxDistance: 20, minQuality: 80, refreshMinutes: 5 });
    for (const [name, value] of [['PDQ_MAX_DISTANCE', '64'], ['PDQ_MAX_DISTANCE', '-1'], ['PDQ_MIN_QUALITY', '101'], ['PDQ_REFRESH_MINUTES', '0']] as const) {
      expect(() => load({ [name]: value }), `${name}=${value}`).toThrow();
    }
  });

  it('are needed by a server that turns the plugin on, which must also hold back what it does not trust', () => {
    const plugins = (env: Record<string, string>) => loadConfig({}, { ...BASE_ENV, ...env }).trust.optionalPlugins;
    expect(plugins({ TRUST_OPTIONAL_PLUGINS: 'pdq', PDQ_HASH_LIST: '/etc/evieverse/pdq.txt' })).toEqual(['pdq']);
    // A server that turns pdq on without a list doesn't start, rather than run it with nothing to match images against.
    expect(() => plugins({ TRUST_OPTIONAL_PLUGINS: 'pdq' })).toThrow(/TRUST_OPTIONAL_PLUGINS turns on pdq, which needs PDQ_HASH_LIST/);
    // Nor one that publishes every post whatever its score.
    expect(() => plugins({ TRUST_OPTIONAL_PLUGINS: 'pdq', PDQ_HASH_LIST: '/etc/evieverse/pdq.txt', TRUST_SCORE_DELETE_BELOW: '0', TRUST_SCORE_ALLOW_FROM: '0' })).toThrow(
      /TRUST_OPTIONAL_PLUGINS turns on pdq, which needs TRUST_SCORE_ALLOW_FROM above 0/,
    );
    // The list alone turns nothing on.
    expect(plugins({ PDQ_HASH_LIST: '/etc/evieverse/pdq.txt' })).toEqual([]);
  });
});

for (const target of TARGETS) {
  describe(`images of known child sexual abuse material (${target.name})`, () => {
    let ctx: TestContext;
    let dir: string;
    let list: string;
    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'evieverse-pdq-'));
      list = join(dir, 'hashes.csv');
      await writeFile(list, LIST);
    });
    afterAll(() => rm(dir, { recursive: true, force: true }));
    afterEach(() => ctx.close());

    const { store, storeText } = requests(() => ctx);
    const POST_REFUSED = { error: "this server doesn't trust the post enough to keep it, so it wasn't published" };
    const COMMENT_REFUSED = { error: "this server doesn't trust the comment enough to keep it, so it wasn't published" };
    const answer = (res: LightMyRequestResponse) => [res.statusCode, res.json()];

    /** A server that runs the plugin with the test's list, beside the plugins every server runs. */
    const serverWithPlugin = async (opts: Parameters<typeof createTestContext>[1] = {}) =>
      createTestContext(target, { ...opts, trust: { ...opts.trust, optionalPlugins: ['pdq'] }, pdq: { hashList: list } });
    const admin = async (name = 'root') => {
      const user = await ctx.register(name);
      await setAdmin(ctx.db, name, true);
      return user;
    };
    /** An image post sent as a form, with its image or images as the form's files. */
    const sendImages = (user: User, files: { name: string; type: string; data: Buffer }[], fields: Record<string, string> = {}) => {
      const form = multipart({ ...user, type: 'image', tags: 'pics', ...fields }, files);
      return ctx.app.inject({ method: 'POST', url: '/store', payload: form.payload, headers: form.headers });
    };
    /** What a client does with an upload link: puts the file in the content store, here a directory. */
    const putUpload = async (user: User, uploadId: string, bytes: Buffer) => {
      const uploads = join(ctx.dir, 'content', 'uploads', user.userId);
      await mkdir(uploads, { recursive: true });
      await writeFile(join(uploads, uploadId), bytes);
    };
    type Notice = { messageId: string; kind: string; contentId?: string; excerpt?: string; details?: Record<string, string | number>; text: string; readAt: string | null };
    /** A user's inbox, oldest first. */
    const inbox = async (user: User): Promise<Notice[]> => {
      const res = await ctx.app.inject({ method: 'GET', url: `/users/${user.userId}/inbox`, headers: as(user) });
      expect(res.statusCode, res.body).toBe(200);
      return (res.json().inbox as Notice[]).reverse();
    };
    const contents = async () => (await ctx.db.selectFrom('content').select('id').execute()).map((row) => row.id);

    it('are refused as a post, however the image is sent, and every admin is told who sent it, when and from where', async () => {
      ctx = await serverWithPlugin();
      const root = await admin();
      const second = await admin('second');
      const alice = await ctx.register('alice');
      const bytes = await copy(LISTED);

      const refused = await ctx.app.inject({
        method: 'POST',
        url: '/store',
        remoteAddress: '203.0.113.9',
        ...(() => {
          const form = multipart({ ...alice, type: 'image', tags: 'pics', text: 'A caption' }, { name: 'holiday.jpg', type: 'image/jpeg', data: bytes });
          return { payload: form.payload, headers: { ...form.headers, 'user-agent': 'TestClient/1.0' } };
        })(),
      });
      expect(answer(refused)).toEqual([422, POST_REFUSED]);
      expect(await contents()).toEqual([]);

      for (const told of [root, second]) {
        const [notice, ...more] = await inbox(told);
        expect(more).toEqual([]);
        expect(notice).toMatchObject({ kind: 'csam_match_refused', readAt: null });
        expect(notice).not.toHaveProperty('excerpt');
        expect(notice).not.toHaveProperty('contentId');
        const { details } = notice!;
        expect(details).toMatchObject({
          userId: alice.userId,
          username: 'alice',
          listed: LISTED.hash,
          at: new Date(ctx.clock.now).toISOString(),
          ip: '203.0.113.9',
          userAgent: 'TestClient/1.0',
          sentAs: 'post',
          filename: 'holiday.jpg',
          mimeType: 'image/jpeg',
          quality: 100,
          frame: 0,
          outcome: 'refused',
        });
        expect(details).not.toHaveProperty('contentId');
        expect(details!.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(apart(String(details!.pdq), LISTED.hash)).toBe(details!.distance);
        expect(details!.distance).toBeLessThanOrEqual(31);
        expect(notice!.text).toBe(
          `An image that alice sent matches this server's list of hashes of known child sexual abuse material. It was refused: nothing of it was published, or stored as a post or a comment. It was sent at ${details!.at} from 203.0.113.9 by the user ${alice.userId}. The image's SHA-256 is ${details!.sha256}; its PDQ hash ${details!.pdq} is ${details!.distance} of 256 bits from the listed hash ${LISTED.hash}. A match is a strong sign, not proof. You may have a duty to report it: in the United States, to NCMEC's CyberTipline (https://report.cybertip.org). Check what the law where you operate asks of you.`,
        );
      }
      // Who sent it is told nothing more than that it wasn't published.
      expect(await inbox(alice)).toEqual([]);

      // Inline, with an upload link, and as one image of several: the same.
      const inline = await store(alice, { type: 'image', content: (await png(LISTED)).toString('base64'), contentEncoding: 'base64', contentType: 'image/png', tags: ['pics'] });
      expect(answer(inline)).toEqual([422, POST_REFUSED]);
      const uploadId = '00000000-0000-4000-8000-000000000001';
      await putUpload(alice, uploadId, await copy(LISTED, 300, 80));
      expect(answer(await store(alice, { type: 'image', uploadId, filename: 'holiday.jpg', tags: ['pics'] }))).toEqual([422, POST_REFUSED]);
      ctx.clock.now += 1000;
      const album = await sendImages(alice, [
        { name: 'one.png', type: 'image/png', data: await png(OTHER) },
        { name: 'two.jpg', type: 'image/jpeg', data: await copy(ALSO_LISTED, 300, 70) },
      ]);
      expect(answer(album)).toEqual([422, POST_REFUSED]);
      expect(await contents()).toEqual([]);

      // An admin with an unread notice of the same user and listed hash gets no second one: one of another listed hash, they do.
      const notices = await inbox(root);
      expect(notices.map(({ kind, details }) => [kind, details!.listed, details!.filename])).toEqual([
        ['csam_match_refused', LISTED.hash, 'holiday.jpg'],
        ['csam_match_refused', ALSO_LISTED.hash, 'two.jpg'],
      ]);
      // Once it is read, the next time is told again, and so is the same image from another user.
      await ctx.app.inject({ method: 'POST', url: `/users/${root.userId}/inbox/read`, headers: as(root), payload: {} });
      ctx.clock.now += 60_000;
      expect(answer(await sendImages(alice, [{ name: 'again.jpg', type: 'image/jpeg', data: bytes }]))).toEqual([422, POST_REFUSED]);
      ctx.clock.now += 1000;
      const bob = await ctx.register('bob');
      expect(answer(await sendImages(bob, [{ name: 'mine.jpg', type: 'image/jpeg', data: bytes }]))).toEqual([422, POST_REFUSED]);
      expect((await inbox(root)).map(({ details }) => [details!.username, details!.filename])).toEqual([
        ['alice', 'holiday.jpg'],
        ['alice', 'two.jpg'],
        ['alice', 'again.jpg'],
        ['bob', 'mine.jpg'],
      ]);
      expect((await inbox(second)).map(({ details }) => [details!.username, details!.filename])).toEqual([
        ['alice', 'holiday.jpg'],
        ['alice', 'two.jpg'],
        ['bob', 'mine.jpg'],
      ]);
    });

    it('leave every other post as it was: an image that is not listed, and what has no image', async () => {
      ctx = await serverWithPlugin();
      const root = await admin();
      const alice = await ctx.register('alice');
      const fine = await sendImages(alice, [
        { name: 'one.png', type: 'image/png', data: await png(OTHER) },
        { name: 'two.jpg', type: 'image/jpeg', data: await copy(OTHER) },
      ]);
      expect(fine.statusCode, fine.body).toBe(201);
      expect((await storeText(alice, `A text that names a hash, ${LISTED.hash} #news`)).statusCode).toBe(201);
      expect((await store(alice, { type: 'link', url: 'https://news.example/story', tags: ['news'] })).statusCode).toBe(201);
      expect(await inbox(root)).toEqual([]);
    });

    it('are refused as an update of a post, which stays as it was', async () => {
      ctx = await serverWithPlugin();
      const root = await admin();
      const alice = await ctx.register('alice');
      const fine = await sendImages(alice, [{ name: 'one.png', type: 'image/png', data: await png(OTHER) }]);
      expect(fine.statusCode, fine.body).toBe(201);
      const { contentId } = fine.json();
      const read = async () => {
        const raw = await ctx.app.inject({ method: 'GET', url: `/content/${contentId}/raw` });
        expect(raw.statusCode, raw.body).toBe(200);
        return [(await ctx.app.inject({ method: 'GET', url: `/content/${contentId}` })).json().preview, sha256(raw.rawPayload)];
      };
      const before = await read();
      const update = await sendImages(alice, [{ name: 'one.png', type: 'image/png', data: await png(OTHER) }, { name: 'two.png', type: 'image/png', data: await png(LISTED) }], { contentId });
      expect(answer(update)).toEqual([422, POST_REFUSED]);
      expect(await read()).toEqual(before);
      expect(await inbox(root)).toMatchObject([{ kind: 'csam_match_refused', contentId, details: { userId: alice.userId, sentAs: 'update', contentId, filename: 'two.png', listed: LISTED.hash, distance: 0 } }]);
    });

    it('are refused with a comment, as a form, inline or with an upload link', async () => {
      ctx = await serverWithPlugin();
      const root = await admin();
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const open = await storeText(alice, 'What do you think? #news', { comments: true });
      expect(open.statusCode, open.body).toBe(201);
      const { contentId } = open.json();
      const url = `/content/${contentId}/comments`;
      const form = (data: Buffer, name: string) => {
        const { payload, headers } = multipart({ text: 'Look' }, { name, type: 'image/jpeg', data });
        return ctx.app.inject({ method: 'POST', url, payload, headers: { ...headers, ...as(bob) } });
      };

      expect(answer(await form(await copy(LISTED), 'look.jpg'))).toEqual([422, COMMENT_REFUSED]);
      ctx.clock.now += 1000;
      const inline = await ctx.app.inject({ method: 'POST', url, headers: as(bob), payload: { content: (await copy(ALSO_LISTED, 300, 70)).toString('base64'), contentEncoding: 'base64', contentType: 'image/jpeg' } });
      expect(answer(inline)).toEqual([422, COMMENT_REFUSED]);
      const uploadId = '00000000-0000-4000-8000-000000000002';
      await putUpload(bob, uploadId, await png(LISTED));
      // The same user and listed hash as the first: refused, and the admin isn't told twice.
      expect(answer(await ctx.app.inject({ method: 'POST', url, headers: as(bob), payload: { uploadId, filename: 'again.png' } }))).toEqual([422, COMMENT_REFUSED]);
      expect(await inbox(root)).toMatchObject([
        { kind: 'csam_match_refused', contentId, details: { userId: bob.userId, username: 'bob', sentAs: 'comment', contentId, filename: 'look.jpg', listed: LISTED.hash } },
        { kind: 'csam_match_refused', contentId, details: { userId: bob.userId, sentAs: 'comment', contentId, listed: ALSO_LISTED.hash } },
      ]);

      // An image that isn't listed is a comment like any other, and so is a text.
      const fine = await form(await copy(OTHER), 'fine.jpg');
      expect(fine.statusCode, fine.body).toBe(201);
      expect((await ctx.app.inject({ method: 'POST', url, headers: as(bob), payload: { text: 'No image' } })).statusCode).toBe(201);
      expect(await inbox(root)).toHaveLength(2);
    });

    it('wait in the moderation queue on a server that deletes nothing on arrival, which the admins are told', async () => {
      ctx = await serverWithPlugin({ trust: { deleteBelow: 0 } });
      const root = await admin();
      const alice = await ctx.register('alice');
      const held = await sendImages(alice, [{ name: 'holiday.jpg', type: 'image/jpeg', data: await copy(LISTED) }]);
      expect(held.statusCode, held.body).toBe(202);
      expect(await ctx.db.selectFrom('moderation_queue').select(['content_id', 'trust_score']).execute()).toEqual([{ content_id: held.json().contentId, trust_score: 0 }]);
      const [notice, ...more] = await inbox(root);
      expect(more).toEqual([]);
      expect(notice).toMatchObject({ kind: 'csam_match_held', details: { userId: alice.userId, outcome: 'held', sentAs: 'post', listed: LISTED.hash } });
      expect(notice!.text).toContain('It was not published: it is stored, and waits in the moderation queue, since this server deletes nothing on arrival. Accepting it there would publish it.');
    });

    it("are refused as a user's avatar, on a server that deletes nothing on arrival too: a profile has no queue to wait in", async () => {
      ctx = await serverWithPlugin({ trust: { deleteBelow: 0 } });
      const root = await admin();
      const alice = await ctx.register('alice');
      const avatar = (data: Buffer, name: string) => {
        const { payload, headers } = multipart({}, { name, type: 'image/jpeg', data });
        return ctx.app.inject({ method: 'PUT', url: `/users/${alice.userId}/avatar`, payload, headers: { ...headers, ...as(alice) } });
      };
      const shown = async () => (await ctx.app.inject({ method: 'GET', url: `/users/${alice.userId}` })).json().avatarUrl;

      expect(answer(await avatar(await copy(LISTED), 'me.jpg'))).toEqual([422, { error: "this server doesn't trust this enough to show it on a profile, so it wasn't saved" }]);
      expect(await shown()).toBeNull();
      // Nothing of it is in the content store, and the admins are told it was refused, as what it was sent as.
      expect(await readdir(join(ctx.dir, 'content', 'avatars')).catch(() => [])).toEqual([]);
      const [notice, ...more] = await inbox(root);
      expect(more).toEqual([]);
      expect(notice).toMatchObject({ kind: 'csam_match_refused', details: { userId: alice.userId, username: 'alice', sentAs: 'avatar', outcome: 'refused', filename: 'me.jpg', listed: LISTED.hash } });
      expect(notice!.details).not.toHaveProperty('contentId');

      // An image that isn't listed is an avatar like any other.
      const fine = await avatar(await copy(OTHER), 'fine.jpg');
      expect(fine.statusCode, fine.body).toBe(200);
      expect(await shown()).toBe(fine.json().avatarUrl);
      expect(await inbox(root)).toHaveLength(1);
    });

    it('are checked only on a server that turns the plugin on, which then reads the list itself', async () => {
      const post = async (user: User) => sendImages(user, [{ name: 'holiday.jpg', type: 'image/jpeg', data: await copy(LISTED) }]);
      // Off, as it is unless the server names it: the image is an image like any other.
      ctx = await createTestContext(target);
      expect((await post(await ctx.register('alice'))).statusCode).toBe(201);
      await ctx.close();

      // On: the server's own plugin, as it loads it, downloading its list from what stands in for where one is kept.
      const asked: string[] = [];
      const http = createServer((req, res) => {
        asked.push(`${req.url} ${req.headers.authorization}`);
        res.end(LIST);
      });
      await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
      try {
        const { port } = http.address() as AddressInfo;
        ctx = await createTestContext(target, { trust: { optionalPlugins: ['pdq'] }, pdq: { hashList: `http://127.0.0.1:${port}/pdq.csv`, authorization: 'Bearer KEY' } });
        const root = await admin();
        const bob = await ctx.register('bob');
        expect(answer(await post(bob))).toEqual([422, POST_REFUSED]);
        expect(await inbox(root)).toMatchObject([{ kind: 'csam_match_refused', details: { username: 'bob' } }]);
        expect((await sendImages(bob, [{ name: 'fine.png', type: 'image/png', data: await png(OTHER) }])).statusCode).toBe(201);
        // Downloaded once, for the posts after the first too.
        expect(asked).toEqual(['/pdq.csv Bearer KEY']);
      } finally {
        http.closeAllConnections();
        await new Promise((resolve) => http.close(resolve));
      }
    });
  });
}
