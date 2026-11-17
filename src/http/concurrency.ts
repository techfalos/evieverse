import type { FastifyRequest, RouteShorthandOptions } from 'fastify';
import type { HttpError } from './errors.js';

/**
 * The hooks of a route that answers at most `max` requests at a time, in this process, and refuses
 * one more with what `refusal` makes rather than have it wait behind them (0: no hooks, so as many
 * as come). It is what holds when the requests come from more addresses than a limit by address
 * can tell apart: each costs a refusal, and the process keeps time for its other routes.
 *
 * A request holds its place from just before its handler until its response has been sent. Not
 * until the handler returns: a response that is streamed is still being made then. A client that
 * goes away early doesn't free the place before the handler is done either, as the work goes on
 * without it; from then on, the place is free once the response is closed or the connection is.
 * The connection is watched as well as the response because a response that waits its turn on a
 * connection (HTTP pipelining) is never told that the connection closed.
 */
export function atMostAtOnce(max: number, refusal: () => HttpError): Pick<RouteShorthandOptions, 'preHandler' | 'onSend'> {
  if (max <= 0) return {};
  let underWay = 0;
  // The requests that hold a place, until what they are answered with is on its way.
  const working = new WeakSet<FastifyRequest>();
  return {
    preHandler: async (req) => {
      if (underWay >= max) throw refusal();
      underWay++;
      working.add(req);
    },
    // Whatever the handler ends with comes here: what it sends, or the error it threw, as the error handler words it.
    onSend: async (req, reply) => {
      // Not one that holds a place: the refusal above is sent through here too.
      if (!working.delete(req)) return;
      const { socket } = req.raw;
      let held = true;
      // Once, whichever of the two calls it, and however often: both can, of the same close.
      const release = () => {
        if (!held) return;
        held = false;
        underWay--;
        reply.raw.removeListener('close', release);
        socket.removeListener('close', release);
      };
      // Nobody is left to send it to, so nothing more is made, and nothing would say when it ended.
      if (reply.raw.destroyed || socket.destroyed) return release();
      reply.raw.on('close', release);
      socket.on('close', release);
    },
  };
}
