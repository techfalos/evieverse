import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { syncFollowing } from '../follows.js';
import { previewOf } from '../posts.js';
import {
  FollowStore,
  PublisherStore,
  type ContentStore,
  type HotStore,
  type Summary,
  type SummaryRef,
  type SummaryStore,
} from '../storage/index.js';
import {
  authorIndex,
  compareRecent,
  compareRecords,
  COMPACTOR_STATE_KEY,
  DAY,
  dayKey,
  dayQuota,
  decodeTail,
  EMPTY_HEAD,
  headKey,
  indexAuthor,
  isTombstone,
  manifestKey,
  newGenId,
  newManifestId,
  packDay,
  recordSize,
  tailIndexKey,
  tailKey,
  unpackDay,
  utcDay,
  type DayRef,
  type Head,
  type IndexEntry,
  type Manifest,
} from '../tagfeed/layout.js';
import { mapLimit } from '../util.js';
import { CompactorLease, LeaseLostError } from './lease.js';

const BATCH = 500;

export interface CompactorDeps {
  config: Config;
  db: Db;
  hot: HotStore;
  summaries: SummaryStore;
  content: ContentStore;
  now?: () => number;
  log?: { info: (o: object, msg?: string) => void; error: (o: object, msg?: string) => void };
}

interface State {
  /** Likes and profile changes before this instant have been applied. */
  through: number;
  /** Summaries of UTC days before this one have been deleted. */
  summariesPurgedBefore?: number;
}

/** What to rebuild for one tag in a run. Days of newly merged tail entries are added by compactTag. */
interface TagWork {
  days: Set<number>;
  /** Per day, content to reconsider even if an earlier compaction trimmed it (or Redis lost it). */
  readmit: Map<number, Set<string>>;
  /** Rebuild every day (`--all`). */
  all: boolean;
}

/** Shared by every tag of one run. */
interface RunContext {
  /** Rebuilding from the database: a missing manifest or day index counts as empty instead of failing the tag. */
  rebuild: boolean;
  /** Summaries checked (and restored if missing) this run, so content in several tags is checked once. */
  ensured: Map<string, Promise<void>>;
}

const newWork = (): TagWork => ({ days: new Set(), readmit: new Map(), all: false });

/**
 * The scheduled task that keeps the feed index small and up to date. Each tag has one index per UTC
 * day, trimmed to a quota that halves with age down to a floor, kept for `tagRetentionDays`. Each run
 * rebuilds only the (tag, day) indexes that changed: new tail entries and tombstones, new likes
 * (re-admitting liked content that was trimmed earlier), versions replaced by newer ones, and content
 * set for deletion; days whose quota shrank are re-trimmed. It then writes a new manifest and swaps
 * the head, erases replaced versions (bytes and summaries), deletes content set for deletion that no
 * day index holds any more, and deletes summaries past retention. Each publisher's own index is
 * compacted the same way, alongside the hashtags of their content, but keeps each day's newest posts.
 * Readers are never blocked: they keep reading the keys they started with, which only expire after
 * `genRetentionMinutes`. Runs never overlap, even across processes: each holds a lease in the
 * database (see CompactorLease), since a run that published its heads after a newer run would bring
 * back what the newer run deleted, and roll back its like counts.
 */
export class Compactor {
  private readonly now: () => number;
  private readonly publishers: PublisherStore;
  private readonly follows: FollowStore;

  constructor(private readonly deps: CompactorDeps) {
    this.now = deps.now ?? Date.now;
    this.publishers = new PublisherStore(deps.hot, { cacheMs: 0 }, this.now);
    this.follows = new FollowStore(deps.hot);
  }

  private get cfg() {
    return this.deps.config;
  }

  private get retentionDays() {
    return Math.min(this.cfg.feed.tagRetentionDays, this.cfg.feed.maxLookbackDays);
  }

  /** How long superseded keys stay readable: the cursor lifetime, plus a window for heads cached by readers. */
  private get keepMs() {
    return (this.cfg.feed.genRetentionMinutes * 60 + this.cfg.feed.tailWindowSeconds) * 1000;
  }

  /** Start of the newest tail window that is closed (plus grace); everything before it can be merged. */
  cutoff(at: number): number {
    const windowMs = this.cfg.feed.tailWindowSeconds * 1000;
    return Math.floor((at - this.cfg.compact.graceSeconds * 1000) / windowMs) * windowMs;
  }

  /**
   * `all` rebuilds every day of every tag. `rebuild` also re-admits every content within retention from
   * the database and the meta files, restoring summaries and publisher credits: run it after Redis
   * lost data, or to migrate from the tag-file layout. Skipped while another run, in this process or
   * any other, holds the lease.
   */
  async runOnce(opts: { all?: boolean; rebuild?: boolean } = {}): Promise<{ tags: string[]; deleted: string[]; skipped: boolean }> {
    const lease = new CompactorLease(this.deps.db, this.cfg.compact.leaseSeconds * 1000, this.now);
    if (!(await lease.acquire())) {
      this.deps.log?.info({}, 'another compactor run holds the lease; skipping this run');
      return { tags: [], deleted: [], skipped: true };
    }
    try {
      return { ...(await this.run(lease, opts)), skipped: false };
    } finally {
      await lease.release().catch((err) => this.deps.log?.error({ err }, 'could not release the compactor lease; it expires on its own'));
    }
  }

  private async run(lease: CompactorLease, opts: { all?: boolean; rebuild?: boolean }): Promise<{ tags: string[]; deleted: string[] }> {
    const { db, hot, content, summaries } = this.deps;
    const runStart = this.now();
    const cutoff = this.cutoff(runStart);
    const stateBuf = await hot.get(COMPACTOR_STATE_KEY);
    const state: State = stateBuf ? JSON.parse(stateBuf.toString('utf8')) : { through: 0 };
    const ctx: RunContext = { rebuild: !!opts.rebuild, ensured: new Map() };

    const work = new Map<string, TagWork>();
    const workFor = (tag: string) => {
      let w = work.get(tag);
      if (!w) work.set(tag, (w = newWork()));
      return w;
    };
    const appended = await db
      .selectFrom('tags')
      .select('name')
      .whereRef('last_appended_at', '>=', 'compacted_at')
      .where('compacted_at', '<', cutoff)
      .execute();
    for (const r of appended) workFor(r.name);
    if (opts.all) for (const r of await db.selectFrom('tags').select('name').execute()) workFor(r.name).all = true;
    if (opts.rebuild) await this.markEverything(workFor, runStart, lease);
    await this.markNewLikes(workFor, state.through, runStart);
    await this.syncChangedPublishers(state.through, runStart, lease);
    await this.syncChangedFollowing(state.through, runStart, lease);
    const superseded = await this.markSuperseded(workFor);
    const pending = await this.markPendingAppends(workFor, runStart);
    const deletions = await this.markDeletions(workFor, cutoff);

    const tags = [...work.keys()].sort();
    const failed = new Set<string>();
    await mapLimit(tags, this.cfg.compact.concurrency, async (tag) => {
      try {
        await this.compactTag(tag, work.get(tag)!, cutoff, runStart, lease, ctx);
        await db.updateTable('tags').set({ compacted_at: cutoff }).where('name', '=', tag).where('compacted_at', '<', cutoff).execute();
      } catch (err) {
        if (err instanceof LeaseLostError) throw err;
        failed.add(tag);
        this.deps.log?.error({ err, tag }, 'compaction failed');
      }
    });
    // Everything below relies on the heads this run published still being the current ones.
    for (const p of pending) {
      if (p.tags.some((t) => failed.has(t))) continue;
      await lease.check();
      await db.deleteFrom('pending_appends').where('content_id', '=', p.id).where('version', '=', p.version).execute();
    }
    for (const s of superseded) {
      if (s.tags.some((t) => failed.has(t))) continue;
      await lease.check();
      // Bytes first: if deleting the row fails, the next run finds no meta, marks nothing, and retries.
      await summaries.remove([{ contentId: s.id, version: s.version, createdAt: s.createdAt }]);
      await content.remove(s.id, s.version);
      await db.deleteFrom('superseded_versions').where('content_id', '=', s.id).where('version', '=', s.version).execute();
    }
    const deleted: string[] = [];
    for (const d of deletions) {
      if (d.tags.some((t) => failed.has(t))) continue;
      await lease.check();
      // Likes and pending_appends rows cascade.
      await db.deleteFrom('content').where('id', '=', d.id).where('delete_requested_at', 'is not', null).execute();
      // Up to the highest reserved number: a write that never committed may have left its bytes behind.
      const versions: SummaryRef[] = Array.from({ length: d.reservedVersion }, (_, i) => ({ contentId: d.id, version: i + 1, createdAt: d.createdAt }));
      await summaries.remove(versions);
      for (const v of versions) await content.remove(d.id, v.version);
      deleted.push(d.id);
    }
    // Tags compacted recently but not now may still list tail windows whose lists have since expired.
    const windowMs = this.cfg.feed.tailWindowSeconds * 1000;
    const horizon = 2 * (this.keepMs + windowMs + this.cfg.compact.intervalSeconds * 1000);
    const settled = await db.selectFrom('tags').select('name').where('compacted_at', '>=', runStart - horizon).execute();
    await mapLimit(
      settled.map((r) => r.name).filter((t) => !work.has(t)),
      this.cfg.compact.concurrency,
      (tag) => this.cleanup(tag).catch((err) => this.deps.log?.error({ err, tag }, 'cleanup failed')),
    );

    const minDay = utcDay(runStart) - this.retentionDays + 1;
    if (state.summariesPurgedBefore !== minDay) {
      await lease.check();
      const purged = await summaries.purgeBefore(minDay);
      if (purged.length) this.deps.log?.info({ days: purged.length }, 'deleted summaries past retention');
    }

    await lease.check();
    await hot.set(COMPACTOR_STATE_KEY, JSON.stringify({ through: runStart, summariesPurgedBefore: minDay } satisfies State));
    if (tags.length || deleted.length) this.deps.log?.info({ tags: tags.length, deleted: deleted.length }, 'compacted the feed index');
    return { tags, deleted };
  }

  /**
   * `--rebuild`: every content within retention is re-admitted under its tags and its publisher's own
   * index, and every publisher credit and every user's follows rewritten.
   */
  private async markEverything(workFor: (tag: string) => TagWork, runStart: number, lease: CompactorLease) {
    const rows = await this.deps.db
      .selectFrom('content')
      .select(['id', 'user_id', 'version', 'created_at'])
      .where('delete_requested_at', 'is', null)
      .where('created_at', '>', runStart - this.retentionDays * DAY)
      .execute();
    await this.markContent(workFor, rows, { readmit: true });
    const users = await this.deps.db.selectFrom('users').select(['id', 'username', 'publisher_url']).execute();
    await lease.check();
    await mapLimit(users, 16, (u) => this.publishers.put({ userId: u.id, username: u.username, publisherUrl: u.publisher_url }));
    await this.syncFollowing(users.map((u) => u.id), lease);
  }

  /** (tag, day) of content liked in [since, until); the liked content is re-admitted if it was trimmed. */
  private async markNewLikes(workFor: (tag: string) => TagWork, since: number, until: number) {
    const rows = await this.deps.db
      .selectFrom('likes')
      .innerJoin('content', 'content.id', 'likes.content_id')
      .select(['content.id', 'content.user_id', 'content.version', 'content.created_at'])
      .distinct()
      .where('likes.created_at', '>=', since)
      .where('likes.created_at', '<', until)
      .where('content.created_at', '>', until - this.retentionDays * DAY)
      .execute();
    await this.markContent(workFor, rows, { readmit: true });
  }

  /**
   * Rewrites the Redis credit of users who changed their username or publisherUrl in [since, until).
   * PATCH /users already wrote it; this repairs a write that failed.
   */
  private async syncChangedPublishers(since: number, until: number, lease: CompactorLease) {
    const users = await this.deps.db
      .selectFrom('users')
      .select(['id', 'username', 'publisher_url'])
      .where('updated_at', '>=', since)
      .where('updated_at', '<', until)
      .execute();
    if (!users.length) return;
    await lease.check();
    await mapLimit(users, 16, (u) => this.publishers.put({ userId: u.id, username: u.username, publisherUrl: u.publisher_url }));
  }

  /**
   * Rewrites the follows in Redis of users who followed or unfollowed someone in [since, until). The
   * request already wrote them; this repairs a write that failed, or two that raced.
   */
  private async syncChangedFollowing(since: number, until: number, lease: CompactorLease) {
    const users = await this.deps.db
      .selectFrom('users')
      .select('id')
      .where('following_changed_at', '>=', since)
      .where('following_changed_at', '<', until)
      .execute();
    await this.syncFollowing(users.map((u) => u.id), lease);
  }

  private async syncFollowing(userIds: string[], lease: CompactorLease) {
    for (let i = 0; i < userIds.length; i += BATCH) {
      await lease.check();
      await syncFollowing(this.deps.db, this.follows, userIds.slice(i, i + BATCH));
    }
  }

  /**
   * Versions replaced by a newer one, each marked under its own hashtags so its entries are dropped
   * (a tag the newer version still carries gets the current entry instead). That needs only the
   * current version's meta, so an entry of the old version merged from a tail later is dropped too.
   * Returns the rows with the tags whose compaction must succeed before the version is erased.
   */
  private async markSuperseded(workFor: (tag: string) => TagWork) {
    const rows = await this.deps.db
      .selectFrom('superseded_versions')
      .innerJoin('content', 'content.id', 'superseded_versions.content_id')
      .select(['content.id', 'content.user_id', 'superseded_versions.version', 'content.created_at'])
      .execute();
    const tagsOf = await this.markContent(workFor, rows);
    return rows.map((r) => ({ id: r.id, version: r.version, createdAt: r.created_at, tags: tagsOf.get(r) ?? [] }));
  }

  /**
   * Versions /store committed without confirming that every tail append succeeded (an append failed, or
   * the node stopped first), once the grace period has given the node time to finish. The current
   * version is re-admitted under each of its tags; a superseded one, or one past retention, needs
   * nothing. Returns the rows with the tags whose compaction must succeed before they're deleted.
   */
  private async markPendingAppends(workFor: (tag: string) => TagWork, until: number) {
    const rows = await this.deps.db
      .selectFrom('pending_appends')
      .innerJoin('content', 'content.id', 'pending_appends.content_id')
      .select(['content.id', 'content.user_id', 'content.version', 'content.created_at', 'pending_appends.version as pending'])
      .where('pending_appends.created_at', '<', until - this.cfg.compact.graceSeconds * 1000)
      .execute();
    const live = rows.filter((r) => r.pending === r.version && r.created_at > until - this.retentionDays * DAY);
    const tagsOf = await this.markContent(workFor, live, { readmit: true });
    return rows.map((r) => ({ id: r.id, version: r.pending, tags: tagsOf.get(r) ?? [] }));
  }

  /**
   * Content set for deletion whose last tail append falls in a window this run merges. An entry in an
   * open tail can't be removed, so recently written content waits for its window to close; /store
   * appends right after its commit, so that append is within the grace period of `updated_at`. Every
   * version's hashtags are marked, so each of its entries is dropped. Returns the rows with the tags
   * whose compaction must succeed before the content is deleted.
   */
  private async markDeletions(workFor: (tag: string) => TagWork, cutoff: number) {
    const rows = await this.deps.db
      .selectFrom('content')
      .select(['id', 'user_id', 'version', 'reserved_version', 'created_at'])
      .where('delete_requested_at', 'is not', null)
      .where('updated_at', '<', cutoff - this.cfg.compact.graceSeconds * 1000)
      .execute();
    const tagsOf = await this.markContent(workFor, rows, { allVersions: true });
    return rows.map((r) => ({
      id: r.id,
      reservedVersion: Math.max(r.version, r.reserved_version),
      createdAt: r.created_at,
      tags: tagsOf.get(r) ?? [],
    }));
  }

  /**
   * Marks the content's UTC day under each of its hashtags, read from the version's metadata file (and
   * every older version's still stored, if asked), and under its publisher's own index; returns every
   * index marked for each row.
   */
  private async markContent<R extends { id: string; user_id: string; version: number; created_at: number }>(
    workFor: (tag: string) => TagWork,
    rows: R[],
    opts: { readmit?: boolean; allVersions?: boolean } = {},
  ): Promise<Map<R, string[]>> {
    const tagsOf = new Map<R, string[]>();
    await mapLimit(rows, 16, async (r) => {
      const day = utcDay(r.created_at);
      const marked = new Set<string>();
      const mark = (tag: string, readmit: boolean) => {
        marked.add(tag);
        const w = workFor(tag);
        w.days.add(day);
        if (readmit) {
          let ids = w.readmit.get(day);
          if (!ids) w.readmit.set(day, (ids = new Set()));
          ids.add(r.id);
        }
      };
      const versions = opts.allVersions ? Array.from({ length: r.version }, (_, i) => r.version - i) : [r.version];
      for (const version of versions) {
        const meta = await this.deps.content.getMeta(r.id, version);
        for (const tag of meta?.tags ?? []) mark(tag, !!opts.readmit && version === r.version);
      }
      // Every version is the same publisher's, whatever its meta file holds.
      mark(authorIndex(r.user_id), !!opts.readmit);
      tagsOf.set(r, [...marked]);
    });
    return tagsOf;
  }

  private async readJson<T>(key: string): Promise<T | null> {
    const buf = await this.deps.hot.get(key);
    return buf ? (JSON.parse(buf.toString('utf8')) as T) : null;
  }

  /** The current head; one from an older layout counts as none. */
  private async readHead(tag: string): Promise<Head> {
    const head = await this.readJson<Head>(headKey(tag));
    return head?.v === 3 ? head : EMPTY_HEAD;
  }

  async compactTag(tag: string, work: TagWork, cutoff: number, runStart: number, lease: CompactorLease, ctx: RunContext): Promise<void> {
    const { hot } = this.deps;
    const head = await this.readHead(tag);
    let manifest = head.manifest ? await this.readJson<Manifest>(manifestKey(tag, head.manifest)) : null;
    if (head.manifest && !manifest && !ctx.rebuild) throw new Error(`manifest ${head.manifest} of #${tag} is missing`);
    if (manifest?.v !== 3) manifest = null;
    const mergedThrough = Math.max(head.mergedThrough, cutoff);

    const today = utcDay(runStart);
    const minDay = today - this.retentionDays + 1;
    const author = indexAuthor(tag) !== null;
    const quotaOf = (day: number) =>
      author ? this.cfg.feed.authorDayMaxPosts : dayQuota(today - day, this.cfg.feed.tagDayMaxPosts, this.cfg.feed.tagDayMinPosts);

    // Entries not yet in a day index, by UTC day, in push order so later entries (newer versions) win.
    const incoming = new Map<number, IndexEntry[]>();
    // Days of merged tombstones: once a tombstone leaves the open tails, its day must no longer hold what it hid.
    const tombstoned = new Set<number>();
    const windows = await hot.scores(tailIndexKey(tag), head.mergedThrough, mergedThrough);
    const lists = await hot.lists(windows.map((w) => tailKey(tag, w)));
    for (const list of lists) {
      for (const line of list) {
        const e = decodeTail(line.toString('utf8'));
        if (!e) continue;
        const day = utcDay(e.createdAt);
        if (isTombstone(e)) {
          tombstoned.add(day);
          continue;
        }
        let into = incoming.get(day);
        if (!into) incoming.set(day, (into = []));
        into.push(e);
      }
    }

    const existing = new Map((manifest?.days ?? []).map((d) => [d.day, d]));
    const rebuild = new Set([...work.days, ...incoming.keys(), ...tombstoned]);
    for (const d of existing.values()) if (work.all || d.quota > quotaOf(d.day)) rebuild.add(d.day);

    const days: DayRef[] = [...existing.values()].filter((d) => d.day >= minDay && !rebuild.has(d.day));
    const written: string[] = [];
    const id = newManifestId(runStart, mergedThrough);
    try {
      for (const day of rebuild) {
        if (day < minDay) continue;
        const built = await this.buildDay(tag, day, existing.get(day), incoming.get(day) ?? [], work.readmit.get(day), { quota: quotaOf(day), runStart }, ctx);
        if (!built) continue;
        days.push(built);
        written.push(dayKey(tag, built.gen));
      }
      days.sort((a, b) => b.day - a.day);
      const next: Manifest = { v: 3, tag, id, mergedThrough, createdAt: runStart, days };
      written.push(manifestKey(tag, id));
      await hot.set(manifestKey(tag, id), JSON.stringify(next));
      await lease.check();
    } catch (err) {
      // No head references these yet.
      await hot.del(written).catch(() => {});
      throw err;
    }
    const nextHead: Head = { v: 3, manifest: id, mergedThrough, compactedAt: runStart };
    await hot.set(headKey(tag), JSON.stringify(nextHead));

    // Readers pinned to the previous head keep its keys, and the tails it hadn't merged, for the cursor lifetime.
    const kept = new Set(days.map((d) => d.gen));
    const superseded = (manifest?.days ?? []).filter((d) => !kept.has(d.gen)).map((d) => dayKey(tag, d.gen));
    if (manifest) superseded.push(manifestKey(tag, manifest.id));
    await hot.expire(superseded, this.keepMs);
    await hot.expire(windows.map((w) => tailKey(tag, w)), this.keepMs);
    await this.cleanup(tag);
  }

  /** Rebuilds one UTC day's index from its current index, new tail entries and re-admitted content; null if empty. */
  private async buildDay(
    tag: string,
    day: number,
    prev: DayRef | undefined,
    incoming: IndexEntry[],
    readmit: Set<string> | undefined,
    opts: { quota: number; runStart: number },
    ctx: RunContext,
  ): Promise<DayRef | null> {
    const latest = new Map<string, IndexEntry>();
    const add = (e: IndexEntry) => {
      const have = latest.get(e.contentId);
      if (!have || e.version >= have.version) latest.set(e.contentId, e);
    };
    if (prev) {
      const buf = await this.deps.hot.get(dayKey(tag, prev.gen));
      if (!buf && !ctx.rebuild) throw new Error(`day index ${prev.gen} of #${tag} is missing`);
      if (buf) unpackDay(buf).forEach(add);
    }
    incoming.forEach(add);

    const { entries, stale } = await this.refresh([...latest.values()], opts.runStart);
    const missing = [...(readmit ?? [])].filter((id) => !latest.has(id));
    entries.push(...(await this.readmitted(tag, [...stale, ...missing], ctx)));
    const kept = this.trim(entries, opts.quota, indexAuthor(tag) !== null);
    if (!kept.length) return null;
    const gen = newGenId(day, opts.runStart);
    await this.deps.hot.set(dayKey(tag, gen), packDay(kept));
    return { day, gen, quota: opts.quota, count: kept.length };
  }

  /**
   * Current-version entries rebuilt from the database and each content's metadata file, for content the
   * day doesn't hold as the database does: liked content an earlier compaction trimmed, versions whose
   * tail append never happened, and entries of another version. Content set for deletion, or whose
   * current version no longer carries the tag (or, in a publisher's own index, isn't theirs), gets
   * none. Their summaries are restored if a tier lacks them. They then compete for the day's quota
   * like any entry.
   */
  private async readmitted(tag: string, ids: string[], ctx: RunContext): Promise<IndexEntry[]> {
    const author = indexAuthor(tag);
    const out: IndexEntry[] = [];
    for (let i = 0; i < ids.length; i += BATCH) {
      const rows = await this.deps.db
        .selectFrom('content')
        .innerJoin('users', 'users.id', 'content.user_id')
        .select([
          'content.id',
          'content.version',
          'content.like_count',
          'content.created_at',
          'content.updated_at',
          'content.ai_generated',
          'users.id as user_id',
          'users.username',
          'users.publisher_url',
        ])
        .where('content.id', 'in', ids.slice(i, i + BATCH))
        .where('content.delete_requested_at', 'is', null)
        .execute();
      await mapLimit(rows, 16, async (row) => {
        const meta = await this.deps.content.getMeta(row.id, row.version);
        if (!meta || (author !== null ? row.user_id !== author : !meta.tags.includes(tag))) return;
        const summary: Summary = {
          contentId: row.id,
          version: row.version,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          userId: row.user_id,
          mimeType: meta.mimeType,
          aiGenerated: row.ai_generated === 1,
          tags: meta.tags,
          preview: previewOf(meta, this.cfg.publicBaseUrl),
          ...(meta.origin && { origin: meta.origin }),
        };
        const key = `${row.id}:${row.version}`;
        let ensured = ctx.ensured.get(key);
        if (!ensured) ctx.ensured.set(key, (ensured = this.deps.summaries.ensure(summary)));
        await ensured;
        const publisher = { userId: row.user_id, username: row.username, publisherUrl: row.publisher_url };
        out.push({
          contentId: row.id,
          version: row.version,
          createdAt: row.created_at,
          likes: row.like_count,
          size: recordSize(summary, publisher, row.like_count),
          aiGenerated: summary.aiGenerated,
        });
      });
    }
    return out;
  }

  /**
   * Applies current likes from the database and drops content that is deleted, set for deletion or
   * past retention. Entries of another version than the database holds are returned as `stale`, to be
   * rebuilt at the current version.
   */
  private async refresh(entries: IndexEntry[], runStart: number): Promise<{ entries: IndexEntry[]; stale: string[] }> {
    const oldest = runStart - this.retentionDays * DAY;
    const out: IndexEntry[] = [];
    const stale: string[] = [];
    for (let i = 0; i < entries.length; i += BATCH) {
      const batch = entries.slice(i, i + BATCH);
      const rows = await this.deps.db
        .selectFrom('content')
        .select(['id', 'version', 'like_count', 'delete_requested_at'])
        .where('id', 'in', batch.map((e) => e.contentId))
        .execute();
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const e of batch) {
        const row = byId.get(e.contentId);
        if (!row || row.delete_requested_at !== null || e.createdAt <= oldest) continue;
        if (row.version !== e.version) {
          stale.push(row.id);
          continue;
        }
        out.push({ ...e, likes: row.like_count });
      }
    }
    return { entries: out, stale };
  }

  /**
   * Sorts one day's entries by likes, then recency (a publisher's own index: by recency alone), and
   * keeps the first `quota` of them. Creation times are cut to the whole seconds an index stores
   * first, so the index order is the order readers see.
   */
  private trim(entries: IndexEntry[], quota: number, newestFirst: boolean): IndexEntry[] {
    return entries
      .map((e) => ({ ...e, createdAt: Math.floor(e.createdAt / 1000) * 1000 }))
      .sort(newestFirst ? compareRecent : compareRecords)
      .slice(0, quota);
  }

  /** Forgets merged tail windows whose lists have expired. */
  private async cleanup(tag: string): Promise<void> {
    const { hot } = this.deps;
    const head = await this.readHead(tag);
    const merged = await hot.scores(tailIndexKey(tag), 0, head.mergedThrough);
    if (!merged.length) return;
    const present = await hot.exists(merged.map((w) => tailKey(tag, w)));
    await hot.zrem(tailIndexKey(tag), merged.filter((_, i) => !present[i]));
  }

  /** Runs every `intervalSeconds` until stopped; runs never overlap. */
  start(): () => Promise<void> {
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    let running: Promise<unknown> = Promise.resolve();
    const tick = () => {
      running = this.runOnce()
        .catch((err) => this.deps.log?.error({ err }, 'compactor run failed'))
        .finally(() => {
          if (!stopped) timer = setTimeout(tick, this.cfg.compact.intervalSeconds * 1000);
        });
    };
    timer = setTimeout(tick, this.cfg.compact.intervalSeconds * 1000);
    return async () => {
      stopped = true;
      clearTimeout(timer);
      await running;
    };
  }
}
