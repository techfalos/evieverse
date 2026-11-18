import { randomBytes } from 'node:crypto';
import type { Publisher, Summary } from '../storage/index.js';
import { iso, wholeSeconds } from '../time.js';
import type { FeedRecord, Head, IndexEntry, RepostMark } from './layout.types.js';

/**
 * Feed index layout in Redis, per hashtag (keys are relative to REDIS_KEY_PREFIX):
 *
 *   head:<tag>                { v: 5, manifest, compactedAt } - the only overwritten index key
 *   man:<tag>:<id>            immutable: every UTC day's index key and quota
 *   day:<tag>:<gen>           immutable: one UTC day's packed index, DAY_ENTRY_BYTES per post, best first
 *
 * Only the compactor writes them, from the feed queue in the database (`feed_queue`): a write
 * reaches the index when the compactor's next run swaps the head.
 *
 * Index entries hold what the planner needs (id, likes, creation time, and the flags feeds filter
 * on: AI-generated, and moderated); the record bodies are summaries shared by every tag (SummaryStore) plus
 * publisher credits (PublisherStore). Each day index holds the best posts of that UTC day (by likes,
 * then creation time) up to a quota that shrinks with age, so popular content stays for the whole
 * retention period.
 *
 * Each publisher's own posts have an index of the same layout, named authorIndex(userId), which
 * following feeds read. Its day indexes hold the day's newest posts instead, up to a fixed quota.
 *
 * A repost (src/reposts.ts) puts content in the index of each hashtag it gave it, and in the
 * reposter's own, as a new post: the entry's time is the repost's, which is the day it is in and
 * where feeds order it, and its likes are those since the repost. Such an entry is flagged as a
 * repost. It is still the one piece of content: the entry names it, and its summary is the same.
 */

/** contentId (16 bytes) | likes u32 | createdAt seconds u32 | flags u8, big-endian. */
export const DAY_ENTRY_BYTES = 25;
/** The most a u32 field of a day index entry holds: likes and creation seconds above it are stored as this. */
const U32 = 0xffffffff;

/** Flag bit of a day index entry: its publisher declared the content as created with AI. */
const AI_GENERATED = 1;
/** Flag bit of a day index entry: a moderator of the hashtag approved the content under it. */
const MODERATED = 2;
/** Flag bit of a day index entry: a repost put the content in the index. */
const REPOST = 4;

/** What a tag that was never compacted has for a head: no manifest, so no day index, and the tag reads as empty. */
export const EMPTY_HEAD: Head = { v: 5, manifest: null, compactedAt: 0 };

/**
 * The key the compactor keeps its progress under from one run to the next, as JSON: the instants
 * up to which it has applied likes, profile changes and hashtag counts, and the day it has purged
 * summaries up to (see `State` in src/compact/compactor.ts).
 */
export const COMPACTOR_STATE_KEY = 'compactor:state';

/** A publisher's own index, named so no hashtag (letters, digits and _) can be the same. */
export const authorIndex = (userId: string) => `@${userId}`;
/** The publisher whose own index this is; null for a hashtag. */
export const indexAuthor = (name: string) => (name.startsWith('@') ? name.slice(1) : null);

/** `moderated` is the record's flag in the hashtag's index it was read from; omitted where it wasn't read from one. */
export const toFeedRecord = (s: Summary, likes: number, publisher: Publisher, moderated?: boolean, repost?: RepostMark): FeedRecord => ({
  contentId: s.contentId,
  publisher,
  mimeType: s.mimeType,
  aiGenerated: s.aiGenerated,
  comments: s.comments,
  preview: s.preview,
  ...(s.mentions?.length && { mentions: s.mentions }),
  tags: s.tags,
  likes,
  ...(moderated !== undefined && { moderated }),
  createdAt: iso(s.createdAt),
  updatedAt: iso(s.updatedAt),
  ...(repost && { repost: { at: iso(repost.at), ...(repost.by && { by: repost.by }) } }),
  ...(s.origin && { origin: s.origin }),
});

/** `n` as a whole number from 0 to `max`: its fraction is dropped, and a value outside is brought to the nearer end. */
const clamp = (n: number, max: number) => Math.min(max, Math.max(0, Math.floor(n)));

/** The flags byte of a day index entry as the booleans an `IndexEntry` has. */
const flagged = (flags: number) => ({ aiGenerated: (flags & AI_GENERATED) !== 0, moderated: (flags & MODERATED) !== 0, repost: (flags & REPOST) !== 0 });

/**
 * A day index as it is stored: DAY_ENTRY_BYTES per entry, in the order given. An entry's time is
 * cut to whole seconds. Throws if a content id isn't a UUID.
 */
export function packDay(entries: IndexEntry[]): Buffer {
  const buf = Buffer.alloc(entries.length * DAY_ENTRY_BYTES);
  entries.forEach((e, i) => {
    const o = i * DAY_ENTRY_BYTES;
    const id = Buffer.from(e.contentId.replace(/-/g, ''), 'hex');
    if (id.length !== 16) throw new Error(`content id ${e.contentId} is not a UUID`);
    id.copy(buf, o);
    buf.writeUInt32BE(clamp(e.likes, U32), o + 16);
    buf.writeUInt32BE(clamp(e.createdAt / 1000, U32), o + 20);
    buf.writeUInt8((e.aiGenerated ? AI_GENERATED : 0) | (e.moderated ? MODERATED : 0) | (e.repost ? REPOST : 0), o + 24);
  });
  return buf;
}

/**
 * The entries `packDay` packed, in the same order, their times in ms again (of whole seconds).
 * Bytes at the end that don't make a whole entry are ignored.
 */
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

/** The key of a tag's head. `tag` is a hashtag or the name of a publisher's own index (`authorIndex`), here and in the keys below. */
export const headKey = (tag: string) => `head:${tag}`;
/** The key of the manifest `id` of a tag's index. */
export const manifestKey = (tag: string, id: string) => `man:${tag}:${id}`;
/** The key of one of a tag's day indexes: `gen` is the one its `DayRef` in the manifest names. */
export const dayKey = (tag: string, gen: string) => `day:${tag}:${gen}`;

/** `n` in decimal, with zeros in front up to `width` digits: 13 by default, which is as long as a time in epoch ms. */
const pad = (n: number, width = 13) => String(n).padStart(width, '0');
/** Eight random hex digits, which end a new id so that two made for the same instant differ. */
const rand = () => randomBytes(4).toString('hex');

/** The id of a new manifest: when it was made (`createdAt`, epoch ms, which is the compactor run's start), then random digits. */
export const newManifestId = (createdAt: number) => `${pad(createdAt)}-${rand()}`;
/**
 * The `gen` of a new day index, which its key carries: the UTC day number, when it was built
 * (`createdAt`, epoch ms, which is the compactor run's start), then random digits. A day that is
 * rebuilt gets a new one, as a day index is never overwritten.
 */
export const newGenId = (day: number, createdAt: number) => `${pad(day, 5)}-${pad(createdAt)}-${rand()}`;

/** Post quota of a UTC day at `ageDays` old: halves each day from `max`, never below `min`. */
export const dayQuota = (ageDays: number, max: number, min: number) => Math.max(min, Math.floor(max / 2 ** Math.max(0, ageDays)));

/** Order of a hashtag's day indexes and of the popular feed: likes desc, newest, id. */
export function compareRecords(
  a: { createdAt: number; likes: number; contentId: string },
  b: { createdAt: number; likes: number; contentId: string },
): number {
  return (
    b.likes - a.likes ||
    b.createdAt - a.createdAt ||
    (a.contentId < b.contentId ? -1 : a.contentId > b.contentId ? 1 : 0)
  );
}

/**
 * Order of a publisher's day indexes and of the following feed: newest first, then id. In the whole
 * seconds day indexes keep, so an entry built from the database, which has milliseconds, is ordered
 * as it will be read.
 */
export function compareRecent(a: { createdAt: number; contentId: string }, b: { createdAt: number; contentId: string }): number {
  return (
    wholeSeconds(b.createdAt) - wholeSeconds(a.createdAt) ||
    (a.contentId < b.contentId ? -1 : a.contentId > b.contentId ? 1 : 0)
  );
}
