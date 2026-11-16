import type { ExpressionBuilder } from 'kysely';
import { purgeAccounts, sweepContent } from '../accounts.js';
import { summaryOf } from '../content.js';
import type { Database, TagDecision } from '../db/schema.js';
import type { AppDeps } from '../deps.types.js';
import { syncFollowing } from '../follows.js';
import { publishedAd } from '../monetization.js';
import { repostedTags, repostTimes, type Repost } from '../reposts.js';
import type { ContentMeta, Summary } from '../storage/index.js';
import { authorIndex, compareRecent, compareRecords, COMPACTOR_STATE_KEY, dayKey, dayQuota, EMPTY_HEAD, headKey, indexAuthor, manifestKey, newGenId, newManifestId, packDay, unpackDay } from '../tagfeed/layout.js';
import type { DayRef, Head, IndexEntry, Manifest } from '../tagfeed/layout.types.js';
import { readJson } from '../tagfeed/read.js';
import { DAY, HOUR, MINUTE, utcDay, wholeSeconds } from '../time.js';
import { mapLimit } from '../util.js';
import { applyPending } from './apply.js';
import type { RunOptions, RunResult } from './compactor.types.js';
import { CompactorLease, LeaseLostError, RunStoppedError } from './lease.js';

/**
 * The most values a run names in the `in (...)` list of one database statement (content ids, user
 * ids, queue tokens), and the most hashtags or users it syncs to Redis between two checks of its
 * lease.
 */
const BATCH = 500;

/** Meta files of queued content read at once, ahead of the indexes that need them. */
const META_READS = 64;

/** Indexes a run opens together: their heads are one round trip, and their manifests another. */
const TAG_BATCH = 200;

/** No content: what a day's plan has for `recheck` or `readmit` when the tag's work names nothing for that day. */
const NONE: ReadonlySet<string> = new Set();

/**
 * What a key of the hot store holds, parsed as the JSON a run wrote there: a head or a manifest.
 * Its shape isn't checked. Throws if it isn't JSON.
 */
const json = <T>(buf: Buffer) => JSON.parse(buf.toString('utf8')) as T;

type LogFn = (o: object, msg?: string) => void;
type CompactorLog = { info: LogFn; warn: LogFn; error: LogFn };

/**
 * What a `Compactor` works with: of what an app has (`AppDeps`), the settings, the database, the
 * stores and the clock, and the log it reports to, if any. `createCompactor` makes it.
 */
interface CompactorDeps extends Pick<AppDeps, 'config' | 'db' | 'hot' | 'summaries' | 'content' | 'comments' | 'publishers' | 'follows' | 'relatedTags' | 'ads' | 'now'> {
  log?: CompactorLog;
}

/** A row of `feed_queue` a run took: content whose entry in a tag's index it rebuilds. */
interface QueueRow {
  id: string;
  tag: string;
  /** Names the write that stamped the row: the run deletes the row only if it still holds it. */
  token: string;
  /** When the row was stamped, by the node that wrote it. */
  queued_at: number;
  /** The content's creation time, which picks the UTC day holding its entry, unless a repost placed it in the tag (see Placement). */
  created_at: number;
}

/**
 * Where a piece of content is in an index, and what its entry there counts.
 *
 * Content is in the index of each hashtag it carries and in its publisher's own from when it was
 * created, with all of its likes. A repost (`reposts`) places it elsewhere as a new post: in the
 * index of each hashtag the repost gave it, and in the reposter's own, from when it was reposted,
 * with the likes since. The time is the UTC day its entry is in, where feeds order it, and what
 * its retention is counted from: content older than the retention period is in an index for as
 * long as a repost that put it there is within it.
 */
interface Placement {
  at: number;
  /** The content's like count when it was placed: its entry counts the likes since. */
  likesBefore: number;
  /** A repost placed it. */
  repost: boolean;
}

/** A place in a reposter's own index that a run takes away: the reposter's account is gone (see markGoneReposters). */
interface GonePlace {
  id: string;
  tag: string;
}

/**
 * How far the compactor's runs have got, which is all it keeps from one run to the next: in the hot
 * store, under `COMPACTOR_STATE_KEY`. A run reads it as it starts (none there counts as nothing
 * applied yet), writes it once its tags are compacted, and again once it has deleted what is past
 * retention, which it does once a UTC day.
 */
interface State {
  /** Likes and profile changes before this instant have been applied. */
  through: number;
  /** Hashtag counts (`tag_pairs`) made before this instant are in the related hashtags Redis holds. */
  relatedThrough?: number;
  /** Summaries of UTC days before this one have been deleted, and inboxes were trimmed to their retention on the day that was done. */
  summariesPurgedBefore?: number;
}

/** What to rebuild for one tag in a run. */
interface TagWork {
  days: Set<number>;
  /** Per day, content to reconsider if the day doesn't hold it: an earlier compaction trimmed it (or Redis lost it). */
  readmit: Map<number, Set<string>>;
  /**
   * Per day, content whose entry is rebuilt from the database and its meta file whether the day holds
   * it or not, and dropped if it no longer carries the tag: the content of the feed queue's rows.
   */
  recheck: Map<number, Set<string>>;
  /** Rebuild every day (`--all`). */
  all: boolean;
}

/** Shared by every tag of one run. */
interface RunContext {
  /** Rebuilding from the database: a missing manifest or day index counts as empty instead of failing the tag. */
  rebuild: boolean;
  /** Summaries checked (and restored if missing) this run, so content in several tags is checked once: what went wrong with each, or null. */
  ensured: Map<string, Promise<Error | null>>;
  /** Meta files read this run, so content in several tags is read once. */
  metas: Map<string, Promise<ContentMeta | null>>;
  /**
   * The places reposts gave content (`reposts`), by content, read this run: once for each piece
   * of content, however many tags it is in. Without the places this run takes away (`gone`).
   */
  reposts: Map<string, Repost[]>;
  /** The places in the own index of a reposter whose account is gone, by `decidedKey`: they count as not there. */
  gone: Set<string>;
  /** Tags whose head this run didn't swap: what waits on them waits for a later run. */
  failed: Set<string>;
}

/** A content row as a chunk reads it: once, for every index of the chunk that holds the content or may come to. */
interface ContentRow {
  id: string;
  user_id: string;
  like_count: number;
  created_at: number;
  ai_generated: number;
  delete_requested_at: number | null;
  /** Its id again, if it waits in the moderation queue. */
  queued_id: string | null;
}

/** What hashtags' moderators decided about content under them, by `decidedKey`. */
type Decided = Map<string, TagDecision>;
/** A tag and a piece of content as one string, which `Decided` and `RunContext.gone` are keyed by. */
const decidedKey = (tag: string, contentId: string) => `${tag} ${contentId}`;

/** One UTC day of a tag that a run rebuilds. */
interface DayPlan {
  day: number;
  /** The day's index as the tag's manifest names it, if it names one. */
  prev?: DayRef;
  quota: number;
  recheck: ReadonlySet<string>;
  readmit: ReadonlySet<string>;
}

/** What a run does to one tag, worked out from its manifest before any of its day indexes is read. */
interface TagPlan {
  tag: string;
  /** The publisher whose own index this is; null for a hashtag. */
  author: string | null;
  /** The manifest its head names; null for a tag with none. */
  manifest: Manifest | null;
  /** Days the next manifest names as they are. */
  carried: DayRef[];
  days: DayPlan[];
  /** About how many entries its days hold, which is what chunks are sized by. */
  weight: number;
}

/** A day as a chunk rebuilds it. */
interface DayBuild {
  plan: DayPlan;
  /** The day's index as it is. */
  before: Buffer | null;
  /** The entries it holds of content that isn't rechecked, to be refreshed. */
  held: IndexEntry[];
  /** Content to build an entry for from the database and its meta file. */
  build: string[];
  entries: IndexEntry[];
}

/** A tag as a chunk rebuilds it: `compactChunk` fills in its days' entries, and `pack` makes its `Publication` of them. */
interface TagBuild {
  plan: TagPlan;
  days: DayBuild[];
  /** The summaries of the content it built entries for, which both tiers must hold before it is published. */
  summaries: Summary[];
}

/** A tag's new index, ready to be published. */
interface Publication {
  tag: string;
  /** The manifest it replaces. */
  previous: Manifest | null;
  next: Manifest;
  /** The day indexes that came out different, and the manifest. */
  writes: { key: string; value: Buffer | string }[];
}

/** The tags of a batch in chunks of about 25,000 entries; a tag that holds more is a chunk of its own. */
function* chunksOf(plans: TagPlan[]): Generator<TagPlan[]> {
  let chunk: TagPlan[] = [];
  let weight = 0;
  for (const plan of plans) {
    // 25,000 is about how many entries a run rebuilds together. The tags of a batch are taken a chunk
    // at a time, each chunk's days holding about that many between them, and a chunk is read, rebuilt
    // and published as one: it is what a run holds in memory, and what one round trip carries.
    if (chunk.length && weight + plan.weight > 25_000) {
      yield chunk;
      chunk = [];
      weight = 0;
    }
    chunk.push(plan);
    weight += plan.weight;
  }
  if (chunk.length) yield chunk;
}

/** A row of `tag_moderation` a run applies. */
interface Decision {
  id: string;
  tag: string;
  decision: TagDecision;
  /** Names the decision: a later one about the same content and hashtag isn't the one this run applied. */
  decidedAt: number;
}

/** Notes the content `id` under `day` in `ids`, a `TagWork`'s `recheck` or `readmit`, which it changes. */
const addTo = (ids: Map<number, Set<string>>, day: number, id: string) => {
  const set = ids.get(day);
  if (set) set.add(id);
  else ids.set(day, new Set([id]));
};

/**
 * Writes the feed index: it is the only thing that does. It is one process that runs for as long
 * as it is up (see `start`): pass after pass, never two at once, and never more than one in
 * `intervalSeconds`, which is therefore how long a write waits to reach feeds.
 *
 * Each tag has one index per UTC day, trimmed to a quota that halves with age down to a floor, kept
 * for `tagRetentionDays`. Each run rebuilds only the (tag, day) indexes that changed: those of the
 * content in the feed queue (`feed_queue`), where every write that commits leaves a row for each
 * index it changes the content's place in, new likes (re-admitting liked content that was trimmed
 * earlier), what tag moderators decided, and content set for deletion; days whose quota shrank are
 * re-trimmed. It then writes a new manifest and swaps the head, once per tag however many writes
 * the run took. Tags are compacted many at a time (see compactBatch): what a run costs in round
 * trips goes by its batches, not by its tags, so a run that took a post from each of a thousand
 * publishers doesn't make a thousand of everything. It then deletes the queue's rows it took, deletes content set for deletion that no day
 * index holds any more, and deletes summaries past retention (and with them, once a day, what is in
 * users' inboxes for longer than `inbox.retentionDays`). Each publisher's own index is compacted
 * the same way, alongside the hashtags of their content, but keeps each day's newest posts. Readers
 * are never blocked: a request under way keeps reading the keys it started with, which only expire
 * a minute after no node can still hold the head that named them.
 *
 * It is also the only thing that writes posts and comments to the stores. A request commits what
 * it writes to the database and nothing else (`pending_writes`, src/pending.ts), and each run
 * starts by applying those writes (see applyPending): a post's bytes, summary and meta file, and
 * a comment, its likes and its image or video. So one process writes them all, each post and
 * each comment as its newest write has it, and nothing is written to content that is set for
 * deletion, which the same run then deletes: no update, comment or like can bring back what was
 * deleted, or write over what a moderator removed.
 *
 * An entry is never copied from what a write says: it is built from the database and the content's
 * meta file as they are when the run reads them. The queue is read before the pending writes are
 * applied, and a write commits its rows in the queue with the write itself, so what a run reads
 * of the content of a row it took is that write's, or a later one's.
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
 * It is what makes a repost show (src/reposts.ts). A repost commits rows of `reposts`, which say
 * where it places the content, and rows in the feed queue for those indexes. The next run writes
 * the hashtags the repost added into the content's meta file and summary (see applyReposts), and
 * builds the content's entry in each of those indexes at the time of the repost (see Placement).
 * An update of the content that committed meanwhile is applied with them too (see applyPending).
 *
 * And it keeps each hashtag's related hashtags in Redis, where feeds asked to add them read them:
 * those of the hashtags whose counts in `tag_pairs` changed since its last run are worked out again
 * (see syncRelatedTags).
 *
 * And, where the server shows ads (MONETIZATION_FEED_ADS, MONETIZATION_POST_ADS), it publishes the
 * ones its admins keep to Redis, which is where feeds and posts read them (see syncAds): feeds
 * read no database, so this is how an ad reaches them.
 *
 * A run that is killed leaves nothing that lasts: what it wrote for a hashtag expires unless the
 * hashtag's head was swapped, and what it hadn't finished is found again by the next run.
 */
export class Compactor {
  private readonly now: () => number;
  /** The lease of the run this process is making, if it is making one: what stops the run (see `start`). */
  private current: CompactorLease | null = null;

  constructor(private readonly deps: CompactorDeps) {
    this.now = deps.now ?? Date.now;
  }

  private get cfg() {
    return this.deps.config;
  }

  private get retentionDays() {
    return Math.min(this.cfg.feed.tagRetentionDays, this.cfg.feed.maxLookbackDays);
  }

  /**
   * How long superseded keys stay readable: as long as a node may still serve the head that named
   * them from its cache, and a minute more for the requests that read it last. No feed session needs
   * them longer: a cursor names no index, and each page reads the one its tag's head names by then.
   */
  private get keepMs() {
    // A minute past the time a node caches a head: a request under way reads on from a head that was just replaced.
    return this.cfg.feed.headCacheMs + MINUTE;
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
   *
   * The lease is held until nothing of the run is under way: what a run does several of at once it
   * waits for before it fails (see mapLimit), so the run after it, here or anywhere, starts with
   * no write of this one still to land. `stopped` says whether the compactor was told to stop
   * (see `start`): a run that finds it so makes no write, and throws RunStoppedError.
   */
  async runOnce(opts: RunOptions = {}, stopped: () => boolean = () => false): Promise<RunResult & { skipped: boolean }> {
    const lease = new CompactorLease(this.deps.db, this.cfg.compact.leaseSeconds * 1000, this.now);
    if (!(await lease.acquire())) {
      this.deps.log?.info({}, 'another compactor run holds the lease; skipping this run');
      return { tags: [], deleted: [], skipped: true };
    }
    if (stopped()) lease.stop();
    this.current = lease;
    try {
      return { ...(await this.run(lease, opts)), skipped: false };
    } finally {
      this.current = null;
      await lease.release().catch((err) => this.deps.log?.error({ err }, 'could not release the compactor lease; it expires on its own'));
    }
  }

  private async run(lease: CompactorLease, opts: RunOptions): Promise<RunResult> {
    const { db, hot, content, summaries } = this.deps;
    const runStart = this.now();
    const state = (await readJson<State>(hot, COMPACTOR_STATE_KEY)) ?? { through: 0 };
    const ctx: RunContext = { rebuild: !!opts.rebuild, ensured: new Map(), metas: new Map(), reposts: new Map(), gone: new Set(), failed: new Set() };

    const work = new Map<string, TagWork>();
    const workFor = (tag: string) => {
      let w = work.get(tag);
      if (!w) work.set(tag, (w = { days: new Set(), readmit: new Map(), recheck: new Map(), all: false }));
      return w;
    };
    // The queue first, before the pending writes are applied: a write commits its rows in the queue
    // with the write itself, so every write whose rows are taken here is applied below, or was
    // before, and every meta file read from then on is at least as new as the rows taken.
    // The same goes for the places of reposts, which a repost commits with its rows.
    const taken = await this.readQueue();
    if (opts.all) for (const r of await db.selectFrom('tags').select('name').execute()) workFor(r.name).all = true;
    // Before any place is read: the ones it finds count as not there for the rest of the run.
    const gone = await this.markGoneReposters(workFor, ctx);
    // The writes requests committed: this is what writes them to the stores, before anything below reads those.
    const applied = await applyPending({
      ...this.deps,
      lease,
      places: async (id) => {
        await this.loadReposts([id], ctx);
        return this.placed(id, ctx);
      },
    });
    for (const [id, meta] of applied.metas) ctx.metas.set(id, Promise.resolve(meta));
    // A post whose write couldn't be applied keeps its rows: the meta file they are to be rebuilt from isn't written yet.
    const queue = taken.filter((r) => !applied.failed.has(r.id));
    await this.loadReposts(queue.map((r) => r.id), ctx);
    // Next, as they write meta files: everything below reads them as these left them.
    const decisions = await this.applyDecisions(workFor, runStart, lease, ctx);
    const unapplied = await this.applyReposts(queue, runStart, lease, ctx);
    if (opts.rebuild) await this.markEverything(workFor, runStart, lease, ctx);
    await this.markNewLikes(workFor, state.through, runStart, ctx);
    await this.syncChangedPublishers(state.through, runStart, lease);
    await this.syncChangedFollowing(state.through, runStart, lease);
    const relatedThrough = await this.syncRelatedTags(state.relatedThrough ?? 0, runStart, !!(opts.all || opts.rebuild), lease);
    await this.syncAds(runStart, lease);
    this.markQueue(workFor, queue, runStart, ctx);
    await this.markOutlived(workFor, queue, runStart, ctx);
    const deletions = await this.markDeletions(workFor, ctx);
    await this.prefetch(queue, ctx);

    const tags = [...work.keys()].sort();
    const { failed } = ctx;
    const batches: string[][] = [];
    for (let i = 0; i < tags.length; i += TAG_BATCH) batches.push(tags.slice(i, i + TAG_BATCH));
    await mapLimit(batches, this.cfg.compact.concurrency, (batch) => this.compactBatch(batch, work, runStart, lease, ctx));
    // Likes and profile changes up to this run's start are now applied. Saved before the work below,
    // so a run killed during it doesn't mark them all again.
    const minDay = utcDay(runStart) - this.retentionDays + 1;
    const next: State = { through: runStart, relatedThrough, summariesPurgedBefore: state.summariesPurgedBefore };
    await lease.check();
    await hot.set(COMPACTOR_STATE_KEY, JSON.stringify(next));

    // Everything below relies on the heads this run published still being the current ones.
    // The rows of content that a repost's hashtags couldn't be written to stay for the next run.
    await this.settleQueue(queue.filter((r) => !unapplied.has(r.id)), failed, lease);
    await this.settleDecisions(decisions, failed, runStart, lease);
    await this.settleGoneReposters(gone, failed, lease);
    const deleted: string[] = [];
    for (const d of deletions) {
      if (d.tags.some((t) => failed.has(t))) continue;
      await lease.check();
      // The post's comments, which only the content store lists by post: while the row is still there, so a run that fails here finds them again.
      await this.deps.comments.removeAll(d.id);
      // The files of its writes that were never applied, and never will be: while the rows that name them are still there, for the same reason.
      for (const { staged_key: staged } of await db.selectFrom('pending_writes').select('staged_key').where('content_id', '=', d.id).where('staged_key', 'is not', null).execute()) {
        await content.removeStaged(staged!);
      }
      // And the files of the writes that were applied, kept for the links that were given to them (see applyPending): gone with the post, whatever time they had left.
      const kept = await db.selectFrom('staged_removals').select('staged_key').where('content_id', '=', d.id).execute();
      for (const { staged_key: staged } of kept) await content.removeStaged(staged);
      if (kept.length) await db.deleteFrom('staged_removals').where('content_id', '=', d.id).execute();
      // Likes, feed_queue rows, pending writes and the places of reposts cascade, and so do the rows of the comments that waited in a queue.
      await db.deleteFrom('content').where('id', '=', d.id).where('delete_requested_at', 'is not', null).execute();
      await summaries.remove([{ contentId: d.id, createdAt: d.createdAt, repostedAt: d.repostedAt }]);
      await content.remove(d.id);
      deleted.push(d.id);
    }
    await this.settleAccounts(lease);

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

    if (tags.length || deleted.length) {
      // How long the oldest write this run took had waited, by the clock of the node that queued it: what feeds lag by.
      this.deps.log?.info(
        { tags: tags.length, deleted: deleted.length, queued: queue.length, lagMs: runStart - queue.reduce((at, r) => Math.min(at, r.queued_at), runStart) },
        'compacted the feed index',
      );
    }
    return { tags, deleted };
  }

  /**
   * Finishes deleting the accounts that were closed (see src/accounts.ts): sets for deletion the
   * content of theirs that a request left unmarked, and deletes the rows of those with no content
   * left, which the deletions above may just have been. The rest wait for a later run.
   */
  private async settleAccounts(lease: CompactorLease) {
    const { db, log } = this.deps;
    const closed = await db.selectFrom('users').select('id').where('deleted_at', 'is not', null).execute();
    if (!closed.length) return;
    const sweep = { ...this.deps, now: this.now };
    for (const { id } of closed) {
      await lease.check();
      try {
        await sweepContent(sweep, id);
      } catch (err) {
        if (err instanceof LeaseLostError) throw err;
        log?.error({ err, userId: id }, 'could not set the content of a deleted account for deletion');
      }
    }
    await lease.check();
    const purged = await purgeAccounts(db, closed.map((u) => u.id));
    if (purged.length) log?.info({ accounts: purged.length }, 'deleted accounts');
  }

  /**
   * `--rebuild`: every content within retention is re-admitted under its tags and its publisher's own
   * index, and where reposts placed it, and every publisher credit and every user's follows rewritten.
   * Content older than that which was reposted within it is still in the indexes the repost put it in.
   */
  private async markEverything(workFor: (tag: string) => TagWork, runStart: number, lease: CompactorLease, ctx: RunContext) {
    const oldest = runStart - this.retentionDays * DAY;
    await this.markContent(
      workFor,
      await this.deps.db
        .selectFrom('content')
        .select(['id', 'user_id', 'created_at'])
        .where('delete_requested_at', 'is', null)
        .where((eb) => eb.or([eb('content.created_at', '>', oldest), this.repostedSince(eb, oldest)]))
        .execute(),
      ctx,
      { readmit: true },
    );
    // Not the accounts that were deleted, whose credits are gone for good.
    const users = await this.deps.db.selectFrom('users').select(['id', 'username']).where('deleted_at', 'is', null).execute();
    await this.putCredits(users, lease);
    await this.syncFollowing(users.map((u) => u.id), lease);
  }

  /** (tag, day) of content liked in [since, until); the liked content is re-admitted if it was trimmed. */
  private async markNewLikes(workFor: (tag: string) => TagWork, since: number, until: number, ctx: RunContext) {
    const oldest = until - this.retentionDays * DAY;
    await this.markContent(
      workFor,
      await this.deps.db
        .selectFrom('likes')
        .innerJoin('content', 'content.id', 'likes.content_id')
        .select(['content.id', 'content.user_id', 'content.created_at'])
        .distinct()
        .where('likes.created_at', '>=', since)
        .where('likes.created_at', '<', until)
        .where((eb) => eb.or([eb('content.created_at', '>', oldest), this.repostedSince(eb, oldest)]))
        .execute(),
      ctx,
      { readmit: true },
    );
  }

  /** Whether the content of a query's row was reposted after `oldest`: it is then in an index, however old it is itself. */
  private repostedSince(eb: ExpressionBuilder<Database, 'content'>, oldest: number) {
    return eb.exists(eb.selectFrom('reposts').select('reposts.content_id').whereRef('reposts.content_id', '=', 'content.id').where('reposts.created_at', '>', oldest));
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
      .where('deleted_at', 'is', null)
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
    await this.syncFollowing(
      (
        await this.deps.db
          .selectFrom('follows')
          .select('follower_id')
          .distinct()
          .where('created_at', '>=', since)
          .where('created_at', '<', until)
          .execute()
      ).map((u) => u.follower_id),
      lease,
    );
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

  /**
   * Publishes the server's ads (src/monetization.ts) to Redis, where feeds and posts read them:
   * every ad of the `monetization` table that hasn't ended at the run's start, those yet to start
   * among them, each with its schedule, which whoever shows it holds it to. So an ad that an admin
   * created, changed or deleted shows as it now is after the next run, and one that only starts or
   * ends does so on time, with no run between.
   *
   * All of them, every run, as there are few (see MAX_OPEN_ADS); Redis is written only if what it
   * holds isn't what the table says. A server that shows no ads has none published, and nothing is
   * read for it. A failure is logged and left for the next run, as nothing else a run does depends
   * on it.
   */
  private async syncAds(runStart: number, lease: CompactorLease): Promise<void> {
    const { db, ads, log } = this.deps;
    const { feedAds, postAds } = this.cfg.monetization;
    if (!feedAds && !postAds) return;
    try {
      const rows = await db
        .selectFrom('monetization')
        .select(['id', 'kind', 'text', 'url', 'tags', 'starts_at', 'ends_at'])
        .where((eb) => eb.or([eb('ends_at', 'is', null), eb('ends_at', '>', runStart)]))
        // In an order of its own, so the same ads are published as the same bytes.
        .orderBy('created_at')
        .orderBy('id')
        .execute();
      await lease.check();
      if (await ads.sync(rows.map(publishedAd))) log?.info({ ads: rows.length }, 'published the ads');
    } catch (err) {
      if (err instanceof LeaseLostError) throw err;
      log?.error({ err }, 'could not publish the ads; the next run tries again');
    }
  }

  private async syncFollowing(userIds: string[], lease: CompactorLease) {
    for (let i = 0; i < userIds.length; i += BATCH) {
      await lease.check();
      await syncFollowing(this.deps.db, this.deps.follows, userIds.slice(i, i + BATCH));
    }
  }

  /**
   * The feed queue's rows this run takes: all of them, as every one is a write's that committed.
   * In one statement, so the rows of a write are taken together or not at all.
   */
  private readQueue(): Promise<QueueRow[]> {
    return this.deps.db
      .selectFrom('feed_queue')
      .innerJoin('content', 'content.id', 'feed_queue.content_id')
      .select(['content.id', 'feed_queue.tag', 'feed_queue.token', 'feed_queue.created_at as queued_at', 'content.created_at'])
      .execute();
  }

  /**
   * Marks the content of each row to be rechecked in its tag: its entry is rebuilt from the database
   * and its meta file, so it is added where a write gave it the tag, replaced where it kept it, and
   * dropped where it no longer carries it. Several writes of the same content since the last run
   * left one row per tag, and are one entry rebuilt.
   *
   * Its entry in the tag is in the day it was created, or, where a repost placed it in the tag, in
   * the day of the repost. It is rechecked in both: it has an entry in at most one (see rebuilt),
   * and the other is where it may have had one before.
   */
  private markQueue(workFor: (tag: string) => TagWork, rows: QueueRow[], until: number, ctx: RunContext) {
    const oldest = until - this.retentionDays * DAY;
    for (const r of rows) {
      const place = this.placed(r.id, ctx).find((p) => p.tag === r.tag);
      for (const at of place ? [r.created_at, place.created_at] : [r.created_at]) {
        // Past retention there is no day to rebuild; the row just goes.
        if (at <= oldest) continue;
        const day = utcDay(at);
        const w = workFor(r.tag);
        w.days.add(day);
        addTo(w.recheck, day, r.id);
      }
    }
  }

  /**
   * Has the indexes planned that queued content past retention was in from its creation: its
   * hashtags' and its publisher's own. Such content is queued when it is reposted, or updated, and
   * its summary is then written again. An index nothing was written under since the content's day
   * passed retention still names that day, which no feed showed for want of the summary: planned,
   * it drops the day (see plan), so the content is only where a repost placed it.
   */
  private async markOutlived(workFor: (tag: string) => TagWork, rows: QueueRow[], until: number, ctx: RunContext) {
    const oldest = until - this.retentionDays * DAY;
    const old = [...new Set(rows.filter((r) => r.created_at <= oldest).map((r) => r.id))];
    if (!old.length) return;
    const found = await this.contentRows(old);
    await mapLimit(old, META_READS, async (id) => {
      const row = found.get(id);
      if (row) workFor(authorIndex(row.user_id));
      for (const tag of (await this.meta(id, ctx).catch(() => null))?.tags ?? []) workFor(tag);
    });
  }

  /**
   * Reads the places reposts gave these pieces of content, for the rest of the run (see
   * RunContext.reposts): those of content it has read already are not read again.
   */
  private async loadReposts(ids: Iterable<string>, ctx: RunContext): Promise<void> {
    const fresh = [...new Set(ids)].filter((id) => !ctx.reposts.has(id));
    for (let i = 0; i < fresh.length; i += BATCH) {
      const batch = fresh.slice(i, i + BATCH);
      const found = new Map<string, Repost[]>(batch.map((id) => [id, []]));
      for (const { content_id: id, ...place } of await this.deps.db
        .selectFrom('reposts')
        .select(['content_id', 'tag', 'user_id', 'likes_before', 'created_at'])
        .where('content_id', 'in', batch)
        // In the order repostsOf reads them, which is the order the content comes to carry the hashtags in.
        .orderBy('created_at')
        .orderBy('tag')
        .execute())
        if (!ctx.gone.has(decidedKey(place.tag, id))) found.get(id)!.push(place);
      for (const [id, places] of found) ctx.reposts.set(id, places);
    }
  }

  /** The places reposts gave the content, as this run read them (see loadReposts); none for content it didn't read them of. */
  private placed(contentId: string, ctx: RunContext): Repost[] {
    return ctx.reposts.get(contentId) ?? [];
  }

  /**
   * Where the content is in an index, or null if it isn't there: see Placement. In a hashtag's
   * index it is there if it carries the hashtag, which for a hashtag a repost gave it is once a
   * run has written it to the meta file (see applyReposts). In a user's own index it is there if
   * it is theirs, or they reposted it.
   */
  private placement(plan: Pick<TagPlan, 'tag' | 'author'>, row: ContentRow, meta: ContentMeta, ctx: RunContext): Placement | null {
    const own: Placement = { at: row.created_at, likesBefore: 0, repost: false };
    if (plan.author !== null && row.user_id === plan.author) return own;
    if (plan.author === null && !meta.tags.includes(plan.tag)) return null;
    const place = this.placed(row.id, ctx).find((p) => p.tag === plan.tag);
    if (place) return { at: place.created_at, likesBefore: place.likes_before, repost: true };
    return plan.author === null ? own : null;
  }

  /**
   * Finds the places in a user's own index whose reposter's account was deleted: what they
   * reposted is theirs to show no more. The days they are in are marked, and for the rest of the
   * run the places count as not there (RunContext.gone), so the entries are dropped. Returns
   * them, to be deleted once their indexes are compacted (see settleGoneReposters), which is what
   * lets the account's row go (see purgeAccounts). The hashtags the user gave content stay.
   */
  private async markGoneReposters(workFor: (tag: string) => TagWork, ctx: RunContext): Promise<GonePlace[]> {
    const { db } = this.deps;
    const closed = await db.selectFrom('users').select('id').where('deleted_at', 'is not', null).execute();
    const gone: GonePlace[] = [];
    for (let i = 0; i < closed.length; i += BATCH) {
      for (const r of await db
        .selectFrom('reposts')
        .select(['content_id', 'tag', 'created_at'])
        .where('user_id', 'in', closed.slice(i, i + BATCH).map((u) => u.id))
        .execute()) {
        // Not the hashtags they gave the content: those are the content's now.
        if (indexAuthor(r.tag) === null) continue;
        workFor(r.tag).days.add(utcDay(r.created_at));
        ctx.gone.add(decidedKey(r.tag, r.content_id));
        gone.push({ id: r.content_id, tag: r.tag });
      }
    }
    return gone;
  }

  /** Deletes the places markGoneReposters found, of the indexes this run compacted: their entries are gone. */
  private async settleGoneReposters(gone: GonePlace[], failed: Set<string>, lease: CompactorLease) {
    for (const g of gone) {
      if (failed.has(g.tag)) continue;
      await lease.check();
      await this.deps.db.deleteFrom('reposts').where('content_id', '=', g.id).where('tag', '=', g.tag).execute();
    }
  }

  /**
   * Writes the hashtags reposts gave content into its meta file and summary, for the content of
   * the queue's rows: a repost commits its places and queues the content, and this is what makes
   * the content carry the hashtags, which is when it has an entry under them (see placement) and
   * feeds show it there. Not a hashtag a moderator removed from the content, which stays off it.
   *
   * An update of the content that this run applied has them already: applying a post's write
   * settles its hashtags by the places reposts gave it (see applyPending), whatever the update
   * knew of them.
   *
   * Content that waits in the moderation queue has no summary, and gets none here. Returns the
   * content it couldn't write: its rows stay in the queue, so the next run tries again.
   */
  private async applyReposts(queue: QueueRow[], at: number, lease: CompactorLease, ctx: RunContext): Promise<Set<string>> {
    const { db, content, summaries, log } = this.deps;
    const unapplied = new Set<string>();
    const ids = [...new Set(queue.map((r) => r.id))].filter((id) => repostedTags(this.placed(id, ctx)).length > 0);
    if (!ids.length) return unapplied;

    const rows = await this.contentRows(ids);
    const removed = new Map<string, Set<string>>();
    for (let i = 0; i < ids.length; i += BATCH) {
      for (const d of await db
        .selectFrom('tag_moderation')
        .select(['content_id', 'tag'])
        .where('content_id', 'in', ids.slice(i, i + BATCH))
        .where('decision', '=', 'removed')
        .execute()) {
        const tags = removed.get(d.content_id);
        if (tags) tags.add(d.tag);
        else removed.set(d.content_id, new Set([d.tag]));
      }
    }
    await lease.check();
    await mapLimit(ids, 16, async (id) => {
      const row = rows.get(id);
      // Content set for deletion keeps what it has until it goes.
      if (!row || row.delete_requested_at !== null) return;
      try {
        const meta = await this.meta(id, ctx);
        if (!meta) return;
        const places = this.placed(id, ctx);
        const missing = repostedTags(places).filter((tag) => !meta.tags.includes(tag) && !removed.get(id)?.has(tag));
        if (!missing.length) return;
        const next: ContentMeta = { ...meta, tags: [...meta.tags, ...missing], updatedAt: Math.max(meta.updatedAt, at) };
        // The meta file last, as for any write: what it says is there.
        if (row.queued_id === null) await summaries.put(summaryOf(row, next, this.cfg.publicBaseUrl, repostTimes(places)));
        await content.putMeta(next);
        ctx.metas.set(id, Promise.resolve(next));
      } catch (err) {
        unapplied.add(id);
        log?.error({ err, contentId: id }, 'could not write the hashtags a repost gave the content to it');
      }
    });
    return unapplied;
  }

  /**
   * Reads the meta files of queued content, each once however many tags it is queued under, and
   * several at once. One that can't be read fails the tags that need it, when they ask for it.
   */
  private async prefetch(rows: QueueRow[], ctx: RunContext) {
    await mapLimit([...new Set(rows.map((r) => r.id))], META_READS, async (id) => {
      await this.meta(id, ctx).catch(() => null);
    });
  }

  /**
   * Deletes the rows this run took whose tag it compacted. By the token it read: a row a write has
   * stamped again since holds another, and is the next run's, which applies that write.
   */
  private async settleQueue(rows: QueueRow[], failed: Set<string>, lease: CompactorLease) {
    const { db } = this.deps;
    // A write with a row under a tag that failed keeps that row, so its others are deleted one by one.
    const partial = new Set(rows.filter((r) => failed.has(r.tag)).map((r) => r.token));
    const whole = [...new Set(rows.filter((r) => !partial.has(r.token)).map((r) => r.token))];
    for (let i = 0; i < whole.length; i += BATCH) {
      await lease.check();
      await db.deleteFrom('feed_queue').where('token', 'in', whole.slice(i, i + BATCH)).execute();
    }
    for (const r of rows) {
      if (!partial.has(r.token) || failed.has(r.tag)) continue;
      await lease.check();
      await db.deleteFrom('feed_queue').where('content_id', '=', r.id).where('tag', '=', r.tag).where('token', '=', r.token).execute();
    }
  }

  /**
   * Applies what tag moderators decided before `until` that no run has applied yet. A hashtag they
   * removed is taken off the content (see untag). For either decision the content's UTC day is
   * marked under the hashtag, and its index is built to the decisions (see refreshed and rebuilt): it flags what is approved and
   * leaves out what is removed. Returns the decisions, each recorded as applied once its hashtag is
   * compacted (see settleDecisions); a removal that couldn't be taken off the content isn't among
   * them, so the next run tries again.
   *
   * A removal with no moderator is one of these too: a hashtag a repost gave the content, which an
   * update of the content was then refused by the hashtag's own rules (see contentWriter).
   */
  private async applyDecisions(workFor: (tag: string) => TagWork, until: number, lease: CompactorLease, ctx: RunContext): Promise<Decision[]> {
    const rows = await this.deps.db
      .selectFrom('tag_moderation')
      .innerJoin('content', 'content.id', 'tag_moderation.content_id')
      .leftJoin('moderation_queue', 'moderation_queue.content_id', 'content.id')
      .select([
        'content.id',
        'content.user_id',
        'content.created_at',
        'content.ai_generated',
        'content.delete_requested_at',
        'moderation_queue.content_id as queued_id',
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

    await this.loadReposts(rows.map((r) => r.id), ctx);
    await lease.check();
    const unapplied = new Set<string>();
    await mapLimit([...new Map(rows.filter((r) => r.decision === 'removed').map((r) => [r.id, r])).values()], 16, async (row) => {
      try {
        await this.untag(row, until, ctx);
      } catch (err) {
        unapplied.add(row.id);
        this.deps.log?.error({ err, contentId: row.id }, 'could not take the hashtags a moderator removed off the content');
      }
    });

    const applied: Decision[] = [];
    for (const r of rows) {
      // Where its entry under the hashtag is: at its creation, or at the repost that gave it the hashtag.
      const at = this.placed(r.id, ctx).find((p) => p.tag === r.tag)?.created_at ?? r.created_at;
      // Past retention no index holds the content.
      if (at > until - this.retentionDays * DAY) workFor(r.tag).days.add(utcDay(at));
      if (r.decision === 'removed' && unapplied.has(r.id)) continue;
      applied.push({ id: r.id, tag: r.tag, decision: r.decision, decidedAt: r.decided_at });
    }
    return applied;
  }

  /**
   * Takes off a piece of content the hashtags moderators removed from it: writes its summary and
   * meta file again without them, which is what the content carries from then on. Its bytes stay
   * as they are, and its other hashtags' indexes aren't touched: they show the summary as it now
   * is. Content left with no hashtag stays, in no hashtag's index: it is still its publisher's,
   * and in their own. Content that doesn't carry them (any more) is left as it is.
   *
   * The summary is also what takes the content out of the hashtag's feeds in the indexes this run
   * doesn't rebuild, which feed sessions under way still read: a feed leaves out a record whose
   * summary doesn't carry the hashtag it is listed under. Content that waits in the moderation
   * queue (`queued_id`) has no summary, and gets none here, which would put it back in those feeds.
   */
  private async untag(
    row: { id: string; user_id: string; created_at: number; ai_generated: number; delete_requested_at: number | null; queued_id: string | null },
    at: number,
    ctx: RunContext,
  ): Promise<void> {
    const { db, content, summaries } = this.deps;
    // All of them, not only this run's: the meta file carries none that was removed.
    const removed = new Set((await db.selectFrom('tag_moderation').select('tag').where('content_id', '=', row.id).where('decision', '=', 'removed').execute()).map((r) => r.tag));
    const meta = await content.getMeta(row.id);
    if (!meta) return;
    const tags = meta.tags.filter((tag) => !removed.has(tag));
    if (tags.length === meta.tags.length) return;
    const next: ContentMeta = { ...meta, tags, updatedAt: Math.max(meta.updatedAt, at) };
    // The meta file last, as for any write: what it says is there.
    if (row.queued_id === null) await summaries.put(summaryOf(row, next, this.cfg.publicBaseUrl, repostTimes(this.placed(row.id, ctx))));
    await content.putMeta(next);
    ctx.metas.set(row.id, Promise.resolve(next));
  }

  /**
   * Records as applied the decisions whose hashtag this run compacted, so the next run doesn't apply
   * them again.
   *
   * A removed hashtag that a repost had given the content loses its place with it (`reposts`): the
   * entry is gone from the hashtag's index, and the removal keeps the hashtag off the content.
   */
  private async settleDecisions(decisions: Decision[], failed: Set<string>, runStart: number, lease: CompactorLease) {
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
      if (d.decision === 'removed') await db.deleteFrom('reposts').where('content_id', '=', d.id).where('tag', '=', d.tag).execute();
    }
  }

  /**
   * Content set for deletion, all of it: no write of it commits once the deletion is set, none
   * that committed before is applied any more (see applyPending), and the index holds no entry
   * this run can't rebuild, so nothing has to be waited for. Marked under its hashtags and under
   * those a write of it left a row in the feed queue for (whether this run took the row or not: a
   * hashtag an update dropped), so each of its entries is dropped. Returns the rows with the tags whose compaction must succeed before
   * the content is deleted.
   */
  private async markDeletions(workFor: (tag: string) => TagWork, ctx: RunContext) {
    const { db } = this.deps;
    const rows = await db.selectFrom('content').select(['id', 'user_id', 'created_at']).where('delete_requested_at', 'is not', null).execute();
    const tagsOf = await this.markContent(workFor, rows, ctx);
    const queued = new Map<string, string[]>();
    for (let i = 0; i < rows.length; i += BATCH) {
      for (const q of await db.selectFrom('feed_queue').select(['content_id', 'tag']).where('content_id', 'in', rows.slice(i, i + BATCH).map((r) => r.id)).execute()) {
        const tags = queued.get(q.content_id);
        if (tags) tags.push(q.tag);
        else queued.set(q.content_id, [q.tag]);
      }
    }
    return rows.map((r) => {
      const tags = new Set(tagsOf.get(r) ?? []);
      // Under a tag a repost placed it in, its day is the repost's, which markContent marked.
      for (const tag of queued.get(r.id) ?? []) {
        tags.add(tag);
        workFor(tag).days.add(utcDay(r.created_at));
      }
      // When it was reposted: its summary is under those days too, and goes from them with it.
      return { id: r.id, createdAt: r.created_at, repostedAt: repostTimes(this.placed(r.id, ctx)), tags: [...tags] };
    });
  }

  private meta(contentId: string, ctx: RunContext): Promise<ContentMeta | null> {
    let meta = ctx.metas.get(contentId);
    if (!meta) ctx.metas.set(contentId, (meta = this.deps.content.getMeta(contentId)));
    return meta;
  }

  /**
   * Marks the content's UTC day under each of its hashtags, read from its meta file, and under its
   * publisher's own index; returns every index marked for each row. Where a repost placed the
   * content in an index (a hashtag it gave it, the reposter's own), the day is the repost's.
   */
  private async markContent<R extends { id: string; user_id: string; created_at: number }>(
    workFor: (tag: string) => TagWork,
    rows: R[],
    ctx: RunContext,
    opts: { readmit?: boolean } = {},
  ): Promise<Map<R, string[]>> {
    const tagsOf = new Map<R, string[]>();
    await this.loadReposts(rows.map((r) => r.id), ctx);
    await mapLimit(rows, 16, async (r) => {
      const placedAt = new Map(this.placed(r.id, ctx).map((p) => [p.tag, p.created_at]));
      // The content is its publisher's, whatever its meta file holds.
      const tags = [...new Set([...((await this.meta(r.id, ctx))?.tags ?? []), authorIndex(r.user_id), ...placedAt.keys()])];
      for (const tag of tags) {
        const day = utcDay(placedAt.get(tag) ?? r.created_at);
        const w = workFor(tag);
        w.days.add(day);
        if (opts.readmit) addTo(w.readmit, day, r.id);
      }
      tagsOf.set(r, tags);
    });
    return tagsOf;
  }

  /**
   * Compacts a batch of tags together, so that what it costs in round trips doesn't grow with the
   * tags: their heads are read in one, their manifests in another, and then, a chunk at a time
   * (see chunksOf), their day indexes, the rows and the moderators' decisions of all the content
   * those hold, and the summaries of what is rebuilt; and the new day indexes and manifests are
   * written in one, made to last in one, and the heads swapped in one.
   *
   * A tag fails on its own where what went wrong is its own (its manifest or a day index is missing,
   * a meta file or a summary it needs can't be read or written, part of its new index was evicted):
   * the rest of its chunk is published without it. A round trip that fails takes its whole chunk,
   * or batch, with it. Either way the tags are recorded in `ctx.failed`, and their heads are as they
   * were.
   */
  private async compactBatch(tags: string[], work: Map<string, TagWork>, runStart: number, lease: CompactorLease, ctx: RunContext): Promise<void> {
    let plans: TagPlan[];
    try {
      plans = await this.open(tags, work, runStart, ctx);
    } catch (err) {
      this.fail(tags, err, ctx);
      return;
    }
    for (const chunk of chunksOf(plans)) {
      try {
        await this.compactChunk(chunk, runStart, lease, ctx);
      } catch (err) {
        if (err instanceof LeaseLostError) throw err;
        this.fail(chunk.map((p) => p.tag), err, ctx);
      }
    }
  }

  /** Records that these tags weren't compacted: they keep their heads, and what waited on them waits for the next run. */
  private fail(tags: string[], err: unknown, ctx: RunContext) {
    for (const tag of tags) ctx.failed.add(tag);
    this.deps.log?.error({ err, tags }, 'compaction failed');
  }

  /** Reads the tags' heads and the manifests they name, and plans each tag's work from its manifest. */
  private async open(tags: string[], work: Map<string, TagWork>, runStart: number, ctx: RunContext): Promise<TagPlan[]> {
    const { hot } = this.deps;
    // A tag that was never compacted has no head, and reads as empty.
    const heads = (await hot.mget(tags.map(headKey))).map((buf) => (buf ? json<Head>(buf) : EMPTY_HEAD));
    const manifests = await hot.mget(tags.flatMap((tag, i) => (heads[i]!.manifest ? [manifestKey(tag, heads[i]!.manifest!)] : [])));
    let next = 0;
    const plans: TagPlan[] = [];
    tags.forEach((tag, i) => {
      const id = heads[i]!.manifest;
      const buf = id ? (manifests[next++] ?? null) : null;
      if (id && !buf && !ctx.rebuild) this.fail([tag], new Error(`manifest ${id} of #${tag} is missing`), ctx);
      else plans.push(this.plan(tag, work.get(tag)!, buf ? json<Manifest>(buf) : null, runStart));
    });
    return plans;
  }

  /**
   * What to do to a tag: rebuild the days `work` names and those whose quota has shrunk, carry the
   * others over as they are, and drop those past retention.
   */
  private plan(tag: string, work: TagWork, manifest: Manifest | null, runStart: number): TagPlan {
    const today = utcDay(runStart);
    const minDay = today - this.retentionDays + 1;
    const author = indexAuthor(tag);
    const quotaOf = (day: number) =>
      author !== null ? this.cfg.feed.authorDayMaxPosts : dayQuota(today - day, this.cfg.feed.tagDayMaxPosts, this.cfg.feed.tagDayMinPosts);

    const existing = new Map((manifest?.days ?? []).map((d) => [d.day, d]));
    const rebuild = new Set(work.days);
    for (const d of existing.values()) if (work.all || d.quota > quotaOf(d.day)) rebuild.add(d.day);

    const days: DayPlan[] = [...rebuild]
      .filter((day) => day >= minDay)
      .map((day) => ({ day, prev: existing.get(day), quota: quotaOf(day), recheck: work.recheck.get(day) ?? NONE, readmit: work.readmit.get(day) ?? NONE }));
    return {
      tag,
      author,
      manifest,
      carried: [...existing.values()].filter((d) => d.day >= minDay && !rebuild.has(d.day)),
      days,
      // A day counts for 8 in a chunk beside its entries: its keys are read and written with them.
      weight: days.reduce((n, d) => n + 8 + (d.prev?.count ?? 0) + d.recheck.size + d.readmit.size, 0),
    };
  }

  /**
   * Rebuilds the days of a chunk of tags, and swaps each tag's head to a manifest of them and of
   * the days carried over. A tag none of whose days came out any different keeps its head, and
   * nothing is written for it.
   */
  private async compactChunk(plans: TagPlan[], runStart: number, lease: CompactorLease, ctx: RunContext): Promise<void> {
    const { hot } = this.deps;

    // The day indexes to rebuild, as they are.
    const current = await hot.mget(plans.flatMap((p) => p.days.flatMap((d) => (d.prev ? [dayKey(p.tag, d.prev.gen)] : []))));
    let next = 0;
    const tags: TagBuild[] = [];
    for (const plan of plans) {
      const before = plan.days.map((d) => (d.prev ? (current[next++] ?? null) : null));
      const lost = plan.days.find((d, i) => d.prev && !before[i]);
      if (lost && !ctx.rebuild) this.fail([plan.tag], new Error(`day index ${lost.prev!.gen} of #${plan.tag} is missing`), ctx);
      else tags.push({ plan, days: plan.days.map((d, i) => this.openDay(d, before[i] ?? null)), summaries: [] });
    }

    // What the database says of all the content those days hold or may come to, and what moderators decided about it.
    const ids = new Set<string>();
    const underHashtags = new Set<string>();
    for (const { plan, days } of tags) {
      for (const d of days) {
        for (const id of [...d.held.map((e) => e.contentId), ...d.build]) {
          ids.add(id);
          if (plan.author === null) underHashtags.add(id);
        }
      }
    }
    const rows = await this.contentRows([...ids]);
    const decided = await this.decisions(tags.filter((t) => t.plan.author === null).map((t) => t.plan.tag), [...underHashtags]);
    // The meta files of what is rebuilt: read already, unless the run that marked the content couldn't.
    const building = new Set(tags.flatMap((t) => t.days.flatMap((d) => d.build)));
    // Where reposts placed what is rebuilt, and what the days hold because of one.
    await this.loadReposts([...building, ...tags.flatMap((t) => t.days.flatMap((d) => d.held.filter((e) => e.repost).map((e) => e.contentId)))], ctx);
    await mapLimit([...building].filter((id) => this.indexable(rows.get(id), runStart, ctx)), META_READS, async (id) => {
      await this.meta(id, ctx).catch(() => null);
    });

    // Each day's entries: those it holds, refreshed, and those rebuilt.
    const built: TagBuild[] = [];
    for (const t of tags) {
      const { plan } = t;
      try {
        for (const d of t.days) {
          d.entries = this.refreshed(plan.tag, d.held, rows, decided, runStart, ctx);
          for (const id of d.build) {
            const made = await this.rebuilt(plan, d.plan.day, rows.get(id), decided, runStart, ctx);
            if (!made) continue;
            d.entries.push(made.entry);
            t.summaries.push(made.summary);
          }
        }
        built.push(t);
      } catch (err) {
        this.fail([plan.tag], err, ctx);
      }
    }

    // A rebuilt entry's summary is in both tiers before a feed can list it.
    const lacking = await this.ensure(built.flatMap((t) => t.summaries), ctx);
    const publishing: Publication[] = [];
    for (const t of built) {
      const lacked = t.summaries.find((s) => lacking.has(s.contentId));
      if (lacked) {
        this.fail([t.plan.tag], lacking.get(lacked.contentId), ctx);
        continue;
      }
      try {
        const publication = this.pack(t, runStart);
        if (publication) publishing.push(publication);
      } catch (err) {
        this.fail([t.plan.tag], err, ctx);
      }
    }
    if (!publishing.length) return;

    const keys = publishing.flatMap((p) => p.writes.map((w) => w.key));
    let kept: boolean[];
    try {
      // Provisional until the heads are swapped: a run killed at any point before leaves nothing for good.
      await hot.setMany(publishing.flatMap((p) => p.writes.map((w) => ({ ...w, ttlMs: this.provisionalMs }))));
      await lease.check();
      // Now it is made to last, and the heads swapped to it straight after.
      kept = await hot.persist(keys);
    } catch (err) {
      // No head references these yet.
      await hot.del(keys).catch(() => {});
      throw err;
    }
    next = 0;
    const evicted: string[] = [];
    const published = publishing.filter((p) => {
      if (!kept.slice(next, (next += p.writes.length)).includes(false)) return true;
      evicted.push(...p.writes.map((w) => w.key));
      this.fail([p.tag], new Error(`part of the new index of #${p.tag} expired or was evicted before its head was swapped`), ctx);
      return false;
    });
    if (evicted.length) await hot.del(evicted).catch(() => {});
    await hot.setMany(published.map((p) => ({ key: headKey(p.tag), value: JSON.stringify({ v: 5, manifest: p.next.id, compactedAt: runStart } satisfies Head) })));

    // Requests that read the previous heads, from a node's cache or just before the swap, still find their keys.
    await hot.expire(
      published.flatMap(({ tag, previous, next: { days } }) => {
        if (!previous) return [];
        const used = new Set(days.map((d) => d.gen));
        return [...previous.days.filter((d) => !used.has(d.gen)).map((d) => dayKey(tag, d.gen)), manifestKey(tag, previous.id)];
      }),
      this.keepMs,
    );
  }

  /**
   * A day to rebuild, from its current index: the entries it holds of content that isn't rechecked,
   * and the content to build an entry for, which is what is rechecked, whether the day holds it or
   * not, and what is re-admitted, if it doesn't.
   */
  private openDay(plan: DayPlan, before: Buffer | null): DayBuild {
    const held = new Map<string, IndexEntry>();
    if (before) for (const e of unpackDay(before)) held.set(e.contentId, e);
    for (const id of plan.recheck) held.delete(id);
    return { plan, before, held: [...held.values()], build: [...plan.recheck, ...[...plan.readmit].filter((id) => !held.has(id) && !plan.recheck.has(id))], entries: [] };
  }

  /** The rows of these pieces of content, by id, each with whether it waits in the moderation queue. */
  private async contentRows(ids: string[]): Promise<Map<string, ContentRow>> {
    const out = new Map<string, ContentRow>();
    for (let i = 0; i < ids.length; i += BATCH) {
      for (const r of await this.deps.db
        .selectFrom('content')
        .leftJoin('moderation_queue', 'moderation_queue.content_id', 'content.id')
        .select(['content.id', 'content.user_id', 'content.like_count', 'content.created_at', 'content.ai_generated', 'content.delete_requested_at', 'moderation_queue.content_id as queued_id'])
        .where('content.id', 'in', ids.slice(i, i + BATCH))
        .execute())
        out.set(r.id, r);
    }
    return out;
  }

  /** What these hashtags' moderators decided about these pieces of content under them. A publisher's own index has no moderators. */
  private async decisions(hashtags: string[], ids: string[]): Promise<Decided> {
    const out: Decided = new Map();
    if (!hashtags.length) return out;
    for (let i = 0; i < ids.length; i += BATCH) {
      for (const r of await this.deps.db
        .selectFrom('tag_moderation')
        .select(['content_id', 'tag', 'decision'])
        .where('content_id', 'in', ids.slice(i, i + BATCH))
        .where('tag', 'in', hashtags)
        .execute())
        out.set(decidedKey(r.tag, r.content_id), r.decision);
    }
    return out;
  }

  /**
   * Whether an index can hold the content at all: it is there, not set for deletion, not waiting
   * in the moderation queue, and within retention, which content older than that is for as long
   * as a repost of it is (see Placement).
   */
  private indexable(row: ContentRow | undefined, runStart: number, ctx: RunContext): row is ContentRow {
    if (!row || row.delete_requested_at !== null || row.queued_id !== null) return false;
    const oldest = runStart - this.retentionDays * DAY;
    return row.created_at > oldest || this.placed(row.id, ctx).some((p) => p.created_at > oldest);
  }

  /**
   * The entries a day holds, with current likes, the AI flag and, in a hashtag's index, what its
   * moderators decided, from the database: content they approved is flagged as moderated, and
   * content they removed the hashtag from is dropped. So is content that is deleted, set for
   * deletion, past retention, or waiting in the moderation queue.
   *
   * An entry a repost made counts the likes since the repost, and is dropped if the repost's place
   * in this index is no more: the reposter's account is gone, or the place was given again since,
   * which is another entry.
   */
  private refreshed(tag: string, entries: IndexEntry[], rows: Map<string, ContentRow>, decided: Decided, runStart: number, ctx: RunContext): IndexEntry[] {
    const oldest = runStart - this.retentionDays * DAY;
    const out: IndexEntry[] = [];
    for (const e of entries) {
      const row = rows.get(e.contentId);
      if (!row || row.delete_requested_at !== null || row.queued_id !== null || e.createdAt <= oldest) continue;
      let likes = row.like_count;
      if (e.repost) {
        const place = this.placed(e.contentId, ctx).find((p) => p.tag === tag);
        if (!place || wholeSeconds(place.created_at) !== e.createdAt) continue;
        likes = Math.max(0, likes - place.likes_before);
      }
      const moderated = this.moderated(tag, e.contentId, decided);
      if (moderated === null) continue;
      out.push({ ...e, likes, aiGenerated: row.ai_generated === 1, moderated });
    }
    return out;
  }

  /**
   * An entry rebuilt from the database and the content's meta file, with the summary it is shown
   * by: for the content of the feed queue's rows, which is how every write reaches the index, and
   * for liked content an earlier compaction trimmed. null for content no index can hold (see
   * indexable), that has no place in this one (see placement: it doesn't carry the tag, or in a
   * user's own index is neither theirs nor reposted by them), whose place is in another day than
   * `day` or past retention, or that a moderator removed the tag from. It then competes for the
   * day's quota like any entry.
   */
  private async rebuilt(
    plan: TagPlan,
    day: number,
    row: ContentRow | undefined,
    decided: Decided,
    runStart: number,
    ctx: RunContext,
  ): Promise<{ entry: IndexEntry; summary: Summary } | null> {
    if (!this.indexable(row, runStart, ctx)) return null;
    const meta = await this.meta(row.id, ctx);
    if (!meta) return null;
    const place = this.placement(plan, row, meta, ctx);
    if (!place || utcDay(place.at) !== day || place.at <= runStart - this.retentionDays * DAY) return null;
    const moderated = this.moderated(plan.tag, row.id, decided);
    if (moderated === null) return null;
    const summary = summaryOf(row, meta, this.cfg.publicBaseUrl, repostTimes(this.placed(row.id, ctx)));
    return {
      entry: {
        contentId: row.id,
        createdAt: place.at,
        likes: Math.max(0, row.like_count - place.likesBefore),
        aiGenerated: summary.aiGenerated,
        moderated,
        repost: place.repost,
      },
      summary,
    };
  }

  /**
   * Has both tiers hold each of these summaries, writing whichever lacks one. Each is looked at
   * once a run, however many tags and chunks its content is in. Returns what went wrong, by
   * content, for those that couldn't be.
   */
  private async ensure(summaries: Summary[], ctx: RunContext): Promise<Map<string, Error>> {
    const wanted = new Map(summaries.map((s) => [s.contentId, s]));
    const fresh = [...wanted.values()].filter((s) => !ctx.ensured.has(s.contentId));
    if (fresh.length) {
      const done = this.deps.summaries.ensureMany(fresh).catch((err: unknown) => fresh.map(() => (err instanceof Error ? err : new Error(String(err)))));
      fresh.forEach((s, i) => ctx.ensured.set(s.contentId, done.then((errors) => errors[i]!)));
    }
    const lacking = new Map<string, Error>();
    await Promise.all(
      [...wanted.keys()].map(async (id) => {
        const err = await ctx.ensured.get(id)!;
        if (err) lacking.set(id, err);
      }),
    );
    return lacking;
  }

  /**
   * A tag's days, each trimmed to its quota and packed, and the manifest that names them with the
   * days carried over. A day that came out exactly as it is keeps its index, so an update that
   * changed nothing the index holds leaves no superseded key behind; null if every day did, when
   * there is nothing to publish.
   */
  private pack({ plan, days: rebuilt }: TagBuild, runStart: number): Publication | null {
    const { tag, manifest } = plan;
    const days = [...plan.carried];
    const writes: Publication['writes'] = [];
    for (const d of rebuilt) {
      const { day, prev, quota } = d.plan;
      const kept = this.trim(d.entries, quota, plan.author !== null);
      if (!kept.length) continue;
      const packed = packDay(kept);
      if (prev && d.before && prev.quota === quota && packed.equals(d.before)) {
        days.push(prev);
        continue;
      }
      const ref: DayRef = { day, gen: newGenId(day, runStart), quota, count: kept.length };
      days.push(ref);
      writes.push({ key: dayKey(tag, ref.gen), value: packed });
    }
    days.sort((a, b) => b.day - a.day);
    if (manifest && days.length === manifest.days.length && days.every((d, i) => d.gen === manifest.days[i]!.gen)) return null;
    const next: Manifest = { v: 5, tag, id: newManifestId(runStart), createdAt: runStart, days };
    writes.push({ key: manifestKey(tag, next.id), value: JSON.stringify(next) });
    return { tag, previous: manifest, next, writes };
  }

  /**
   * Whether the content's entry in a hashtag's index is flagged as moderated: its moderators
   * approved it. null if they removed the hashtag from the content, which then has no entry there.
   */
  private moderated(tag: string, id: string, decided: Decided): boolean | null {
    const decision = decided.get(decidedKey(tag, id));
    return decision === 'removed' ? null : decision === 'approved';
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

  /**
   * Runs for as long as the process is up, until stopped: a run starts `intervalSeconds` after the
   * previous one started, or as soon as that one ends if it took longer. So runs never overlap, and
   * there is never more than one in `intervalSeconds`.
   *
   * Stopping it starts no other run, and has the one under way stop at its next step (see
   * CompactorLease.stop): it finishes the writes it is making, makes no more, and frees the lease.
   * What it returns resolves once that is done, so a process that waits for it before it exits
   * leaves no write half made. What the run hadn't got to, the next run does: every step of a run
   * can be made again.
   */
  start(): () => Promise<void> {
    const intervalMs = this.cfg.compact.intervalSeconds * 1000;
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    let running: Promise<unknown> = Promise.resolve();
    const tick = () => {
      const startedAt = Date.now();
      running = this.runOnce({}, () => stopped)
        .catch((err) => {
          if (err instanceof RunStoppedError) this.deps.log?.info({}, 'the compactor was stopped during a run, which the next run makes again');
          else this.deps.log?.error({ err }, 'compactor run failed');
        })
        .finally(() => {
          if (!stopped) timer = setTimeout(tick, Math.max(0, intervalMs - (Date.now() - startedAt)));
        });
    };
    timer = setTimeout(tick, intervalMs);
    return async () => {
      stopped = true;
      clearTimeout(timer);
      this.current?.stop();
      await running;
    };
  }
}

/** The compactor of an app's database and stores. */
export function createCompactor({ config, db, hot, summaries, content, comments, publishers, follows, relatedTags, ads, now }: AppDeps, log?: CompactorLog) {
  return new Compactor({ config, db, hot, summaries, content, comments, publishers, follows, relatedTags, ads, now, log });
}
