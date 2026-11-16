import { promisify } from 'node:util';
import { brotliCompress, brotliDecompressSync, constants } from 'node:zlib';
import type { Operator } from 'opendal';
import { Lru, mapLimit } from '../util.js';
import type { Origin, Preview } from './contentStore.js';
import type { HotStore } from './hotStore.js';
import { createOperator, isNotFound } from './opendal.js';

const compress = promisify(brotliCompress);
const DAY = 24 * 60 * 60 * 1000;
const SEPARATOR = '\u001e';
const HEADER_LINES = 6;
const COLD_READS = 32;

/** Everything a feed record holds except its likes and the publisher's name and URL. */
export interface Summary {
  contentId: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  userId: string;
  mimeType: string;
  /** Declared by the publisher at /store. */
  aiGenerated: boolean;
  tags: string[];
  preview: Preview;
  /** Federated content only. */
  origin?: Origin;
}

/** What locates a summary: the content's creation day picks its object-store prefix and its tier. */
export interface SummaryRef {
  contentId: string;
  version: number;
  createdAt: number;
}

export const summaryKey = (r: { contentId: string; version: number }) => `sum:${r.contentId}:${r.version}`;
export const summaryDay = (createdAt: number) => Math.floor(createdAt / DAY);
const dayPrefix = (day: number) => `summaries/${String(day).padStart(5, '0')}/`;
export const summaryObjectKey = (r: SummaryRef) => `${dayPrefix(summaryDay(r.createdAt))}${r.contentId}/${r.version}.br`;

export const mediaUrl = (publicBaseUrl: string, contentId: string, version: number) =>
  `${publicBaseUrl}/content/${contentId}/raw?version=${version}`;

const clean = (s: string) => s.replaceAll(SEPARATOR, '');

/**
 * Plain text rather than JSON, which compresses better: a header line of numbers (version,
 * timestamps, and 1 if AI-generated, else 0), the publisher's id, MIME type, hashtags, preview kind
 * and origin ("<server> <contentId> <version>" for federated content, else empty), then an empty
 * line, a line holding only U+001E, and the preview text (with U+001E removed). A media preview
 * stores no text; its URL is built when read, on the origin server for federated content.
 * Summaries written before the AI flag existed have three numbers, and read as not AI-generated.
 * Releases with an AI wrote its summary in place of the empty line, and need a line there to read
 * a summary; reading skips it.
 */
export function encodeSummary(s: Summary): string {
  const numbers = `${s.version} ${s.createdAt} ${s.updatedAt} ${s.aiGenerated ? 1 : 0}`;
  const origin = s.origin ? `${s.origin.server} ${s.origin.contentId} ${s.origin.version}` : '';
  const header = [numbers, s.userId, s.mimeType, s.tags.join(' '), s.preview.kind, origin];
  const preview = s.preview.kind === 'text' ? clean(s.preview.text) : '';
  return `${header.join('\n')}\n\n${SEPARATOR}\n${preview}`;
}

export function decodeSummary(contentId: string, text: string, publicBaseUrl: string): Summary {
  const lines: string[] = [];
  let pos = 0;
  for (let i = 0; i < HEADER_LINES; i++) {
    const nl = text.indexOf('\n', pos);
    if (nl < 0) throw new Error(`summary of ${contentId} is truncated`);
    lines.push(text.slice(pos, nl));
    pos = nl + 1;
  }
  const sep = text.indexOf(`\n${SEPARATOR}\n`, pos);
  if (sep < 0) throw new Error(`summary of ${contentId} has no separator`);
  const [version, createdAt, updatedAt, ai] = lines[0]!.split(' ').map(Number);
  const kind = lines[4];
  const [server, originId, originVersion] = lines[5]!.split(' ');
  const origin = server && originId && originVersion ? { server, contentId: originId, version: Number(originVersion) } : undefined;
  return {
    contentId,
    version: version!,
    createdAt: createdAt!,
    updatedAt: updatedAt!,
    userId: lines[1]!,
    mimeType: lines[2]!,
    aiGenerated: ai === 1,
    tags: lines[3] ? lines[3].split(' ') : [],
    preview:
      kind === 'text'
        ? { kind, text: text.slice(sep + 3) }
        : { kind: 'media', url: origin ? mediaUrl(origin.server, origin.contentId, origin.version) : mediaUrl(publicBaseUrl, contentId, version!) },
    ...(origin && { origin }),
  };
}

export interface SummaryStoreOptions {
  /** Posts younger than this are kept in Redis too. */
  hotDays: number;
  /** Brotli quality, 0-11. */
  quality: number;
  /** Compressed summaries from the object store kept in this process. */
  cacheSize: number;
  publicBaseUrl: string;
}

/**
 * Feed summaries, Brotli-compressed, once per content version (not once per hashtag). The object
 * store holds every summary for the retention period under summaries/<createdAt day>/, so a day
 * past retention is deleted as a whole. Redis holds the same bytes until the post is `hotDays`
 * old: reads of younger posts take one MGET; older posts, and anything Redis lost, are read from
 * the object store (and the hot copy is restored while it's still due).
 */
export class SummaryStore {
  private readonly op: Operator;
  private readonly cache: Lru<Buffer>;

  constructor(
    private readonly hot: HotStore,
    cfg: { scheme: string; options: Record<string, string> },
    private readonly opts: SummaryStoreOptions,
    private readonly now: () => number = Date.now,
  ) {
    this.op = createOperator(cfg.scheme, cfg.options);
    this.cache = new Lru(opts.cacheSize);
  }

  /** How much longer the post counts as hot; zero or less once it's `hotDays` old. */
  private hotTtl(createdAt: number) {
    return createdAt + this.opts.hotDays * DAY - this.now();
  }

  compress(s: Summary): Promise<Buffer> {
    const text = Buffer.from(encodeSummary(s));
    return compress(text, {
      params: {
        [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
        [constants.BROTLI_PARAM_QUALITY]: this.opts.quality,
        [constants.BROTLI_PARAM_SIZE_HINT]: text.length,
      },
    });
  }

  decode(contentId: string, blob: Buffer): Summary {
    return decodeSummary(contentId, brotliDecompressSync(blob).toString('utf8'), this.opts.publicBaseUrl);
  }

  /** Writes the object store, then Redis while the post is younger than `hotDays`. */
  async put(s: Summary, blob?: Buffer): Promise<void> {
    blob ??= await this.compress(s);
    await this.op.write(summaryObjectKey(s), blob);
    const ttl = this.hotTtl(s.createdAt);
    if (ttl > 0) await this.hot.set(summaryKey(s), blob, ttl);
  }

  /** Writes whichever tier is missing the summary. */
  async ensure(s: Summary): Promise<void> {
    const hot = this.hotTtl(s.createdAt) > 0;
    const [inCold, [inHot]] = await Promise.all([this.op.exists(summaryObjectKey(s)), hot ? this.hot.exists([summaryKey(s)]) : [true]]);
    if (!inCold) return this.put(s);
    if (!inHot) await this.hot.set(summaryKey(s), await this.compress(s), this.hotTtl(s.createdAt));
  }

  /** The summaries, in order; null where neither tier has one (e.g. erased since it was planned). */
  async getMany(refs: SummaryRef[]): Promise<(Summary | null)[]> {
    const blobs: (Buffer | null)[] = refs.map(() => null);
    const hot: number[] = [];
    const cold: number[] = [];
    refs.forEach((r, i) => (this.hotTtl(r.createdAt) > 0 ? hot : cold).push(i));
    if (hot.length) {
      const got = await this.hot.mget(hot.map((i) => summaryKey(refs[i]!)));
      hot.forEach((i, k) => (got[k] ? (blobs[i] = got[k]) : cold.push(i)));
    }
    await mapLimit(cold, COLD_READS, async (i) => {
      const ref = refs[i]!;
      const key = summaryObjectKey(ref);
      let blob = this.cache.get(key);
      if (!blob) {
        const read = await this.readObject(key);
        if (!read) return;
        blob = read;
        this.cache.set(key, blob);
        const ttl = this.hotTtl(ref.createdAt);
        if (ttl > 0) await this.hot.set(summaryKey(ref), blob, ttl).catch(() => {});
      }
      blobs[i] = blob;
    });
    return blobs.map((blob, i) => {
      if (!blob) return null;
      try {
        return this.decode(refs[i]!.contentId, blob);
      } catch {
        return null;
      }
    });
  }

  /** Erases the summaries from both tiers. */
  async remove(refs: SummaryRef[]): Promise<void> {
    if (!refs.length) return;
    for (const r of refs) this.cache.delete(summaryObjectKey(r));
    await mapLimit(refs, COLD_READS, (r) => this.op.delete(summaryObjectKey(r)).catch(() => {}));
    await this.hot.del(refs.map(summaryKey));
  }

  /** Deletes every day of summaries before `day`; returns the days deleted. */
  async purgeBefore(day: number): Promise<number[]> {
    let entries: string[];
    try {
      entries = (await this.op.list('summaries/')).map((e) => e.path());
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
    const days = entries
      .map((p) => /^summaries\/(\d{5})\/$/.exec(p)?.[1])
      .filter((d): d is string => d !== undefined)
      .map(Number)
      .filter((d) => d < day);
    for (const d of days) await this.op.removeAll(dayPrefix(d));
    return days;
  }

  private async readObject(key: string): Promise<Buffer | null> {
    try {
      return await this.op.read(key);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }
}
