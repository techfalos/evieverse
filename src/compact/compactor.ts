import { summaryOf } from '../content.js';
import type { TagDecision } from '../db/schema.js';
import { setForDeletion } from '../deletion.js';
import type { AppDeps } from '../deps.js';
import { syncFollowing } from '../follows.js';
import type { ContentMeta } from '../storage/index.js';
import {
  authorIndex,
  compareRecent,
  compareRecords,
  COMPACTOR_STATE_KEY,
  dayKey,
  dayQuota,
  headKey,
  indexAuthor,
  isApproval,
  isTombstone,
  manifestKey,
  newGenId,
  newManifestId,
  packDay,
  tailIndexKey,
  tailKey,
  unpackDay,
  type DayRef,
  type Head,
  type IndexEntry,
  type Manifest,
} from '../tagfeed/layout.js';
import { readHead, readJson, readTails } from '../tagfeed/read.js';
import { DAY, HOUR, utcDay, wholeSeconds } from '../time.js';
import { mapLimit } from '../util.js';
import { CompactorLease, LeaseLostError } from './lease.js';

const BATCH = 500;

type LogFn = (o: object, msg?: string) => void;
type CompactorLog = { info: LogFn; warn: LogFn; error: LogFn };

interface CompactorDeps extends Pick<AppDeps, 'config' | 'db' | 'hot' | 'summaries' | 'content' | 'comments' | 'publishers' | 'follows' | 'relatedTags' | 'appender' | 'now'> {
  log?: CompactorLog;
}

interface State {
  /** Likes and profile changes before this instant have been applied. */
  through: number;
  /** Hashtag counts (`tag_pairs`) made before this instant are in the related hashtags Redis holds. */
  relatedThrough?: number;
  /** Summaries of UTC days before this one have been deleted, and inboxes were trimmed to their retention on the day that was done. */
  summariesPurgedBefore?: number;
}

/** What to rebuild for one tag in a run. Days of newly merged tail entries are added by compactTag. */
interface TagWork {
  days: Set<number>;
  /** Per day, content to reconsider if the day doesn't hold it: an earlier compaction trimmed it (or Redis lost it). */
  readmit: Map<number, Set<string>>;
  /**
   * Per day, content whose entry is rebuilt from the database and its meta file whether the day holds
   * it or not, and dropped if it no longer carries the tag. compactTag adds the content of merged tombstones.
   */
  recheck: Map<number, Set<string>>;
  /** Rebuild every day (`--all`). */
  all: boolean;
}

/** Shared by every tag of one run. */
interface RunContext {
  /** Rebuilding from the database: a missing manifest or day index counts as empty instead of failing the tag. */
  rebuild: boolean;
  /** Summaries checked (and restored if missing) this run, so content in several tags is checked once. */
  ensured: Map<string, Promise<void>>;
  /** Meta files read this run, so content in several tags is read once. */
  metas: Map<string, Promise<ContentMeta | null>>;
  /**
   * Hashtags a moderator removed from content, and a run took off it, that an index still had an
   * entry of the content for: a write that was under way when the hashtag was removed may have
   * written it back to the meta file, so the removal is applied again by the next run.
   */
  strays: { id: string; tag: string }[];
}

/** A row of `tag_moderation` a run applies. */
interface Decision {
  id: string;
  tag: string;
  decision: TagDecision;
  /** Names the decision: a later one about the same content and hashtag isn't the one this run applied. */
  decidedAt: number;
}

const newWork = (): TagWork => ({ days: new Set(), readmit: new Map(), recheck: new Map(), all: false });

const addTo = (ids: Map<number, Set<string>>, day: number, id: string) => {
  const set = ids.get(day);
  if (set) set.add(id);
  else ids.set(day, new Set([id]));
};

export interface RunOptions {
  all?: boolean;
  rebuild?: boolean;
}

export interface RunResult {
  /** Hashtags (and publishers' own indexes) compacted. */
  tags: string[];
  /** Content deleted for good. */
  deleted: string[];
}

/**
 * Keeps the feed index small and up to date. It is one process that runs for as long as it is up
 * (see `start`): pass after pass, never two at once, and never more than one in `intervalSeconds`.
 *
 * Each tag has one index per UTC day, trimmed to a quota that halves with age down to a floor, kept
 * for `tagRetentionDays`. Each run rebuilds only the (tag, day) indexes that changed: new tail
 * entries and tombstones, new likes (re-admitting liked content that was trimmed earlier), writes
 * whose tail appends weren't confirmed, what tag moderators decided, and content set for deletion;
 * days whose quota shrank are re-trimmed. It then writes a new manifest and swaps the head, deletes
 * content set for deletion that no day index holds any more, and deletes summaries past retention
 * (and with them, once a day, what is in users' inboxes for longer than `inbox.retentionDays`).
 * Each publisher's own index is compacted the same way, alongside the hashtags of their content, but
 * keeps each day's newest posts. Readers are never blocked: they keep reading the keys they started
 * with, which only expire after `genRetentionMinutes`.
 *
 * Should two compactor processes be up at once (a deploy replacing one, a rebuild started by hand),
 * their runs still never overlap: each holds a lease in the database (see CompactorLease), since a
 * run that published its heads after a newer run would bring back what the newer run deleted, and
 * roll back its like counts.
 *
 * It is also what applies moderation to the index, which feeds read instead of the database. What a
 * hashtag's moderators decided (`tag_moderation`) is applied by the next run: content they approved
 * is flagged as moderated in the hashtag's day index, and a hashtag they removed is taken off the
 * content (see applyDecisions). Every day index it builds is built to those decisions, and without
 * content that waits in the moderation queue, so nothing it does for another reason (a like, a
 * `--rebuild`) undoes them.
 *
 * And it keeps each hashtag's related hashtags in Redis, where feeds asked to add them read them:
 * those of the hashtags whose counts in `tag_pairs` changed since its last run are worked out again
 * (see syncRelatedTags).
 *
 * A run that is killed leaves nothing that lasts: what it wrote for a hashtag expires unless the
 * hashtag's head was swapped, and what it hadn't finished is found again by the next run.
 */
export class Compactor {
  private readonly now: () => number;
  /** The cutoff of this process's last run, if that run compacted every tag it had to; else null. */
  private settledCutoff: number | null = null;

  constructor(private readonly deps: CompactorDeps) {
    this.now = deps.now ?? Date.now;
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

  /** How long what a run writes for a hashtag lasts unless the hashtag's head is swapped to it. */
  private get provisionalMs() {
    return Math.max(this.keepMs, HOUR);
  }

  /**
   * `all` rebuilds every day of every tag, and works out every hashtag's related hashtags again.
   * `rebuild` also re-admits every content within retention from the database and the meta files,
   * restoring summaries and publisher credits: run it after Redis lost data. Skipped while another
   * run, in this process or any other, holds the lease.
   */
  async runOnce(opts: RunOptions = {}): Promise<RunResult & { skipped: boolean }> {
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

  private async run(lease: CompactorLease, opts: RunOptions): Promise<RunResult> {
    const { db, hot, content, summaries } = this.deps;
    const runStart = this.now();
    const cutoff = this.cutoff(runStart);
    const state = (await readJson<State>(hot, COMPACTOR_STATE_KEY)) ?? { through: 0 };
    const ctx: RunContext = { rebuild: !!opts.rebuild, ensured: new Map(), metas: new Map(), strays: [] };

    const work = new Map<string, TagWork>();
    const workFor = (tag: string) => {
      let w = work.get(tag);
      if (!w) work.set(tag, (w = newWork()));
      return w;
    };
    // Tags with tail lines in windows that have closed. The cutoff moves on once per tail window, and
    // runs come far more often: a run at the cutoff of one that compacted every tag it found would
    // find only tags whose lines are in windows still open, so it doesn't look (it reads all of `tags`).
    const appended =
      cutoff === this.settledCutoff
        ? []
        : await db.selectFrom('tags').select('name').whereRef('last_appended_at', '>=', 'compacted_at').where('compacted_at', '<', cutoff).execute();
    for (const r of appended) workFor(r.name);
    if (opts.all) for (const r of await db.selectFrom('tags').select('name').execute()) workFor(r.name).all = true;
    // First, as it writes meta files: everything below reads them as it left them.
    const decisions = await this.applyDecisions(workFor, runStart, lease, ctx);
    if (opts.rebuild) await this.markEverything(workFor, runStart, lease, ctx);
    await this.markNewLikes(workFor, state.through, runStart, ctx);
    await this.syncChangedPublishers(state.through, runStart, lease);
    await this.syncChangedFollowing(state.through, runStart, lease);
    const relatedThrough = await this.syncRelatedTags(state.relatedThrough ?? 0, runStart, !!(opts.all || opts.rebuild), lease);
    const pending = await this.markPendingAppends(workFor, runStart);
    const deletions = await this.markDeletions(workFor, cutoff, ctx);

    const tags = [...work.keys()].sort();
    // Hashtags whose head this run didn't swap: what waits on them below waits for a later run.
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
    this.settledCutoff = failed.size ? null : cutoff;
    // Likes and profile changes up to this run's start are now applied. Saved before the work below,
    // so a run killed during it doesn't mark them all again.
    const minDay = utcDay(runStart) - this.retentionDays + 1;
    const next: State = { through: runStart, relatedThrough, summariesPurgedBefore: state.summariesPurgedBefore };
    await lease.check();
    await hot.set(COMPACTOR_STATE_KEY, JSON.stringify(next));

    // Everything below relies on the heads this run published still being the current ones.
    for (const p of pending) {
      if (failed.has(p.tag)) continue;
      await lease.check();
      // Not a row a write stamped again since: its line may not be in the tail yet either.
      await db.deleteFrom('pending_appends').where('content_id', '=', p.id).where('tag', '=', p.tag).where('created_at', '=', p.stamp).execute();
    }
    await this.settleDecisions(decisions, failed, runStart, lease, ctx);
    const deleted: string[] = [];
    for (const d of deletions) {
      if (d.tags.some((t) => failed.has(t))) continue;
      await lease.check();
      // The post's comments, which only the content store lists by post: while the row is still there, so a run that fails here finds them again.
      await this.deps.comments.removeAll(d.id);
      // Likes and pending_appends rows cascade, and so do the rows of the comments that waited in a queue.
      await db.deleteFrom('content').where('id', '=', d.id).where('delete_requested_at', 'is not', null).execute();
      await summaries.remove([{ contentId: d.id, createdAt: d.createdAt }]);
      await content.remove(d.id);
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

    // Once a UTC day, what is past its retention goes: inbox messages and notices, then summaries.
    if (state.summariesPurgedBefore !== minDay) {
      await lease.check();
      const expired = await db.deleteFrom('inbox').where('created_at', '<', runStart - this.cfg.inbox.retentionDays * DAY).executeTakeFirst();
      if (Number(expired.numDeletedRows) > 0) this.deps.log?.info({ messages: Number(expired.numDeletedRows) }, 'deleted inbox messages past retention');
      const purged = await summaries.purgeBefore(minDay);
      if (purged.length) this.deps.log?.info({ days: purged.length }, 'deleted summaries past retention');
      await lease.check();
      await hot.set(COMPACTOR_STATE_KEY, JSON.stringify({ ...next, summariesPurgedBefore: minDay } satisfies State));
    }

    if (tags.length || deleted.length) this.deps.log?.info({ tags: tags.length, deleted: deleted.length }, 'compacted the feed index');
    return { tags, deleted };
  }

  /**
   * `--rebuild`: every content within retention is re-admitted under its tags and its publisher's own
   * index, and every publisher credit and every user's follows rewritten.
   */
  private async markEverything(workFor: (tag: string) => TagWork, runStart: number, lease: CompactorLease, ctx: RunContext) {
    const rows = await this.deps.db
      .selectFrom('content')
      .select(['id', 'user_id', 'created_at'])
      .where('delete_requested_at', 'is', null)
      .where('created_at', '>', runStart - this.retentionDays * DAY)
      .execute();
    await this.markContent(workFor, rows, ctx, { readmit: true });
    const users = await this.deps.db.selectFrom('users').select(['id', 'username']).execute();
    await this.putCredits(users, lease);
    await this.syncFollowing(users.map((u) => u.id), lease);
  }

  /** (tag, day) of content liked in [since, until); the liked content is re-admitted if it was trimmed. */
  private async markNewLikes(workFor: (tag: string) => TagWork, since: number, until: number, ctx: RunContext) {
    const rows = await this.deps.db
      .selectFrom('likes')
      .innerJoin('content', 'content.id', 'likes.content_id')
      .select(['content.id', 'content.user_id', 'content.created_at'])
      .distinct()
      .where('likes.created_at', '>=', since)
      .where('likes.created_at', '<', until)
      .where('content.created_at', '>', until - this.retentionDays * DAY)
      .execute();
    await this.markContent(workFor, rows, ctx, { readmit: true });
  }

  /**
   * Rewrites the Redis credit of users who registered or changed their username in [since, until).
   * The request already wrote it; this repairs a write that failed.
   */
  private async syncChangedPublishers(since: number, until: number, lease: CompactorLease) {
    const users = await this.deps.db
      .selectFrom('users')
      .select(['id', 'username'])
      .where('updated_at', '>=', since)
      .where('updated_at', '<', until)
      .execute();
    if (users.length) await this.putCredits(users, lease);
  }

  private async putCredits(users: { id: string; username: string }[], lease: CompactorLease) {
    await lease.check();
    await mapLimit(users, 16, (u) => this.deps.publishers.put({ userId: u.id, username: u.username }));
  }

  /**
   * Rewrites the follows in Redis of users who followed someone in [since, until). The request already
   * wrote them; this repairs a write that failed, or two that raced. An unfollow leaves no row to find
   * its user by, so its request fails if its write does (see followRoutes).
   */
  private async syncChangedFollowing(since: number, until: number, lease: CompactorLease) {
    const users = await this.deps.db
      .selectFrom('follows')
      .select('follower_id')
      .distinct()
      .where('created_at', '>=', since)
      .where('created_at', '<', until)
      .execute();
    await this.syncFollowing(users.map((u) => u.follower_id), lease);
  }

  /**
   * Works out again, and writes to Redis, the related hashtags of every hashtag with a count in
   * `tag_pairs` made in [since, the run's start less the grace period), or of every hashtag there:
   * with `everything`, and when no run has applied any yet. Returns the instant the counts are now
   * applied through: `since` if it failed, which is logged, and leaves them for the next run, as
   * nothing else a run does depends on it.
   *
   * A count is stamped when its statement runs, by the node that runs it, so one stamped before
   * the grace period may only be readable, or only seem that old, once it has passed: counts
   * younger than that wait for a later run.
   */
  private async syncRelatedTags(since: number, runStart: number, everything: boolean, lease: CompactorLease): Promise<number> {
    const { db, relatedTags, log } = this.deps;
    const until = Math.max(since, runStart - this.cfg.compact.graceSeconds * 1000);
    // No run has applied any yet (or Redis lost which had): every hashtag's are due.
    const all = everything || since === 0;
    if (until === since && !all) return since;
    try {
      let rows = db.selectFrom('tag_pairs').select(['tag_a', 'tag_b']);
      // Every hashtag counted has the row of its own posts.
      rows = all ? rows.whereRef('tag_a', '=', 'tag_b') : rows.where('updated_at', '>=', since).where('updated_at', '<', until);
      const tags = [...new Set((await rows.execute()).flatMap((r) => [r.tag_a, r.tag_b]))];
      for (let i = 0; i < tags.length; i += BATCH) {
        await lease.check();
        await mapLimit(tags.slice(i, i + BATCH), this.cfg.compact.concurrency, async (tag) => relatedTags.put(tag, await this.relatedTo(tag)));
      }
      return until;
    } catch (err) {
      if (err instanceof LeaseLostError) throw err;
      log?.error({ err }, 'could not work out related hashtags; the next run tries again');
      return since;
    }
  }

  /**
   * The hashtags related to `tag`, most related first: those on the most posts that carry `tag`
   * too, of the ones on at least `relatedMinPosts` such posts which are at least `relatedMinPercent`
   * of all the posts that carry `tag`. At most `relatedTags` of them.
   *
   * It is one-sided: #pets is related to #dogs when a good share of the posts under #dogs are under
   * #pets too, whatever share of #pets' posts they are.
   */
  private async relatedTo(tag: string): Promise<string[]> {
    const { db } = this.deps;
    const { relatedTags: most, relatedMinPosts, relatedMinPercent } = this.cfg.feed;
    const own = await db.selectFrom('tag_pairs').select('posts').where('tag_a', '=', tag).where('tag_b', '=', tag).executeTakeFirst();
    if (!own || most === 0) return [];
    const least = Math.max(relatedMinPosts, Math.ceil((own.posts * relatedMinPercent) / 100));
    // A pair's row names its hashtags in order, so `tag` is the first of some of its pairs and the second of the others.
    const [first, second] = await Promise.all([
      db.selectFrom('tag_pairs').select(['tag_b as tag', 'posts']).where('tag_a', '=', tag).where('tag_b', '<>', tag).where('posts', '>=', least).orderBy('posts', 'desc').orderBy('tag_b').limit(most).execute(),
      db.selectFrom('tag_pairs').select(['tag_a as tag', 'posts']).where('tag_b', '=', tag).where('tag_a', '<>', tag).where('posts', '>=', least).orderBy('posts', 'desc').orderBy('tag_a').limit(most).execute(),
    ]);
    return [...first, ...second]
      .sort((a, b) => b.posts - a.posts || (a.tag < b.tag ? -1 : 1))
      .slice(0, most)
      .map((r) => r.tag);
  }

  private async syncFollowing(userIds: string[], lease: CompactorLease) {
    for (let i = 0; i < userIds.length; i += BATCH) {
      await lease.check();
      await syncFollowing(this.deps.db, this.deps.follows, userIds.slice(i, i + BATCH));
    }
  }

  /**
   * Tails that /store didn't confirm hold a write's line (an append failed, or the node stopped
   * first), once the grace period has given the node time to finish. The content's entry in that
   * tag is rebuilt from the database and its meta file: added where the write gave it the tag,
   * dropped where it no longer carries it. Returns the rows, each deleted once its tag is compacted.
   */
  private async markPendingAppends(workFor: (tag: string) => TagWork, until: number) {
    const rows = await this.deps.db
      .selectFrom('pending_appends')
      .innerJoin('content', 'content.id', 'pending_appends.content_id')
      .select(['content.id', 'pending_appends.tag', 'pending_appends.created_at as stamp', 'content.created_at'])
      .where('pending_appends.created_at', '<', until - this.cfg.compact.graceSeconds * 1000)
      .execute();
    for (const r of rows) {
      // Past retention there is no day to rebuild; the row just goes.
      if (r.created_at <= until - this.retentionDays * DAY) continue;
      const day = utcDay(r.created_at);
      const w = workFor(r.tag);
      w.days.add(day);
      addTo(w.recheck, day, r.id);
    }
    return rows.map((r) => ({ id: r.id, tag: r.tag, stamp: r.stamp }));
  }

  /**
   * Applies what tag moderators decided before `until` that no run has applied yet. A hashtag they
   * removed is taken off the content (see untag). For either decision the content's UTC day is
   * marked under the hashtag, and buildDay builds it to the decisions: it flags what is approved and
   * leaves out what is removed. Returns the decisions, each recorded as applied once its hashtag is
   * compacted (see settleDecisions); a removal that couldn't be taken off the content isn't among
   * them, so the next run tries again.
   */
  private async applyDecisions(workFor: (tag: string) => TagWork, until: number, lease: CompactorLease, ctx: RunContext): Promise<Decision[]> {
    const rows = await this.deps.db
      .selectFrom('tag_moderation')
      .innerJoin('content', 'content.id', 'tag_moderation.content_id')
      .select([
        'content.id',
        'content.user_id',
        'content.created_at',
        'content.ai_generated',
        'content.delete_requested_at',
        'tag_moderation.tag',
        'tag_moderation.decision',
        'tag_moderation.decided_at',
      ])
      .where('tag_moderation.applied_at', 'is', null)
      .where('tag_moderation.decided_at', '<', until)
      // Content set for deletion keeps its hashtags until it goes, and its decisions go with it.
      .where('content.delete_requested_at', 'is', null)
      .execute();
    if (!rows.length) return [];

    await lease.check();
    const removals = new Map(rows.filter((r) => r.decision === 'removed').map((r) => [r.id, r]));
    const unapplied = new Set<string>();
    await mapLimit([...removals.values()], 16, async (row) => {
      try {
        await this.untag(row, until, ctx);
      } catch (err) {
        unapplied.add(row.id);
        this.deps.log?.error({ err, contentId: row.id }, 'could not take the hashtags a moderator removed off the content');
      }
    });

    const applied: Decision[] = [];
    for (const r of rows) {
      // Past retention no index holds the content.
      if (r.created_at > until - this.retentionDays * DAY) workFor(r.tag).days.add(utcDay(r.created_at));
      if (r.decision === 'removed' && unapplied.has(r.id)) continue;
      applied.push({ id: r.id, tag: r.tag, decision: r.decision, decidedAt: r.decided_at });
    }
    return applied;
  }

  /**
   * Takes off a piece of content the hashtags moderators removed from it: writes its summary and
   * meta file again without them, which is what the content carries from then on. Its bytes stay
   * as they are, and its other hashtags' indexes aren't touched: they show the summary as it now
   * is. Content left with no hashtag is set for deletion instead, since a post needs one, and
   * content that doesn't carry them (any more) is left as it is.
   */
  private async untag(
    row: { id: string; user_id: string; created_at: number; ai_generated: number; delete_requested_at: number | null },
    at: number,
    ctx: RunContext,
  ): Promise<void> {
    const { db, content, summaries, log } = this.deps;
    // All of them, not only this run's: a write under way when one was removed may have written it back.
    const rows = await db.selectFrom('tag_moderation').select('tag').where('content_id', '=', row.id).where('decision', '=', 'removed').execute();
    const removed = new Set(rows.map((r) => r.tag));
    const meta = await content.getMeta(row.id);
    if (!meta) return;
    const tags = meta.tags.filter((tag) => !removed.has(tag));
    if (tags.length === meta.tags.length) return;
    if (!tags.length) {
      // The route that removed the last one did this already, unless two moderators each removed one of the last two.
      await setForDeletion({ ...this.deps, now: this.now }, row, { warn: (o, msg) => log?.warn(o, msg) });
      return;
    }
    const next: ContentMeta = { ...meta, tags, updatedAt: Math.max(meta.updatedAt, at) };
    // The meta file last, as for any write: what it says is there.
    await summaries.put(summaryOf(row, next, this.cfg.publicBaseUrl));
    await content.putMeta(next);
    ctx.metas.set(row.id, Promise.resolve(next));
  }

  /**
   * Records as applied the decisions whose hashtag this run compacted, so the next run doesn't apply
   * them again. A removal that an index turned out to still hold an entry for (see RunContext.strays)
   * is recorded as not applied instead, so the next run does.
   */
  private async settleDecisions(decisions: Decision[], failed: Set<string>, runStart: number, lease: CompactorLease, ctx: RunContext) {
    const { db } = this.deps;
    for (const d of decisions) {
      if (failed.has(d.tag)) continue;
      await lease.check();
      // Not a decision made since: this run applied the one before it.
      await db
        .updateTable('tag_moderation')
        .set({ applied_at: runStart })
        .where('content_id', '=', d.id)
        .where('tag', '=', d.tag)
        .where('decided_at', '=', d.decidedAt)
        .where('applied_at', 'is', null)
        .execute();
    }
    for (const s of ctx.strays) {
      await db.updateTable('tag_moderation').set({ applied_at: null }).where('content_id', '=', s.id).where('tag', '=', s.tag).where('decision', '=', 'removed').execute();
    }
  }

  /**
   * Content set for deletion long enough ago that the tail windows of its last write are among those
   * this run merges: an entry in an open tail can't be removed, so recently written content waits
   * for its window to close. No write commits once the deletion is set, and /store appends right
   * after its commit, so that append is within the grace period of `delete_requested_at`. Marked
   * under its hashtags and under those a write of it left a pending row for, so each of its entries
   * is dropped. Returns the rows with the tags whose compaction must succeed before the content is deleted.
   */
  private async markDeletions(workFor: (tag: string) => TagWork, cutoff: number, ctx: RunContext) {
    const { db } = this.deps;
    const rows = await db
      .selectFrom('content')
      .select(['id', 'user_id', 'created_at'])
      .where('delete_requested_at', 'is not', null)
      .where('delete_requested_at', '<', cutoff - this.cfg.compact.graceSeconds * 1000)
      .execute();
    const tagsOf = await this.markContent(workFor, rows, ctx);
    const pending = new Map<string, string[]>();
    for (let i = 0; i < rows.length; i += BATCH) {
      const ids = rows.slice(i, i + BATCH).map((r) => r.id);
      for (const p of await db.selectFrom('pending_appends').select(['content_id', 'tag']).where('content_id', 'in', ids).execute()) {
        const tags = pending.get(p.content_id);
        if (tags) tags.push(p.tag);
        else pending.set(p.content_id, [p.tag]);
      }
    }
    return rows.map((r) => {
      const tags = new Set(tagsOf.get(r) ?? []);
      for (const tag of pending.get(r.id) ?? []) {
        tags.add(tag);
        workFor(tag).days.add(utcDay(r.created_at));
      }
      return { id: r.id, createdAt: r.created_at, tags: [...tags] };
    });
  }

  private meta(contentId: string, ctx: RunContext): Promise<ContentMeta | null> {
    let meta = ctx.metas.get(contentId);
    if (!meta) ctx.metas.set(contentId, (meta = this.deps.content.getMeta(contentId)));
    return meta;
  }

  /**
   * Marks the content's UTC day under each of its hashtags, read from its meta file, and under its
   * publisher's own index; returns every index marked for each row.
   */
  private async markContent<R extends { id: string; user_id: string; created_at: number }>(
    workFor: (tag: string) => TagWork,
    rows: R[],
    ctx: RunContext,
    opts: { readmit?: boolean } = {},
  ): Promise<Map<R, string[]>> {
    const tagsOf = new Map<R, string[]>();
    await mapLimit(rows, 16, async (r) => {
      const day = utcDay(r.created_at);
      const meta = await this.meta(r.id, ctx);
      // The content is its publisher's, whatever its meta file holds.
      const tags = [...(meta?.tags ?? []), authorIndex(r.user_id)];
      for (const tag of tags) {
        const w = workFor(tag);
        w.days.add(day);
        if (opts.readmit) addTo(w.readmit, day, r.id);
      }
      tagsOf.set(r, tags);
    });
    return tagsOf;
  }

  async compactTag(tag: string, work: TagWork, cutoff: number, runStart: number, lease: CompactorLease, ctx: RunContext): Promise<void> {
    const { hot } = this.deps;
    const head = await readHead(hot, tag);
    const manifest = head.manifest ? await readJson<Manifest>(hot, manifestKey(tag, head.manifest)) : null;
    if (head.manifest && !manifest && !ctx.rebuild) throw new Error(`manifest ${head.manifest} of #${tag} is missing`);
    const mergedThrough = Math.max(head.mergedThrough, cutoff);

    const today = utcDay(runStart);
    const minDay = today - this.retentionDays + 1;
    const author = indexAuthor(tag) !== null;
    const quotaOf = (day: number) =>
      author ? this.cfg.feed.authorDayMaxPosts : dayQuota(today - day, this.cfg.feed.tagDayMaxPosts, this.cfg.feed.tagDayMinPosts);

    // Entries not yet in a day index, by UTC day, in push order so later entries (of later writes) win.
    const incoming = new Map<number, IndexEntry[]>();
    // The content of merged tombstones, by day: once a tombstone leaves the open tails, the day must no
    // longer hold what it hid. A tombstone doesn't say what the content carries now (a later write may
    // have given the hashtag back), so the content's entry is rebuilt from the database and its meta file.
    const recheck = new Map([...work.recheck].map(([day, ids]) => [day, new Set(ids)]));
    const windows = await hot.scores(tailIndexKey(tag), head.mergedThrough, mergedThrough);
    for (const list of await readTails(hot, tag, windows)) {
      for (const e of list) {
        if (!e) continue;
        const day = utcDay(e.createdAt);
        if (isTombstone(e)) {
          addTo(recheck, day, e.contentId);
          continue;
        }
        // An approval is applied from `tag_moderation`, which records it: the line only showed it meanwhile.
        if (isApproval(e)) continue;
        let into = incoming.get(day);
        if (!into) incoming.set(day, (into = []));
        into.push(e);
      }
    }

    const existing = new Map((manifest?.days ?? []).map((d) => [d.day, d]));
    const rebuild = new Set([...work.days, ...incoming.keys(), ...recheck.keys()]);
    for (const d of existing.values()) if (work.all || d.quota > quotaOf(d.day)) rebuild.add(d.day);

    const days: DayRef[] = [...existing.values()].filter((d) => d.day >= minDay && !rebuild.has(d.day));
    const written: string[] = [];
    const id = newManifestId(runStart, mergedThrough);
    try {
      for (const day of rebuild) {
        if (day < minDay) continue;
        const ids = { readmit: work.readmit.get(day), recheck: recheck.get(day) };
        const built = await this.buildDay(tag, day, existing.get(day), incoming.get(day) ?? [], ids, { quota: quotaOf(day), runStart }, ctx);
        if (!built) continue;
        days.push(built);
        written.push(dayKey(tag, built.gen));
      }
      days.sort((a, b) => b.day - a.day);
      const next: Manifest = { v: 4, tag, id, mergedThrough, createdAt: runStart, days };
      written.push(manifestKey(tag, id));
      await hot.set(manifestKey(tag, id), JSON.stringify(next), this.provisionalMs);
      await lease.check();
      // Until here everything written expires on its own, so a run killed at any point before leaves
      // nothing for good. Now it is made to last, and the head swapped to it straight after.
      const kept = await hot.persist(written);
      if (kept.includes(false)) throw new Error(`part of the new index of #${tag} expired or was evicted before its head was swapped`);
    } catch (err) {
      // No head references these yet.
      await hot.del(written).catch(() => {});
      throw err;
    }
    const nextHead: Head = { v: 4, manifest: id, mergedThrough, compactedAt: runStart };
    await hot.set(headKey(tag), JSON.stringify(nextHead));

    // Readers pinned to the previous head keep its keys, and the tails it hadn't merged, for the cursor lifetime.
    const kept = new Set(days.map((d) => d.gen));
    const superseded = (manifest?.days ?? []).filter((d) => !kept.has(d.gen)).map((d) => dayKey(tag, d.gen));
    if (manifest) superseded.push(manifestKey(tag, manifest.id));
    await hot.expire(superseded, this.keepMs);
    await hot.expire(windows.map((w) => tailKey(tag, w)), this.keepMs);
    await this.cleanup(tag);
  }

  /**
   * Rebuilds one UTC day's index from its current index, new tail entries, and content rebuilt from
   * the database: `recheck` whether the day holds it or not, `readmit` if it doesn't. null if empty.
   */
  private async buildDay(
    tag: string,
    day: number,
    prev: DayRef | undefined,
    incoming: IndexEntry[],
    ids: { readmit?: Set<string>; recheck?: Set<string> },
    opts: { quota: number; runStart: number },
    ctx: RunContext,
  ): Promise<DayRef | null> {
    // An entry pushed later takes the place of the content's earlier one.
    const latest = new Map<string, IndexEntry>();
    const add = (e: IndexEntry) => latest.set(e.contentId, e);
    if (prev) {
      const buf = await this.deps.hot.get(dayKey(tag, prev.gen));
      if (!buf && !ctx.rebuild) throw new Error(`day index ${prev.gen} of #${tag} is missing`);
      if (buf) unpackDay(buf).forEach(add);
    }
    incoming.forEach(add);

    const recheck = ids.recheck ?? new Set<string>();
    for (const id of recheck) latest.delete(id);
    const entries = await this.refresh(tag, [...latest.values()], opts.runStart, ctx);
    const missing = [...(ids.readmit ?? [])].filter((id) => !latest.has(id) && !recheck.has(id));
    entries.push(...(await this.readmitted(tag, [...recheck, ...missing], opts.runStart, ctx)));
    const kept = this.trim(entries, opts.quota, indexAuthor(tag) !== null);
    if (!kept.length) return null;
    const gen = newGenId(day, opts.runStart);
    // Provisional until compactTag swaps the head.
    await this.deps.hot.set(dayKey(tag, gen), packDay(kept), this.provisionalMs);
    return { day, gen, quota: opts.quota, count: kept.length };
  }

  /**
   * Entries rebuilt from the database and each content's meta file, for content the day doesn't hold
   * as they do: liked content an earlier compaction trimmed, content whose tail append never
   * happened, and content a tombstone or an unconfirmed write says to look at again. Content set for
   * deletion, past retention, waiting in the moderation queue, or that doesn't carry the tag (or, in
   * a publisher's own index, isn't theirs), gets none; nor does content a moderator removed the tag
   * from. Their summaries are restored if a tier lacks them. They then compete for the day's quota
   * like any entry.
   */
  private async readmitted(tag: string, ids: string[], runStart: number, ctx: RunContext): Promise<IndexEntry[]> {
    const author = indexAuthor(tag);
    const out: IndexEntry[] = [];
    for (let i = 0; i < ids.length; i += BATCH) {
      const rows = await this.deps.db
        .selectFrom('content')
        .leftJoin('moderation_queue', 'moderation_queue.content_id', 'content.id')
        .select(['content.id', 'content.user_id', 'content.like_count', 'content.created_at', 'content.ai_generated'])
        .where('content.id', 'in', ids.slice(i, i + BATCH))
        .where('content.delete_requested_at', 'is', null)
        .where('moderation_queue.content_id', 'is', null)
        .where('content.created_at', '>', runStart - this.retentionDays * DAY)
        .execute();
      const decided = await this.decisionsOf(tag, rows.map((r) => r.id));
      await mapLimit(rows, 16, async (row) => {
        const meta = await this.meta(row.id, ctx);
        if (!meta || (author !== null ? row.user_id !== author : !meta.tags.includes(tag))) return;
        const moderated = this.moderated(tag, row.id, decided, ctx);
        if (moderated === null) return;
        const summary = summaryOf(row, meta, this.cfg.publicBaseUrl);
        let ensured = ctx.ensured.get(row.id);
        if (!ensured) ctx.ensured.set(row.id, (ensured = this.deps.summaries.ensure(summary)));
        await ensured;
        out.push({ contentId: row.id, createdAt: row.created_at, likes: row.like_count, aiGenerated: summary.aiGenerated, moderated });
      });
    }
    return out;
  }

  /**
   * Applies current likes, the AI flag and, in a hashtag's index, what its moderators decided, from
   * the database: content they approved is flagged as moderated, and content they removed the
   * hashtag from is dropped. So is content that is deleted, set for deletion, past retention, or
   * waiting in the moderation queue.
   */
  private async refresh(tag: string, entries: IndexEntry[], runStart: number, ctx: RunContext): Promise<IndexEntry[]> {
    const oldest = runStart - this.retentionDays * DAY;
    const out: IndexEntry[] = [];
    for (let i = 0; i < entries.length; i += BATCH) {
      const batch = entries.slice(i, i + BATCH);
      const ids = batch.map((e) => e.contentId);
      const rows = await this.deps.db
        .selectFrom('content')
        .leftJoin('moderation_queue', 'moderation_queue.content_id', 'content.id')
        .select(['content.id', 'content.like_count', 'content.ai_generated', 'content.delete_requested_at', 'moderation_queue.content_id as queued_id'])
        .where('content.id', 'in', ids)
        .execute();
      const decided = await this.decisionsOf(tag, ids);
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const e of batch) {
        const row = byId.get(e.contentId);
        if (!row || row.delete_requested_at !== null || row.queued_id !== null || e.createdAt <= oldest) continue;
        const moderated = this.moderated(tag, e.contentId, decided, ctx);
        if (moderated === null) continue;
        out.push({ ...e, likes: row.like_count, aiGenerated: row.ai_generated === 1, moderated });
      }
    }
    return out;
  }

  /** What a hashtag's moderators decided about each of these pieces of content under it. A publisher's own index has no moderators. */
  private async decisionsOf(tag: string, ids: string[]): Promise<Map<string, { decision: TagDecision; applied: boolean }>> {
    if (indexAuthor(tag) !== null || !ids.length) return new Map();
    const rows = await this.deps.db
      .selectFrom('tag_moderation')
      .select(['content_id', 'decision', 'applied_at'])
      .where('tag', '=', tag)
      .where('content_id', 'in', ids)
      .execute();
    return new Map(rows.map((r) => [r.content_id, { decision: r.decision, applied: r.applied_at !== null }]));
  }

  /**
   * Whether the content's entry in a hashtag's index is flagged as moderated: its moderators
   * approved it. null if they removed the hashtag from the content, which then has no entry there.
   * An index that still has one after a run took the hashtag off the content is how a hashtag
   * written back to it shows (see RunContext.strays).
   */
  private moderated(tag: string, id: string, decided: Map<string, { decision: TagDecision; applied: boolean }>, ctx: RunContext): boolean | null {
    const d = decided.get(id);
    if (d?.decision !== 'removed') return d?.decision === 'approved';
    if (d.applied) ctx.strays.push({ id, tag });
    return null;
  }

  /**
   * Sorts one day's entries by likes, then recency (a publisher's own index: by recency alone), and
   * keeps the first `quota` of them. Creation times are cut to the whole seconds an index stores
   * first, so the index order is the order readers see.
   */
  private trim(entries: IndexEntry[], quota: number, newestFirst: boolean): IndexEntry[] {
    return entries
      .map((e) => ({ ...e, createdAt: wholeSeconds(e.createdAt) }))
      .sort(newestFirst ? compareRecent : compareRecords)
      .slice(0, quota);
  }

  /** Forgets merged tail windows whose lists have expired. */
  private async cleanup(tag: string): Promise<void> {
    const { hot } = this.deps;
    const head = await readHead(hot, tag);
    const merged = await hot.scores(tailIndexKey(tag), 0, head.mergedThrough);
    if (!merged.length) return;
    const present = await hot.exists(merged.map((w) => tailKey(tag, w)));
    await hot.zrem(tailIndexKey(tag), merged.filter((_, i) => !present[i]));
  }

  /**
   * Runs for as long as the process is up, until stopped: a run starts `intervalSeconds` after the
   * previous one started, or as soon as that one ends if it took longer. So runs never overlap, and
   * there is never more than one in `intervalSeconds`.
   */
  start(): () => Promise<void> {
    const intervalMs = this.cfg.compact.intervalSeconds * 1000;
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    let running: Promise<unknown> = Promise.resolve();
    const tick = () => {
      const startedAt = Date.now();
      running = this.runOnce()
        .catch((err) => this.deps.log?.error({ err }, 'compactor run failed'))
        .finally(() => {
          if (!stopped) timer = setTimeout(tick, Math.max(0, intervalMs - (Date.now() - startedAt)));
        });
    };
    timer = setTimeout(tick, intervalMs);
    return async () => {
      stopped = true;
      clearTimeout(timer);
      await running;
    };
  }
}

/** The compactor of an app's database and stores. */
export function createCompactor({ config, db, hot, summaries, content, comments, publishers, follows, relatedTags, appender, now }: AppDeps, log?: CompactorLog) {
  return new Compactor({ config, db, hot, summaries, content, comments, publishers, follows, relatedTags, appender, now, log });
}
