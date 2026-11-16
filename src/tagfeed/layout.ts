import { randomBytes } from 'node:crypto';
import type { Preview, Publisher, Summary } from '../storage/index.js';
import { iso, utcDay, wholeSeconds } from '../time.js';

/**
 * Feed index layout in Redis, per hashtag (keys are relative to REDIS_KEY_PREFIX):
 *
 *   head:<tag>                { v: 4, manifest, mergedThrough, compactedAt } - the only overwritten index key
 *   man:<tag>:<id>            immutable: every UTC day's index key and quota
 *   day:<tag>:<gen>           immutable: one UTC day's packed index, DAY_ENTRY_BYTES per post, best first
 *   tail:<tag>:<windowStart>  list: new-post entries, tombstones and approvals, pushed by any node
 *   tails:<tag>               sorted set of the tag's tail windows
 *
 * Index entries hold what the planner needs (id, likes, creation time, and the flags feeds filter
 * on: AI-generated, and moderated); the record bodies are summaries shared by every tag (SummaryStore) plus
 * publisher credits (PublisherStore). Each day index holds the best posts of that UTC day (by likes,
 * then creation time) up to a quota that shrinks with age, so popular content stays for the whole
 * retention period.
 *
 * Each publisher's own posts have an index of the same layout, named authorIndex(userId), which
 * following feeds read. Its day indexes hold the day's newest posts instead, up to a fixed quota.
 */

/** A publisher's own index, named so no hashtag (letters, digits and _) can be the same. */
export const authorIndex = (userId: string) => `@${userId}`;
/** The publisher whose own index this is; null for a hashtag. */
export const indexAuthor = (name: string) => (name.startsWith('@') ? name.slice(1) : null);

/** A feed record, in exactly the shape the feed returns. */
export interface FeedRecord {
  contentId: string;
  publisher: Publisher;
  mimeType: string;
  aiGenerated: boolean;
  /** Whether the post takes comments, which are read at /content/:contentId/comments. */
  comments: boolean;
  preview: Preview;
  tags: string[];
  likes: number;
  /**
   * Whether a moderator of the hashtag the record is listed under has approved it there. Only on
   * the records of a hashtag's feed: moderation is per hashtag.
   */
  moderated?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** `moderated` is the record's flag in the hashtag's index it was read from; omitted where it wasn't read from one. */
export const toFeedRecord = (s: Summary, likes: number, publisher: Publisher, moderated?: boolean): FeedRecord => ({
  contentId: s.contentId,
  publisher,
  mimeType: s.mimeType,
  aiGenerated: s.aiGenerated,
  comments: s.comments,
  preview: s.preview,
  tags: s.tags,
  likes,
  ...(moderated !== undefined && { moderated }),
  createdAt: iso(s.createdAt),
  updatedAt: iso(s.updatedAt),
});

/** One post in a day index or a tail. */
export interface IndexEntry {
  contentId: string;
  /** UTC epoch ms; day indexes keep whole seconds. */
  createdAt: number;
  likes: number;
  /** Declared by the publisher at /store. */
  aiGenerated: boolean;
  /**
   * A moderator of this hashtag approved the content under it. A write never sets it: what was
   * written is yet to be moderated. The compactor does, from `tag_moderation`, when it builds a day
   * index; until then an approval line in the tail says so. Never set in a publisher's own index.
   */
  moderated: boolean;
}

/** contentId (16 bytes) | likes u32 | createdAt seconds u32 | flags u8, big-endian. */
export const DAY_ENTRY_BYTES = 25;
const U32 = 0xffffffff;
const clamp = (n: number, max: number) => Math.min(max, Math.max(0, Math.floor(n)));

/** Flag bits, in day index entries and tail lines. */
const AI_GENERATED = 1;
const MODERATED = 2;
const flagsOf = (e: IndexEntry) => (e.aiGenerated ? AI_GENERATED : 0) | (e.moderated ? MODERATED : 0);
const flagged = (flags: number) => ({ aiGenerated: (flags & AI_GENERATED) !== 0, moderated: (flags & MODERATED) !== 0 });

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
      ...flagged(buf.readUInt8(o + 24)),
    });
  }
  return out;
}

/** A tail line for a committed write of a piece of content; it takes the place of an older entry of the same content. */
export interface TailRecord extends IndexEntry {
  /** When the write was made. */
  updatedAt: number;
}

/**
 * A tail line that hides a content's entries from readers until the compactor has removed them.
 * DELETE appends one to every tag of the content; an update, to each hashtag it dropped (all of
 * them, if it sent the content to the moderation queue); a moderator removing a hashtag, to that
 * hashtag. Readers apply it whatever the cursor's anchor, so it also hides records from feed sessions
 * that started earlier. The compactor rebuilds the content's entry in that day when it merges the line.
 */
export interface Tombstone {
  tombstone: true;
  contentId: string;
  /**
   * Hides the content's entries written before this instant, which is that of the write that
   * dropped the tag (and those stamped with the same instant that were pushed before this line).
   * An entry of a later write, which gave the tag back, shows. null hides every entry: the content
   * is being deleted, or a moderator removed the hashtag from it, which no later write undoes.
   */
  before: number | null;
  /** The content's creation time, which picks the UTC day holding its entries. */
  createdAt: number;
}

/**
 * A tail line that says a moderator of the hashtag approved the content under it: readers flag the
 * content's entries pushed before the line as moderated, in the tails and in the day indexes, until
 * the compactor has set the flag in the day index itself (from `tag_moderation`, which is what
 * records the decision). An entry pushed after the line is of a later write, an update, which is
 * unmoderated again. Unlike a tombstone it is part of what a cursor pins: a feed session keeps
 * seeing each record as moderated or not as its first page did, since the feed can be filtered by it.
 */
export interface Approval {
  approval: true;
  contentId: string;
  /** The content's creation time, which picks the UTC day holding its entries. */
  createdAt: number;
}

export type TailLine = TailRecord | Tombstone | Approval;

export const isTombstone = (line: TailLine): line is Tombstone => 'tombstone' in line;
export const isApproval = (line: TailLine): line is Approval => 'approval' in line;

/** "r <id> <createdAt> <updatedAt> <flags>", "t <id> <before|*> <createdAt>" or "a <id> <createdAt>". */
export function encodeTail(e: TailLine): string {
  if (isTombstone(e)) return `t ${e.contentId} ${e.before ?? '*'} ${e.createdAt}`;
  if (isApproval(e)) return `a ${e.contentId} ${e.createdAt}`;
  return `r ${e.contentId} ${e.createdAt} ${e.updatedAt} ${flagsOf(e)}`;
}

export function decodeTail(line: string): TailLine | null {
  const [kind, contentId, a, b, flags] = line.split(' ');
  if (kind === 't' && contentId && a && b) return { tombstone: true, contentId, before: a === '*' ? null : Number(a), createdAt: Number(b) };
  if (kind === 'a' && contentId && a) return { approval: true, contentId, createdAt: Number(a) };
  if (kind === 'r' && contentId && flags) return { contentId, createdAt: Number(a), updatedAt: Number(b), likes: 0, ...flagged(Number(flags)) };
  return null;
}

export interface Head {
  v: 4;
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
  /** The most posts the index was trimmed to; when the day's quota shrinks with age, it's re-trimmed. */
  quota: number;
  count: number;
}

export interface Manifest {
  v: 4;
  tag: string;
  id: string;
  mergedThrough: number;
  createdAt: number;
  /** Newest day first. */
  days: DayRef[];
}

export const EMPTY_HEAD: Head = { v: 4, manifest: null, mergedThrough: 0, compactedAt: 0 };

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

/** Post quota of a UTC day at `ageDays` old: halves each day from `max`, never below `min`. */
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

/**
 * Order of a publisher's day indexes and of the following feed: newest first, then id. In the whole
 * seconds day indexes keep, so an entry keeps its place when the compactor moves it out of a tail.
 */
export function compareRecent(a: { createdAt: number; contentId: string }, b: { createdAt: number; contentId: string }): number {
  return (
    wholeSeconds(b.createdAt) - wholeSeconds(a.createdAt) ||
    (a.contentId < b.contentId ? -1 : a.contentId > b.contentId ? 1 : 0)
  );
}
