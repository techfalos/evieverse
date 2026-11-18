import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Config } from '../../../config.js';
import type { TrustContext } from '../../../moderation/trust.types.js';
import { MINUTE } from '../../../time.js';
import { bitsOf, distance, fromHex, HASH_BITS, HASH_WORDS, toHex } from './hash.js';
import type { HashList, Match } from './list.types.js';

/** How many values a word of a hash can have: the index has a table for each, for each of a hash's words. */
const WORD_VALUES = 1 << 16;
/** How long a download of the list may take, in milliseconds. An image waits for the first one. */
const DOWNLOAD_MS = 120_000;
/** The 16-bit words with at most so many bits set, by how many: what `nearest` changes a word by to find the ones near it. */
const WITHIN: Uint16Array[] = [];

/** Whether `source`, which is `pdq.hashList`, is an address to download the list from, and not a file's path. */
const isUrl = (source: string): boolean => /^https?:\/\//i.test(source);

/** The 16-bit words that have at most `bits` bits set, fewest first. */
function within(bits: number): Uint16Array {
  let words = WITHIN[bits];
  if (!words) {
    const found: number[] = [];
    for (let set = 0; set <= bits; set++) {
      for (let word = 0; word < WORD_VALUES; word++) if (bitsOf(word) === set) found.push(word);
    }
    words = WITHIN[bits] = Uint16Array.from(found);
  }
  return words;
}

/**
 * The hash of a line of the list: the first run of exactly 64 hex digits in it, so a plain list
 * of hashes is read, one a line, and so is a CSV or a TSV that has the hash in a column. Null for
 * an empty line, a comment (#), and a line with no hash, as a header is.
 */
export function hashOfLine(line: string): string | null {
  const text = line.trim();
  if (!text || text.startsWith('#')) return null;
  return /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/i.exec(text)?.[0].toLowerCase() ?? null;
}

/**
 * The list of `size` hashes whose words are in `words`, with its index: for each of a hash's 16
 * words, and each value it can have, the hashes that have it there.
 */
function indexed(words: Uint16Array, size: number): HashList {
  const tables = HASH_WORDS * WORD_VALUES;
  const starts = new Uint32Array(tables + 1);
  for (let id = 0; id < size; id++) {
    for (let word = 0; word < HASH_WORDS; word++) starts[word * WORD_VALUES + words[id * HASH_WORDS + word]! + 1]!++;
  }
  for (let table = 0; table < tables; table++) starts[table + 1]! += starts[table]!;
  const ids = new Uint32Array(size * HASH_WORDS);
  // Where the next hash of each table goes.
  const next = starts.slice(0, tables);
  for (let id = 0; id < size; id++) {
    for (let word = 0; word < HASH_WORDS; word++) ids[next[word * WORD_VALUES + words[id * HASH_WORDS + word]!]!++] = id;
  }
  return { size, words, starts, ids };
}

/**
 * The list that `lines` hold (see hashOfLine). Throws for one with no hash in it, and for one
 * whose hashes aren't PDQ's: either mustn't take the place of a list.
 *
 * A PDQ hash sets the bits that are above the median of its 256 values, which is half of them,
 * but for values that are equal. Hashes of another kind that are written the same way (a SHA-256
 * is 64 hex digits too) have exactly half their bits set one time in twenty, so a list of which
 * fewer than half the hashes do is one of those, and would match nothing.
 */
export async function listOf(lines: AsyncIterable<string>): Promise<HashList> {
  let words = new Uint16Array(HASH_WORDS * 1024);
  let size = 0;
  let halfSet = 0;
  for await (const line of lines) {
    const hex = hashOfLine(line);
    if (hex === null) continue;
    const at = size * HASH_WORDS;
    if (at === words.length) {
      const larger = new Uint16Array(words.length * 2);
      larger.set(words);
      words = larger;
    }
    fromHex(hex, words, at);
    let set = 0;
    for (let word = 0; word < HASH_WORDS; word++) set += bitsOf(words[at + word]!);
    if (set === HASH_BITS / 2) halfSet++;
    size++;
  }
  if (!size) throw new Error('PDQ_HASH_LIST has no hash in it: a PDQ hash is 64 hex digits, and the list has one a line');
  if (halfSet * 2 < size) {
    throw new Error(
      `PDQ_HASH_LIST doesn't hold PDQ hashes: only ${halfSet} of its ${size} have half their bits set, as nearly every PDQ hash has. Are they hashes of another kind, such as SHA-256, which is 64 hex digits too?`,
    );
  }
  return indexed(words.slice(0, size * HASH_WORDS), size);
}

/**
 * The listed hash nearest the hash in `words`, if one differs from it in `most` bits or fewer.
 *
 * Two hashes that differ in so few bits differ in at most `most / 16` of them, rounded down, in
 * at least one of their 16 words. So the hashes to compare are only those that have, in some
 * word, a value that near this hash's, which the index finds: for the 31 bits hashes are matched
 * at by default, 17 values for each word. This is the multi-index hashing the reference searches
 * its own lists with.
 */
export function nearest(list: HashList, words: Uint16Array, most: number): Match | null {
  let best = most + 1;
  let found = -1;
  for (const change of within(Math.floor(most / HASH_WORDS))) {
    for (let word = 0; word < HASH_WORDS; word++) {
      const table = word * WORD_VALUES + (words[word]! ^ change);
      for (let i = list.starts[table]!; i < list.starts[table + 1]!; i++) {
        const id = list.ids[i]!;
        const bits = distance(words, 0, list.words, id * HASH_WORDS, best - 1);
        if (bits < best) {
          best = bits;
          found = id;
        }
      }
    }
    if (best === 0) break;
  }
  return found < 0 ? null : { listed: toHex(list.words, found * HASH_WORDS), distance: best };
}

/** The lines of a file or of a response's body, read as it arrives: a list can be tens of megabytes, and is never held whole as text. */
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

/** Downloads the list. The address may hold a key, and the Authorization header is one, so neither is put in an error. */
async function download(url: string, authorization: string | undefined, fetcher: typeof fetch): Promise<HashList> {
  const response = await fetcher(url, {
    headers: { 'user-agent': 'evieverse (pdq trust plugin)', ...(authorization !== undefined && { authorization }) },
    signal: AbortSignal.timeout(DOWNLOAD_MS),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(
      `the server PDQ_HASH_LIST names answered ${response.status}${response.status === 401 || response.status === 403 ? ': it refused the request (PDQ_HASH_LIST_AUTHORIZATION)' : ''}`,
    );
  }
  return listOf(linesOf(response.body));
}

type Context = Pick<TrustContext, 'config' | 'now' | 'log'>;

/** The list, and what keeps it current. One per process. */
export class KnownHashes {
  private list: HashList | null = null;
  /** The reading under way, which leaves the list as it found it if it fails. */
  private reading: Promise<void> | null = null;
  /** When the next reading is due. */
  private dueAt = -Infinity;
  /** Why the last reading failed, if it did. */
  private failure: unknown;
  /** The file the list was read from, as its size and when it was last written: one that is still that isn't read again. */
  private readFile: string | null = null;

  constructor(private readonly fetcher: typeof fetch = fetch) {}

  /** Reads the list from where `pdq.hashList` says: a file, unless it hasn't changed since it was read, or an address. */
  private async read({ hashList, authorization }: Config['pdq']): Promise<void> {
    if (hashList === undefined) throw new Error('PDQ_HASH_LIST is not set: the pdq trust plugin needs the list of hashes to match images against');
    if (isUrl(hashList)) {
      this.list = await download(hashList, authorization, this.fetcher);
      return;
    }
    const { size, mtimeMs } = await stat(hashList);
    const file = `${hashList}:${size}:${mtimeMs}`;
    if (this.list && file === this.readFile) return;
    this.list = await listOf(linesOf(createReadStream(hashList)));
    this.readFile = file;
  }

  /**
   * Starts a reading if one is due, and doesn't wait for it: the list is replaced when it ends.
   * One that fails leaves the list there is, which is used for as long as no newer one can be had,
   * and is tried again a minute later. The log is told either way.
   */
  refresh({ config, now, log }: Context): void {
    if (this.reading || now() < this.dueAt) return;
    // A minute from now the next one is tried, if this one fails.
    this.dueAt = now() + MINUTE;
    this.reading = this.read(config.pdq)
      .then(
        () => {
          this.failure = undefined;
          this.dueAt = now() + config.pdq.refreshMinutes * MINUTE;
          log?.info({ hashes: this.list?.size }, 'pdq: read the list of hashes of known child sexual abuse material');
        },
        (err: unknown) => {
          this.failure = err;
          log?.error({ err, stale: this.list !== null }, "pdq: the list of hashes of known child sexual abuse material couldn't be read");
        },
      )
      .finally(() => {
        this.reading = null;
      });
  }

  /**
   * The list, current or not. A process that has none yet waits for its first reading, and throws
   * if that fails: there is then nothing to check an image with.
   */
  async get(ctx: Context): Promise<HashList> {
    this.refresh(ctx);
    if (!this.list) await this.reading;
    if (this.list) return this.list;
    throw new Error(`the pdq trust plugin has no list of hashes to check images with: ${this.failure instanceof Error ? this.failure.message : String(this.failure)}`, {
      cause: this.failure,
    });
  }
}
