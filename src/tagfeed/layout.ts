import { randomBytes } from 'node:crypto';
import type { Origin, Preview, Publisher, Summary } from '../storage/index.js';
import { iso, wholeSeconds } from '../time.js';

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
  /** When the post was published, which for a reposted one is before it was placed here (see `repost`). */
  createdAt: string;
  updatedAt: string;
  /**
   * On a record a repost put where it was read: under a hashtag the repost gave the post, or in a
   * following feed, by someone the user follows. `at` is when, which is where the feed orders the
   * record, and `likes` are those since. `by` is who reposted it, in a following feed, where the
   * record is read from their own index; a hashtag's feed doesn't say.
   */
  repost?: { at: string; by?: Publisher };
  /**
   * On a repost of a post on another server: the original, which the record is a link to, and who
   * published it there. `publisher` is who reposted it here.
   */
  origin?: Origin;
}

/** The repost that put a record where it was read: when, and by whom if the index it was read from says. */
export interface RepostMark {
  at: number;
  by?: Publisher;
}

/** `moderated` is the record's flag in the hashtag's index it was read from; omitted where it wasn't read from one. */
export const toFeedRecord = (s: Summary, likes: number, publisher: Publisher, moderated?: boolean, repost?: RepostMark): FeedRecord => ({
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
  ...(repost && { repost: { at: iso(repost.at), ...(repost.by && { by: repost.by }) } }),
  ...(s.origin && { origin: s.origin }),
});

/** One post in a day index. */
export interface IndexEntry {
  contentId: string;
  /**
   * When the content was placed in this index, which is where feeds order it: its creation, or
   * for a repost's entry, the repost. UTC epoch ms; day indexes keep whole seconds.
   */
  createdAt: number;
  /** The content's likes; for a repost's entry, those since the repost. */
  likes: number;
  /** Declared by the publisher at /store. */
  aiGenerated: boolean;
  /**
   * A moderator of this hashtag approved the content under it. The compactor sets it, from
   * `tag_moderation`, when it builds a day index. Never set in a publisher's own index.
   */
  moderated: boolean;
  /**
   * A repost put the content here: under a hashtag it gave it, or in the reposter's own index.
   * The entry's time and likes are then the repost's (see above).
   */
  repost: boolean;
}

/** contentId (16 bytes) | likes u32 | createdAt seconds u32 | flags u8, big-endian. */
export const DAY_ENTRY_BYTES = 25;
const U32 = 0xffffffff;
const clamp = (n: number, max: number) => Math.min(max, Math.max(0, Math.floor(n)));

/** Flag bits of a day index entry. */
const AI_GENERATED = 1;
const MODERATED = 2;
const REPOST = 4;
const flagsOf = (e: IndexEntry) => (e.aiGenerated ? AI_GENERATED : 0) | (e.moderated ? MODERATED : 0) | (e.repost ? REPOST : 0);
const flagged = (flags: number) => ({ aiGenerated: (flags & AI_GENERATED) !== 0, moderated: (flags & MODERATED) !== 0, repost: (flags & REPOST) !== 0 });

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

export interface Head {
  v: 5;
  /** The manifest readers should use; null until the tag's first compaction. */
  manifest: string | null;
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
  v: 5;
  tag: string;
  id: string;
  createdAt: number;
  /** Newest day first. */
  days: DayRef[];
}

export const EMPTY_HEAD: Head = { v: 5, manifest: null, compactedAt: 0 };

export const headKey = (tag: string) => `head:${tag}`;
export const manifestKey = (tag: string, id: string) => `man:${tag}:${id}`;
export const dayKey = (tag: string, gen: string) => `day:${tag}:${gen}`;
export const COMPACTOR_STATE_KEY = 'compactor:state';

const pad = (n: number, width = 13) => String(n).padStart(width, '0');
const rand = () => randomBytes(4).toString('hex');

export const newManifestId = (createdAt: number) => `${pad(createdAt)}-${rand()}`;
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
