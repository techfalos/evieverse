import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { crc32 } from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageError, stripImage, type ImageType } from '../src/image.js';
import { createTestContext, JPEG, multipart, PNG, requests, TARGETS, type TestContext, type User } from './helpers.js';

// 1x1 GIF and 1x1 lossless WebP, with nothing in them but the image
const GIF = Buffer.from('R0lGODdhAQABAIAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw==', 'base64');
const WEBP = Buffer.from('UklGRhwAAABXRUJQVlA4TA8AAAAvAAAAAAcQ/Y/+ByKi/wEA', 'base64');

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const ascii = (s: string) => Buffer.from(s, 'latin1');
const u16le = (n: number) => Buffer.from([n & 0xff, n >> 8]);
const u32le = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u32be = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

/**
 * An EXIF block as a phone writes one: who made it, where the photo was taken (a GPS directory),
 * and how it is turned if `orientation` says. Little-endian, as phones write it.
 */
function exif(orientation?: number): Buffer {
  const entry = (tag: number, type: number, count: number, value: Buffer) => Buffer.concat([u16le(tag), u16le(type), u32le(count), value, Buffer.alloc(4 - value.length)]);
  const entries = orientation ? 3 : 2;
  const makeAt = 8 + 2 + 12 * entries + 4;
  return Buffer.concat([
    ascii('II'),
    u16le(42),
    u32le(8),
    u16le(entries),
    entry(0x010f, 2, 6, u32le(makeAt)),
    ...(orientation ? [entry(0x0112, 3, 1, u16le(orientation))] : []),
    entry(0x8825, 4, 1, u32le(makeAt + 6)),
    u32le(0),
    ascii('Apple\0'),
    // The GPS directory: north of the equator.
    u16le(1),
    entry(0x0001, 2, 2, ascii('N\0')),
    u32le(0),
  ]);
}

/** The EXIF block a stripped image is left with: big-endian, one directory of one entry, the Orientation. */
const turned = (orientation: number) => hex(`4d4d002a 00000008 0001 0112 0003 00000001 000${orientation}0000 00000000`);

const XMP = ascii('<x:xmpmeta><photoshop:City>Springfield</photoshop:City></x:xmpmeta>');
const APPENDED = ascii('a second image with EXIF of its own, or the video of a motion photo');

// JPEG: segments go in after the JFIF header, which is the image's first 20 bytes.
const segment = (code: number, body: Buffer) => Buffer.concat([Buffer.from([0xff, code, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
const jpegWith = (...segments: Buffer[]) => Buffer.concat([JPEG.subarray(0, 20), ...segments, JPEG.subarray(20)]);
const jpegExif = (block: Buffer) => segment(0xe1, Buffer.concat([ascii('Exif\0\0'), block]));
/** A photo as a phone sends it. */
const PHOTO = Buffer.concat([
  jpegWith(
    jpegExif(exif(6)),
    segment(0xe1, Buffer.concat([ascii('http://ns.adobe.com/xap/1.0/\0'), XMP])),
    segment(0xe2, ascii('MPF\0II*\0')),
    segment(0xed, ascii('Photoshop 3.0\x008BIM\x04\x04Springfield')),
    segment(0xfe, ascii('taken at home')),
  ),
  APPENDED,
]);
/** What is stored of it. */
const PHOTO_STRIPPED = jpegWith(jpegExif(turned(6)));

// PNG: chunks go in after IHDR, which ends at byte 33.
const pngChunk = (type: string, data: Buffer) => {
  const body = Buffer.concat([ascii(type), data]);
  return Buffer.concat([u32be(data.length), body, u32be(crc32(body))]);
};
const pngWith = (...chunks: Buffer[]) => Buffer.concat([PNG.subarray(0, 33), ...chunks, PNG.subarray(33)]);

// GIF: blocks go in after the colour table, which ends at byte 19.
const gifWith = (...blocks: Buffer[]) => Buffer.concat([GIF.subarray(0, 19), ...blocks, GIF.subarray(19)]);
const gifApp = (name: string, ...data: Buffer[]) => Buffer.concat([hex('21ff0b'), ascii(name), ...data.map((d) => Buffer.concat([Buffer.from([d.length]), d])), hex('00')]);
const GIF_LOOP = gifApp('NETSCAPE2.0', hex('010000'));
const GIF_FRAME = hex('21f904 000a0000 00');
const GIF_COMMENT = Buffer.concat([hex('21fe'), Buffer.from([13]), ascii('taken at home'), hex('00')]);

// WebP: a RIFF file of chunks.
const riffChunk = (type: string, data: Buffer) => Buffer.concat([ascii(type), u32le(data.length), data, Buffer.alloc(data.length & 1)]);
const webpOf = (...chunks: Buffer[]) => {
  const body = Buffer.concat([ascii('WEBP'), ...chunks]);
  return Buffer.concat([ascii('RIFF'), u32le(body.length), body]);
};
const VP8L = WEBP.subarray(12);
/** The extended format's header: flags (0x08: has EXIF; 0x04: has XMP), and a canvas of 1x1. */
const vp8x = (flags: number) => riffChunk('VP8X', Buffer.from([flags, 0, 0, 0, 0, 0, 0, 0, 0, 0]));

const SVG = ascii('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>');

describe('stripping an image of its metadata', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'evieverse-images-'));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));
  // No temp file outlives its image, stripped or refused.
  afterEach(async () => expect(await readdir(dir)).toEqual([]));

  /** The image stripped, read `piece` bytes at a time (all at once unless given). */
  async function strip(image: Buffer, piece = image.length || 1, expected?: ImageType) {
    const pieces = Array.from({ length: Math.ceil(image.length / piece) }, (_, i) => image.subarray(i * piece, (i + 1) * piece));
    const { type, file } = await stripImage(Readable.from(pieces), dir, expected);
    try {
      const bytes = await readFile(file.path);
      expect(file.size).toBe(bytes.length);
      return { type, bytes };
    } finally {
      await file.cleanup();
    }
  }
  /** The same however the bytes arrive: all at once, a few at a time, one by one. */
  async function stripped(image: Buffer): Promise<{ type: ImageType; bytes: Buffer }> {
    const whole = await strip(image);
    for (const piece of [1, 7]) expect((await strip(image, piece)).bytes.equals(whole.bytes), `read ${piece} at a time`).toBe(true);
    return whole;
  }
  const refused = async (image: Buffer, type: ImageType | null, expected?: ImageType) => {
    for (const piece of [undefined, 1]) {
      const err = await strip(image, piece, expected).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ImageError);
      expect((err as ImageError).type).toBe(type);
    }
  };

  it('leaves an image that has none as it is', async () => {
    for (const [image, type] of [[JPEG, 'image/jpeg'], [PNG, 'image/png'], [GIF, 'image/gif'], [WEBP, 'image/webp']] as const) {
      const out = await stripped(image);
      expect(out.type).toBe(type);
      expect(out.bytes.equals(image), type).toBe(true);
    }
  });

  it('takes the EXIF, XMP, IPTC, comments and whatever follows the image out of a JPEG, and keeps how it is turned', async () => {
    const out = await stripped(PHOTO);
    expect(out.type).toBe('image/jpeg');
    expect(out.bytes.equals(PHOTO_STRIPPED)).toBe(true);
    for (const word of ['Apple', 'Springfield', 'home', 'motion photo']) expect(out.bytes.includes(word)).toBe(false);

    // Not turned (no Orientation, or the upright one): no EXIF is left at all.
    expect((await stripped(jpegWith(jpegExif(exif())))).bytes.equals(JPEG)).toBe(true);
    expect((await stripped(jpegWith(jpegExif(exif(1))))).bytes.equals(JPEG)).toBe(true);
    // Only the first EXIF block counts, and one that can't be read is dropped.
    expect((await stripped(jpegWith(jpegExif(exif(3)), jpegExif(exif(8))))).bytes.equals(jpegWith(jpegExif(turned(3))))).toBe(true);
    expect((await stripped(jpegWith(jpegExif(ascii('II*\0\xff\xff\xff\xff'))))).bytes.equals(JPEG)).toBe(true);
  });

  it('keeps what draws a JPEG right: its colour profile and transform, not a thumbnail of what it was', async () => {
    const colour = [segment(0xe2, ascii('ICC_PROFILE\0\x01\x01profile')), segment(0xee, ascii('Adobe\0d\0\0\0\0\x01'))];
    expect((await stripped(jpegWith(...colour))).bytes.equals(jpegWith(...colour))).toBe(true);

    // A JFIF header can hold a thumbnail, and a JFXX segment after it another: the photo before it was cropped.
    const jfif = JPEG.subarray(6, 20);
    const thumbnail = segment(0xe0, Buffer.concat([jfif.subarray(0, 12), hex('0101 ff0000')]));
    const withThumbnails = Buffer.concat([JPEG.subarray(0, 2), thumbnail, segment(0xe0, ascii('JFXX\0\x13thumbnail')), JPEG.subarray(20)]);
    expect((await stripped(withThumbnails)).bytes.equals(JPEG)).toBe(true);
  });

  it('reads a JPEG’s scans as they are coded: stuffed bytes and restart markers are data, the next marker is not', async () => {
    const scan = JPEG.indexOf(hex('ffda')) + 10;
    // FF 00 is a 0xFF of data, FF D0 a restart marker, and a marker may be led up to by more 0xFF.
    const data = hex('12 ff00 34 ffd0 56 ff00 ffd1 78 ff');
    const image = Buffer.concat([JPEG.subarray(0, scan), data, segment(0xfe, ascii('between scans')), JPEG.subarray(scan - 10, scan), data, JPEG.subarray(-2), APPENDED]);
    const kept = Buffer.concat([JPEG.subarray(0, scan), data, JPEG.subarray(scan - 10, scan), data, JPEG.subarray(-2)]);
    expect((await stripped(image)).bytes.equals(kept)).toBe(true);
  });

  it('takes the text, time, EXIF and private chunks out of a PNG, and whatever follows it', async () => {
    const drawn = [pngChunk('gAMA', u32be(45455)), pngChunk('pHYs', hex('00000b13 00000b13 01'))];
    const described = [
      pngChunk('tEXt', ascii('Comment\0taken at home')),
      pngChunk('iTXt', Buffer.concat([ascii('XML:com.adobe.xmp\0\0\0\0\0'), XMP])),
      pngChunk('zTXt', ascii('Author\0\0compressed')),
      pngChunk('tIME', hex('07ea 0b 0e 06 00 00')),
      pngChunk('prVt', ascii('Springfield')),
    ];
    const image = Buffer.concat([pngWith(drawn[0]!, ...described, pngChunk('eXIf', exif(6)), drawn[1]!), APPENDED]);
    const out = await stripped(image);
    expect(out.type).toBe('image/png');
    expect(out.bytes.equals(pngWith(drawn[0]!, pngChunk('eXIf', turned(6)), drawn[1]!))).toBe(true);
    expect((await stripped(pngWith(...described, pngChunk('eXIf', exif())))).bytes.equals(PNG)).toBe(true);

    // An animated PNG keeps its frames.
    const frames = [pngChunk('acTL', hex('00000001 00000000')), pngChunk('fcTL', Buffer.alloc(26)), pngChunk('fdAT', hex('00000001 00'))];
    expect((await stripped(pngWith(...frames))).bytes.equals(pngWith(...frames))).toBe(true);
  });

  it('takes the comments and XMP out of a GIF, and keeps how it plays', async () => {
    const image = Buffer.concat([gifWith(GIF_COMMENT, GIF_LOOP, gifApp('XMP DataXMP', XMP), GIF_FRAME), APPENDED]);
    const out = await stripped(image);
    expect(out.type).toBe('image/gif');
    expect(out.bytes.equals(gifWith(GIF_LOOP, GIF_FRAME))).toBe(true);
  });

  it('takes the EXIF and XMP out of a WebP, and says so in its header', async () => {
    const described = [riffChunk('XMP ', XMP), riffChunk('junk', ascii('Springfield'))];
    const image = Buffer.concat([webpOf(vp8x(0x0c), VP8L, riffChunk('EXIF', exif(6)), ...described), APPENDED]);
    const out = await stripped(image);
    expect(out.type).toBe('image/webp');
    expect(out.bytes.equals(webpOf(vp8x(0x08), VP8L, riffChunk('EXIF', turned(6))))).toBe(true);

    expect((await stripped(webpOf(vp8x(0x0c), VP8L, riffChunk('EXIF', exif()), ...described))).bytes.equals(webpOf(vp8x(0), VP8L))).toBe(true);
    // Some write the EXIF chunk as JPEG has it, after "Exif\0\0". Other flags (0x10: alpha) stay.
    const prefixed = webpOf(vp8x(0x18), VP8L, riffChunk('EXIF', Buffer.concat([ascii('Exif\0\0'), exif(3)])));
    expect((await stripped(prefixed)).bytes.equals(webpOf(vp8x(0x18), VP8L, riffChunk('EXIF', turned(3))))).toBe(true);
    // The simple format has no place for EXIF: a chunk of it there goes.
    expect((await stripped(Buffer.concat([webpOf(VP8L, riffChunk('EXIF', exif(6)))]))).bytes.equals(WEBP)).toBe(true);
  });

  it('refuses what is not a JPEG, PNG, GIF or WebP, whatever it is', async () => {
    const heic = Buffer.concat([hex('00000018'), ascii('ftypheic'), Buffer.alloc(12)]);
    const others = [SVG, heic, ascii('<!doctype html><script>alert(1)</script>'), ascii('BM'), ascii('II*\0'), Buffer.alloc(0), hex('ff'), ascii('RIFF\x04\0\0\0WAVE')];
    for (const file of others) await refused(file, null);
  });

  it('refuses an image that is cut short or not laid out as its format says', async () => {
    await refused(JPEG.subarray(0, -2), 'image/jpeg');
    await refused(JPEG.subarray(0, 40), 'image/jpeg');
    // A JPEG's start and end with no image between them.
    await refused(hex('ffd8 ffe0 0002 ffd9'), 'image/jpeg');
    await refused(PNG.subarray(0, -1), 'image/png');
    await refused(PNG.subarray(0, 20), 'image/png');
    await refused(Buffer.concat([PNG.subarray(0, 8), PNG.subarray(-12)]), 'image/png');
    await refused(GIF.subarray(0, -1), 'image/gif');
    await refused(Buffer.concat([GIF.subarray(0, 19), hex('3b')]), 'image/gif');
    await refused(WEBP.subarray(0, -1), 'image/webp');
    await refused(webpOf(riffChunk('EXIF', exif(6))), 'image/webp');
    await refused(webpOf(), 'image/webp');
  });

  it('refuses an image that is not the one expected', async () => {
    expect((await strip(PNG, undefined, 'image/png')).bytes.equals(PNG)).toBe(true);
    await refused(GIF, 'image/png', 'image/png');
    await refused(SVG, 'image/png', 'image/png');
  });
});

for (const target of TARGETS) {
  describe(`images (${target.name})`, () => {
    let ctx: TestContext;
    beforeEach(async () => {
      ctx = await createTestContext(target, { maxUploadBytes: 1000 });
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      // Nothing is left of the files a request spooled.
      expect(await readdir(join(ctx.dir, 'tmp')).catch(() => [])).toEqual([]);
      await ctx.close();
    });

    const { store } = requests(() => ctx);
    const send = (user: User, file: { name: string; type: string; data: Buffer }, fields: Record<string, string> = {}) => {
      const mp = multipart({ ...user, type: 'image', tags: 'pics', ...fields }, file);
      return ctx.app.inject({ method: 'POST', url: '/store', payload: mp.payload, headers: mp.headers });
    };
    const inline = (user: User, data: Buffer, fields: Record<string, unknown>) =>
      store(user, { type: 'image', tags: ['pics'], content: data.toString('base64'), contentEncoding: 'base64', ...fields });
    /** What a client does with an upload link: puts the file in the content store, here a directory. */
    const put = async (user: User, uploadId: string, bytes: Buffer) => {
      const dir = join(ctx.dir, 'content', 'uploads', user.userId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, uploadId), bytes);
    };
    const uploaded = (user: User, uploadId: string, fields: Record<string, unknown> = {}) => store(user, { type: 'image', tags: ['pics'], uploadId, filename: 'photo.jpg', ...fields });
    /** Replaces the upload once /store has looked at it, before it reads it to store it: whoever holds the link can. */
    const replacedBy = (user: User, bytes: Buffer) => {
      const stream = ctx.content.streamUpload.bind(ctx.content);
      vi.spyOn(ctx.content, 'streamUpload').mockImplementationOnce(async (...args) => {
        await put(user, args[1], bytes);
        return stream(...args);
      });
    };
    const uploads = (user: User) => readdir(join(ctx.dir, 'content', 'uploads', user.userId)).catch(() => []);
    const raw = (contentId: string) => ctx.app.inject({ method: 'GET', url: `/content/${contentId}/raw` });
    const kept = async () => (await readdir(join(ctx.dir, 'content', 'content')).catch(() => [])).sort();
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const NOT_AN_IMAGE = 'image posts take JPEG, PNG, GIF and WebP files, and the file is none of them';

    it('stores an image without its metadata, however it is sent, and says what was stored', async () => {
      const alice = await ctx.register('alice');
      await put(alice, id(1), PHOTO);
      const posts = [
        await send(alice, { name: 'photo.jpg', type: 'image/jpeg', data: PHOTO }),
        await inline(alice, PHOTO, { filename: 'photo.jpg' }),
        await uploaded(alice, id(1)),
      ];
      for (const res of posts) {
        expect(res.statusCode, res.body).toBe(201);
        const { contentId } = res.json();
        const bytes = await raw(contentId);
        expect(bytes.rawPayload.equals(PHOTO_STRIPPED)).toBe(true);
        expect(bytes.headers['content-type']).toBe('image/jpeg');
        expect(bytes.headers['content-length']).toBe(String(PHOTO_STRIPPED.length));
        expect(await ctx.content.getMeta(contentId)).toMatchObject({ mimeType: 'image/jpeg', size: PHOTO_STRIPPED.length });
      }
      expect(await uploads(alice)).toEqual([]);
    });

    it('takes an image for what its bytes are, not for what it is sent as', async () => {
      const alice = await ctx.register('alice');
      await put(alice, id(1), GIF);
      const posts: [Awaited<ReturnType<typeof send>>, string, Buffer][] = [
        [await send(alice, { name: 'photo.jpg', type: 'image/jpeg', data: PNG }), 'image/png', PNG],
        [await inline(alice, WEBP, { contentType: 'image/svg+xml' }), 'image/webp', WEBP],
        [await uploaded(alice, id(1)), 'image/gif', GIF],
      ];
      for (const [res, mimeType, image] of posts) {
        expect(res.statusCode, res.body).toBe(201);
        const { contentId } = res.json();
        expect(await ctx.content.getMeta(contentId)).toMatchObject({ mimeType });
        const bytes = await raw(contentId);
        expect(bytes.headers['content-type']).toBe(mimeType);
        expect(bytes.rawPayload.equals(image)).toBe(true);
      }
      // So an update is the same type when its bytes are, and another when they aren't.
      const { contentId } = posts[0]![0].json();
      expect((await send(alice, { name: 'photo.jpg', type: 'image/jpeg', data: PNG }, { contentId })).statusCode).toBe(200);
      const other = await send(alice, { name: 'pixel.png', type: 'image/png', data: JPEG }, { contentId });
      expect(other.json().error).toBe('an update must have the same content type as the original (image/png), got image/jpeg');
    });

    it('refuses a file that is not an image it takes, whatever it is sent as, and one that is cut short', async () => {
      const alice = await ctx.register('alice');
      const refused = (res: { statusCode: number; json(): { error: string } }, error = NOT_AN_IMAGE) => expect([res.statusCode, res.json().error]).toEqual([400, error]);
      const page = Buffer.from('<!doctype html><script>alert(document.domain)</script>');

      refused(await send(alice, { name: 'drawing.svg', type: 'image/svg+xml', data: SVG }));
      refused(await send(alice, { name: 'pixel.png', type: 'image/png', data: SVG }));
      refused(await send(alice, { name: 'pixel.png', type: 'image/png', data: page }));
      refused(await send(alice, { name: 'pixel.png', type: 'image/png', data: Buffer.alloc(0) }));
      refused(await inline(alice, SVG, { contentType: 'image/svg+xml' }));
      refused(await store(alice, { type: 'image', tags: ['pics'], content: SVG.toString(), contentType: 'image/svg+xml' }));
      await put(alice, id(1), SVG);
      refused(await uploaded(alice, id(1), { filename: 'drawing.svg' }));
      await put(alice, id(2), hex('ff'));
      refused(await uploaded(alice, id(2)));

      const cut = 'the file is not a complete, well-formed image/jpeg image';
      refused(await send(alice, { name: 'photo.jpg', type: 'image/jpeg', data: PHOTO.subarray(0, 200) }), cut);
      refused(await inline(alice, PHOTO.subarray(0, 200), { filename: 'photo.jpg' }), cut);
      await put(alice, id(3), PHOTO.subarray(0, 200));
      refused(await uploaded(alice, id(3)), cut);

      expect(await ctx.db.selectFrom('content').select('id').execute()).toEqual([]);
      expect(await kept()).toEqual([]);
    });

    it('checks an uploaded image when it stores it, not when it first looks: the upload may be replaced meanwhile', async () => {
      const alice = await ctx.register('alice');
      const first = await send(alice, { name: 'pixel.png', type: 'image/png', data: PNG });
      const { contentId } = first.json();
      const before = await ctx.content.getMeta(contentId);
      ctx.clock.now += 1000;

      // By another image, by one that is cut short, by an image past the limit: each as an update, which then changes nothing.
      const large = pngWith(pngChunk('IDAT', Buffer.alloc(1000)));
      for (const [bytes, status] of [[GIF, 400], [PNG.subarray(0, -4), 400], [SVG, 400], [large, 413]] as const) {
        await put(alice, id(1), PNG);
        replacedBy(alice, bytes);
        const res = await uploaded(alice, id(1), { contentId });
        expect(res.statusCode, res.body).toBe(status);
        if (status === 400) expect(res.json().error).toBe('the file is not a complete, well-formed image/png image');
        expect((await raw(contentId)).rawPayload.equals(PNG)).toBe(true);
        expect(await ctx.content.getMeta(contentId)).toEqual(before);
      }
      // And as a new post, of which nothing is kept.
      await put(alice, id(2), PNG);
      replacedBy(alice, GIF);
      expect((await uploaded(alice, id(2))).statusCode).toBe(400);
      expect(await ctx.db.selectFrom('content').select('id').execute()).toEqual([{ id: contentId }]);
      expect(await kept()).toEqual([contentId, `${contentId}.meta.json`]);

      // Replaced by a photo of the same type, it is that photo that is stored, without its metadata.
      await put(alice, id(3), JPEG);
      replacedBy(alice, PHOTO);
      const res = await uploaded(alice, id(3));
      expect(res.statusCode, res.body).toBe(201);
      expect((await raw(res.json().contentId)).rawPayload.equals(PHOTO_STRIPPED)).toBe(true);
      expect(await ctx.content.getMeta(res.json().contentId)).toMatchObject({ size: PHOTO_STRIPPED.length });
    });

    it('serves a post’s bytes as something to show and nothing more', async () => {
      const alice = await ctx.register('alice');
      const shown = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox";
      // A video's or audio's type is its sender's word, and its bytes are whatever was sent: here a page with a script.
      const posts: [Awaited<ReturnType<typeof send>>, string, string][] = [
        [await send(alice, { name: 'pixel.png', type: 'image/png', data: PNG }), 'image/png', shown],
        [await store(alice, { type: 'text', tags: ['news'], text: '<script>alert(document.domain)</script>' }), 'text/plain', shown],
        [await store(alice, { type: 'link', tags: ['news'], url: 'https://news.example/a' }), 'text/uri-list', shown],
        [await store(alice, { type: 'video', tags: ['clips'], content: SVG.toString(), contentType: 'video/mp4' }), 'video/mp4', `${shown} allow-same-origin`],
        [await store(alice, { type: 'audio', tags: ['clips'], content: SVG.toString(), contentType: 'audio/mpeg' }), 'audio/mpeg', `${shown} allow-same-origin`],
      ];
      for (const [res, type, policy] of posts) {
        expect(res.statusCode, res.body).toBe(201);
        const { headers } = await raw(res.json().contentId);
        expect(headers['content-type']).toBe(type);
        expect(headers['x-content-type-options']).toBe('nosniff');
        expect(headers['content-security-policy']).toBe(policy);
      }
    });
  });
}
