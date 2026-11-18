import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RouteDeps } from '../deps.types.js';

/** The path of a challenge's audio: the id the challenge was issued with. */
const Params = z.object({ challengeId: z.string().uuid() });

/**
 * The bytes of `size` a Range header asks for, as the first and the last; null if it asks for none
 * that can be given, and undefined for a header that isn't one range of bytes, which is answered as
 * a request without one is.
 */
function byteRange(header: string | undefined, size: number): { first: number; last: number } | null | undefined {
  const asked = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '');
  if (!asked || (asked[1] === '' && asked[2] === '')) return undefined;
  // "-n" is the last n bytes.
  const first = asked[1] === '' ? Math.max(0, size - Number(asked[2])) : Number(asked[1]);
  const last = asked[1] === '' || asked[2] === '' ? size - 1 : Math.min(Number(asked[2]), size - 1);
  return first <= last ? { first, last } : null;
}

/**
 * A challenge read out, for whoever can't read its image: GET /challenges/:challengeId/audio, and
 * nothing else. Challenges are issued, and answered, by the request they are asked of, which is
 * registering (POST /register); this reads them out.
 */
export function challengeRoutes(app: FastifyInstance, { challenges }: RouteDeps) {
  /**
   * A challenge's characters read out: what its `audio` names, for people who can't read its image
   * (see Challenges.audio). A WAV, in the language the challenge came in. Whoever has the challenge
   * has its id, and nobody else does, so it takes no credentials: a page plays it as it is. It can
   * be played as often as it takes while the challenge can be answered, and is 404 from then on.
   *
   * Never kept by a cache, and never compressed: it is answered in parts to a client that asks for
   * parts (Range), which some browsers won't play audio without.
   */
  app.get('/challenges/:challengeId/audio', { compress: false }, async (req, reply) => {
    const wav = await challenges.audio(Params.parse(req.params).challengeId);
    reply.header('content-type', 'audio/wav').header('cache-control', 'no-store').header('accept-ranges', 'bytes');
    const range = byteRange(req.headers.range, wav.length);
    if (range === undefined) return reply.send(wav);
    if (range === null) return reply.status(416).header('content-range', `bytes */${wav.length}`).send();
    return reply
      .status(206)
      .header('content-range', `bytes ${range.first}-${range.last}/${wav.length}`)
      .send(wav.subarray(range.first, range.last + 1));
  });
}
