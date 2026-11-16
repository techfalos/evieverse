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
  type Manifest,
  type TailRecord,
} from './layout.js';

/** One post available to the feed: an entry of a day index or of an open tail. Never mutated once built. */
export interface Candidate {
  contentId: string;
  version: number;
  createdAt: number;
  likes: number;
  /** Bytes of the rendered feed record. */
  length: number;
  aiGenerated: boolean;
  /** Hidden by a tombstone: never returned, but kept in place so cursor positions stay valid. */
  hidden?: boolean;
}

export interface TagView {
  tag: string;
  manifest: string | null;
  mergedThrough: number;
  /** Tail entries first, then every day index's entries in index order (newest day first). */
  candidates: Candidate[];
}

export interface Pin {
  manifest: string | null;
  mergedThrough: number;
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
        const p = loaded.then((bufs) => (bufs[j] ? unpackDay(bufs[j]!).map(({ size, ...e }): Candidate => ({ ...e, length: size })) : null));
        void p.then((v) => v ?? this.days.delete(key), () => this.days.delete(key));
        this.days.set(key, p);
        return p;
      }),
    );
  }

  /**
   * Every post of a tag visible at `anchor`: the day indexes of the manifest named by the head (or by
   * the cursor's pin) plus tail entries pushed since it was compacted. Newer versions of a content
   * item hide older ones, and tombstones in the tails mark the entries they cover as hidden.
   */
  async view(tag: string, anchor: number, pin?: Pin): Promise<TagView> {
    const { manifest: id, mergedThrough } = pin ?? (await this.head(tag));
    const [manifest, tails] = await Promise.all([
      id ? this.manifest(tag, id) : Promise.resolve(null),
      this.tailCandidates(tag, mergedThrough, anchor),
    ]);
    if (id && !manifest) throw pin ? cursorExpired() : new Error(`manifest ${id} of #${tag} is missing`);
    const days = manifest ? await this.dayEntries(tag, manifest.days) : [];
    if (days.includes(null)) throw pin ? cursorExpired() : new Error(`a day index of #${tag} is missing`);

    const inTails = new Set(tails.candidates.map((c) => c.contentId));
    const candidates: Candidate[] = [...tails.candidates];
    for (const entries of days) {
      for (const c of entries!) {
        // A tail entry is always newer than the day indexes (e.g. an updated version).
        if (!inTails.has(c.contentId)) candidates.push(c);
      }
    }
    if (tails.hiddenBelow.size) {
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i]!;
        if (c.version < (tails.hiddenBelow.get(c.contentId) ?? 0)) candidates[i] = { ...c, hidden: true };
      }
    }
    return { tag, manifest: id, mergedThrough, candidates };
  }

  /** The newest tail entry per content, and per tombstoned content the version below which entries are hidden. */
  private async tailCandidates(
    tag: string,
    mergedThrough: number,
    anchor: number,
  ): Promise<{ candidates: Candidate[]; hiddenBelow: Map<string, number> }> {
    const windows = (await this.windows.get(tag, () => this.hot.scores(tailIndexKey(tag), 0, Infinity))).filter((w) => w >= mergedThrough);
    const lists = await this.hot.lists(windows.map((w) => tailKey(tag, w)));
    const latest = new Map<string, TailRecord>();
    const hiddenBelow = new Map<string, number>();
    for (const list of lists) {
      for (const line of list) {
        const e = decodeTail(line.toString('utf8'));
        if (!e) continue;
        if (isTombstone(e)) {
          const below = e.below ?? Infinity;
          if (below > (hiddenBelow.get(e.contentId) ?? 0)) hiddenBelow.set(e.contentId, below);
          continue;
        }
        // Entries written after the first page was served are left out so cursor positions stay stable.
        if (!(e.updatedAt <= anchor)) continue;
        const prev = latest.get(e.contentId);
        if (prev && (prev.version > e.version || (prev.version === e.version && prev.updatedAt >= e.updatedAt))) continue;
        latest.set(e.contentId, e);
      }
    }
    const candidates = [...latest.values()].map(({ contentId, version, createdAt, likes, size, aiGenerated }) => ({
      contentId,
      version,
      createdAt,
      likes,
      length: size,
      aiGenerated,
    }));
    return { candidates, hiddenBelow };
  }
}
