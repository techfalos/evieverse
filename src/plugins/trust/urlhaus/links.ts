/**
 * The links in what a post or a comment has to read, and what each is compared with URLhaus's list
 * by. A link is found wherever it is written: alone, as a link post's URL is, or anywhere in a
 * text, a caption or a comment, inside whatever markup surrounds it.
 */

import type { Address, Link } from './links.types.js';

/** `url` as it is compared, the way the URL parser writes it; null if it isn't an http or https URL. */
export function addressOf(url: string): Address | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  // example.com. is example.com.
  const name = parsed.hostname.replace(/\.+$/, '');
  if (!name) return null;
  const host = parsed.port ? `${name}:${parsed.port}` : name;
  const path = host + parsed.pathname;
  return { host, path, full: path + parsed.search };
}

/** What can't be in a link, so ends it: a space, and the characters markup puts around one. Written as the inside of a character class. */
const END = '\\s<>"`';
/** The dots domain names are written with: the full stop, and the ones the URL parser reads as it. Written as the inside of a character class. */
const DOT = '.\\u3002\\uFF0E\\uFF61';

/**
 * http:// or https://, whoever it names before an @, and a host. The host is read loosely, as the
 * URL parser then says what it is: a name, an IP address however it is written, or an IPv6 one.
 */
const SCHEMED = new RegExp(`(https?:\\/\\/(?:[^${END}\\/?#\\\\@]{0,256}@)?)(\\[[0-9a-f:.]{2,45}\\]|[\\p{L}\\p{N}${DOT}\\-_%]{1,255})(:\\d{1,5})?`, 'giu');

/**
 * A host written without a scheme, as people write links and clients make them: a domain name
 * with its top-level domain, or an IPv4 address. Not what follows a letter, a slash or an @, which
 * is the rest of a word, of a URL already found, or of an email address.
 */
const BARE = new RegExp(
  '(?<![\\p{L}\\p{N}.\\-_@\\/:%])((?:[\\p{L}\\p{N}\\-_]{1,63}\\.)+\\p{L}[\\p{L}\\p{N}\\-]{1,62}|\\d{1,3}(?:\\.\\d{1,3}){3})(?::\\d{1,5})?(?![\\p{L}\\p{N}\\-_@])',
  'giu',
);

/** What follows a host that has a path, a query or a fragment. 2048 characters is the longest path and query that is read: URLhaus lists none near as long. */
const TAIL = new RegExp(`[\\/?#\\\\][^${END}]{0,2048}`, 'y');

/** What a sentence or markup puts after a host that ends the link: "see https://example.com." */
const AFTER_HOST = new RegExp(`[${DOT}_%\\-]+$`, 'u');

function tailAt(text: string, index: number): string {
  TAIL.lastIndex = index;
  return TAIL.exec(text)?.[0] ?? '';
}

/**
 * The links of `text`, and what may be one. A URL inside another's path or query is a link of its
 * own, so a redirect to a listed URL is found too.
 */
export function findLinks(text: string): Link[] {
  const links: Link[] = [];
  SCHEMED.lastIndex = 0;
  for (let match: RegExpExecArray | null; (match = SCHEMED.exec(text)); ) {
    const [whole, scheme = '', host = '', port = ''] = match;
    const tail = tailAt(text, match.index + whole.length);
    // A host with something after it is whole. One with nothing may end with what isn't its own.
    const name = port || tail ? host : host.replace(AFTER_HOST, '');
    if (name) links.push({ schemed: true, origins: [scheme + name + port], tail });
    // The next one is looked for right after the scheme, so that a URL in this one's path is found.
    SCHEMED.lastIndex = match.index + scheme.length;
  }
  for (const match of text.matchAll(BARE)) {
    const host = match[0];
    links.push({ schemed: false, origins: [`http://${host}`, `https://${host}`], tail: tailAt(text, match.index + host.length) });
  }
  return links;
}

/** What a sentence or markup puts right after a link, which isn't part of it. */
const TRAILING = new Set(`.,;:!?'")]}*_~|`);
/** What markup ends a link with before it goes on without a space, and what the server's own formatting (src/format.ts) ends an address at. */
const CLOSING = new Set(`)]}[\\'|,;!*`);

/**
 * What `tail` is if the link ends where it could. Nothing in a text marks a link's end, and any of
 * these characters may be the link's own, so each place is tried: the whole of it first, then
 * without what trails it ("… at example.com/a)."), then up to each character that could close it
 * ("[a](example.com/a)[b](…"), from the first, so that nothing written after a link hides its end.
 */
export function endings(tail: string): string[] {
  const ends = new Set([tail.length]);
  // The link is tried without up to 8 of the characters that trail it, and ending at up to 32 places in it.
  for (let end = tail.length, n = 0; end > 0 && TRAILING.has(tail[end - 1]!) && n < 8; n++) ends.add(--end);
  for (let i = 0, n = 0; i < tail.length && n < 32; i++) if (CLOSING.has(tail[i]!) && ++n) ends.add(i);
  return [...ends].map((end) => tail.slice(0, end));
}

/**
 * `tail`, and `tail` up to each segment that steps back ("/.."). The URL parser takes such a
 * segment and the one before it out of a path, so what is written after a link could otherwise
 * take the link's own path away: "example.com/a.exe/../b" is read as "example.com/b".
 */
export function beforeStepsBack(tail: string): string[] {
  const tails = [tail];
  // Each path segment that takes back the one before it: "..", however it is written.
  for (const match of tail.matchAll(/[/\\](?:\.|%2e){2}(?=[/\\?#]|$)/gi)) {
    if (tails.length > 4) break; // the most steps back that are read
    tails.push(tail.slice(0, match.index));
  }
  return tails;
}
