import { HttpError } from '../http/errors.js';
import { msg } from '../language.js';
import type { HotStore } from '../storage/index.js';
import { Lru, TtlCache } from '../util.js';
import { dayKey, isApproval, isTombstone, manifestKey, tailIndexKey, unpackDay, type DayRef, type Head, type IndexEntry, type Manifest, type TailRecord } from './layout.js';
import { readHead, readJson, readTails } from './read.js';

/** One post available to the feed: an entry of a day index or of an open tail. Never mutated once built. */
export interface Candidate {
  contentId: string;
  createdAt: number;
  likes: number;
  aiGenerated: boolean;
  /** Approved by a moderator of the hashtag whose index this is: flagged in its day index, or by an approval line in its tails. */
  moderated: boolean;
  /** Hidden by a tombstone: never returned, but kept in place so cursor positions stay valid. */
  hidden?: boolean;
}

const toCandidate = ({ contentId, createdAt, likes, aiGenerated, moderated }: IndexEntry): Candidate => ({ contentId, createdAt, likes, aiGenerated, moderated });

export interface TagView {
  tag: string;
  /** What later pages of a feed session read, so they see exactly what this view saw. */
  pin: Required<Pin>;
  /** Tail entries first, then every day index's entries in index order (newest day first). */
  candidates: Candidate[];
}

/** A tag's head, manifest and open tails, read; `TagFeedReader.loadDays` loads the day indexes it needs. */
export interface OpenTag {
  tag: string;
  pin: Required<Pin>;
  /** Read from a cursor's pin, so a missing key means the cursor expired. */
  pinned: boolean;
  /** The newest tail entry per content. */
  tails: Candidate[];
  /** Every UTC day's index the manifest names, newest first. */
  days: DayRef[];
  /** Content with a tombstone in the open tails: its day index entries are hidden. */
  tombstoned: Set<string>;
  /** Content with an approval among the tail lines read: its day index entries are flagged as moderated. */
  approved: Set<string>;
}

/** Each open tail window a view read, with how many lines it held then. */
export type TailPin = [window: number, lines: number][];

export interface Pin {
  manifest: string | null;
  mergedThrough: number;
  /** The tail lines the first page read; without it, every line of every open window. */
  tails?: TailPin;
}

/** Day indexes kept per cached tag (a tag holds up to one per retained day). */
const DAYS_PER_TAG = 100;

export const cursorExpired = () => new HttpError(410, msg('cursor.expired'));

/**
 * Read side of the feed index. Uses only Redis: no database access. Holds manifests and day indexes
 * (immutable) in memory; the open tails are read on every request, so a new post shows at once.
 */
export class TagFeedReader {
  private readonly heads: TtlCache<Head>;
  private readonly windows: TtlCache<number[]>;
  private readonly manifests: Lru<Promise<Manifest | null>>;
  private readonly days: Lru<Promise<Candidate[] | null>>;

  constructor(
    private readonly hot: HotStore,
    opts: { headCacheMs: number; indexCacheSize: number },
    now: () => number = Date.now,
  ) {
    this.heads = new TtlCache(opts.headCacheMs, now);
    this.windows = new TtlCache(opts.headCacheMs, now);
    this.manifests = new Lru(opts.indexCacheSize);
    this.days = new Lru(opts.indexCacheSize * DAYS_PER_TAG);
  }

  /** A tag that was never compacted reads as empty: only its tails are visible. */
  head(tag: string): Promise<Head> {
    return this.heads.get(tag, () => readHead(this.hot, tag));
  }

  private manifest(tag: string, id: string): Promise<Manifest | null> {
    const key = manifestKey(tag, id);
    let m = this.manifests.get(key);
    if (!m) {
      m = readJson<Manifest>(this.hot, key);
      void m.then((v) => v ?? this.manifests.delete(key), () => this.manifests.delete(key));
      this.manifests.set(key, m);
    }
    return m;
  }

  /** Each day's entries, in index order; null for a day whose index has expired. One MGET for the uncached days. */
  private dayEntries(tag: string, refs: DayRef[]): Promise<(Candidate[] | null)[]> {
    const keys = refs.map((d) => dayKey(tag, d.gen));
    const cached = keys.map((k) => this.days.get(k));
    const missing = keys.filter((_, i) => !cached[i]);
    const loaded = missing.length ? this.hot.mget(missing) : Promise.resolve([]);
    let next = 0;
    return Promise.all(
      keys.map((key, i) => {
        if (cached[i]) return cached[i]!;
        const j = next++;
        const p = loaded.then((bufs) => (bufs[j] ? unpackDay(bufs[j]!).map(toCandidate) : null));
        void p.then((v) => v ?? this.days.delete(key), () => this.days.delete(key));
        this.days.set(key, p);
        return p;
      }),
    );
  }

  /**
   * Every post of a tag visible at `anchor`: the day indexes of the manifest named by the head (or by
   * the cursor's pin) plus tail entries pushed since it was compacted (or the pinned ones). A newer
   * entry of a content item takes the place of older ones, and tombstones in the tails mark the
   * entries they cover as hidden, whenever they were pushed. Approvals in the tails flag the entries
   * pushed before them as moderated.
   */
  async view(tag: string, anchor: number, pin?: Pin): Promise<TagView> {
    const open = await this.open(tag, anchor, pin);
    return { tag, pin: open.pin, candidates: [...open.tails, ...(await this.loadDays(open, open.days))] };
  }

  /** The tag's head (or the cursor's pin), its manifest and its open tails, without loading any day index. */
  async open(tag: string, anchor: number, pin?: Pin): Promise<OpenTag> {
    const { manifest: id, mergedThrough } = pin ?? (await this.head(tag));
    const [manifest, tails] = await Promise.all([
      id ? this.manifest(tag, id) : Promise.resolve(null),
      this.tailCandidates(tag, mergedThrough, anchor, pin?.tails),
    ]);
    if (id && !manifest) throw pin ? cursorExpired() : new Error(`manifest ${id} of #${tag} is missing`);
    return {
      tag,
      pin: { manifest: id, mergedThrough, tails: tails.read },
      pinned: !!pin,
      tails: tails.candidates,
      days: manifest?.days ?? [],
      tombstoned: tails.tombstoned,
      approved: tails.approved,
    };
  }

  /** The entries of some of an open tag's day indexes, in index order, leaving out content its tails hold a newer entry of. */
  async loadDays(open: OpenTag, refs: DayRef[]): Promise<Candidate[]> {
    const days = await this.dayEntries(open.tag, refs);
    if (days.includes(null)) throw open.pinned ? cursorExpired() : new Error(`a day index of #${open.tag} is missing`);
    // A tail entry is always newer than the day indexes (e.g. an update).
    const inTails = new Set(open.tails.map((c) => c.contentId));
    const out: Candidate[] = [];
    for (const entries of days) {
      for (const c of entries!) {
        if (inTails.has(c.contentId)) continue;
        // Whatever a tombstone says it hides, the entry was written before it: a later write would be in the tails.
        // So it was before an approval, which therefore covers it.
        const hidden = open.tombstoned.has(c.contentId);
        const moderated = c.moderated || open.approved.has(c.contentId);
        out.push(hidden || moderated !== c.moderated ? { ...c, moderated, ...(hidden && { hidden }) } : c);
      }
    }
    return out;
  }

  /**
   * The newest tail entry per content, hidden if a tombstone covers it and moderated if an approval
   * does, and the content that has a tombstone, and an approval. With `pinned`, only the lines the
   * first page read hold entries and approvals, so a post pushed since is left out however old its
   * timestamp (posts are stamped before their bytes are uploaded), and one approved since is as
   * unmoderated as the first page saw it.
   */
  private async tailCandidates(
    tag: string,
    mergedThrough: number,
    anchor: number,
    pinned: TailPin | undefined,
  ): Promise<{ candidates: Candidate[]; tombstoned: Set<string>; approved: Set<string>; read: TailPin }> {
    const open = (await this.windows.get(tag, () => this.hot.scores(tailIndexKey(tag), 0, Infinity))).filter((w) => w >= mergedThrough);
    const limits = new Map(pinned);
    // A pinned window is read even when this node's cached list of windows doesn't have it yet.
    const windows = pinned ? [...new Set([...limits.keys(), ...open])].sort((a, b) => a - b) : open;
    const lists = await readTails(this.hot, tag, windows);
    // Each with where its line is among all those read, which orders lines stamped alike.
    const latest = new Map<string, { entry: TailRecord; at: number }>();
    /** Per tombstoned content, the instant before which its entries are hidden. */
    const hiddenBefore = new Map<string, { before: number; at: number }>();
    /** Per approved content, where its last approval is among the lines read: it covers the entries pushed before it. */
    const approvedAt = new Map<string, number>();
    let at = 0;
    lists.forEach((list, i) => {
      const limit = pinned ? (limits.get(windows[i]!) ?? 0) : list.length;
      // Tails only grow, so one shorter than the first page saw has expired or been evicted since.
      if (list.length < limit) throw cursorExpired();
      list.forEach((e, j) => {
        at++;
        if (!e) return;
        if (isTombstone(e)) {
          const before = e.before ?? Infinity;
          if (before >= (hiddenBefore.get(e.contentId)?.before ?? 0)) hiddenBefore.set(e.contentId, { before, at });
          return;
        }
        if (j >= limit) return;
        if (isApproval(e)) {
          approvedAt.set(e.contentId, at);
          return;
        }
        // The anchor holds back entries stamped after it, by a node whose clock runs ahead, on every page alike.
        if (!(e.updatedAt <= anchor)) return;
        const prev = latest.get(e.contentId);
        // Of two entries stamped alike, the one pushed later.
        if (prev && prev.entry.updatedAt > e.updatedAt) return;
        latest.set(e.contentId, { entry: e, at });
      });
    });
    const read = pinned ?? windows.flatMap((w, i): TailPin => (lists[i]!.length ? [[w, lists[i]!.length]] : []));
    const candidates = [...latest.values()].map(({ entry, at }) => {
      // An approval is of what was there when it was pushed: an entry pushed after it is of a later write.
      const c = toCandidate({ ...entry, moderated: entry.moderated || at < (approvedAt.get(entry.contentId) ?? 0) });
      const tomb = hiddenBefore.get(entry.contentId);
      // A tombstone hides the entries of writes before the one that pushed it; of one stamped alike, those pushed before it.
      const hidden = tomb !== undefined && (entry.updatedAt < tomb.before || (entry.updatedAt === tomb.before && at < tomb.at));
      return hidden ? { ...c, hidden: true } : c;
    });
    return { candidates, tombstoned: new Set(hiddenBefore.keys()), approved: new Set(approvedAt.keys()), read };
  }
}
