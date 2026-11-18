import type { PdqHash } from './hash.types.js';

/**
 * PDQ, the perceptual hash of an image that Meta published (https://github.com/facebook/ThreatExchange,
 * pdq/): 256 bits that stay nearly the same when the image is resized, compressed again or
 * lightly edited, so two hashes that differ in few bits are of the same picture. This is its
 * reference implementation (pdq/cpp/hashing/pdqhashing.cpp, pdq/cpp/downscaling/downscaling.cpp)
 * in TypeScript, step for step and in its 32-bit arithmetic, so that it gives the hashes the
 * lists of hashes were made with.
 *
 * An image is hashed from its luminance: blurred and brought down to 64 by 64, of which the 16 by
 * 16 lowest frequencies are worked out (but for the constant ones), and each is one bit, set if it
 * is above their median. A hash comes with a quality from 0 to 100, which says how much there is in
 * the image to tell it by: one of a single colour has none, and its hash says nothing.
 */

/** How many bits a hash has. */
export const HASH_BITS = 256;
/** How many 16-bit words that is, which is how a hash is held (see PdqHash). */
export const HASH_WORDS = 16;
/** The side of the square an image is brought down to before its frequencies are worked out. */
const SIDE = 64;
/** How many of the lowest frequencies along each side make the hash: a bit for each pair of them. */
const FREQUENCIES = 16;
/** An image smaller than this along either side has no hash: its quality is 0. */
const MIN_SIDE = 5;
/** How many times the image is blurred along its rows and then its columns: two box filters make a tent filter. */
const BLUR_PASSES = 2;
/** How much of a pixel's luminance each of red, green and blue is, as 32-bit floats. */
const LUMA = [Math.fround(0.299), Math.fround(0.587), Math.fround(0.114)] as const;
/** The cosines the frequencies are worked out with: row i is frequency i + 1 across the 64 pixels of a side, as 32-bit floats. */
const DCT = dctMatrix();

/** The reference's DCT matrix: 16 rows of 64, the constant frequency left out. */
function dctMatrix(): Float32Array {
  const matrix = new Float32Array(FREQUENCIES * SIDE);
  const scale = Math.fround(Math.sqrt(2 / SIDE));
  for (let i = 0; i < FREQUENCIES; i++) {
    for (let j = 0; j < SIDE; j++) matrix[i * SIDE + j] = scale * Math.cos((Math.PI / 2 / SIDE) * (i + 1) * (2 * j + 1));
  }
  return matrix;
}

/**
 * The luminance of an image's pixels, from 0 to 255, a row after another: what `pdqHash` reads.
 * `pixels` holds `channels` bytes a pixel, of which the first three are red, green and blue, or the
 * only one is grey.
 */
export function lumaOf(pixels: Uint8Array, channels: number, count = pixels.length / channels): Float32Array {
  const luma = new Float32Array(count);
  if (channels < 3) {
    for (let i = 0; i < count; i++) luma[i] = pixels[i * channels]!;
    return luma;
  }
  const [r, g, b] = LUMA;
  for (let i = 0, at = 0; i < count; i++, at += channels) {
    luma[i] = Math.fround(Math.fround(Math.fround(r * pixels[at]!) + Math.fround(g * pixels[at + 1]!)) + Math.fround(b * pixels[at + 2]!));
  }
  return luma;
}

/**
 * A box filter along one row or column: each value becomes the mean of the `window` values around
 * it, or of as many of them as there are at an edge. `length` values are read from `input` at
 * `from`, each `stride` after the last, and written to the same places of `output`.
 */
function box(input: Float32Array, output: Float32Array, from: number, length: number, stride: number, window: number): void {
  const half = (window + 2) >> 1;
  let left = from;
  let right = from;
  let out = from;
  let sum = 0;
  let size = 0;
  // The first values are only added up: the window isn't centred on anything yet.
  for (let i = 0; i < half - 1; i++, right += stride) {
    sum = Math.fround(sum + input[right]!);
    size++;
  }
  // The window grows until it is whole.
  for (let i = 0; i < window - half + 1; i++, right += stride, out += stride) {
    sum = Math.fround(sum + input[right]!);
    size++;
    output[out] = sum / size;
  }
  // The whole window slides along.
  for (let i = 0; i < length - window; i++, left += stride, right += stride, out += stride) {
    sum = Math.fround(Math.fround(sum + input[right]!) - input[left]!);
    output[out] = sum / size;
  }
  // It shrinks again at the far edge.
  for (let i = 0; i < half - 1; i++, left += stride, out += stride) {
    sum = Math.fround(sum - input[left]!);
    size--;
    output[out] = sum / size;
  }
}

/** The image blurred and brought down to 64 by 64: each pixel of the result is the middle of its part of the image. `luma` is written over. */
function downsample(luma: Float32Array, rows: number, cols: number): Float32Array {
  const other = new Float32Array(luma.length);
  // Half of what one of the 64 pixels covers, since the two passes together cover all of it.
  const alongRows = Math.floor((cols + 2 * SIDE - 1) / (2 * SIDE));
  const alongCols = Math.floor((rows + 2 * SIDE - 1) / (2 * SIDE));
  for (let pass = 0; pass < BLUR_PASSES; pass++) {
    for (let i = 0; i < rows; i++) box(luma, other, i * cols, cols, 1, alongRows);
    for (let j = 0; j < cols; j++) box(other, luma, j, rows, cols, alongCols);
  }
  const square = new Float32Array(SIDE * SIDE);
  for (let i = 0; i < SIDE; i++) {
    const row = Math.floor(((i + 0.5) * rows) / SIDE);
    for (let j = 0; j < SIDE; j++) square[i * SIDE + j] = luma[row * cols + Math.floor(((j + 0.5) * cols) / SIDE)]!;
  }
  return square;
}

/**
 * How much there is in the 64 by 64 image to tell it by, from 0 to 100: the steps between
 * neighbouring pixels, counted in hundredths of the whole range so that only steps that show
 * count, and scaled by a factor the reference chose by hand.
 */
function qualityOf(square: Float32Array): number {
  let gradients = 0;
  const step = (u: number, v: number) => Math.abs(Math.trunc(Math.fround(Math.fround(Math.fround(u - v) * 100) / 255)));
  for (let i = 0; i < SIDE - 1; i++) {
    for (let j = 0; j < SIDE; j++) gradients += step(square[i * SIDE + j]!, square[(i + 1) * SIDE + j]!);
  }
  for (let i = 0; i < SIDE; i++) {
    for (let j = 0; j < SIDE - 1; j++) gradients += step(square[i * SIDE + j]!, square[i * SIDE + j + 1]!);
  }
  return Math.min(100, Math.trunc(gradients / 90));
}

/** The 16 by 16 lowest frequencies of the 64 by 64 image, the constant ones left out: D A Dt, with D the DCT matrix. */
function frequenciesOf(square: Float32Array): Float32Array {
  const half = new Float32Array(FREQUENCIES * SIDE);
  for (let i = 0; i < FREQUENCIES; i++) {
    for (let j = 0; j < SIDE; j++) {
      let sum = 0;
      for (let k = 0; k < SIDE; k++) sum = Math.fround(sum + Math.fround(DCT[i * SIDE + k]! * square[k * SIDE + j]!));
      half[i * SIDE + j] = sum;
    }
  }
  const frequencies = new Float32Array(FREQUENCIES * FREQUENCIES);
  for (let i = 0; i < FREQUENCIES; i++) {
    for (let j = 0; j < FREQUENCIES; j++) {
      let sum = 0;
      for (let k = 0; k < SIDE; k++) sum = Math.fround(sum + Math.fround(half[i * SIDE + k]! * DCT[j * SIDE + k]!));
      frequencies[i * FREQUENCIES + j] = sum;
    }
  }
  return frequencies;
}

/**
 * The median of `values`, by Torben Mogensen's method as the reference has it (torben.cpp): of an
 * even number of them, the lower of the two in the middle. It is ported and not sorted for, so
 * that equal values fall on the side of it they do there.
 */
function median(values: Float32Array): number {
  const n = values.length;
  const half = (n + 1) >> 1;
  let min = values[0]!;
  let max = min;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  for (;;) {
    const guess = Math.fround((min + max) / 2);
    let less = 0;
    let greater = 0;
    let equal = 0;
    let below = min;
    let above = max;
    for (const value of values) {
      if (value < guess) {
        less++;
        if (value > below) below = value;
      } else if (value > guess) {
        greater++;
        if (value < above) above = value;
      } else {
        equal++;
      }
    }
    if (less <= half && greater <= half) return less >= half ? below : less + equal >= half ? guess : above;
    if (less > greater) max = below;
    else min = above;
  }
}

/**
 * The PDQ hash of an image, from its luminance (see lumaOf): `rows` by `cols` values, a row after
 * another, which are written over. An image smaller than 5 along a side has no hash: all its bits
 * are 0, and so is its quality.
 */
export function pdqHash(luma: Float32Array, rows: number, cols: number): PdqHash {
  const words = new Uint16Array(HASH_WORDS);
  if (rows < MIN_SIDE || cols < MIN_SIDE) return { words, quality: 0 };
  // An image that is 64 by 64 already is taken as it is.
  const square = rows === SIDE && cols === SIDE ? luma : downsample(luma, rows, cols);
  const frequencies = frequenciesOf(square);
  const middle = median(frequencies);
  for (let bit = 0; bit < HASH_BITS; bit++) {
    if (frequencies[bit]! > middle) words[bit >> 4]! |= 1 << (bit & 15);
  }
  return { words, quality: qualityOf(square) };
}

/** A hash as it is written: 64 hex digits, its highest word first. */
export function toHex(words: Uint16Array, at = 0): string {
  let hex = '';
  for (let i = HASH_WORDS - 1; i >= 0; i--) hex += words[at + i]!.toString(16).padStart(4, '0');
  return hex;
}

/** Reads a hash as it is written into `words` at `at`. False, with nothing written, for what isn't 64 hex digits. */
export function fromHex(hex: string, words: Uint16Array, at = 0): boolean {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false;
  for (let i = 0; i < HASH_WORDS; i++) words[at + HASH_WORDS - 1 - i] = Number.parseInt(hex.slice(i * 4, i * 4 + 4), 16);
  return true;
}

/** How many bits of a 16-bit word are set. */
export function bitsOf(word: number): number {
  let v = word - ((word >> 1) & 0x5555);
  v = (v & 0x3333) + ((v >> 2) & 0x3333);
  return (((v + (v >> 4)) & 0x0f0f) * 0x0101 >> 8) & 0xff;
}

/** How many bits two hashes differ in: the hash of `a` at `aAt` and that of `b` at `bAt`. Past `most`, the count stops, and what is returned is only more than it. */
export function distance(a: Uint16Array, aAt: number, b: Uint16Array, bAt: number, most = HASH_BITS): number {
  let bits = 0;
  for (let i = 0; i < HASH_WORDS && bits <= most; i++) bits += bitsOf(a[aAt + i]! ^ b[bAt + i]!);
  return bits;
}
