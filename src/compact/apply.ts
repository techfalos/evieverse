import { hasReplies, prune, removeCommentRows } from '../comments.js';
import { summaryOf } from '../content.js';
import type { PendingKind } from '../db/schema.js';
import type { AppDeps } from '../deps.types.js';
import { awaitReplies, payloadBytes, payloadOf, UNNUMBERED } from '../pending.js';
import type { CommentLikePayload, CommentPutPayload, CommentRemovePayload, PostPayload } from '../pending.types.js';
import { repostedTags, repostTimes, type Repost } from '../reposts.js';
import { commentPlaceholder, type Comment, type ContentMeta } from '../storage/index.js';
import { isNotFound } from '../storage/opendal.js';
import { MINUTE } from '../time.js';
import { allDone, limiter, mapLimit } from '../util.js';
import type { Applied } from './apply.types.js';
import { LeaseLostError, type CompactorLease } from './lease.js';

/** The most values one statement names: the rows of a post it deletes, the staged files it forgets. */
const BATCH = 500;

/**
 * How many writes to comments a run has under way at once, on whatever posts: a comment's own
 * write, or one like of it. Beside them, a run writes the posts of `compact.concurrency` posts
 * at a time.
 */
const COMMENT_WRITES = 16;

/**
 * How long past the lifetime of a link an applied staged file is kept (see settle): for a request
 * that read the write's row just before it was applied and signs its link just after, and for
 * clocks that differ between nodes.
 */
const LINK_MARGIN_MS = MINUTE;

/** The most staged files one run deletes of those whose time has come: the others are the next run's. */
const STAGED_REMOVALS = 5000;

type LogFn = (o: object, msg?: string) => void;

/** What runs a write to a comment once it is its turn among the run's (see COMMENT_WRITES). */
type Slot = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * What applying pending writes works with: of what an app has, the settings, the database, the
 * stores it writes and the clock; the run's lease; where reposts placed a piece of content, as
 * the run reads it; and the log it reports to, if any.
 */
interface ApplyDeps extends Pick<AppDeps, 'config' | 'db' | 'content' | 'comments' | 'summaries' | 'now'> {
  lease: CompactorLease;
  places: (contentId: string) => Promise<Repost[]>;
  log?: { warn: LogFn; error: LogFn };
}

/** A row of `pending_writes`, as it is applied. */
interface PendingRow {
  /** Its number among its post's writes, or UNNUMBERED: then `write_key` is what tells it apart. */
  seq: number;
  write_key: string;
  kind: PendingKind;
  comment_id: string | null;
  payload: unknown;
  staged_key: string | null;
}

/** The post a pending write is of, as the database has it when the write is applied. */
interface PostRow {
  id: string;
  user_id: string;
  created_at: number;
  ai_generated: number;
  delete_requested_at: number | null;
  /** Its id again, if it waits in the moderation queue. */
  queued_id: string | null;
}

/** The pending writes of one comment, which are applied together: each kind oldest first. */
interface CommentWrites {
  commentId: string;
  /** What made the comment what it is, in turn: new, edited, held, accepted. The newest is what it is now. */
  puts: PendingRow[];
  likes: PendingRow[];
  /** What removes it. The last of its writes: nothing commits to a comment once its removal has. */
  removal: PendingRow | null;
  /** The comment it replies to, as its puts say; undefined for one on the post itself, and for one with no put. */
  parentId: string | undefined;
}

/**
 * Applies the writes that requests committed and no run has applied yet (`pending_writes`): it is
 * what writes a post's bytes, meta file and summary, and a comment, its likes and its image or
 * video. Nothing else does, and a compactor run is one process at a time (see CompactorLease), so
 * no two writers ever write one object, and what is written is what committed, as it was when
 * the last of it committed.
 *
 * Posts are applied several at a time. Content that is set for deletion is left as it is, with
 * its rows: nothing more is written to it, and the run deletes it, its comments and the files its
 * rows staged (see Compactor). That is what keeps a write from bringing back what was deleted:
 * the write either committed before the deletion was set, and is never applied, or didn't commit
 * at all.
 *
 * Of a post's own writes (`post`) only the newest is applied, since each is the whole post:
 *
 * 1. its bytes: the staged file is copied to where the post's bytes are kept, or for a text or
 *    a link, written from the row;
 * 2. its summary, or for content that waits in the moderation queue, none: the one it had is
 *    erased, which is what takes a held update out of the feeds;
 * 3. its meta file, last, as what it says is there, with its hashtags settled: without the ones
 *    moderators removed from the content, and with the ones reposts gave it, whatever the write
 *    knew of either;
 * 4. the rows, this one and the ones it superseded, and then the files they staged.
 *
 * Every step can be made again, so a run that stops anywhere leaves the row, and the next run
 * applies it. A staged file goes only after its row has: a row never names a file that is gone.
 * Where the store signs links, it goes later still, when the links given to it have expired
 * (see settle), and this is where the ones whose time has come are deleted, before anything else.
 *
 * The writes of a post's comments (`comment_put`, `comment_remove`, `comment_like`) are applied a
 * comment at a time, all the writes of one comment together (see applyComments). They don't wait
 * for the post's own write, nor it for them.
 *
 * A failure is logged and left for the next run, and fails nothing else. Returns the meta files
 * written and the posts whose own write failed.
 */
export async function applyPending(deps: ApplyDeps): Promise<Applied> {
  const { db, lease, log } = deps;
  const applied: Applied = { metas: new Map(), failed: new Set() };
  await removeKept(deps);
  const ids = (await db.selectFrom('pending_writes').select('content_id').distinct().execute()).map((r) => r.content_id);
  if (!ids.length) return applied;

  const slot = limiter(COMMENT_WRITES);
  await mapLimit(ids, deps.config.compact.concurrency, async (id) => {
    await lease.check();
    const post = await postRow(deps, id);
    // Gone, and its rows with it; or set for deletion, when the run deletes it with what its rows staged.
    if (!post || post.delete_requested_at !== null) return;
    // The ones that took no number first, in whatever order: new comments and likes, which are before the numbered writes of what they are of.
    const rows = await db.selectFrom('pending_writes').select(['seq', 'write_key', 'kind', 'comment_id', 'payload', 'staged_key']).where('content_id', '=', id).orderBy('seq').orderBy('write_key').execute();

    const writes = rows.filter((r) => r.kind === 'post');
    if (writes.length) {
      try {
        applied.metas.set(id, await applyPost(deps, post, writes));
      } catch (err) {
        if (err instanceof LeaseLostError) throw err;
        applied.failed.add(id);
        log?.error({ err, contentId: id, seq: Number(writes.at(-1)!.seq) }, 'could not apply a write of a post; the next run tries again');
      }
    }

    try {
      await applyComments(
        deps,
        id,
        rows.filter((r) => r.kind !== 'post'),
        slot,
      );
    } catch (err) {
      if (err instanceof LeaseLostError) throw err;
      log?.error({ err, contentId: id }, "could not apply the writes of a post's comments; the next run tries again");
    }
  });
  return applied;
}

/** The post's row, with whether it waits in the moderation queue; undefined for one that is gone. */
function postRow({ db }: Pick<ApplyDeps, 'db'>, id: string): Promise<PostRow | undefined> {
  return db
    .selectFrom('content')
    .leftJoin('moderation_queue', 'moderation_queue.content_id', 'content.id')
    .select(['content.id', 'content.user_id', 'content.created_at', 'content.ai_generated', 'content.delete_requested_at', 'moderation_queue.content_id as queued_id'])
    .where('content.id', '=', id)
    .executeTakeFirst();
}

/**
 * Deletes rows of a post that were applied, and sees to the files they staged. Each row is
 * settled once.
 *
 * Where the store gives no links to its files, a staged file is deleted here, after its row: one
 * that can't be deleted is left for the bucket to expire. Where it signs links, a reader may hold
 * one to the staged file, given while the write waited, and a file that was deleted now would
 * fail them. So the file stays, and what says so (`staged_removals`) commits with the deletion
 * of the row: until then the row names the file, and from then on that does, and a run deletes
 * the file once the last link that can have been given to it has expired (see removeKept), or
 * with its post, if that is deleted first (see Compactor).
 */
async function settle({ db, content, log, now = Date.now }: ApplyDeps, contentId: string, rows: PendingRow[]): Promise<void> {
  if (!rows.length) return;
  const staged = rows.flatMap((r) => (r.staged_key === null ? [] : [r.staged_key]));
  const keepMs = content.linkMs();
  if (staged.length && keepMs > 0) {
    const removeAt = now() + keepMs + LINK_MARGIN_MS;
    await db.transaction().execute(async (trx) => {
      await deleteRows(trx, contentId, rows);
      for (let i = 0; i < staged.length; i += BATCH) {
        const keys = staged.slice(i, i + BATCH);
        // None is there, unless a run that had lost its lease settled the same row.
        await trx.deleteFrom('staged_removals').where('staged_key', 'in', keys).execute();
        await trx
          .insertInto('staged_removals')
          .values(keys.map((key) => ({ staged_key: key, content_id: contentId, remove_at: removeAt })))
          .execute();
      }
    });
    return;
  }
  await deleteRows(db, contentId, rows);
  for (const key of staged) {
    await content.removeStaged(key).catch((err) => log?.warn({ err, contentId, staged: key }, 'could not delete a staged file that was applied'));
  }
}

/** Deletes rows of a post: the numbered ones by their numbers, and the ones that took none by their keys. */
async function deleteRows(db: Pick<ApplyDeps['db'], 'deleteFrom'>, contentId: string, rows: PendingRow[]): Promise<void> {
  const seqs = rows.filter((r) => Number(r.seq) !== UNNUMBERED).map((r) => Number(r.seq));
  const keys = rows.filter((r) => Number(r.seq) === UNNUMBERED).map((r) => r.write_key);
  for (let i = 0; i < seqs.length; i += BATCH) {
    await db
      .deleteFrom('pending_writes')
      .where('content_id', '=', contentId)
      .where('seq', 'in', seqs.slice(i, i + BATCH))
      .execute();
  }
  for (let i = 0; i < keys.length; i += BATCH) {
    await db
      .deleteFrom('pending_writes')
      .where('content_id', '=', contentId)
      .where('seq', '=', UNNUMBERED)
      .where('write_key', 'in', keys.slice(i, i + BATCH))
      .execute();
  }
}

/**
 * Deletes the staged files that were kept for the links given to them (see settle) and whose
 * time has come, and then what said to keep them. A file that can't be deleted is tried again
 * by the next run, and fails nothing.
 */
async function removeKept({ db, config, content, lease, log, now = Date.now }: ApplyDeps): Promise<void> {
  const due = await db.selectFrom('staged_removals').select('staged_key').where('remove_at', '<=', now()).orderBy('remove_at').limit(STAGED_REMOVALS).execute();
  if (!due.length) return;
  const removed: string[] = [];
  try {
    await mapLimit(due, config.compact.concurrency, async ({ staged_key: staged }) => {
      await lease.check();
      try {
        await content.removeStaged(staged);
        removed.push(staged);
      } catch (err) {
        log?.warn({ err, staged }, 'could not delete a staged file whose links have expired; the next run tries again');
      }
    });
  } finally {
    for (let i = 0; i < removed.length; i += BATCH) {
      await db
        .deleteFrom('staged_removals')
        .where('staged_key', 'in', removed.slice(i, i + BATCH))
        .execute();
    }
  }
}

/** Applies the newest of a post's own writes (see applyPending), and returns the meta file it wrote. `writes` are the post's, oldest first. */
async function applyPost(deps: ApplyDeps, post: PostRow, writes: PendingRow[]): Promise<ContentMeta> {
  const { db, config, content, summaries, places } = deps;
  const newest = writes.at(-1)!;
  const { meta } = payloadOf<PostPayload>(newest.payload);

  // The bytes first: the meta file, which says what they are, is written once they are there.
  if (newest.staged_key !== null) {
    await content.adopt(newest.staged_key, post.id, meta.mimeType);
  } else {
    const { bytes, mimeType } = payloadBytes(meta);
    await content.putBytes(post.id, bytes, mimeType);
  }

  // The hashtags as they are now, whatever the write knew: a moderator's removal stays, and so does what a repost gave.
  const [removals, placed] = await Promise.all([
    db.selectFrom('tag_moderation').select('tag').where('content_id', '=', post.id).where('decision', '=', 'removed').execute(),
    places(post.id),
  ]);
  const removed = new Set(removals.map((r) => r.tag));
  const own = meta.tags.filter((tag) => !removed.has(tag));
  const next: ContentMeta = { ...meta, tags: [...own, ...repostedTags(placed).filter((tag) => !own.includes(tag) && !removed.has(tag))] };

  // Content that waits in the moderation queue has no summary: an update that was held loses the one it had.
  const repostedAt = repostTimes(placed);
  if (post.queued_id !== null) await summaries.erase({ contentId: post.id, createdAt: post.created_at, repostedAt });
  else await summaries.put(summaryOf(post, next, config.publicBaseUrl, repostedAt));

  // The meta file last, as for any write: what it says is there.
  await content.putMeta(next);
  await settle(deps, post.id, writes);
  return next;
}

/**
 * Applies the pending writes of a post's comments: `rows`, the ones that took no number first
 * (new comments, likes), then the numbered ones in the order they committed.
 *
 * The writes of one comment are applied together, as what they come to:
 *
 * - Its puts are one write, of the comment as the newest of them has it: each is the whole
 *   comment, so the ones before it are superseded, as a post's are (see applyPuts).
 * - Its likes are made after that, each an object of its own, several at a time.
 * - Its removal is last, as it committed last: nothing commits to a comment once its removal
 *   has. A comment that is removed is given no likes first.
 *
 * Different comments are written several at a time (see COMMENT_WRITES), in two passes:
 *
 * 1. The puts and the likes. A reply waits for the comment it replies to, if that one has a put
 *    here too: a reply is never written before its comment. So a post's new comments are
 *    written level by level, the comments on the post first.
 * 2. The removals, one after another, in the order they committed: whether a removal leaves a
 *    placeholder depends on what replies to the comment, and whether it takes the placeholder
 *    above it away on what else replies to that one, which two removals at once would both
 *    read before either had written. Before the first of them, the run waits for the replies
 *    to the post's comments that requests are committing (see awaitReplies), which is the one
 *    lock a run takes on a post, and only on one that has removals: a reply that read a comment
 *    before its removal committed is then a row, and keeps the comment's place.
 *
 * A write that fails is logged and left for the next run, with what depends on it: the rest of
 * that comment's writes, and the replies that waited for it, with theirs. Every other comment of
 * the post is applied. What is left is applied by a later run as it would have been by this one:
 * each step looks at what the store has, and can be made again.
 *
 * A comment whose image or video is gone from where it was staged can never be applied as it
 * is: the bucket expired the file, after a week, or somebody deleted it. It is then published
 * with its text alone, or if the file was all of it, removed as a removal would remove it, so
 * that nothing waits behind it for good. Either is logged as an error.
 */
async function applyComments(deps: ApplyDeps, postId: string, rows: PendingRow[], slot: Slot): Promise<void> {
  const { lease, log } = deps;
  const byComment = new Map<string, CommentWrites>();
  for (const row of rows) {
    if (row.comment_id === null) {
      log?.error({ contentId: postId, seq: Number(row.seq), kind: row.kind }, 'a pending write of a comment names no comment; it is left as it is');
      continue;
    }
    let of = byComment.get(row.comment_id);
    if (!of) byComment.set(row.comment_id, (of = { commentId: row.comment_id, puts: [], likes: [], removal: null, parentId: undefined }));
    if (row.kind === 'comment_put') {
      of.puts.push(row);
      of.parentId = payloadOf<CommentPutPayload>(row.payload).comment.parentId;
    } else if (row.kind === 'comment_like') of.likes.push(row);
    else of.removal = row;
  }

  /** The comments with a put that isn't written yet: what their replies wait for. */
  const unwritten = new Set<string>();
  /** The comments with a write that wasn't applied: their removal waits for the next run, as nothing of a comment is applied after its removal. */
  const stuck = new Set<string>();
  /** The comments of which nothing is left to do: the reply to nothing that was removed with its rows. */
  const over = new Set<string>();
  /** The comments whose file is lost and that had no text: removed in the second pass, each as its newest put had it. */
  const lost = new Map<string, Comment>();

  let waiting = [...byComment.values()].filter((of) => of.puts.length || (of.likes.length && !of.removal));
  for (const of of waiting) if (of.puts.length) unwritten.add(of.commentId);
  while (waiting.length) {
    const ready = waiting.filter((of) => of.parentId === undefined || !unwritten.has(of.parentId));
    // The rest reply to a comment that couldn't be written, or to one of its replies.
    if (!ready.length) break;
    waiting = waiting.filter((of) => of.parentId !== undefined && unwritten.has(of.parentId));
    await allDone(
      ready.map(async (of) => {
        const { commentId } = of;
        try {
          if (of.puts.length) {
            const outcome = await slot(async () => {
              await lease.check();
              return applyPuts(deps, postId, of);
            });
            unwritten.delete(commentId);
            if (outcome === 'removed') over.add(commentId);
            else if (outcome !== 'written') lost.set(commentId, outcome);
            if (outcome !== 'written') return;
          }
          if (of.likes.length && !of.removal) await applyLikes(deps, postId, of, slot);
        } catch (err) {
          if (err instanceof LeaseLostError) throw err;
          stuck.add(commentId);
          log?.error({ err, contentId: postId, commentId }, 'could not apply the writes of a comment; they and the writes of its replies wait for the next run');
        }
      }),
    );
  }
  for (const { commentId } of waiting) stuck.add(commentId);

  /** A comment's place among the removals: where its removal committed, or for one whose file is lost, its newest put. */
  const at = (of: CommentWrites) => Number((of.removal ?? of.puts.at(-1)!).seq);
  const removals = [...byComment.values()].filter((of) => (of.removal || lost.has(of.commentId)) && !stuck.has(of.commentId) && !over.has(of.commentId)).sort((a, b) => at(a) - at(b));
  if (!removals.length) return;
  // A reply takes no lock on its post, so one may be under way that read a comment before its removal committed. Once
  // for the post's removals, the run waits for those: each has then committed, and keeps its comment's place, or failed.
  await lease.check();
  await awaitReplies(deps.db, deps.config.db.dialect, postId);
  for (const of of removals) {
    try {
      await slot(async () => {
        await lease.check();
        await applyRemoval(deps, postId, of, lost.get(of.commentId));
      });
    } catch (err) {
      if (err instanceof LeaseLostError) throw err;
      log?.error({ err, contentId: postId, commentId: of.commentId }, 'could not remove a comment; the next run tries again');
    }
  }
}

/**
 * Applies a comment's puts (see applyComments) as one write, of the comment as the newest has
 * it, and deletes their rows. What the store has of the comment by then, published, held, or
 * the placeholder an edit left, is what every write before these left there, and the newest put
 * is written over it as it would have been over what the puts before it wrote.
 *
 * One of the puts before it counts all the same: a comment that was published by one of them
 * and is held by the newest has a place among the post's comments, which its replies are listed
 * under. If the store has nothing of it, that place is made, with the placeholder that holding
 * it would have left.
 *
 * Returns `written`; or `removed`, for a reply to a comment of which nothing is left, which is
 * removed with its rows; or the comment, for one that is nothing without the file it came with,
 * which is lost. A placeholder is then left in its place, for its replies to be written under,
 * until the removals are made (see applyRemoval).
 */
async function applyPuts(deps: ApplyDeps, postId: string, { commentId, puts, likes, removal }: CommentWrites): Promise<'written' | 'removed' | Comment> {
  const { db, content, comments, log } = deps;
  const payloads = puts.map((row) => payloadOf<CommentPutPayload>(row.payload));
  const { held } = payloads.at(-1)!;
  let { comment } = payloads.at(-1)!;

  // Its image or video first: a comment that is there to read never lacks its file. Only the put that made the comment staged one.
  for (const { staged_key: staged } of puts) {
    if (staged === null) continue;
    const of = { postId, commentId };
    try {
      await content.adopt(staged, of, comment.media?.mimeType ?? 'application/octet-stream');
    } catch (err) {
      // Not where it waited, and it is where it goes: a run that stopped before it deleted the row had copied it.
      if (!isNotFound(err) || (await content.statIfThere(of))) {
        if (!isNotFound(err)) throw err;
        continue;
      }
      log?.error({ contentId: postId, commentId, staged }, 'the file a comment came with is gone from where it waited; the comment is published with its text alone, or removed if it has none');
      if (comment.text === '') {
        await comments.remove(postId, commentId, { keepPlace: true, comment });
        return comment;
      }
      const { media: _, ...text } = comment;
      comment = text;
    }
  }

  const there = await comments.find(postId, commentId);
  /** For a reply: whether nothing is left of the comment it replies to, not a placeholder to list it under. No request commits such a reply. */
  const orphan = async () => comment.parentId !== undefined && !(await comments.find(postId, comment.parentId));
  /** Removes the reply to nothing, with every row of it. */
  const removeOrphan = async () => {
    log?.warn({ contentId: postId, commentId, parentId: comment.parentId }, 'a reply was to be published under a comment of which nothing is left; it is removed');
    await comments.remove(postId, commentId, { comment });
    await removeCommentRows(db, postId, commentId);
    await settle(deps, postId, [...puts, ...likes, ...(removal ? [removal] : [])]);
    return 'removed' as const;
  };

  if (held) {
    if (there) {
      // One that was published leaves a placeholder in its place.
      await comments.hold(comment);
    } else if (payloads.some((put) => !put.held)) {
      // Published and then held, both since the last run: where it waits, and then the placeholder in the place it had.
      if (await orphan()) return removeOrphan();
      await comments.put(comment, { held: true });
      await comments.put(commentPlaceholder(comment, 'held'));
    } else {
      // One that never was published is only where comments wait.
      await comments.put(comment, { held: true });
    }
  } else if (await orphan()) {
    return removeOrphan();
  } else if (there || (await comments.getHeld(postId, commentId))) {
    // One that is there, waiting or as a placeholder, or as it was before an edit: published as it now is, over what is there.
    await comments.publish(comment);
  } else {
    // A new one, which has no likes yet: put with that number, which saves its first readers the list that would say so.
    await comments.put(comment);
  }
  await settle(deps, postId, puts);
  return 'written';
}

/**
 * Applies the likes of a comment (see applyComments), each user's once, and deletes their rows:
 * those of the likes that were made, if one fails. A comment's likes are a comment's that is
 * there, or that an edit took back to the queue; not a deleted one's, nor those of one that was
 * never published, whose rows are deleted with nothing made.
 */
async function applyLikes(deps: ApplyDeps, postId: string, { commentId, likes }: CommentWrites, slot: Slot): Promise<void> {
  const { comments, lease } = deps;
  const liked = await comments.find(postId, commentId);
  if (!liked || liked.gone === 'deleted') return settle(deps, postId, likes);
  const byUser = new Map<string, PendingRow[]>();
  for (const row of likes) {
    const { userId } = payloadOf<CommentLikePayload>(row.payload);
    byUser.set(userId, [...(byUser.get(userId) ?? []), row]);
  }
  const made: PendingRow[] = [];
  try {
    await allDone(
      [...byUser].map(([userId, rows]) =>
        slot(async () => {
          await lease.check();
          await comments.addLike(postId, commentId, userId);
          made.push(...rows);
        }),
      ),
    );
  } finally {
    await settle(deps, postId, made);
  }
}

/**
 * Removes a comment (see applyComments), and deletes the rows of it that are left: its removal,
 * and the likes that committed before that, which are made for nothing. If something replies to
 * it, a placeholder is left in its place; if nothing does, nothing of it is left, and the
 * placeholder of the deleted comment it replied to goes too, if this was the last reply to it.
 *
 * `lost` is the comment, for one that is removed because its file is lost: its puts are still
 * rows, which go last, and what stands in its place is the placeholder applyPuts left.
 */
async function applyRemoval(deps: ApplyDeps, postId: string, { commentId, puts, likes, removal }: CommentWrites, lost?: Comment): Promise<void> {
  const { db, comments } = deps;
  const { parentId } = (removal && payloadOf<CommentRemovePayload | null>(removal.payload)) ?? {};
  const was = lost ?? (await comments.find(postId, commentId)) ?? (await comments.getHeld(postId, commentId));
  // Nothing of it, or the placeholder a run that stopped here left: there is only what follows to do.
  if (was && (lost || was.gone !== 'deleted')) {
    const keepPlace = await hasReplies(deps, postId, commentId);
    await comments.remove(postId, commentId, { keepPlace, comment: was });
  }
  // It may have been the last reply to a deleted comment, whose placeholder then stands for nothing. Its own rows, if it has any left, reply to nothing any more.
  if (!(await comments.find(postId, commentId))) await prune(deps, postId, parentId ?? was?.parentId, commentId);
  await removeCommentRows(db, postId, commentId);
  await settle(deps, postId, [...(lost ? puts : []), ...likes, ...(removal ? [removal] : [])]);
}
