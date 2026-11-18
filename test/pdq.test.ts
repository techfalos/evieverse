import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { msg } from '../src/language.js';
import { setAdmin } from '../src/moderation/policy.js';
import { loadTrustPlugins } from '../src/moderation/trust.js';
import type { TrustContext, TrustImage, TrustPost } from '../src/moderation/trust.types.js';
import { bitsOf, distance, fromHex, lumaOf, pdqHash, toHex } from '../src/plugins/trust/pdq/hash.js';
import { framesOf, MAX_FRAMES, UnreadableImage } from '../src/plugins/trust/pdq/image.js';
import { pdq } from '../src/plugins/trust/pdq/index.js';
import { hashOfLine, listOf, nearest } from '../src/plugins/trust/pdq/list.js';
import { as, createTestContext, multipart, requests, sha256, TARGETS, type TestContext, type User } from './helpers.js';

/**
 * A picture to hash: `rows` by `cols` of soft light and dark patches, as a photo out of focus has,
 * each about `block` across. `seed` chooses the patches: another seed is another picture.
 */
type Picture = { rows: number; cols: number; seed: number; block: number };

/**
 * Pictures, each with the hash and quality that Meta's reference implementation of PDQ gives its
 * pixels (the pdqhash binding of pdq/cpp, which hashes an image at the size it is given).
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

/** A hash's words, from how it is written. */
function wordsOf(hex: string): Uint16Array {
  const words = new Uint16Array(16);
  expect(fromHex(hex, words), hex).toBe(true);
  return words;
}
/** How many bits two hashes, as they are written, differ in. */
const apart = (a: string, b: string) => distance(wordsOf(a), 0, wordsOf(b), 0);
/** `hex` with `count` of its bits changed: every `step`th, from `from`. */
function changed(hex: string, count: number, step = 7, from = 3): string {
  const words = wordsOf(hex);
  for (let i = 0; i < count; i++) {
    const bit = (from + i * step) % 256;
    words[bit >> 4]! ^= 1 << (bit & 15);
  }
  return toHex(words);
}

/** Numbers from 0 to 1 that are the same every run. */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The lines of a list, as `listOf` is given them. */
async function* lines(text: string) {
  yield* text.split('\n');
}

describe('the PDQ hash', () => {
  it("is the reference implementation's, bit for bit, with its quality", () => {
    for (const picture of REFERENCE) {
      const { words, quality } = pdqHash(lumaOf(grey(picture), 1), picture.rows, picture.cols);
      expect([toHex(words), quality], `${picture.cols}x${picture.rows}`).toEqual([picture.hash, picture.quality]);
    }
    // Colour is read as its luminance: a grey picture's hash is the same from its red, green and blue.
    const rgb = Buffer.from([...grey(LISTED)].flatMap((value) => [value, value, value, 255]));
    expect(toHex(pdqHash(lumaOf(rgb, 4), LISTED.rows, LISTED.cols).words)).toBe(LISTED.hash);
  });

  it('is nearly the same for the same picture at another size, and not for another picture', () => {
    // The same squares at twice the size.
    expect(apart(REFERENCE[0]!.hash, REFERENCE[3]!.hash)).toBeLessThanOrEqual(31);
    expect(apart(LISTED.hash, OTHER.hash)).toBeGreaterThan(90);
    expect(apart(LISTED.hash, ALSO_LISTED.hash)).toBeGreaterThan(90);
  });

  it('has no quality for a picture with nothing in it, and none at all for one too small to hash', () => {
    const flat = pdqHash(new Float32Array(100 * 100).fill(77), 100, 100);
    expect(flat.quality).toBe(0);
    const small = pdqHash(lumaOf(grey({ rows: 4, cols: 9, seed: 1, block: 2 }), 1), 4, 9);
    expect([toHex(small.words), small.quality]).toEqual(['0'.repeat(64), 0]);
  });

  it('is written as 64 hex digits, and compared by the bits that differ', () => {
    expect(toHex(wordsOf(LISTED.hash))).toBe(LISTED.hash);
    expect(toHex(wordsOf(LISTED.hash.toUpperCase()))).toBe(LISTED.hash);
    const words = new Uint16Array(16).fill(7);
    for (const hex of ['', LISTED.hash.slice(1), `${LISTED.hash}0`, `g${LISTED.hash.slice(1)}`]) expect(fromHex(hex, words), hex).toBe(false);
    expect([...words]).toEqual(Array(16).fill(7));
    expect([0, 1, 0x8000, 0xffff, 0x0f0f].map(bitsOf)).toEqual([0, 1, 1, 16, 8]);
    expect(apart(LISTED.hash, LISTED.hash)).toBe(0);
    expect(apart(LISTED.hash, changed(LISTED.hash, 31))).toBe(31);
    expect(apart('0'.repeat(64), 'f'.repeat(64))).toBe(256);
    // Counted only as far as it is asked to.
    expect(distance(wordsOf('0'.repeat(64)), 0, wordsOf('f'.repeat(64)), 0, 31)).toBeGreaterThan(31);
  });
});

describe('an image read for its hash', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'evieverse-pdq-'));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  /** The hash and quality of each frame of the image `bytes` are. */
  async function hashes(bytes: Buffer, name = 'image') {
    const path = join(dir, name);
    await writeFile(path, bytes);
    const found: { hash: string; quality: number }[] = [];
    for await (const { luma, rows, cols } of framesOf(path)) {
      const { words, quality } = pdqHash(luma, rows, cols);
      found.push({ hash: toHex(words), quality });
    }
    return found;
  }

  it('is hashed as the reference hashes it, whichever type of file it is', async () => {
    for (const picture of REFERENCE.slice(0, 3)) {
      const exact = { hash: picture.hash, quality: picture.quality };
      expect(await hashes(await png(picture)), 'png').toEqual([exact]);
      expect(await hashes(await drawn(picture).webp({ lossless: true }).toBuffer()), 'webp').toEqual([exact]);
      expect(await hashes(await drawn(picture).gif().toBuffer()), 'gif').toEqual([exact]);
      // A JPEG isn't the picture to the bit, and neither is its hash.
      const [jpeg] = await hashes(await drawn(picture).jpeg({ quality: 90 }).toBuffer());
      expect(apart(jpeg!.hash, picture.hash), 'jpeg').toBeLessThanOrEqual(20);
    }
  });

  it('is the picture as it shows: what is transparent is white, and a copy of it has nearly its hash', async () => {
    // Half transparent over black is, on white, grey: not the black a reader that drops the transparency sees.
    const veiled = await sharp(Buffer.from([...grey(LISTED)].flatMap((value) => [0, 0, 0, 255 - value])), { raw: { width: LISTED.cols, height: LISTED.rows, channels: 4 } })
      .png()
      .toBuffer();
    expect(await hashes(veiled)).toEqual([{ hash: LISTED.hash, quality: 100 }]);

    for (const [width, quality] of [[200, 60], [320, 30], [96, 80], [900, 85]] as const) {
      const [found] = await hashes(await copy(LISTED, width, quality));
      expect(apart(found!.hash, LISTED.hash), `${width} wide at quality ${quality}`).toBeLessThanOrEqual(20);
    }
    // Larger than it is hashed at: brought down first, which costs its hash a few bits.
    const [large] = await hashes(await drawn({ rows: 1500, cols: 2000, seed: 1, block: 125 }).png().toBuffer());
    expect(apart(large!.hash, LISTED.hash)).toBeLessThanOrEqual(20);
    // What the hash doesn't see through: the picture mirrored.
    const [mirrored] = await hashes(await drawn(LISTED).flop().png().toBuffer());
    expect(apart(mirrored!.hash, LISTED.hash)).toBeGreaterThan(31);
  });

  it('is each frame of an animation, up to a number of them', async () => {
    const frames = [LISTED, { ...LISTED, seed: 2 }, { ...LISTED, seed: 5 }];
    const film = (count: number, picture = (i: number) => frames[i % frames.length]!) =>
      sharp(Buffer.concat(Array.from({ length: count }, (_, i) => grey(picture(i)))), { raw: { width: LISTED.cols, height: LISTED.rows * count, channels: 1, pageHeight: LISTED.rows } });
    const expected = frames.map((picture) => toHex(pdqHash(lumaOf(grey(picture), 1), picture.rows, picture.cols).words));
    for (const [type, bytes] of [['gif', await film(3).gif().toBuffer()], ['webp', await film(3).webp({ lossless: true }).toBuffer()]] as const) {
      expect((await hashes(bytes)).map(({ hash }) => hash), type).toEqual(expected);
    }
    // A long one: its first frames, and no more.
    const small = { rows: 40, cols: 60, seed: 0, block: 5 };
    const long = sharp(Buffer.concat(Array.from({ length: MAX_FRAMES + 8 }, (_, i) => grey({ ...small, seed: i }))), { raw: { width: 60, height: 40 * (MAX_FRAMES + 8), channels: 1, pageHeight: 40 } });
    const found = await hashes(await long.gif().toBuffer());
    expect(found).toHaveLength(MAX_FRAMES);
    expect(new Set(found.map(({ hash }) => hash)).size).toBe(MAX_FRAMES);
  });

  it("is unreadable if it can't be decoded", async () => {
    for (const bytes of [Buffer.from('not an image at all'), (await png(LISTED)).subarray(0, 20), Buffer.alloc(0)]) {
      await expect(hashes(bytes)).rejects.toBeInstanceOf(UnreadableImage);
    }
    await expect(framesOf(join(dir, 'missing')).next()).rejects.toBeInstanceOf(UnreadableImage);
  });
});

describe('the list of hashes', () => {
  it('is read a hash a line, wherever in the line it is', () => {
    const hash = LISTED.hash;
    expect(hashOfLine(hash)).toBe(hash);
    expect(hashOfLine(`  ${hash.toUpperCase()} \r`)).toBe(hash);
    expect(hashOfLine(`7,${hash},2026-11-06`)).toBe(hash);
    expect(hashOfLine(`"7","${hash}","csam"`)).toBe(hash);
    expect(hashOfLine(`pdq\t${hash}\t100`)).toBe(hash);
    expect(hashOfLine(`{"hash":"${hash}"}`)).toBe(hash);
    // The first of two.
    expect(hashOfLine(`${hash},${OTHER.hash}`)).toBe(hash);
    for (const line of ['', '   ', '# a comment', `# ${hash}`, 'id,pdq,added', hash.slice(1), `${hash}0`, `0${hash}`, 'd41d8cd98f00b204e9800998ecf8427e']) {
      expect(hashOfLine(line), line).toBeNull();
    }
  });

  it('refuses what holds no hash, and hashes that are not PDQ hashes', async () => {
    const list = await listOf(lines(LIST));
    expect(list.size).toBe(2);
    await expect(listOf(lines('# nothing\n\n<html>Maintenance</html>\n'))).rejects.toThrow(/PDQ_HASH_LIST has no hash in it/);
    // SHA-256s, which are written as PDQ hashes are.
    const sums = Array.from({ length: 40 }, (_, i) => sha256(Buffer.from(String(i))));
    await expect(listOf(lines(sums.join('\n')))).rejects.toThrow(/PDQ_HASH_LIST doesn't hold PDQ hashes: only \d+ of its 40 have half their bits set/);
    // A few hashes of pictures whose values tie, which don't set exactly half, are a list all the same.
    expect((await listOf(lines([LISTED.hash, OTHER.hash, REFERENCE[2]!.hash].join('\n')))).size).toBe(3);
  });

  it('finds the listed hash nearest another, within the distance asked for', async () => {
    const list = await listOf(lines(LIST));
    expect(nearest(list, wordsOf(LISTED.hash), 31)).toEqual({ listed: LISTED.hash, distance: 0 });
    expect(nearest(list, wordsOf(ALSO_LISTED.hash), 0)).toEqual({ listed: ALSO_LISTED.hash, distance: 0 });
    expect(nearest(list, wordsOf(changed(LISTED.hash, 1)), 31)).toEqual({ listed: LISTED.hash, distance: 1 });
    expect(nearest(list, wordsOf(changed(LISTED.hash, 31)), 31)).toEqual({ listed: LISTED.hash, distance: 31 });
    expect(nearest(list, wordsOf(changed(LISTED.hash, 32)), 31)).toBeNull();
    expect(nearest(list, wordsOf(changed(LISTED.hash, 32)), 32)).toEqual({ listed: LISTED.hash, distance: 32 });
    expect(nearest(list, wordsOf(changed(LISTED.hash, 1)), 0)).toBeNull();
    // All the bits that differ in a few words, as they are when one part of a picture was changed.
    expect(nearest(list, wordsOf(changed(LISTED.hash, 31, 1, 16)), 31)).toEqual({ listed: LISTED.hash, distance: 31 });
    expect(nearest(list, wordsOf(OTHER.hash), 63)).toBeNull();
  });

  it('finds in a long list what comparing with every hash finds', async () => {
    const next = random(11);
    // Hashes with half their bits set, as PDQ's have.
    const hashes = Array.from({ length: 4000 }, () => {
      const bits = Array.from({ length: 256 }, (_, i) => i < 128);
      for (let i = 255; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [bits[i], bits[j]] = [bits[j]!, bits[i]!];
      }
      const words = new Uint16Array(16);
      bits.forEach((set, bit) => set && (words[bit >> 4]! |= 1 << (bit & 15)));
      return toHex(words);
    });
    // And some that are near each other, so that the nearest isn't the only one near.
    for (let i = 0; i < 200; i++) hashes.push(changed(hashes[i]!, 2 + (i % 20), 11, i));
    const list = await listOf(lines(hashes.join('\n')));
    expect(list.size).toBe(hashes.length);
    const all = hashes.map(wordsOf);
    for (let i = 0; i < 300; i++) {
      const flips = [0, 1, 5, 16, 30, 31, 32, 40, 47, 48, 60, 63, 64, 90][i % 14]!;
      const words = wordsOf(changed(hashes[Math.floor(next() * hashes.length)]!, flips, 1 + Math.floor(next() * 40), Math.floor(next() * 256)));
      const best = Math.min(...all.map((listed) => distance(words, 0, listed, 0)));
      for (const most of [0, 15, 16, 31, 47, 63]) {
        const found = nearest(list, words, most);
        expect(found?.distance ?? null, `${flips} bits changed, within ${most}`).toBe(best <= most ? best : null);
        if (found) expect(distance(words, 0, wordsOf(found.listed), 0)).toBe(best);
      }
    }
  });
});

describe('the pdq trust plugin', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'evieverse-pdq-'));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  /** An image as a plugin is given it: `bytes` in a file of the test's. */
  async function image(bytes: Buffer, filename = `${sha256(bytes).slice(0, 12)}.img`): Promise<TrustImage> {
    const path = join(dir, filename);
    await writeFile(path, bytes);
    return { mimeType: 'image/png', filename, file: async () => path, sha256: async () => sha256(bytes) };
  }

  /** What stands in for where a list is downloaded from: answers with `body`, and keeps the requests it got. */
  function listServer(body = LIST) {
    const server = {
      body,
      status: 200,
      down: false,
      requests: [] as { url: string; authorization: string | null }[],
      fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
        server.requests.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') });
        if (server.down) throw new TypeError('fetch failed');
        return new Response(server.body, { status: server.status });
      }) as typeof fetch,
    };
    return server;
  }

  /** The plugin with a list of its own, on a clock the test moves, as `assess` is called with it. The database is one that can't be reached. */
  function setup(settings: Record<string, unknown> = { hashList: 'https://lists.example/pdq.csv' }, body?: string) {
    const server = listServer(body);
    const clock = { now: Date.UTC(2026, 10, 6, 12) };
    const logged: { level: string; fields: Record<string, unknown>; text: string }[] = [];
    const log = Object.fromEntries(['info', 'warn', 'error'].map((level) => [level, (fields: Record<string, unknown>, text: string) => logged.push({ level, fields, text })]));
    const db = { selectFrom: () => { throw new Error('no database'); } };
    const ctx = { config: loadConfig({ pdq: settings }, {}), now: () => clock.now, score: 100, log, db, client: { ip: '203.0.113.9', userAgent: 'TestClient/1.0' } } as unknown as TrustContext;
    const plugin = pdq(server.fetcher);
    const assess = async (images: TrustImage[], post: Partial<TrustPost> = {}) => plugin.assess({ userId: 'u', tags: ['news'], texts: [], ...(images.length ? { images } : {}), ...post }, ctx);
    return { server, clock, logged, assess };
  }

  const MATCH = { set: 0 };

  it('is optional: a plugin the server comes with, and runs only if it names it', async () => {
    expect(pdq().optional).toBe(true);
    expect((await loadTrustPlugins()).map((plugin) => plugin.name)).not.toContain('pdq');
    expect((await loadTrustPlugins(['pdq'])).map((plugin) => plugin.name)).toContain('pdq');
  });

  it('downloads the list once, with its Authorization header, and gives an image near a listed hash no trust, without a reason', async () => {
    const { server, assess } = setup({ hashList: 'https://lists.example/pdq.csv?token=1', authorization: 'Bearer SECRET' });
    expect(await assess([await image(await png(LISTED))])).toEqual(MATCH);
    expect(await assess([await image(await copy(LISTED))])).toEqual(MATCH);
    expect(await assess([await image(await copy(ALSO_LISTED, 300, 50))])).toEqual(MATCH);
    // A comment's image is a post's.
    expect(await assess([await image(await copy(LISTED))], { commentOn: 'c1' })).toEqual(MATCH);
    // Any image of several.
    expect(await assess([await image(await png(OTHER)), await image(await copy(LISTED))])).toEqual(MATCH);
    expect(server.requests).toEqual([{ url: 'https://lists.example/pdq.csv?token=1', authorization: 'Bearer SECRET' }]);
  });

  it('leaves a post whose images are not near a listed hash as it is, and one that has none', async () => {
    const { server, assess } = setup();
    expect(await assess([await image(await png(OTHER))])).toBeNull();
    expect(await assess([await image(await copy(OTHER)), await image(await png(REFERENCE[2]!))])).toBeNull();
    expect(await assess([await image(await drawn(LISTED).flop().png().toBuffer())])).toBeNull();
    expect(await assess([])).toBeNull();
    expect(await assess([], { texts: [LISTED.hash] })).toBeNull();
    expect(server.requests.map(({ authorization }) => authorization)).toEqual([null]);
  });

  it('matches at the distance and the quality the server sets', async () => {
    // A list with a hash 20 bits from the picture's, and not the picture's own.
    const far = [changed(LISTED.hash, 20), ALSO_LISTED.hash, OTHER.hash].join('\n');
    const bytes = await png(LISTED);
    expect(await setup({ hashList: 'https://lists.example/a' }, far).assess([await image(bytes)])).toEqual(MATCH);
    expect(await setup({ hashList: 'https://lists.example/a', maxDistance: 20 }, far).assess([await image(bytes)])).toEqual(MATCH);
    expect(await setup({ hashList: 'https://lists.example/a', maxDistance: 19 }, far).assess([await image(bytes)])).toBeNull();
    expect(await setup({ hashList: 'https://lists.example/a', maxDistance: 0 }, far).assess([await image(bytes)])).toBeNull();
    expect(await setup({ hashList: 'https://lists.example/a', maxDistance: 0 }).assess([await image(bytes)])).toEqual(MATCH);

    // A picture with little in it: a soft gradient, whose hash is on the list. It is matched only where the server asks for no quality.
    const soft = Buffer.from(Array.from({ length: 200 * 200 }, (_, i) => 100 + Math.floor((i % 200) / 8)));
    const gradient = await sharp(soft, { raw: { width: 200, height: 200, channels: 1 } }).png().toBuffer();
    const { words, quality } = pdqHash(lumaOf(soft, 1), 200, 200);
    expect(quality).toBeLessThan(50);
    const list = `${toHex(words)}\n${LIST}`;
    expect(await setup({ hashList: 'https://lists.example/a' }, list).assess([await image(gradient)])).toBeNull();
    expect(await setup({ hashList: 'https://lists.example/a', minQuality: 0 }, list).assess([await image(gradient)])).toEqual(MATCH);
  });

  it('checks every frame of an animated image', async () => {
    const { assess } = setup();
    const film = (pictures: Picture[]) =>
      sharp(Buffer.concat(pictures.map(grey)), { raw: { width: LISTED.cols, height: LISTED.rows * pictures.length, channels: 1, pageHeight: LISTED.rows } }).gif().toBuffer();
    const frame = (seed: number) => ({ ...LISTED, seed });
    expect(await assess([await image(await film([frame(7), frame(8), frame(9)]))])).toBeNull();
    expect(await assess([await image(await film([frame(7), frame(8), LISTED, frame(9)]))])).toEqual(MATCH);
  });

  it("holds an image it can't decode for a person to look at, or has it refused where there is no queue", async () => {
    const { assess, logged } = setup();
    const broken = await image(Buffer.from('not an image at all'), 'broken.png');
    // One under the score that publishes, which is 75 unless the server says otherwise.
    expect(await assess([broken])).toEqual({ set: 74, reason: msg('moderation.image_unreadable') });
    expect(await assess([broken], { commentOn: 'c1' })).toEqual({ set: 74, reason: msg('comment.image_unreadable') });
    expect(await assess([await image(await png(OTHER)), broken])).toEqual({ set: 74, reason: msg('moderation.image_unreadable') });
    expect(logged.filter(({ level }) => level === 'warn').map(({ text, fields }) => [text, fields.filename])).toContainEqual(["pdq: an image couldn't be decoded, so it wasn't checked against the list", 'broken.png']);
    // A match among them is a match.
    expect(await assess([broken, await image(await png(LISTED))])).toEqual(MATCH);
  });

  it('tells the log of a match with what a report is written from, whether or not the admins can be told', async () => {
    const { assess, logged } = setup();
    const bytes = await copy(LISTED);
    expect(await assess([await image(bytes, 'holiday\n.jpg')], { userId: 'user-1', contentId: 'content-1' })).toEqual(MATCH);
    const [told] = logged.filter(({ level }) => level === 'error');
    expect(told!.text).toBe("pdq: an image matches the list of hashes of known child sexual abuse material, and the admins couldn't be told in their inboxes");
    expect(told!.fields.match).toMatchObject({
      userId: 'user-1',
      listed: LISTED.hash,
      at: '2026-11-06T12:00:00.000Z',
      ip: '203.0.113.9',
      userAgent: 'TestClient/1.0',
      sentAs: 'update',
      contentId: 'content-1',
      filename: 'holiday .jpg',
      mimeType: 'image/png',
      sha256: sha256(bytes),
      quality: 100,
      frame: 0,
      outcome: 'refused',
    });
    const { pdq: hash, distance: bits } = told!.fields.match as { pdq: string; distance: number };
    expect(apart(hash, LISTED.hash)).toBe(bits);
    expect(bits).toBeLessThanOrEqual(31);
  });

  it('reads the list again when it is due, without making a post wait, and keeps the one it has if that fails', async () => {
    const { server, clock, assess } = setup({ hashList: 'https://lists.example/pdq.csv', refreshMinutes: 10 });
    const listed = await image(await png(LISTED));
    const other = await image(await png(OTHER));
    expect(await assess([listed])).toEqual(MATCH);
    expect(await assess([other])).toBeNull();

    // Not yet due: nothing is asked for, whatever is posted.
    server.body = `${LIST}\n${OTHER.hash}\n`;
    clock.now += 9 * 60_000;
    expect(await assess([other])).toBeNull();
    expect(await assess([])).toBeNull();
    expect(server.requests).toHaveLength(1);

    // Due: the post that finds it so is answered from the list there is, and the next ones from the new one. A post with no image does as well.
    clock.now += 60_000;
    expect(await assess([])).toBeNull();
    expect(server.requests).toHaveLength(2);
    await vi.waitFor(async () => expect(await assess([other])).toEqual(MATCH));
    expect(server.requests).toHaveLength(2);

    // A download that fails leaves the list as it was, and is tried again a minute later.
    clock.now += 10 * 60_000;
    server.down = true;
    expect(await assess([other])).toEqual(MATCH);
    expect(server.requests).toHaveLength(3);
    clock.now += 59_000;
    expect(await assess([listed])).toEqual(MATCH);
    expect(server.requests).toHaveLength(3);
    clock.now += 1000;
    // An answer that isn't the list doesn't take its place either.
    Object.assign(server, { down: false, body: '<html>Maintenance</html>' });
    expect(await assess([listed])).toEqual(MATCH);
    expect(server.requests).toHaveLength(4);
    clock.now += 60_000;
    Object.assign(server, { body: `${OTHER.hash}\n` });
    expect(await assess([listed])).toEqual(MATCH);
    await vi.waitFor(async () => expect(await assess([listed])).toBeNull());
    expect(await assess([other])).toEqual(MATCH);
    expect(server.requests).toHaveLength(5);
  });

  it("fails a post with an image while it has no list, and no other, and doesn't put the address or its key in the error", async () => {
    const { server, clock, assess } = setup({ hashList: 'https://lists.example/pdq.csv?token=SECRET-TOKEN', authorization: 'Bearer SECRET-KEY' });
    server.status = 403;
    const picture = await image(await png(OTHER));
    const failure = await assess([picture]).catch((err: Error) => err);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      'the pdq trust plugin has no list of hashes to check images with: the server PDQ_HASH_LIST names answered 403: it refused the request (PDQ_HASH_LIST_AUTHORIZATION)',
    );
    expect(JSON.stringify([failure, (failure as Error).cause, (failure as Error).stack])).not.toMatch(/SECRET|lists\.example/);
    // What has no image isn't failed, and the list isn't asked for again for each: once a minute, until it is there.
    expect(await assess([])).toBeNull();
    await expect(assess([picture])).rejects.toThrow(/answered 403/);
    expect(server.requests).toHaveLength(1);

    clock.now += 60_000;
    server.down = true;
    await expect(assess([picture])).rejects.toThrow('the pdq trust plugin has no list of hashes to check images with: fetch failed');
    clock.now += 60_000;
    Object.assign(server, { down: false, status: 200, body: 'Not a list.' });
    await expect(assess([picture])).rejects.toThrow(/PDQ_HASH_LIST has no hash in it/);
    expect(server.requests).toHaveLength(3);

    clock.now += 60_000;
    server.body = LIST;
    expect(await assess([picture])).toBeNull();
    expect(await assess([await image(await png(LISTED))])).toEqual(MATCH);
    expect(server.requests).toHaveLength(4);
  });

  it('reads the list once for the posts that wait for it together', async () => {
    const { server, assess } = setup();
    const answers = await Promise.all([[await image(await png(LISTED))], [await image(await png(OTHER))], []].map((images) => assess(images)));
    expect(answers).toEqual([MATCH, null, null]);
    expect(server.requests).toHaveLength(1);
  });

  it('reads the list from a file, and again once the file has changed', async () => {
    const file = join(dir, 'hashes.txt');
    await writeFile(file, LIST);
    const { server, clock, assess } = setup({ hashList: file, refreshMinutes: 5 });
    const other = await image(await png(OTHER));
    expect(await assess([await image(await png(LISTED))])).toEqual(MATCH);
    expect(await assess([other])).toBeNull();

    await writeFile(file, `${LIST}\n${OTHER.hash}\n`);
    // So that the file is seen to have changed, however coarse the clock of where it is kept.
    await utimes(file, new Date(), new Date(Date.now() + 5000));
    expect(await assess([other])).toBeNull();
    clock.now += 5 * 60_000;
    expect(await assess([])).toBeNull();
    await vi.waitFor(async () => expect(await assess([other])).toEqual(MATCH));
    // Nothing is downloaded for a list that is a file.
    expect(server.requests).toEqual([]);

    await expect(setup({ hashList: join(dir, 'missing.txt') }).assess([other])).rejects.toThrow(/the pdq trust plugin has no list of hashes to check images with: ENOENT/);
  });
});

describe('PDQ_HASH_LIST and the other settings of the pdq trust plugin', () => {
  const load = (env: Record<string, string>) => loadConfig({}, env).pdq;

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
    const plugins = (env: Record<string, string>) => loadConfig({}, env).trust.optionalPlugins;
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
      createTestContext(target, { ...opts, pdq: { hashList: list }, trustPlugins: [...(await loadTrustPlugins()), { name: 'pdq', ...pdq() }] });
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
        // The process has one copy of the list, so only its first server of this file downloads it.
        expect(asked.length).toBeLessThanOrEqual(1);
        expect(asked.every((request) => request === '/pdq.csv Bearer KEY')).toBe(true);
      } finally {
        http.closeAllConnections();
        await new Promise((resolve) => http.close(resolve));
      }
    });
  });
}
