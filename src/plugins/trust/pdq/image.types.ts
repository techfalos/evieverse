/** One frame of an image, as `pdqHash` reads it: a still image is one, and an animated one has several. */
export interface Frame {
  /** The luminance of its pixels, from 0 to 255, a row after another. */
  luma: Float32Array;
  rows: number;
  cols: number;
}
