import { promisify } from 'node:util';
import { brotliCompress, brotliDecompressSync, constants } from 'node:zlib';
import type { Operator } from 'opendal';
import { mediaUrl, originMediaUrl, readPreview, type StoredPreview } from '../posts.js';
import { DAY, utcDay } from '../time.js';
import { Lru, mapLimit } from '../util.js';
import type { Origin } from './contentStore.types.js';
import type { HotStore } from './hotStore.types.js';
import { createOperator, isNotFound, readObject } from './opendal.js';
import type { Summary, SummaryRef, SummaryStoreOptions } from './summaryStore.types.js';

/** zlib's `brotliCompress` as a promise: what SummaryStore.compress compresses a summary's text with. */
const compress = promisify(brotliCompress);
/**
 * The most one call has under way at the object store at once: summaries being read (getMany),
 * summaries being looked for, and written where one is missing (ensureMany), or copies being
 * deleted (remove).
 */
const STORE_CONCURRENCY = 32;

/** The Redis key of a piece of content's summary: one key, under however many days the object store keeps it. */
export const summaryKey = (r: { contentId: string }) => `sum:${r.contentId}`;
/** The object-store prefix of the summaries kept under a UTC day: the day's number (see utcDay), as five digits, which is how purgeBefore knows a day. */
const dayPrefix = (day: number) => `summaries/${String(day).padStart(5, '0')}/`;
/** Where a piece of content's summary is kept under one UTC day: its Brotli-compressed bytes, named by the content's id. */
const objectKey = (contentId: string, day: number) => `${dayPrefix(day)}${contentId}.br`;
/** Where a feed reads the summary of an entry placed at `createdAt`. */
export const summaryObjectKey = (r: { contentId: string; createdAt: number }) => objectKey(r.contentId, utcDay(r.createdAt));
/** Every key a summary is kept under: one for the day the content was created, and one for each day it was reposted. */
const summaryObjectKeys = (r: SummaryRef) => [...new Set([r.createdAt, ...(r.repostedAt ?? [])].map(utcDay))].map((day) => objectKey(r.contentId, day));
/** The latest time a summary is found by: for as long as that is young, Redis keeps the summary. */
const latest = (r: SummaryRef) => Math.max(r.createdAt, ...(r.repostedAt ?? []));

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
 *
 * The summary of a repost of a post on another server has a fifth number, 1, and with it a sixth
 * header line, for the original: its address, then its publisher's id and username there,
 * separated by single spaces (neither of the first two holds one). Its image's, video's or audio's
 * URL is built from that address. Any other summary is as it was before there were reposts.
 */
export function encodeSummary(s: Summary): string {
  return [
    `${s.createdAt} ${s.updatedAt} ${s.aiGenerated ? 1 : 0} ${s.comments ? 1 : 0}${s.origin ? ' 1' : ''}`,
    s.userId,
    s.mimeType,
    s.tags.join(' '),
    s.preview.kind,
    ...(s.origin ? [`${s.origin.url} ${s.origin.publisher.userId} ${s.origin.publisher.username}`] : []),
    // What a summary holds after its header: a text post's text or a caption, or a link's URL.
    s.preview.kind === 'link' ? s.preview.url : (s.preview.text ?? ''),
  ].join('\n');
}

/** The original a summary's sixth header line names. */
function storedOrigin(contentId: string, line: string): Origin {
  const [url, userId, ...username] = line.split(' ');
  if (!url || !userId || !username.length) throw new Error(`summary of ${contentId} names no original`);
  return { url, publisher: { userId, username: username.join(' ') } };
}

/**
 * The summary that `text` holds, as encodeSummary wrote it, of the content with this id, which the
 * text doesn't say. An image's, video's or audio's URL is built here: from `publicBaseUrl` and the
 * id, or for a repost of a post on another server, from the original's address. `repostedAt` is
 * never set. Throws if the text ends before its header does, names a preview kind that is none of
 * a post's, or says it has an original and names none.
 */
export function decodeSummary(contentId: string, text: string, publicBaseUrl: string): Summary {
  const lines: string[] = [];
  let pos = 0;
  const line = () => {
    const nl = text.indexOf('\n', pos);
    if (nl < 0) throw new Error(`summary of ${contentId} is truncated`);
    lines.push(text.slice(pos, nl));
    pos = nl + 1;
  };
  for (let i = 0; i < 5; i++) line(); // the header's lines (see encodeSummary)
  const [createdAt, updatedAt, ai, comments, reposted] = lines[0]!.split(' ').map(Number);
  if (reposted === 1) line();
  const origin = reposted === 1 ? storedOrigin(contentId, lines[5]!) : undefined;
  return {
    contentId,
    createdAt: createdAt!,
    updatedAt: updatedAt!,
    userId: lines[1]!,
    mimeType: lines[2]!,
    aiGenerated: ai === 1,
    comments: comments === 1,
    tags: lines[3] ? lines[3].split(' ') : [],
    preview: readPreview(storedPreview(contentId, lines[4]!, text.slice(pos)), origin ? originMediaUrl(origin) : mediaUrl(publicBaseUrl, contentId)),
    ...(origin && { origin }),
  };
}

/**
 * Feed summaries, Brotli-compressed, one per piece of content (not one per hashtag); an update
 * writes over it. The object store holds every summary for the retention period under
 * summaries/<createdAt day>/, so a day past retention is deleted as a whole. Redis holds the same
 * bytes until the post is `hotDays` old: reads of younger posts take one MGET; older posts, and
 * anything Redis lost, are read from the object store (and the hot copy is restored while it's
 * still due).
 *
 * Content that was reposted is in indexes at the time of the repost as well as at its own (see
 * SummaryRef), and a repost can be of a post older than the retention period. So its summary is
 * also under the day of each repost, where the entries the repost made find it, and where it
 * lasts as long as they do; and Redis holds it until the latest repost is `hotDays` old. It is
 * still one summary: every copy is written by the same write, with the same bytes.
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

  /** How much longer a post created, or reposted, at `createdAt` counts as hot; zero or less once that is `hotDays` ago. */
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

  /** Writes the object store, under every day the summary is kept (see SummaryRef), then Redis while the post, or its latest repost, is younger than `hotDays`. */
  async put(s: Summary, blob?: Buffer): Promise<void> {
    blob ??= await this.compress(s);
    for (const key of summaryObjectKeys(s)) {
      await this.op.write(key, blob);
      this.cache.delete(key);
    }
    const ttl = this.hotTtl(latest(s));
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
    const hot = list.map((s) => this.hotTtl(latest(s)) > 0);
    const found = await this.hot.exists(list.filter((_, i) => hot[i]).map(summaryKey));
    let next = 0;
    const inHot = hot.map((due) => (due ? found[next++]! : true));
    const errors: (Error | null)[] = list.map(() => null);
    await mapLimit([...list.keys()], STORE_CONCURRENCY, async (i) => {
      const s = list[i]!;
      try {
        // Every copy: one under a day the content was reposted on is the only one an entry of that day finds.
        if ((await Promise.all(summaryObjectKeys(s).map((key) => this.op.exists(key)))).includes(false)) await this.put(s);
        else if (!inHot[i]) await this.hot.set(summaryKey(s), await this.compress(s), this.hotTtl(latest(s)));
      } catch (err) {
        errors[i] = err instanceof Error ? err : new Error(String(err));
      }
    });
    return errors;
  }

  /**
   * The summaries, in order; null where neither tier has one (e.g. erased since it was planned).
   * Each is found by the time of the index entry it is read for (`createdAt`), which is the
   * content's creation or a repost of it (see SummaryRef).
   */
  async getMany(refs: { contentId: string; createdAt: number }[]): Promise<(Summary | null)[]> {
    const blobs: (Buffer | null)[] = refs.map(() => null);
    const hot: number[] = [];
    const cold: number[] = [];
    refs.forEach((r, i) => (this.hotTtl(r.createdAt) > 0 ? hot : cold).push(i));
    if (hot.length) {
      const got = await this.hot.mget(hot.map((i) => summaryKey(refs[i]!)));
      hot.forEach((i, k) => (got[k] ? (blobs[i] = got[k]) : cold.push(i)));
    }
    await mapLimit(cold, STORE_CONCURRENCY, async (i) => {
      const ref = refs[i]!;
      const key = summaryObjectKey(ref);
      const cached = this.cache.get(key);
      let blob = cached && this.now() - cached.at < this.opts.cacheSeconds * 1000 ? cached.blob : null;
      if (!blob) {
        blob = await readObject(this.op, key);
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
   * Erases one summary from both tiers, every copy of it (see SummaryRef), and fails if it can't:
   * for content that must leave feeds now, which leave out a record with no summary. One that
   * isn't there is no error.
   */
  async erase(r: SummaryRef): Promise<void> {
    for (const key of summaryObjectKeys(r)) {
      this.cache.delete(key);
      await this.op.delete(key);
    }
    await this.hot.del([summaryKey(r)]);
  }

  /** Erases the summaries from both tiers, every copy of each, as far as it can: one it couldn't is left behind. */
  async remove(refs: SummaryRef[]): Promise<void> {
    if (!refs.length) return;
    const keys = refs.flatMap(summaryObjectKeys);
    for (const key of keys) this.cache.delete(key);
    await mapLimit(keys, STORE_CONCURRENCY, (key) => this.op.delete(key).catch(() => {}));
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
}
