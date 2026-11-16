import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { crc32 } from 'node:zlib';
import { spoolToTemp, type SpooledFile } from './storage/spool.js';

/**
 * The images a post can be: the formats browsers show whose metadata `stripImage` knows how to
 * remove. Any other (SVG, which can carry scripts; HEIC, TIFF, ...) is refused.
 */
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

/** How many of a file's first bytes say which image it is. */
export const IMAGE_HEAD_BYTES = 12;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Which image a file is, by its first bytes (IMAGE_HEAD_BYTES of them), whatever its sender calls it. */
export function imageType(head: Buffer): ImageType | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  const start = head.toString('latin1', 0, 12);
  if (start.startsWith('GIF87a') || start.startsWith('GIF89a')) return 'image/gif';
  if (start.startsWith('RIFF') && start.slice(8) === 'WEBP') return 'image/webp';
  return null;
}

/** A file that can't be an image post. `type` null: it is no image the server takes. Else: it isn't a whole, well-formed image of that type. */
export class ImageError extends Error {
  constructor(public readonly type: ImageType | null) {
    super(type ? `not a well-formed ${type} file` : 'not an image of a type the server takes');
  }
}

/** Thrown where a file isn't laid out as its format says, or ends early. */
class Malformed extends Error {}

/** Bytes to write over the output once it is all written: what a format says up front about what follows. */
type Patch = { at: number; bytes: Buffer };

/** A stream of bytes, read a few at a time or passed on in runs as they come. */
class Bytes {
  /** What is read and not yet taken. */
  held: Buffer = Buffer.alloc(0);
  private readonly source: AsyncIterator<Buffer>;
  private ended = false;

  constructor(source: AsyncIterable<Buffer>) {
    this.source = source[Symbol.asyncIterator]();
  }

  /** Whether `n` more bytes are there: reads on until they are held, or the stream ends. */
  async has(n: number): Promise<boolean> {
    while (this.held.length < n && !this.ended) {
      const { done, value } = await this.source.next();
      if (done) this.ended = true;
      else if (value.length) this.held = this.held.length ? Buffer.concat([this.held, value]) : value;
    }
    return this.held.length >= n;
  }

  /** The first `n` of the bytes held. */
  shift(n: number): Buffer {
    const out = this.held.subarray(0, n);
    this.held = this.held.subarray(n);
    return out;
  }

  /** The next `n` bytes in one piece. Only for a few: they are all held at once. */
  async take(n: number): Promise<Buffer> {
    if (!(await this.has(n))) throw new Malformed();
    return this.shift(n);
  }

  /** The next `n` bytes, in pieces as they come. */
  async *pass(n: number): AsyncGenerator<Buffer> {
    for (let left = n; left > 0; ) {
      if (!(await this.has(1))) throw new Malformed();
      const part = this.shift(Math.min(left, this.held.length));
      left -= part.length;
      yield part;
    }
  }

  async skip(n: number): Promise<void> {
    for await (const _ of this.pass(n));
  }
}

// --- EXIF ---

/** As much of an EXIF block as is read to find its Orientation, which is at its start in any file a camera wrote. */
const EXIF_HEAD_BYTES = 1 << 16;
const EXIF_PREFIX = Buffer.from('Exif\0\0', 'latin1');

/**
 * The Orientation an EXIF block (a TIFF file) gives, if it turns or mirrors the image (2 to 8).
 * It is the one EXIF tag that changes how the image is shown, so the one that is kept.
 */
function orientation(tiff: Buffer): number | null {
  if (tiff.length < 8) return null;
  const order = tiff.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const u16 = (at: number) => (order === 'II' ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = (at: number) => (order === 'II' ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  if (u16(2) !== 42) return null;
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return null;
  const entries = u16(ifd);
  for (let at = ifd + 2; at < ifd + 2 + entries * 12; at += 12) {
    if (at + 12 > tiff.length) return null;
    if (u16(at) !== 0x0112) continue;
    // One SHORT, which sits in the entry itself.
    const value = u16(at + 8);
    return u16(at + 2) === 3 && u32(at + 4) === 1 && value >= 2 && value <= 8 ? value : null;
  }
  return null;
}

/** An EXIF block that says how the image is turned, and nothing else. */
const orientationOnly = (value: number) =>
  Buffer.from([0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, value, 0, 0, 0, 0, 0, 0]);

const startsWith = (bytes: Buffer, text: string) => bytes.toString('latin1', 0, text.length) === text;

// --- JPEG ---

const jpegSegment = (code: number, body: Buffer) => Buffer.concat([Buffer.from([0xff, code, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);

/**
 * A JPEG without the segments that describe it rather than draw it: EXIF (but for the Orientation),
 * XMP, IPTC, comments, thumbnails, maker's segments. What decodes the image and its colours is
 * kept: the tables, frames and scans, the JFIF header, an ICC profile, Adobe's colour transform.
 * It ends at the image's end marker: phones append more after it (a second image with EXIF of its
 * own, the video of a motion photo), which goes.
 */
async function* jpeg(r: Bytes): AsyncGenerator<Buffer> {
  yield await r.take(2);
  let exif = false;
  let scans = 0;
  for (;;) {
    if ((await r.take(1))[0] !== 0xff) throw new Malformed();
    let code = 0xff;
    // A marker may be led up to by any number of 0xFF.
    while (code === 0xff) code = (await r.take(1))[0]!;
    if (code === 0xd9) {
      if (!scans) throw new Malformed();
      yield Buffer.from([0xff, 0xd9]);
      return;
    }
    if (code === 0x00 || code === 0xd8) throw new Malformed();
    // Markers that stand alone; between segments they mean nothing.
    if (code === 0x01 || (code >= 0xd0 && code <= 0xd7)) continue;
    const length = (await r.take(2)).readUInt16BE(0);
    if (length < 2) throw new Malformed();
    const body = await r.take(length - 2);

    if (code === 0xe0) {
      // The JFIF header, without the thumbnail it can hold.
      if (startsWith(body, 'JFIF\0') && body.length >= 14) {
        const header = Buffer.from(body.subarray(0, 14));
        header[12] = header[13] = 0;
        yield jpegSegment(code, header);
      }
    } else if (code === 0xe1) {
      const turn = !exif && body.subarray(0, 6).equals(EXIF_PREFIX) ? orientation(body.subarray(6)) : null;
      if (turn) {
        exif = true;
        yield jpegSegment(code, Buffer.concat([EXIF_PREFIX, orientationOnly(turn)]));
      }
    } else if (code === 0xe2) {
      if (startsWith(body, 'ICC_PROFILE\0')) yield jpegSegment(code, body);
    } else if (code === 0xee) {
      if (startsWith(body, 'Adobe')) yield jpegSegment(code, body);
    } else if ((code >= 0xc0 && code <= 0xcf) || (code >= 0xda && code <= 0xdf)) {
      // Frames, Huffman and quantization tables, restart intervals, scans.
      yield jpegSegment(code, body);
    }
    // Anything else (other APPn, comments, reserved markers) is dropped.

    if (code === 0xda) {
      scans++;
      yield* jpegScan(r);
    }
  }
}

/** A scan's entropy-coded data, up to the next marker that isn't part of it. */
async function* jpegScan(r: Bytes): AsyncGenerator<Buffer> {
  for (;;) {
    if (!(await r.has(2))) throw new Malformed();
    const buf = r.held;
    let marker = -1;
    for (let i = buf.indexOf(0xff); i >= 0 && i < buf.length - 1; i = buf.indexOf(0xff, i)) {
      const next = buf[i + 1]!;
      // In the data: a stuffed 0xFF (FF 00), a restart marker, or a 0xFF that leads up to the next.
      if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) i += 2;
      else if (next === 0xff) i += 1;
      else {
        marker = i;
        break;
      }
    }
    if (marker >= 0) {
      if (marker > 0) yield r.shift(marker);
      return;
    }
    // A 0xFF at the very end is held back until the byte after it is read.
    yield r.shift(buf.length - (buf[buf.length - 1] === 0xff ? 1 : 0));
  }
}

// --- PNG ---

/** The chunks that draw a PNG: its pixels, palette, transparency, colour space, pixel size, and an APNG's frames. */
const PNG_KEPT = new Set([
  ...['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'pHYs', 'hIST', 'sPLT'],
  ...['cICP', 'mDCV', 'cLLI', 'acTL', 'fcTL', 'fdAT'],
]);

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * A PNG with only the chunks that draw it: text chunks (where XMP is kept too), the time, EXIF but
 * for the Orientation, and chunks of anyone's own go, and so does whatever follows the image's end.
 */
async function* png(r: Bytes): AsyncGenerator<Buffer> {
  yield await r.take(8);
  let first = true;
  let exif = false;
  let pixels = false;
  for (;;) {
    const head = await r.take(8);
    const length = head.readUInt32BE(0);
    const type = head.toString('latin1', 4, 8);
    if (length > 0x7fffffff || (first && (type !== 'IHDR' || length !== 13))) throw new Malformed();
    first = false;
    if (type === 'eXIf') {
      const tiff = await r.take(Math.min(length, EXIF_HEAD_BYTES));
      await r.skip(length - tiff.length + 4);
      const turn = exif ? null : orientation(tiff);
      if (turn) {
        exif = true;
        yield pngChunk(type, orientationOnly(turn));
      }
    } else if (PNG_KEPT.has(type)) {
      if (type === 'IEND' && !pixels) throw new Malformed();
      pixels ||= type === 'IDAT';
      yield head;
      // With its CRC.
      yield* r.pass(length + 4);
      if (type === 'IEND') return;
    } else {
      await r.skip(length + 4);
    }
  }
}

// --- GIF ---

/** The application extensions that say how a GIF plays (how often it loops) or what its colours are. */
const GIF_APPS = new Set(['NETSCAPE2.0', 'ANIMEXTS1.0', 'ICCRGBG1012']);

/** A GIF without its comments and the application extensions that only describe it (XMP is one), ending at its trailer. */
async function* gif(r: Bytes): AsyncGenerator<Buffer> {
  const head = await r.take(13);
  yield head;
  yield* gifColors(r, head[10]!);
  let images = 0;
  for (;;) {
    const [kind] = await r.take(1);
    if (kind === 0x3b) {
      if (!images) throw new Malformed();
      yield Buffer.from([0x3b]);
      return;
    }
    if (kind === 0x2c) {
      images++;
      const descriptor = await r.take(9);
      yield Buffer.from([kind]);
      yield descriptor;
      yield* gifColors(r, descriptor[8]!);
      // The LZW code size, then the pixels.
      yield await r.take(1);
      yield* gifBlocks(r, true);
    } else if (kind === 0x21) {
      const [label] = await r.take(1);
      if (label === 0xff) {
        // An application extension names its application in a first block of 11 bytes.
        const named = (await r.has(12)) && r.held[0] === 11 && GIF_APPS.has(r.held.toString('latin1', 1, 12));
        if (named) yield Buffer.from([kind, label]);
        yield* gifBlocks(r, named);
      } else {
        // Kept: graphic control (a frame's delay and transparency) and plain text, which is drawn. A comment isn't.
        const kept = label === 0xf9 || label === 0x01;
        if (kept) yield Buffer.from([kind, label!]);
        yield* gifBlocks(r, kept);
      }
    } else {
      throw new Malformed();
    }
  }
}

/** A colour table, if `packed` (of the screen or an image) says there is one. */
async function* gifColors(r: Bytes, packed: number): AsyncGenerator<Buffer> {
  if (packed & 0x80) yield* r.pass(3 * (2 << (packed & 0x07)));
}

/** A run of data sub-blocks up to and with the empty one that ends it, passed on if `keep`. */
async function* gifBlocks(r: Bytes, keep: boolean): AsyncGenerator<Buffer> {
  for (;;) {
    if (!(await r.has(1))) throw new Malformed();
    const size = r.held[0]!;
    const block = await r.take(1 + size);
    if (keep) yield block;
    if (size === 0) return;
  }
}

// --- WebP ---

/** The chunks that draw a WebP: its header, pixels, alpha, colour profile, and an animation's frames. */
const WEBP_KEPT = new Set(['VP8 ', 'VP8L', 'ALPH', 'ICCP', 'ANIM', 'ANMF']);

function riffChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(8 + data.length + (data.length & 1));
  out.write(type, 0, 'latin1');
  out.writeUInt32LE(data.length, 4);
  data.copy(out, 8);
  return out;
}

/**
 * A WebP without its EXIF chunk (but for the Orientation), its XMP chunk and chunks of anyone's
 * own. The file's size and whether it has EXIF and XMP are said at its start, before the chunks
 * are read: both are patched once they are known.
 */
async function* webp(r: Bytes, patches: Patch[]): AsyncGenerator<Buffer> {
  const head = await r.take(12);
  yield head;
  /** Of the bytes the RIFF header counts, after "WEBP". */
  let left = head.readUInt32LE(4) - 4;
  let size = 12;
  let first = true;
  /** The flags of the extended format's header, which alone can have EXIF. */
  let flags: number | undefined;
  let exif = false;
  while (left > 0) {
    if (left < 8) throw new Malformed();
    const chunk = await r.take(8);
    const type = chunk.toString('latin1', 0, 4);
    const length = chunk.readUInt32LE(4);
    // A chunk of odd length is followed by a padding byte.
    const padded = length + (length & 1);
    if (8 + padded > left) throw new Malformed();
    left -= 8 + padded;

    if (first && type !== 'VP8X' && type !== 'VP8 ' && type !== 'VP8L') throw new Malformed();
    if (type === 'VP8X') {
      if (!first || length !== 10) throw new Malformed();
      const body = Buffer.from(await r.take(padded));
      // No EXIF (until an Orientation is kept) and no XMP.
      flags = body[0]! & ~0x0c;
      body[0] = flags;
      yield chunk;
      yield body;
      size += 8 + padded;
    } else if (type === 'EXIF') {
      const read = await r.take(Math.min(length, EXIF_HEAD_BYTES));
      await r.skip(padded - read.length);
      const tiff = read.subarray(0, 6).equals(EXIF_PREFIX) ? read.subarray(6) : read;
      const turn = flags !== undefined && !exif ? orientation(tiff) : null;
      if (turn) {
        exif = true;
        const kept = riffChunk(type, orientationOnly(turn));
        yield kept;
        size += kept.length;
        patches.push({ at: 20, bytes: Buffer.from([flags! | 0x08]) });
      }
    } else if (WEBP_KEPT.has(type)) {
      yield chunk;
      yield* r.pass(padded);
      size += 8 + padded;
    } else {
      await r.skip(padded);
    }
    first = false;
  }
  if (first) throw new Malformed();
  const riffSize = Buffer.alloc(4);
  riffSize.writeUInt32LE(size - 8);
  patches.push({ at: 4, bytes: riffSize });
}

// --- Any of them ---

const STRIP: Record<ImageType, (r: Bytes, patches: Patch[]) => AsyncGenerator<Buffer>> = {
  'image/jpeg': jpeg,
  'image/png': png,
  'image/gif': gif,
  'image/webp': webp,
};

/** The source's image without its metadata. `found` is told which image it is before the first bytes are given. */
async function* stripped(source: AsyncIterable<Buffer>, found: { type?: ImageType; patches: Patch[] }, expected?: ImageType): AsyncGenerator<Buffer> {
  const r = new Bytes(source);
  await r.has(IMAGE_HEAD_BYTES);
  const type = imageType(r.held);
  if (!type || (expected && type !== expected)) throw new ImageError(expected ?? null);
  found.type = type;
  try {
    yield* STRIP[type](r, found.patches);
  } catch (err) {
    throw err instanceof Malformed ? new ImageError(type) : err;
  }
}

/** The same bytes in pieces of at least `size` (but for the last): a format read block by block gives very many small ones. */
async function* batched(parts: AsyncIterable<Buffer>, size = 1 << 16): AsyncGenerator<Buffer> {
  let held: Buffer[] = [];
  let bytes = 0;
  for await (const part of parts) {
    held.push(part);
    bytes += part.length;
    if (bytes < size) continue;
    yield Buffer.concat(held, bytes);
    held = [];
    bytes = 0;
  }
  if (bytes) yield Buffer.concat(held, bytes);
}

/**
 * Reads an image and writes it to a temp file without its metadata: where and when it was taken
 * (EXIF with its GPS position, XMP, IPTC), by what, thumbnails of what it was before it was
 * cropped, comments, and anything appended after the image. Nothing is decoded or encoded again:
 * the pixels are the ones sent, and so are what draws them right (colour profiles, transparency,
 * animation, and the EXIF Orientation, kept alone in an EXIF block of its own).
 *
 * Which image it is, is read from its first bytes: `type` is what the file is, whatever it was
 * sent as. Throws ImageError if that is none of IMAGE_TYPES, isn't `expected` (where the caller
 * already told someone what it is), or the file isn't laid out as its format says or ends early.
 */
export async function stripImage(source: Readable, tmpDir?: string, expected?: ImageType): Promise<{ type: ImageType; file: SpooledFile }> {
  const found: { type?: ImageType; patches: Patch[] } = { patches: [] };
  try {
    const file = await spoolToTemp(Readable.from(batched(stripped(source, found, expected))), tmpDir);
    try {
      if (found.patches.length) {
        const out = await open(file.path, 'r+');
        try {
          for (const { at, bytes } of found.patches) await out.write(bytes, 0, bytes.length, at);
        } finally {
          await out.close();
        }
      }
    } catch (err) {
      await file.cleanup();
      throw err;
    }
    return { type: found.type!, file };
  } finally {
    source.destroy();
  }
}
