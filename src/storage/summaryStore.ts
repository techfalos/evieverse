import { promisify } from 'node:util';
import { brotliCompress, brotliDecompressSync, constants } from 'node:zlib';
import type { Operator } from 'opendal';
import { mediaUrl, readPreview, type StoredPreview } from '../posts.js';
import { DAY, utcDay } from '../time.js';
import { Lru, mapLimit } from '../util.js';
import type { Preview } from './contentStore.js';
import type { HotStore } from './hotStore.js';
import { createOperator, isNotFound } from './opendal.js';

const compress = promisify(brotliCompress);
const HEADER_LINES = 5;
const COLD_READS = 32;

/** Everything a feed record holds except its likes and the publisher's name. */
export interface Summary {
  contentId: string;
  createdAt: number;
  /** When the content was last written. */
  updatedAt: number;
  userId: string;
  mimeType: string;
  /** Declared by the publisher at /store. */
  aiGenerated: boolean;
  /** Whether the post takes comments, which its publisher says at /store. */
  comments: boolean;
  tags: string[];
  preview: Preview;
}

/** What locates a summary: the content's creation day picks its object-store prefix and its tier. */
export interface SummaryRef {
  contentId: string;
  createdAt: number;
}

export const summaryKey = (r: { contentId: string }) => `sum:${r.contentId}`;
const dayPrefix = (day: number) => `summaries/${String(day).padStart(5, '0')}/`;
export const summaryObjectKey = (r: SummaryRef) => `${dayPrefix(utcDay(r.createdAt))}${r.contentId}.br`;

/** What a summary holds after its header: a text post's text or a caption, or a link's URL. */
const body = (p: Preview) => (p.kind === 'link' ? p.url : (p.text ?? ''));

/** The preview a summary's kind line and body hold. */
function storedPreview(contentId: string, kind: string, text: string): StoredPreview {
  if (kind === 'link') return { kind, url: text };
  if (kind === 'text' || kind === 'image' || kind === 'video' || kind === 'audio') return { kind, text };
  throw new Error(`summary of ${contentId} has an unknown preview kind`);
}

/**
 * Plain text rather than JSON, which compresses better: a header line of numbers (when the content
 * was created and last written, 1 if AI-generated, else 0, and 1 if it takes comments, else 0), then
 * one line each for the publisher's id, MIME type, hashtags and preview kind. Everything after those
 * five lines is the preview's text: a text post's or a caption, or a link's URL. An image's, video's
 * or audio's URL isn't stored; it's built when read.
 *
 * A summary written before posts took comments has three numbers, and reads as one that takes none.
 */
export function encodeSummary(s: Summary): string {
  const numbers = `${s.createdAt} ${s.updatedAt} ${s.aiGenerated ? 1 : 0} ${s.comments ? 1 : 0}`;
  return [numbers, s.userId, s.mimeType, s.tags.join(' '), s.preview.kind, body(s.preview)].join('\n');
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
  const [createdAt, updatedAt, ai, comments] = lines[0]!.split(' ').map(Number);
  return {
    contentId,
    createdAt: createdAt!,
    updatedAt: updatedAt!,
    userId: lines[1]!,
    mimeType: lines[2]!,
    aiGenerated: ai === 1,
    comments: comments === 1,
    tags: lines[3] ? lines[3].split(' ') : [],
    preview: readPreview(storedPreview(contentId, lines[4]!, text.slice(pos)), mediaUrl(publicBaseUrl, contentId)),
  };
}

export interface SummaryStoreOptions {
  /** Posts younger than this are kept in Redis too. */
  hotDays: number;
  /** Brotli quality, 0-11. */
  quality: number;
  /** Compressed summaries from the object store kept in this process... */
  cacheSize: number;
  /** ...for this long: how long a node may go on showing a post as it was before an update. */
  cacheSeconds: number;
  publicBaseUrl: string;
}

/**
 * Feed summaries, Brotli-compressed, one per piece of content (not one per hashtag); an update
 * writes over it. The object store holds every summary for the retention period under
 * summaries/<createdAt day>/, so a day past retention is deleted as a whole. Redis holds the same
 * bytes until the post is `hotDays` old: reads of younger posts take one MGET; older posts, and
 * anything Redis lost, are read from the object store (and the hot copy is restored while it's
 * still due).
 */
export class SummaryStore {
  private readonly op: Operator;
  private readonly cache: Lru<{ blob: Buffer; at: number }>;

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
    this.cache.delete(summaryObjectKey(s));
    const ttl = this.hotTtl(s.createdAt);
    if (ttl > 0) await this.hot.set(summaryKey(s), blob, ttl);
  }

  /** Writes whichever tier is missing the summary. */
  async ensure(s: Summary): Promise<void> {
    const [err] = await this.ensureMany([s]);
    if (err) throw err;
  }

  /**
   * Writes whichever tier is missing each of the summaries: Redis is asked about them all in one
   * round trip, and the object store about several at a time. Returns, in order, what went wrong
   * with each, and null where nothing did, so one that fails doesn't keep the others from being
   * looked at.
   */
  async ensureMany(list: Summary[]): Promise<(Error | null)[]> {
    const hot = list.map((s) => this.hotTtl(s.createdAt) > 0);
    const found = await this.hot.exists(list.filter((_, i) => hot[i]).map(summaryKey));
    let next = 0;
    const inHot = hot.map((due) => (due ? found[next++]! : true));
    const errors: (Error | null)[] = list.map(() => null);
    await mapLimit([...list.keys()], COLD_READS, async (i) => {
      const s = list[i]!;
      try {
        if (!(await this.op.exists(summaryObjectKey(s)))) await this.put(s);
        else if (!inHot[i]) await this.hot.set(summaryKey(s), await this.compress(s), this.hotTtl(s.createdAt));
      } catch (err) {
        errors[i] = err instanceof Error ? err : new Error(String(err));
      }
    });
    return errors;
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
      const cached = this.cache.get(key);
      let blob = cached && this.now() - cached.at < this.opts.cacheSeconds * 1000 ? cached.blob : null;
      if (!blob) {
        blob = await this.readObject(key);
        if (!blob) return;
        this.cache.set(key, { blob, at: this.now() });
        const ttl = this.hotTtl(ref.createdAt);
        // Only where Redis has none, so a summary read just before an update never replaces the update's.
        if (ttl > 0) await this.hot.setIfAbsent(summaryKey(ref), blob, ttl).catch(() => {});
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

  /**
   * Erases one summary from both tiers, and fails if it can't: for content that must leave feeds
   * now, which leave out a record with no summary. One that isn't there is no error.
   */
  async erase(r: SummaryRef): Promise<void> {
    this.cache.delete(summaryObjectKey(r));
    await this.op.delete(summaryObjectKey(r));
    await this.hot.del([summaryKey(r)]);
  }

  /** Erases the summaries from both tiers, as far as it can: one it couldn't is left behind. */
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
