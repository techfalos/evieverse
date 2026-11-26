import { addon } from '../native.js';

/**
 * A request to an address that somebody else chose: the one place the server asks a host it has
 * no reason to trust (another server's keys, originKeys.ts; the compactor asks one the same way for
 * its attestation of a post this server holds a repost of, compactor/src/sweep.rs). Whoever
 * names the address could name one that only this server can reach (the cloud's metadata service, the database's host, a
 * neighbour in its network), and have the server ask it for them. So a request is made only:
 *
 * - over https, to a certificate that is the host's, on the port https has (443) and no other:
 *   a server answers for itself there, and the request is no way to try a host's other ports;
 * - to an address on the public internet, checked on the addresses the name resolves to as the
 *   connection is made, so that a name can't resolve to one address when it is checked and to
 *   another when it is connected to;
 * - once: a redirect isn't followed, since where it leads was checked by nobody;
 * - for a short time, and a small answer.
 *
 * The rules are Rust's (compactor/crates/core/src/public_fetch.rs), which the compactor asks
 * other servers by too: these are that code's, reached through the addon (src/native.ts).
 */

/** Whether `address` is an IP address on the public internet. One that isn't an IP address is not. */
export function isPublicAddress(address: string): boolean {
  return addon().isPublicAddress(address);
}

/**
 * What the server at `address` answers a GET with, read as JSON, under the rules above. Throws for
 * an address that isn't https, names a port or isn't public, an answer that isn't 200 (a redirect
 * among them), that is too long or too late, or that isn't JSON.
 */
export async function fetchPublicJson(address: string): Promise<unknown> {
  return JSON.parse(await addon().fetchPublicJson(address));
}
