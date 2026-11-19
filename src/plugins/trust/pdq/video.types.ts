import type { Match } from './list.types.js';

/** A picture of a video that matched the list (see checkVideo), and how. */
export interface FrameMatch extends Match {
  /** The picture's own PDQ hash, as it is written. */
  pdq: string;
  /** That hash's quality, from 0 to 100. */
  quality: number;
  /** Which of the pictures that were checked it is, from 0. */
  frame: number;
  /** Where in the video it is, in seconds from its start. */
  seconds: number;
}
