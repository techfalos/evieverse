import type { HotStore } from '../storage/index.js';
import { Lru, TtlCache } from '../util.js';
import { dayKey, manifestKey, unpackDay, type DayRef, type Head, type IndexEntry, type Manifest } from './layout.js';
import { readHead, readJson } from './read.js';

/** One post available to the feed: an entry of a day index. Never mutated once built. */
export interface Candidate {
  contentId: string;
  /** When the content was placed in the index: its creation, or the repost that put it there (see IndexEntry). */
  createdAt: number;
  /** For a repost's entry, the likes since the repost. */
  likes: number;
  aiGenerated: boolean;
  /** Approved by a moderator of the hashtag whose index this is: flagged in its day index. */
  moderated: boolean;
  /** A repost put the content in this index, at `createdAt`. */
  repost: boolean;
}

const toCandidate = ({ contentId, createdAt, likes, aiGenerated, moderated, repost }: IndexEntry): Candidate => ({ contentId, createdAt, likes, aiGenerated, moderated, repost });

export interface TagView {
  tag: string;
  /** Every day index's entries in index order (newest day first). */
  candidates: Candidate[];
}

/** A tag's head and manifest, read; `TagFeedReader.loadDays` loads the day indexes it needs. */
export interface OpenTag {
  tag: string;
  /** Every UTC day's index the manifest names, newest first. */
  days: DayRef[];
}

/** Day indexes kept per cached tag (a tag holds up to one per retained day). */
const DAYS_PER_TAG = 100;

/**
 * Read side of the feed index. Uses only Redis: no database access. Everything it reads but the
 * head is immutable, and held in memory: a tag's manifest and day indexes are read once, and again
 * only when the compactor has swapped the head to new ones, which is when a write shows. Every
 * request reads the index its tag's head names at that moment: a feed's later pages read the index
 * as it is by then, not the one its first page read.
 */
export class TagFeedReader {
  private readonly heads: TtlCache<Head>;
  private readonly manifests: Lru<Promise<Manifest | null>>;
  private readonly days: Lru<Promise<Candidate[] | null>>;

  constructor(
    private readonly hot: HotStore,
    opts: { headCacheMs: number; indexCacheSize: number },
    now: () => number = Date.now,
  ) {
    this.heads = new TtlCache(opts.headCacheMs, now);
    this.manifests = new Lru(opts.indexCacheSize);
    this.days = new Lru(opts.indexCacheSize * DAYS_PER_TAG);
  }

  /** A tag that was never compacted reads as empty. */
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

  /** Every post of a tag in its index: the day indexes of the manifest its head names. */
  async view(tag: string): Promise<TagView> {
    const open = await this.open(tag);
    return { tag, candidates: await this.loadDays(open, open.days) };
  }

  /** The tag's head and its manifest, without loading any day index. */
  async open(tag: string): Promise<OpenTag> {
    const id = (await this.head(tag)).manifest;
    const manifest = id ? await this.manifest(tag, id) : null;
    if (id && !manifest) throw new Error(`manifest ${id} of #${tag} is missing`);
    return { tag, days: manifest?.days ?? [] };
  }

  /** The entries of some of an open tag's day indexes, in index order. */
  async loadDays(open: OpenTag, refs: DayRef[]): Promise<Candidate[]> {
    const days = await this.dayEntries(open.tag, refs);
    if (days.includes(null)) throw new Error(`a day index of #${open.tag} is missing`);
    return days.flatMap((entries) => entries!);
  }
}
