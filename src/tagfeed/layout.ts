import { randomBytes } from 'node:crypto';
import type { Origin, Preview, Publisher, Summary } from '../storage/index.js';

/**
 * Feed index layout in Redis, per hashtag (keys are relative to REDIS_KEY_PREFIX):
 *
 *   head:<tag>                { v: 3, manifest, mergedThrough, compactedAt } - the only overwritten index key
 *   man:<tag>:<id>            immutable: every UTC day's index key and quota
 *   day:<tag>:<gen>           immutable: one UTC day's packed index, DAY_ENTRY_BYTES per post, best first
 *   tail:<tag>:<windowStart>  list: new-post entries and tombstones, pushed by any node
 *   tails:<tag>               sorted set of the tag's tail windows
 *
 * Index entries hold only what the planner needs (id, version, likes, creation time, size, and the
 * AI-generated flag feeds filter on); the record bodies are summaries shared by every tag
 * (SummaryStore) plus publisher credits (PublisherStore). Each day index holds the best posts of that
 * UTC day (by likes, then creation time) up to a quota that shrinks with age, so popular content
 * stays for the whole retention period.
 */

/** A feed record, in exactly the shape the feed returns. */
export interface FeedRecord {
  contentId: string;
  version: number;
  publisher: Publisher;
  /** Federated content only: where it lives. */
  origin?: Origin;
  mimeType: string;
  aiGenerated: boolean;
  preview: Preview;
  tags: string[];
  likes: number;
  createdAt: string;
  updatedAt: string;
}

const iso = (ms: number) => new Date(ms).toISOString();

export const toFeedRecord = (s: Summary, likes: number, publisher: Publisher): FeedRecord => ({
  contentId: s.contentId,
  version: s.version,
  publisher,
  ...(s.origin && { origin: s.origin }),
  mimeType: s.mimeType,
  aiGenerated: s.aiGenerated,
  preview: s.preview,
  tags: s.tags,
  likes,
  createdAt: iso(s.createdAt),
  updatedAt: iso(s.updatedAt),
});

/** Bytes of the record as the feed returns it; the planner budgets tokens from this. */
export const recordSize = (s: Summary, publisher: Publisher, likes = 0) => Buffer.byteLength(JSON.stringify(toFeedRecord(s, likes, publisher)));

/** One post in a day index or a tail. */
export interface IndexEntry {
  contentId: string;
  version: number;
  /** UTC epoch ms; day indexes keep whole seconds. */
  createdAt: number;
  likes: number;
  /** Bytes of the rendered feed record. */
  size: number;
  /** Declared by the publisher at /store. */
  aiGenerated: boolean;
}

/**
 * contentId (16 bytes) | likes u32 | createdAt seconds u32 | flags u8 | size u24 | version u16, big-endian.
 * Sizes were once a u32; no record comes near 16 MB, so entries written then read with no flags set.
 */
export const DAY_ENTRY_BYTES = 30;
export const MAX_VERSION = 0xffff;
const U32 = 0xffffffff;
const U24 = 0xffffff;
const clamp = (n: number, max: number) => Math.min(max, Math.max(0, Math.floor(n)));

/** Flag bits, in day index entries and tail lines. */
const AI_GENERATED = 1;
const flagsOf = (e: IndexEntry) => (e.aiGenerated ? AI_GENERATED : 0);

export function packDay(entries: IndexEntry[]): Buffer {
  const buf = Buffer.alloc(entries.length * DAY_ENTRY_BYTES);
  entries.forEach((e, i) => {
    const o = i * DAY_ENTRY_BYTES;
    const id = Buffer.from(e.contentId.replace(/-/g, ''), 'hex');
    if (id.length !== 16) throw new Error(`content id ${e.contentId} is not a UUID`);
    id.copy(buf, o);
    buf.writeUInt32BE(clamp(e.likes, U32), o + 16);
    buf.writeUInt32BE(clamp(e.createdAt / 1000, U32), o + 20);
    buf.writeUInt8(flagsOf(e), o + 24);
    buf.writeUIntBE(clamp(e.size, U24), o + 25, 3);
    buf.writeUInt16BE(e.version, o + 28);
  });
  return buf;
}

export function unpackDay(buf: Buffer): IndexEntry[] {
  const out: IndexEntry[] = [];
  for (let o = 0; o + DAY_ENTRY_BYTES <= buf.length; o += DAY_ENTRY_BYTES) {
    const h = buf.toString('hex', o, o + 16);
    out.push({
      contentId: `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`,
      likes: buf.readUInt32BE(o + 16),
      createdAt: buf.readUInt32BE(o + 20) * 1000,
      size: buf.readUIntBE(o + 25, 3),
      version: buf.readUInt16BE(o + 28),
      aiGenerated: (buf.readUInt8(o + 24) & AI_GENERATED) !== 0,
    });
  }
  return out;
}

/** A tail line for a newly committed version; it hides an older entry of the same content. */
export interface TailRecord extends IndexEntry {
  updatedAt: number;
}

/**
 * A tail line that hides a content's entries from readers until the compactor has removed them.
 * DELETE appends one to every tag of every version; a new version, to every tag of the previous one.
 * Readers apply it whatever the cursor's anchor, so it also hides records from feed sessions that
 * started earlier. The compactor rebuilds the content's day when it merges the line.
 */
export interface Tombstone {
  tombstone: true;
  contentId: string;
  /** Hides versions below this one; null hides every version. */
  below: number | null;
  /** The content's creation time, which picks the UTC day holding its entries. */
  createdAt: number;
}

export const isTombstone = (line: TailRecord | Tombstone): line is Tombstone => 'tombstone' in line;

/**
 * "r <id> <version> <createdAt> <updatedAt> <size> <flags>" or "t <id> <below|*> <createdAt>".
 * Records pushed before flags existed end at <size>, and read with no flags set.
 */
export function encodeTail(e: TailRecord | Tombstone): string {
  return isTombstone(e)
    ? `t ${e.contentId} ${e.below ?? '*'} ${e.createdAt}`
    : `r ${e.contentId} ${e.version} ${e.createdAt} ${e.updatedAt} ${e.size} ${flagsOf(e)}`;
}

export function decodeTail(line: string): TailRecord | Tombstone | null {
  const [kind, contentId, a, b, c, d, flags = '0'] = line.split(' ');
  if (kind === 't' && contentId && a && b) return { tombstone: true, contentId, below: a === '*' ? null : Number(a), createdAt: Number(b) };
  if (kind === 'r' && contentId && d) {
    const aiGenerated = (Number(flags) & AI_GENERATED) !== 0;
    return { contentId, version: Number(a), createdAt: Number(b), updatedAt: Number(c), size: Number(d), likes: 0, aiGenerated };
  }
  return null;
}

export interface Head {
  v: 3;
  /** The manifest readers should use; null until the tag's first compaction. */
  manifest: string | null;
  /** Tail windows starting before this instant are merged into the manifest's day indexes. */
  mergedThrough: number;
  compactedAt: number;
}

/** One UTC day's index. */
export interface DayRef {
  /** UTC day number (ms / DAY). */
  day: number;
  gen: string;
  /** The token quota the index was trimmed to; when the day's quota shrinks with age, it's re-trimmed. */
  quota: number;
  count: number;
}

export interface Manifest {
  v: 3;
  tag: string;
  id: string;
  mergedThrough: number;
  createdAt: number;
  /** Newest day first. */
  days: DayRef[];
}

export const EMPTY_HEAD: Head = { v: 3, manifest: null, mergedThrough: 0, compactedAt: 0 };

export const headKey = (tag: string) => `head:${tag}`;
export const manifestKey = (tag: string, id: string) => `man:${tag}:${id}`;
export const dayKey = (tag: string, gen: string) => `day:${tag}:${gen}`;
export const tailKey = (tag: string, windowStart: number) => `tail:${tag}:${windowStart}`;
export const tailIndexKey = (tag: string) => `tails:${tag}`;
export const COMPACTOR_STATE_KEY = 'compactor:state';

const pad = (n: number, width = 13) => String(n).padStart(width, '0');
const rand = () => randomBytes(4).toString('hex');

export const newManifestId = (createdAt: number, mergedThrough: number) => `${pad(createdAt)}-${pad(mergedThrough)}-${rand()}`;
export const newGenId = (day: number, createdAt: number) => `${pad(day, 5)}-${pad(createdAt)}-${rand()}`;

export const DAY = 24 * 60 * 60 * 1000;
export const utcDay = (ms: number) => Math.floor(ms / DAY);

/** Token quota of a UTC day at `ageDays` old: halves each day from `max`, never below `min`. */
export const dayQuota = (ageDays: number, max: number, min: number) => Math.max(min, Math.floor(max / 2 ** Math.max(0, ageDays)));

/** Order of day indexes and of each feed slice: UTC day desc, likes desc, newest, id. */
export function compareRecords(
  a: { createdAt: number; likes: number; contentId: string },
  b: { createdAt: number; likes: number; contentId: string },
): number {
  return (
    utcDay(b.createdAt) - utcDay(a.createdAt) ||
    b.likes - a.likes ||
    b.createdAt - a.createdAt ||
    (a.contentId < b.contentId ? -1 : a.contentId > b.contentId ? 1 : 0)
  );
}
