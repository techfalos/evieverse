import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { isPublicAddress } from './publicFetch.js';

/**
 * Two warnings of a TRUST_PROXY that looks wrong, each said once in a process's life. The client
 * address decides whom the limits by address count (registrations, feeds, and the reads that
 * need no key), and a server can't know what stands in front of it: it can only notice what a
 * wrong setting looks like. Neither proves anything, so neither refuses a request.
 */

/**
 * How many different public addresses must have come just before one counted address for the
 * second warning. A busy server behind a proxy it didn't count sees that many readers through
 * each of the proxy's addresses soon enough; a few don't make it. Some proxies send a request
 * again through another of their own addresses now and then (Azure Front Door was seen to, of
 * a request that waited for a container to start), and those few arrive as if there were one
 * proxy more.
 */
const DISTINCT_BEFORE = 20;

/** The most counted addresses that are remembered with what came before them; past it they are forgotten, and counted anew. */
const MAX_COUNTED = 1000;

/** The addresses a request came through, as X-Forwarded-For lists them, then the connection's own: the client first, if nobody made any up. */
function hops(forwardedFor: string | string[], connection: string | undefined): string[] {
  return [
    ...[forwardedFor]
      .flat()
      .flatMap((value) => value.split(','))
      .map((address) => address.trim())
      .filter(Boolean),
    ...(connection === undefined ? [] : [connection]),
  ];
}

/**
 * Warns of a TRUST_PROXY that names too few proxies, as far as requests show it.
 *
 * With no proxy trusted: the first request that comes with X-Forwarded-For. Behind a proxy
 * nobody told the server of, every client has the proxy's address, and they all share what one
 * address may send. A client that connects directly can send the header too.
 *
 * With some trusted, by count or by address: one counted address that came with DISTINCT_BEFORE
 * different public addresses just before it in X-Forwarded-For. That is what a proxy that
 * wasn't counted looks like: the address the server takes for the client is the proxy's, and
 * the clients are the entries before it. On a cloud whose front end has one more hop than
 * TRUST_PROXY says, every reader is then one of a few front-end addresses, and a busy server
 * refuses nearly all of them (429). It is also what a proxy of the clients' own looks like, or
 * one client that sends the header itself with an address after another, so the warning names
 * the address for whoever reads it to tell which: the request log settles it, where
 * `remoteAddress` should be the readers' own addresses on nearly every line.
 *
 * With every proxy trusted (TRUST_PROXY=true) the first address of the header is the client, and
 * nothing comes before it to count.
 */
export function warnOfUncountedProxies(app: FastifyInstance, trustProxy: Config['trustProxy']): void {
  if (trustProxy === true) return;
  let warned = false;
  if (trustProxy === false || trustProxy === 0) {
    app.addHook('onRequest', async (req) => {
      if (warned || req.headers['x-forwarded-for'] === undefined) return;
      warned = true;
      req.log.warn(
        { address: req.ip },
        'a request came with X-Forwarded-For, and TRUST_PROXY names no proxy: if this server is behind one, every client is counted as that proxy, and they share the limits on registrations, feeds and the other reads that are limited by address. Set TRUST_PROXY to the proxies in front',
      );
    });
    return;
  }

  /** The public addresses that came just before each counted address, until the warning is given. */
  const before = new Map<string, Set<string>>();
  app.addHook('onRequest', async (req) => {
    const forwardedFor = req.headers['x-forwarded-for'];
    if (warned || forwardedFor === undefined) return;
    const chain = hops(forwardedFor, req.socket.remoteAddress);
    const previous = chain[chain.lastIndexOf(req.ip) - 1];
    if (previous === undefined || previous === req.ip || !isPublicAddress(previous)) return;
    let seen = before.get(req.ip);
    if (!seen) {
      if (before.size >= MAX_COUNTED) before.clear();
      before.set(req.ip, (seen = new Set()));
    }
    seen.add(previous);
    if (seen.size < DISTINCT_BEFORE) return;
    warned = true;
    before.clear();
    req.log.warn(
      { address: req.ip, forwardedFor },
      `requests counted as coming from ${req.ip} came with ${DISTINCT_BEFORE} different public addresses just before it in X-Forwarded-For: if ${req.ip} is a proxy in front of this server (a load balancer, a gateway, a CDN) and most requests are counted as such an address (remoteAddress in the request log), TRUST_PROXY names too few proxies, and every client behind it shares the limits on registrations, feeds and the other reads that are limited by address. Count it in TRUST_PROXY, or name the proxies' addresses there. If it is a proxy of the clients' own, or one client sending the header itself, nothing is wrong`,
    );
  });
}
