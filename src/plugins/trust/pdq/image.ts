import { lumaOf } from './hash.js';
import type { Frame } from './image.types.js';

/** The sharp package's function, which opens an image. */
type Sharp = (typeof import('sharp'))['default'];

/**
 * Reading an image for its hash: the pixels of a JPEG, PNG, GIF or WebP file, decoded by libvips
 * (the sharp package), as their luminance.
 */

/**
 * The longest side an image is hashed at. A larger one is brought down to this by this first, as
 * the reference's own tool does, since the hash is of a 64 by 64 picture of it anyway: blurring
 * the whole of a large image down to that is slow, and tells nothing more. The hash of such an
 * image is within a few bits of what the reference's tool gives it (2 of 256, measured), and of
 * what hashing it at its full size gives (up to 14), both well inside the distance hashes are
 * matched at.
 */
const MAX_SIDE = 512;
/**
 * The most frames of an animated GIF or WebP that are read: its first ones. Each is hashed, as a
 * picture of its own. What comes after them in a longer animation isn't looked at.
 */
export const MAX_FRAMES = 32;
/** The longest decoding an image may take, in seconds, after which it is given up as unreadable. */
const DECODE_SECONDS = 30;

/** Thrown for a file whose pixels can't be read: it isn't an image libvips decodes, is too large for it, or is damaged past showing. */
export class UnreadableImage extends Error {
  constructor(cause: unknown) {
    super(`the image can't be decoded: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

/** The pixels of the image in the file at `path`, its frames one under another, as `framesOf` reads them. */
async function decode(sharp: Sharp, path: string) {
  const { width, height, pages } = await sharp(path, { failOn: 'none' }).metadata();
  let image = sharp(path, { failOn: 'none', pages: Math.min(pages ?? 1, MAX_FRAMES) })
    .timeout({ seconds: DECODE_SECONDS })
    .flatten({ background: '#ffffff' });
  if (width > MAX_SIDE || height > MAX_SIDE) image = image.resize(MAX_SIDE, MAX_SIDE, { fit: 'fill' });
  return image.toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
}

/**
 * The frames of the image in the file at `path`, each as its luminance: one for a still image,
 * and the first MAX_FRAMES of an animated one, given one at a time so that only one is held as
 * its luminance. Throws UnreadableImage, before the first, for a file that can't be decoded.
 *
 * A frame is read as it shows: what is transparent in it is white, and its colours are sRGB. One
 * that is damaged is read as far as it goes, which is what a browser shows of it. One larger than
 * MAX_SIDE along a side is brought down to MAX_SIDE by MAX_SIDE, whatever its shape was: the hash
 * is of a square picture of it either way.
 */
export async function* framesOf(path: string): AsyncGenerator<Frame> {
  // Loaded when the first image is read: a server that doesn't run the plugin never loads libvips, and starts without it.
  const { default: sharp } = await import('sharp');
  // libvips keeps what it read of a file by the file's path, and would give it again for another file written there since. Each file is read once here.
  sharp.cache(false);
  let decoded: Awaited<ReturnType<typeof decode>>;
  try {
    decoded = await decode(sharp, path);
  } catch (err) {
    throw new UnreadableImage(err);
  }
  const { data, info } = decoded;
  // Of an animated image, the frames come one under another.
  const rows = info.pageHeight ?? info.height;
  for (let at = 0; at + rows <= info.height; at += rows) {
    const pixels = data.subarray(at * info.width * info.channels, (at + rows) * info.width * info.channels);
    yield { luma: lumaOf(pixels, info.channels), rows, cols: info.width };
  }
}
