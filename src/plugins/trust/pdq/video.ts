import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Config } from '../../../config.js';
import { keyframesOf } from '../../../video/ffmpeg.js';
import type { Rendition, VideoTools } from '../../../video/ffmpeg.types.js';
import { lumaOf, pdqHash, toHex } from './hash.js';
import { MAX_SIDE } from './image.js';
import { nearest } from './list.js';
import type { HashList } from './list.types.js';
import type { FrameMatch } from './video.types.js';

/**
 * Checks a video against the list, as the plugin checks an image: by the PDQ hashes of its
 * pictures. Not of every one. The video worker (src/video/worker.ts) calls this with a
 * rendition the server has just made of the video, which has a keyframe every two seconds
 * whatever the file that was sent had (see encodeVideo), and each of those is hashed as a
 * picture of its own, from the first: this is what Meta's vPDQ does with the frames it takes.
 * They are matched as an image's are: within `pdq.maxDistance` bits of a listed hash, and not
 * at all under `pdq.minQuality`, which a black or a blank picture is.
 *
 * It is the rendition that is read, and not the file as it was sent: its keyframes are where
 * the server put them, so a file made with one keyframe, or with them placed around what it
 * shows, is checked as often as any other; and it is upright, at the size it is published at.
 *
 * Returns the first picture that matches, or null if none does. A picture hashed like the one
 * before it, as in a video that stands still, isn't looked up again.
 *
 * What it doesn't see: what a video shows for less than two seconds, between two of the
 * pictures that are checked; a picture that was mirrored, rotated or cropped far; and one
 * that fills only a part of the frame, as a picture shown inside another does.
 */
export async function checkVideo(tools: VideoTools, rendition: Pick<Rendition, 'path' | 'width' | 'height'>, list: HashList, { maxDistance, minQuality }: Config['pdq'], signal?: AbortSignal): Promise<FrameMatch | null> {
  let frame = 0;
  let last = '';
  for await (const { pixels, width, height, seconds } of keyframesOf(tools, rendition, MAX_SIDE, signal)) {
    // Hashing a picture is some milliseconds of work that nothing else gets a turn in: the process's other work gets one between two.
    if (frame > 0) await nextTurn();
    const { words, quality } = pdqHash(lumaOf(pixels, 3), height, width);
    const pdq = toHex(words);
    if (quality >= minQuality && pdq !== last) {
      const match = nearest(list, words, maxDistance);
      if (match) return { ...match, pdq, quality, frame, seconds };
    }
    last = pdq;
    frame++;
  }
  return null;
}
