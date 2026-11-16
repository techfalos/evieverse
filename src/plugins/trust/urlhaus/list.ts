import type { Config } from '../../../config.js';
import type { TrustContext } from '../../../moderation/trust.types.js';
import { addressOf, beforeStepsBack, endings } from './links.js';
import type { Link } from './links.types.js';
import type { Listed } from './list.types.js';

/**
 * Whether `link` is on the list. It is when it is a listed URL:
 * - as the text has it, or ending at any of the places it could end (see `endings`);
 * - with a query added, if the listed URL has none: that changes nothing of what it serves;
 * - with anything written after it, unless the listed URL ends in a slash. A server gives the
 *   same file for example.com/a.exe/x as for example.com/a.exe, and a text can go on right after
 *   a link (as the server's own reading of "[a](example.com/a.exe)b" does), so a link that starts
 *   with a listed file's address is that file's. A listed folder, or a host's front page, isn't
 *   matched so: every other page of the host would be.
 */
export function isListed({ hosts, urls }: Listed, link: Link): boolean {
  for (const origin of link.origins) {
    const host = addressOf(origin)?.host;
    // Nothing on that host is listed, which is so of nearly every link: no need to read on.
    const longest = host === undefined ? undefined : hosts.get(host);
    if (longest === undefined) continue;
    for (const tail of endings(link.tail)) {
      const address = addressOf(origin + tail);
      if (address && (urls.has(address.full) || urls.has(address.path))) return true;
    }
    for (const tail of beforeStepsBack(link.tail)) {
      const address = addressOf(origin + tail);
      if (!address) continue;
      if (urls.has(address.full) || urls.has(address.path)) return true;
      // Each start of it that could be a listed URL: longer than the host and its slash, and no longer than the host's longest.
      const { full } = address;
      // 512 characters is the longest listed URL that a link is taken for when it only starts with it. A longer one is matched whole.
      for (let end = Math.min(full.length - 1, longest, 512); end > address.host.length + 1; end--) {
        if (full[end - 1] !== '/' && urls.has(full.slice(0, end))) return true;
      }
    }
  }
  return false;
}

/**
 * The URL of a line of the list. URLhaus writes it as a CSV, of which the URL is the first field
 * that is one, and as a plain list of URLs, one a line; either is read. Null for a comment (#),
 * and for a line with no URL.
 */
export function urlOfLine(line: string): string | null {
  const text = line.trim();
  if (text.startsWith('#')) return null;
  const start = text.search(/https?:\/\//i);
  if (start < 0) return null;
  if (start === 0) return text;
  // A field without quotes ends at the next comma.
  if (text[start - 1] !== '"') return text.slice(start).split(',', 1)[0]!;
  // A quoted one ends at the next quote that isn't doubled, which is how a CSV writes a quote.
  let url = '';
  for (let i = start; i < text.length; i++) {
    if (text[i] !== '"') url += text[i];
    else if (text[i + 1] === '"') url += text[i++];
    else break;
  }
  return url;
}

/** The lines of a response's body, read as it arrives: the list is tens of megabytes, and is never held whole. */
async function* linesOf(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let rest = '';
  for await (const chunk of body) {
    const lines = (rest + decoder.decode(chunk, { stream: true })).split('\n');
    rest = lines.pop()!;
    yield* lines;
  }
  rest += decoder.decode();
  if (rest) yield rest;
}

/** Downloads the list. The Auth-Key is part of the address, so neither is put in an error. */
async function download({ authKey, listUrl }: Config['urlhaus'], fetcher: typeof fetch): Promise<Listed> {
  const key = authKey ?? '';
  const response = await fetcher(listUrl.replaceAll('{key}', encodeURIComponent(key)), {
    headers: { 'auth-key': key, 'user-agent': 'evieverse (urlhaus trust plugin)' },
    // A download may take 30 seconds. A post with a link waits for the first one.
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`URLhaus answered ${response.status}${response.status === 401 || response.status === 403 ? ': it refused the Auth-Key (URLHAUS_AUTH_KEY)' : ''}`);
  }
  const listed: Listed = { hosts: new Map(), urls: new Set() };
  for await (const line of linesOf(response.body)) {
    const url = urlOfLine(line);
    const address = url === null ? null : addressOf(url);
    if (!address) continue;
    listed.hosts.set(address.host, Math.max(listed.hosts.get(address.host) ?? 0, address.full.length));
    listed.urls.add(address.full);
  }
  // An answer that isn't the list (an error page, a list that moved) mustn't take the place of one.
  if (!listed.urls.size) throw new Error('what URLhaus answered with has no URL in it: is URLHAUS_LIST_URL one of its lists?');
  return listed;
}

type Context = Pick<TrustContext, 'config' | 'now' | 'log'>;

/** The list, and what keeps it current. One per process. */
export class MalwareList {
  private listed: Listed | null = null;
  /** The download under way, which leaves the list as it found it if it fails. */
  private download: Promise<void> | null = null;
  /** When the next download is due. */
  private dueAt = -Infinity;
  /** Why the last download failed, if it did. */
  private failure: unknown;

  constructor(private readonly fetcher: typeof fetch = fetch) {}

  /**
   * Starts a download if one is due, and doesn't wait for it: the list is replaced when it ends.
   * One that fails leaves the list there is, which is used for as long as no newer one can be had,
   * and is tried again a minute later. The log is told either way.
   */
  refresh({ config, now, log }: Context): void {
    if (this.download || now() < this.dueAt) return;
    // A minute from now the next one is tried, if this one fails.
    this.dueAt = now() + 60_000;
    this.download = download(config.urlhaus, this.fetcher)
      .then(
        (listed) => {
          this.listed = listed;
          this.failure = undefined;
          this.dueAt = now() + config.urlhaus.refreshMinutes * 60_000;
          log?.info({ urls: listed.urls.size, hosts: listed.hosts.size }, "urlhaus: downloaded URLhaus's list of malware URLs");
        },
        (err: unknown) => {
          this.failure = err;
          log?.error({ err, stale: this.listed !== null }, "urlhaus: URLhaus's list of malware URLs couldn't be downloaded");
        },
      )
      .finally(() => {
        this.download = null;
      });
  }

  /**
   * The list, current or not. A process that has none yet waits for its first download, and
   * throws if that fails: there is then nothing to check a link with.
   */
  async get(ctx: Context): Promise<Listed> {
    this.refresh(ctx);
    if (!this.listed) await this.download;
    if (this.listed) return this.listed;
    throw new Error(
      `the urlhaus trust plugin has no list of malware URLs to check links with: ${this.failure instanceof Error ? this.failure.message : String(this.failure)}`,
      { cause: this.failure },
    );
  }
}
