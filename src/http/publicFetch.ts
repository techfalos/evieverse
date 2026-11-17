import { lookup, type LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

/**
 * A request to an address that somebody else chose: the one place the server asks a host it has
 * no reason to trust (another server's keys, originKeys.ts, and its attestation of a post this
 * server holds a repost of, originSweep.ts). Whoever names the address could name
 * one that only this server can reach (the cloud's metadata service, the database's host, a
 * neighbour in its network), and have the server ask it for them. So a request is made only:
 *
 * - over https, to a certificate that is the host's, on the port https has (443) and no other:
 *   a server answers for itself there, and the request is no way to try a host's other ports;
 * - to an address on the public internet, checked on the addresses the name resolves to as the
 *   connection is made, so that a name can't resolve to one address when it is checked and to
 *   another when it is connected to;
 * - once: a redirect isn't followed, since where it leads was checked by nobody;
 * - for a short time, and a small answer.
 */

/** How long a request may take, from the name being resolved to the last byte of the answer. */
const TIMEOUT_MS = 3000;

/** The largest answer that is read. A longer one is given up on. */
const MAX_BYTES = 64 * 1024;

/**
 * The addresses that aren't the public internet's, as IANA's registries of special-purpose
 * addresses list them: this host, private networks, link-local (where clouds keep their metadata
 * services), carrier-grade NAT, documentation, multicast, what is reserved, and the IPv6 ranges
 * that carry an IPv4 address inside them, which could carry a private one: IPv4-compatible
 * (::/96, which this host's own :: and ::1 are in), IPv4-translated (::ffff:0:0:0/96), NAT64,
 * 6to4 and Teredo. And site-local (fec0::/10), which was IPv6's private range before fc00::/7.
 * An IPv4 address written as IPv6 (::ffff:10.0.0.1) is held to the IPv4 ranges.
 */
const NOT_PUBLIC = blockList(
  [
    '0.0.0.0/8',
    '10.0.0.0/8',
    '100.64.0.0/10',
    '127.0.0.0/8',
    '169.254.0.0/16',
    '172.16.0.0/12',
    '192.0.0.0/24',
    '192.0.2.0/24',
    '192.88.99.0/24',
    '192.168.0.0/16',
    '198.18.0.0/15',
    '198.51.100.0/24',
    '203.0.113.0/24',
    '224.0.0.0/4',
    '240.0.0.0/4',
  ],
  ['::/96', '::ffff:0:0:0/96', '64:ff9b::/96', '64:ff9b:1::/48', '100::/64', '2001::/23', '2001:db8::/32', '2002::/16', 'fc00::/7', 'fe80::/10', 'fec0::/10', 'ff00::/8'],
);

/** A block list of the ranges given, each as `<address>/<prefix length>`. */
function blockList(ipv4: string[], ipv6: string[]): BlockList {
  const list = new BlockList();
  for (const [ranges, family] of [[ipv4, 'ipv4'], [ipv6, 'ipv6']] as const) {
    for (const range of ranges) {
      const [address, prefix] = range.split('/');
      list.addSubnet(address!, Number(prefix), family);
    }
  }
  return list;
}

/** Whether `address` is an IP address on the public internet. One that isn't an IP address is not. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family !== 0 && !NOT_PUBLIC.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

/**
 * Resolves a name as the connection asks for it, and refuses it if any address it resolves to
 * isn't public: the connection is then made to one of the addresses that were checked.
 */
const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err, '');
    if (!addresses.length || !addresses.every(({ address }) => isPublicAddress(address))) {
      return callback(Object.assign(new Error(`${hostname} resolves to an address that isn't on the public internet`), { code: 'ENOTPUBLIC' }), '');
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  });
};

/**
 * What the server at `address` answers a GET with, read as JSON, under the rules above. Throws for
 * an address that isn't https, names a port or isn't public, an answer that isn't 200 (a redirect
 * among them), that is too long or too late, or that isn't JSON.
 */
export function fetchPublicJson(address: string): Promise<unknown> {
  return fetchPublicAnswer(address, [200], MAX_BYTES).then(({ body }) => body);
}

/**
 * The same, for an answer whose status says something too: the status, which must be one of
 * `statuses` (a redirect is never taken, whatever they are), and the body, read as JSON, of up
 * to `maxBytes`.
 */
export function fetchPublicAnswer(address: string, statuses: readonly number[], maxBytes: number): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(address);
    if (url.protocol !== 'https:') return reject(new Error(`${url.origin} is not an https address`));
    // The URL parser leaves out the port that is https's own, so one that is there is another.
    if (url.port !== '') return reject(new Error(`${url.origin} is not on the port of https, which is the only one asked`));
    // A host written as an address is connected to as it is, with no name to resolve: it is checked here.
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && !isPublicAddress(host)) return reject(new Error(`${host} is not an address on the public internet`));

    const req = request(
      url,
      {
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': 'evieverse' },
        lookup: publicLookup,
        // A connection of its own, which is closed with the request: none is kept to be used again.
        agent: false,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (!statuses.includes(status) || (status >= 300 && status < 400)) {
          req.destroy();
          return reject(new Error(`${url.origin} answered ${status}`));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) req.destroy(new Error(`${url.origin} answered with more than ${maxBytes} bytes`));
          else chunks.push(chunk);
        });
        res.on('error', reject);
        // After `end` this changes nothing: the answer was read. Before it, the answer was cut short.
        res.on('close', () => reject(new Error(`${url.origin} closed the connection before its answer ended`)));
        res.on('end', () => {
          try {
            resolve({ status, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
          } catch {
            reject(new Error(`${url.origin} did not answer with JSON`));
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}
