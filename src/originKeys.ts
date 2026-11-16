import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { publishedKey } from './attestation.js';
import type { PublishedKey } from './attestation.types.js';
import { fetchPublicJson } from './http/publicFetch.js';
import type { HotStore } from './storage/index.js';
import { HOUR, MINUTE } from './time.js';

/**
 * The keys other servers sign with, which is the one thing this server asks another: an
 * attestation names the address of a post (src/attestation.ts), and the keys it is checked with
 * are the ones the server at that address publishes. Everything else of a post on another server
 * is carried by the reposter's client.
 *
 * A server's keys are kept in Redis for a few hours, so a server is asked once for many reposts
 * from it. It is asked again, at most once a minute, when an attestation names a key that isn't
 * among them: that is how a new key is learnt. One that gave no keys isn't asked again for a minute.
 */

/** How long the keys a server gave are used before it is asked for them again. A key it took out is taken for no longer than this. */
const KEYS_TTL_MS = 3 * HOUR;

/** How long a server isn't asked again: after it gave no keys, and after it gave keys that an attestation's isn't among. */
const ASK_AGAIN_MS = MINUTE;

/** The most keys taken from one server: the first ones it lists. */
const MAX_KEYS = 16;

/** What gets a server's keys: the answer to a GET of `address`, read as JSON. It throws if there is none. */
export type KeyFetcher = (address: string) => Promise<unknown>;

/** What `find` answers: the key, `unknown` if the server has no key of that id, or `unavailable` if its keys couldn't be had. */
export type KeyFound = PublishedKey | 'unknown' | 'unavailable';

/** The keys of one server as Redis holds them: what it gave (null: nothing that reads as keys), when it was asked, and until when that is used. */
interface Kept {
  at: number;
  until: number;
  keys: PublishedKey[] | null;
}

/** Where the server at `base` publishes its keys: GET /repost/keys there. */
export const keysAddress = (base: string) => `${base}/repost/keys`;

/** The Redis key of the keys of the server at `base`, which is a URL of any length: its hash. */
const keptKey = (base: string) => `originkeys:${createHash('sha256').update(base).digest('hex')}`;

export class OriginKeys {
  constructor(
    private readonly hot: HotStore,
    private readonly fetcher: KeyFetcher = fetchPublicJson,
    private readonly now: () => number = Date.now,
    private readonly log?: FastifyBaseLogger,
  ) {}

  /**
   * The key with the id `kid` of the server at `base`, which is what a post's address there
   * starts with (https://other.example). From Redis, if the server's keys are there and the key
   * is among them; else the server is asked, unless it was within the last minute.
   *
   * `asking` is called before the server is asked, and not when Redis answers: it is where the
   * caller limits how often a user has this server ask others, by throwing.
   */
  async find(base: string, kid: string, asking: () => Promise<void>): Promise<KeyFound> {
    const kept = await this.kept(base);
    const known = kept?.keys?.find((key) => key.id === kid);
    if (known) return known;
    if (kept && this.now() - kept.at < ASK_AGAIN_MS) return kept.keys ? 'unknown' : 'unavailable';

    await asking();
    const at = this.now();
    const asked = await this.ask(base);
    // A server that doesn't answer now keeps the keys it gave before, for as long as they had left.
    const next: Kept = asked ? { at, until: at + KEYS_TTL_MS, keys: asked } : kept?.keys ? { ...kept, at } : { at, until: at + ASK_AGAIN_MS, keys: null };
    await this.hot.set(keptKey(base), JSON.stringify(next), Math.max(1, next.until - at));
    return next.keys ? (next.keys.find((key) => key.id === kid) ?? 'unknown') : 'unavailable';
  }

  /** What Redis holds of a server's keys, if it holds any that are still to be used. */
  private async kept(base: string): Promise<Kept | null> {
    const stored = await this.hot.get(keptKey(base));
    if (!stored) return null;
    const kept = JSON.parse(stored.toString('utf8')) as Kept;
    return kept.until > this.now() ? kept : null;
  }

  /**
   * The keys the server at `base` publishes, or null if it gave none: it didn't answer, or not
   * with a list of keys. Why is logged, and told to nobody: what this server can and can't reach
   * is not a user's to learn. A server that signs nothing answers with an empty list.
   */
  private async ask(base: string): Promise<PublishedKey[] | null> {
    try {
      const answer = (await this.fetcher(keysAddress(base))) as { keys?: unknown } | null;
      if (!Array.isArray(answer?.keys)) throw new Error('it did not answer with a list of keys');
      return answer.keys
        .slice(0, MAX_KEYS)
        .map((key: { publicKey?: unknown } | null) => publishedKey(key?.publicKey))
        .filter((key) => key !== null);
    } catch (err) {
      this.log?.warn({ err, server: base }, "could not get another server's keys, so a repost from it was refused");
      return null;
    }
  }
}
