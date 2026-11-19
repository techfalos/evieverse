import { setImmediate as nextTurn } from 'node:timers/promises';
import { msg } from '../../../language.js';
import { MIN_TRUST_SCORE } from '../../../moderation/trust.js';
import type { TrustAlgorithm } from '../../../moderation/trust.types.js';
import { pdqHash, toHex } from './hash.js';
import { framesOf, UnreadableImage } from './image.js';
import { knownHashes, KnownHashes, nearest } from './list.js';
import { report } from './report.js';

/**
 * Known child sexual abuse material: an image whose PDQ hash is near one on the operator's list
 * of hashes of such material isn't trusted at all, and the server's admins are told of it, with
 * what a report to the authorities is written from (see report). Every image of an image post
 * is checked, new or an update, the image a comment comes with, and the avatar a user gives
 * their profile.
 *
 * PDQ is the perceptual hash Meta published for this (see hash.ts): the hash of a picture stays
 * nearly the same when it is resized, compressed again or lightly edited, so a copy is found
 * that isn't the same file. Two hashes are of the same picture when they differ in at most
 * `pdq.maxDistance` of their 256 bits. An image with too little in it to tell it by (one colour,
 * a plain gradient: a quality under `pdq.minQuality`) isn't matched, since its hash is near that
 * of every other such image. Each frame of an animated image is hashed as a picture of its own,
 * up to its 32nd.
 *
 * The list is the operator's to get (`pdq.hashList`, PDQ_HASH_LIST): hashes of this material
 * aren't published, and are given to platforms by the bodies that keep them (see .env.example).
 * Each process holds it in memory (see KnownHashes), so an image is checked against what the list
 * had when it was sent. Nothing of an image, and no hash, is sent to anyone.
 *
 * What a match leads to is the score's doing: 0, which the server's thresholds refuse (422, with
 * nothing kept as a post or a comment) unless it deletes nothing on arrival, and then hold in
 * the moderation queue. The sender is told what anyone whose post isn't trusted is told, and
 * not why: no `reason` is given. On a server that has a quarantine (QUARANTINE_SCHEME,
 * src/quarantine.ts) the file that matched is kept there, for the report its operator may have
 * to make of it, where only an admin reads it; on any other, nothing of it is kept.
 *
 * The plugin is optional: it runs on a server that names it in TRUST_OPTIONAL_PLUGINS, and on no
 * other. Where it runs, no image is published unchecked. While the process has no list, because
 * its first reading failed, a post or a comment with an image fails (500), as a plugin that fails
 * has it; one without an image is stored whatever the list does. An image that can't be decoded,
 * so that there is nothing to hash, is given a score just under the one that publishes: it waits
 * in the moderation queue for a person to look at, or is refused with the reason where the
 * server has no queue. An avatar has no queue to wait in: it is refused either way, a match
 * and an image that can't be decoded alike.
 *
 * A video is not the plugin's to check, as its pictures aren't there to read while its request
 * waits: the video worker checks it, with this folder's `checkVideo` (video.ts), before
 * anything of it is published, on a server that processes videos (VIDEO_PROCESSING).
 *
 * What it doesn't see: an audio file, a video on a server that publishes videos as they are
 * sent, an image that was mirrored, rotated or cropped far (its hash is another), the frames of
 * an animation past the 32nd, an ad's image, and the image of a repost of a post on another
 * server, which this server never holds.
 *
 * `fetcher` is what downloads a list that is at an address: fetch, unless a test gives its own.
 * `known` is the list it checks against: one of its own, unless it is given the process's.
 */
export function pdq(fetcher?: typeof fetch, known: KnownHashes = new KnownHashes(fetcher)): TrustAlgorithm {
  return {
    optional: true,
    async assess(post, ctx) {
      const images = post.images ?? [];
      if (!images.length) {
        // Nothing to check, but the list is kept current for the post that has.
        known.refresh(ctx);
        return null;
      }
      const list = await known.get(ctx);
      const { maxDistance, minQuality } = ctx.config.pdq;
      let unreadable = false;
      for (const image of images) {
        try {
          let frame = 0;
          for await (const { luma, rows, cols } of framesOf(await image.file())) {
            // Hashing a frame is some milliseconds of work that nothing else gets a turn in: other requests get one between two frames.
            if (frame > 0) await nextTurn();
            const { words, quality } = pdqHash(luma, rows, cols);
            const match = quality < minQuality ? null : nearest(list, words, maxDistance);
            if (match) {
              await report(post, ctx, { ...match, image, sha256: await image.sha256(), pdq: toHex(words), quality, frame });
              return { set: MIN_TRUST_SCORE };
            }
            frame++;
          }
        } catch (err) {
          if (!(err instanceof UnreadableImage)) throw err;
          unreadable = true;
          ctx.log?.warn({ err, userId: post.userId, filename: image.filename, mimeType: image.mimeType }, "pdq: an image couldn't be decoded, so it wasn't checked against the list");
        }
      }
      if (!unreadable) return null;
      // Just under what publishes: held for a person to look at, or refused where the server has no queue.
      return {
        set: ctx.config.trust.allowFrom - 1,
        reason: msg(post.profile ? 'user.avatar_unreadable' : post.commentOn === undefined ? 'moderation.image_unreadable' : 'comment.image_unreadable'),
      };
    },
  };
}

export default pdq(undefined, knownHashes());
