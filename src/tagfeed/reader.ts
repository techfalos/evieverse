import { HttpError } from '../http/errors.js';
import type { HotStore } from '../storage/index.js';
import { Lru, TtlCache } from '../util.js';
import {
  dayKey,
  decodeTail,
  EMPTY_HEAD,
  headKey,
  isTombstone,
  manifestKey,
  tailIndexKey,
  tailKey,
  unpackDay,
  type DayRef,
  type Head,
  type IndexEntry,
  type Manifest,
  type TailRecord,
} from './layout.js';

/** One post available to the feed: an entry of a day index or of an open tail. Never mutated once built. */
export interface Candidate {
  contentId: string;
  version: number;
  createdAt: number;
  likes: number;
  aiGenerated: boolean;
  /** Hidden by a tombstone: never returned, but kept in place so cursor positions stay valid. */
  hidden?: boolean;
}

const toCandidate = ({ contentId, version, createdAt, likes, aiGenerated }: IndexEntry): Candidate => ({ contentId, version, createdAt, likes, aiGenerated });

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
  /** Per tombstoned content, the version below which its entries are hidden. */
  hiddenBelow: Map<string, number>;
}

const hide = (hiddenBelow: Map<string, number>, c: Candidate): Candidate =>
  c.version < (hiddenBelow.get(c.contentId) ?? 0) ? { ...c, hidden: true } : c;

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

export const cursorExpired = () => new HttpError(410, 'cursor expired; request the first page again');

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
    private readonly now: () => number = Date.now,
  ) {
    this.heads = new TtlCache(opts.headCacheMs, now);
    this.windows = new TtlCache(opts.headCacheMs, now);
    this.manifests = new Lru(opts.indexCacheSize);
    this.days = new Lru(opts.indexCacheSize * DAYS_PER_TAG);
  }

  /** A tag that was never compacted (or a head from an older layout) reads as empty: only its tails are visible. */
  head(tag: string): Promise<Head> {
    return this.heads.get(tag, async () => {
      const buf = await this.hot.get(headKey(tag));
      const head = buf ? (JSON.parse(buf.toString('utf8')) as Head) : EMPTY_HEAD;
      return head.v === 3 ? head : EMPTY_HEAD;
    });
  }

  private manifest(tag: string, id: string): Promise<Manifest | null> {
    const key = manifestKey(tag, id);
    let m = this.manifests.get(key);
    if (!m) {
      m = this.hot.get(key).then((buf) => (buf ? (JSON.parse(buf.toString('utf8')) as Manifest) : null));
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
   * the cursor's pin) plus tail entries pushed since it was compacted (or the pinned ones). Newer
   * versions of a content item hide older ones, and tombstones in the tails mark the entries they
   * cover as hidden, whenever they were pushed.
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
      tails: tails.candidates.map((c) => hide(tails.hiddenBelow, c)),
      days: manifest?.days ?? [],
      hiddenBelow: tails.hiddenBelow,
    };
  }

  /** The entries of some of an open tag's day indexes, in index order, leaving out content its tails hold a newer entry of. */
  async loadDays(open: OpenTag, refs: DayRef[]): Promise<Candidate[]> {
    const days = await this.dayEntries(open.tag, refs);
    if (days.includes(null)) throw open.pinned ? cursorExpired() : new Error(`a day index of #${open.tag} is missing`);
    // A tail entry is always newer than the day indexes (e.g. an updated version).
    const inTails = new Set(open.tails.map((c) => c.contentId));
    const out: Candidate[] = [];
    for (const entries of days) for (const c of entries!) if (!inTails.has(c.contentId)) out.push(hide(open.hiddenBelow, c));
    return out;
  }

  /**
   * The newest tail entry per content, and per tombstoned content the version below which entries are
   * hidden. With `pinned`, only the lines the first page read hold entries, so a post pushed since is
   * left out however old its timestamp (posts are stamped before their bytes are uploaded).
   */
  private async tailCandidates(
    tag: string,
    mergedThrough: number,
    anchor: number,
    pinned: TailPin | undefined,
  ): Promise<{ candidates: Candidate[]; hiddenBelow: Map<string, number>; read: TailPin }> {
    const open = (await this.windows.get(tag, () => this.hot.scores(tailIndexKey(tag), 0, Infinity))).filter((w) => w >= mergedThrough);
    const limits = new Map(pinned);
    // A pinned window is read even when this node's cached list of windows doesn't have it yet.
    const windows = pinned ? [...new Set([...limits.keys(), ...open])].sort((a, b) => a - b) : open;
    const lists = await this.hot.lists(windows.map((w) => tailKey(tag, w)));
    const latest = new Map<string, TailRecord>();
    const hiddenBelow = new Map<string, number>();
    lists.forEach((list, i) => {
      const limit = pinned ? (limits.get(windows[i]!) ?? 0) : list.length;
      // Tails only grow, so one shorter than the first page saw has expired or been evicted since.
      if (list.length < limit) throw cursorExpired();
      list.forEach((line, j) => {
        const e = decodeTail(line.toString('utf8'));
        if (!e) return;
        if (isTombstone(e)) {
          const below = e.below ?? Infinity;
          if (below > (hiddenBelow.get(e.contentId) ?? 0)) hiddenBelow.set(e.contentId, below);
          return;
        }
        // The anchor holds back entries stamped after it, by a node whose clock runs ahead, on every page alike.
        if (j >= limit || !(e.updatedAt <= anchor)) return;
        const prev = latest.get(e.contentId);
        if (prev && (prev.version > e.version || (prev.version === e.version && prev.updatedAt >= e.updatedAt))) return;
        latest.set(e.contentId, e);
      });
    });
    const read = pinned ?? windows.flatMap((w, i): TailPin => (lists[i]!.length ? [[w, lists[i]!.length]] : []));
    const candidates = [...latest.values()].map(toCandidate);
    return { candidates, hiddenBelow, read };
  }
}
