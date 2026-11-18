import { hasReplies, prune, removeCommentRows } from '../comments.js';
import { summaryOf, withheld } from '../content.js';
import type { PendingKind } from '../db/schema.js';
import type { AppDeps } from '../deps.types.js';
import { awaitReplies, payloadBytes, payloadOf, UNNUMBERED } from '../pending.js';
import type { CommentLikePayload, CommentPutPayload, CommentRemovePayload, PostPayload } from '../pending.types.js';
import { removedRepostTags, repostedTags, repostTimes, type Repost } from '../reposts.js';
import { indexContent } from '../search/index.js';
import { commentPlaceholder, type Comment, type ContentMeta } from '../storage/index.js';
import { isNotFound } from '../storage/opendal.js';
import { MINUTE } from '../time.js';
import { allDone, limiter, mapLimit } from '../util.js';
import type { Applied } from './apply.types.js';
import { LeaseLostError, type CompactorLease } from './lease.js';

/** The most values one statement names: the rows of a post it deletes, the staged files it forgets. */
const BATCH = 500;

/**
 * How long past the lifetime of a link an applied staged file is kept (see settle): for a request
 * that read the write's row just before it was applied and signs its link just after, and for
 * clocks that differ between nodes.
 */
const LINK_MARGIN_MS = MINUTE;

/** The most staged files one run deletes of those whose time has come: the others are the next run's. */
const STAGED_REMOVALS = 5000;

type LogFn = (o: object, msg?: string) => void;

/** What runs a write to a comment once it is its turn among the run's (see `compact.commentWrites`). */
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
  /** On a comment's like: what it adds to the number of likes the store has of the comment (see `pending_writes.net`). */
  net: number | null;
}

/** A row of a comment's like that was applied, with what it asked for when it was: the like, or its taking back (`unlike`). */
interface AppliedLike {
  row: PendingRow;
  unlike: boolean;
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
  /** On an entry for a post on another server: since when that server says the post is gone, if it does (see `withheld`). */
  origin_gone_at: number | null;
}

/** The pending writes of one comment, which are applied together: each kind oldest first. */
interface CommentWrites {
  commentId: string;
  /** What made the comment what it is, in turn: new, edited, held, accepted. The newest is what it is now. */
  puts: PendingRow[];
  /** The likes of it, and the takings back of likes: a row for each user who has one waiting, which says what they last asked. */
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
 *    a link, written from the row. An image post of several images has a staged file for each,
 *    the ones after the first named by rows of their own (`post_file`): each is copied to its
 *    place, and the images the post had past those, before an update with fewer, are deleted;
 * 2. its summary, or for content that is withheld, none: the one it had is erased, which is what
 *    takes a held update out of the feeds, and an entry whose original is gone from its own
 *    server (see `withheld`);
 * 3. the terms a search finds it by, which are rows of `search_terms` (see indexContent): those
 *    of the meta file as it is about to be written, withheld or not;
 * 4. its meta file, last, as what it says is there, with its hashtags settled: without the ones
 *    moderators removed from the content, without the ones of a repost that was removed and is
 *    yet to be taken off it, and with the ones reposts gave it, whatever the write knew of any
 *    of them;
 * 5. the rows, this one and the ones it superseded, and then the files they staged.
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
 * A write that came with a video the server processes (src/video) says so until the video
 * worker has made the staged file what is published (see PostPayload.process). Such a write is
 * left as it is, and so is every older write of its post: the run that finds it processed
 * applies it. A comment's is left the same way, with every other write of that comment and of
 * its replies (see applyComments). The worker changes the row in one commit, so a run reads a
 * write either as it waits or as it is to be applied, and never half of each.
 *
 * A failure is logged and left for the next run, and fails nothing else. Returns the meta files
 * written, the posts whose own write failed, and the ones whose write waits for its video.
 */
export async function applyPending(deps: ApplyDeps): Promise<Applied> {
  const { db, lease, log } = deps;
  const applied: Applied = { metas: new Map(), failed: new Set(), waiting: new Set() };
  await removeKept(deps);
  const ids = (await db.selectFrom('pending_writes').select('content_id').distinct().execute()).map((r) => r.content_id);
  if (!ids.length) return applied;

  // Writes to comments, on whatever posts, a set number at a time: beside the posts' own, which are `compact.concurrency` posts at a time.
  const slot = limiter(deps.config.compact.commentWrites);
  await mapLimit(ids, deps.config.compact.concurrency, async (id) => {
    await lease.check();
    const post = await postRow(deps, id);
    // Gone, and its rows with it; or set for deletion, when the run deletes it with what its rows staged.
    if (!post || post.delete_requested_at !== null) return;
    // The ones that took no number first, in whatever order: new comments and likes, which are before the numbered writes of what they are of.
    const rows = await db.selectFrom('pending_writes').select(['seq', 'write_key', 'kind', 'comment_id', 'payload', 'staged_key', 'net']).where('content_id', '=', id).orderBy('seq').orderBy('write_key').execute();

    const writes = rows.filter((r) => r.kind === 'post');
    // A video that is yet to be processed: the write waits for the video worker, and with it the rows it queued (see Applied.waiting).
    if (writes.length && payloadOf<PostPayload>(writes.at(-1)!.payload).process) {
      applied.waiting.add(id);
    } else if (writes.length) {
      try {
        applied.metas.set(
          id,
          await applyPost(
            deps,
            post,
            writes,
            rows.filter((r) => r.kind === 'post_file'),
          ),
        );
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
        rows.filter((r) => r.kind !== 'post' && r.kind !== 'post_file'),
        slot,
      );
    } catch (err) {
      if (err instanceof LeaseLostError) throw err;
      log?.error({ err, contentId: id }, "could not apply the writes of a post's comments; the next run tries again");
    }
  });
  return applied;
}

/** The post's row, with whether it is withheld from readers (see `withheld`); undefined for one that is gone. */
function postRow({ db }: Pick<ApplyDeps, 'db'>, id: string): Promise<PostRow | undefined> {
  return db
    .selectFrom('content')
    .leftJoin('moderation_queue', 'moderation_queue.content_id', 'content.id')
    .select(['content.id', 'content.user_id', 'content.created_at', 'content.ai_generated', 'content.delete_requested_at', 'content.origin_gone_at', 'moderation_queue.content_id as queued_id'])
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

/** The id of the version of its video that a meta file names, of a video post whose video the server processed (see StoredVideo.id). */
const videoOf = ({ preview }: ContentMeta): string | undefined => (preview.kind === 'video' ? preview.video?.id : undefined);

/**
 * Applies the newest of a post's own writes (see applyPending), and returns the meta file it
 * wrote. `writes` are the post's, oldest first, and `files` the rows that name the images after
 * the first of those that are of several images (`post_file`), each under its write's number.
 */
async function applyPost(deps: ApplyDeps, post: PostRow, writes: PendingRow[], files: PendingRow[]): Promise<ContentMeta> {
  const { db, config, content, summaries, places } = deps;
  const newest = writes.at(-1)!;
  const { meta, keepBytes } = payloadOf<PostPayload>(newest.payload);

  // The bytes first: the meta file, which says what they are, is written once they are there.
  if (newest.staged_key !== null) {
    await content.adopt(newest.staged_key, post.id, meta.mimeType);
  } else if (!keepBytes) {
    // Not for an update that keeps the bytes the post has: one whose new video couldn't be processed (see PostPayload.keepBytes).
    const { bytes, mimeType } = payloadBytes(meta);
    await content.putBytes(post.id, bytes, mimeType);
  }
  // The images after the first, of an image post of several: each to its place among the post's (see `pending_writes.write_key`).
  for (const file of files) {
    if (Number(file.seq) !== Number(newest.seq) || file.staged_key === null) continue;
    const image = Number(file.write_key);
    await content.adopt(file.staged_key, { contentId: post.id, image }, meta.images?.[image - 1]?.mimeType ?? meta.mimeType);
  }
  // The images the post had past the ones it has now, which an update with fewer left behind. Before the meta file, which is
  // what says how many there are to delete: a run that stops here finds it as it was, and deletes them again.
  const before = Number(newest.seq) > 1 ? await content.getMeta(post.id) : null;
  if (before) {
    const had = before.images?.length ?? 1;
    for (let image = Math.max(meta.images?.length ?? 1, 1) + 1; image <= had; image++) await content.removeImage(post.id, image);
  }
  // The poster and the stream of the versions of its video that this write leaves behind: the one the post had, and those
  // of the writes this one superseded, which were never the post's. Before the meta file, for the same reason.
  const video = videoOf(meta);
  const left = new Set([before, ...writes.slice(0, -1).map((write) => payloadOf<PostPayload>(write.payload).meta)].map((had) => had && videoOf(had)));
  for (const id of left) if (id && id !== video) await content.removeMedia(post.id, id);

  // The hashtags as they are now, whatever the write knew: a moderator's removal stays, and so does what a repost gave.
  // What a repost that was removed had given goes, while the run is yet to take it off the post (see Compactor's
  // applyRemovals): the write may hold it as the post had it, and nothing else says it isn't the publisher's own.
  const [removals, placed, taken] = await Promise.all([
    db.selectFrom('tag_moderation').select('tag').where('content_id', '=', post.id).where('decision', '=', 'removed').execute(),
    places(post.id),
    removedRepostTags(db, post.id),
  ]);
  const removed = new Set(removals.map((r) => r.tag));
  const given = repostedTags(placed);
  const own = meta.tags.filter((tag) => !removed.has(tag) && !taken.includes(tag));
  const next: ContentMeta = { ...meta, tags: [...own, ...given.filter((tag) => !own.includes(tag) && !removed.has(tag))] };

  // Content that is withheld has no summary: an update that was held loses the one it had, and so does an entry whose original is gone.
  const repostedAt = repostTimes(placed);
  if (withheld(post)) await summaries.erase({ contentId: post.id, createdAt: post.created_at, repostedAt });
  else await summaries.put(summaryOf(post, next, config.publicBaseUrl, repostedAt));

  // What a search finds the post by (`search_terms`), from the meta file as it is about to be written: a run that stops
  // between the two applies the write again. Withheld content has its terms too, and a search leaves it out by its row.
  await indexContent(db, config.db.dialect, post, next, config.search.maxKeywords);

  // The meta file last, as for any write: what it says is there.
  await content.putMeta(next);
  // With the rows of the images: of this write, and of the ones it superseded, whose files were never the post's.
  await settle(deps, post.id, [...writes, ...files]);
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
 * - Its likes are applied after that, several at a time: each is an object of its own, which
 *   a like makes and its taking back deletes (see applyLikes).
 * - Its removal is last, as it committed last: nothing commits to a comment once its removal
 *   has. A comment that is removed is given no likes first.
 *
 * Different comments are written several at a time (COMPACT_COMMENT_WRITES), in two passes:
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
 * A comment that came with a video the server is yet to process (see CommentPutPayload.process)
 * is left for a later run, with every write of it and of the comments that reply to it, until
 * the video worker has made its file what is published. A video that can't be processed is
 * deleted from where it was staged, and the comment is then one whose file is gone:
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
    else if (row.kind === 'comment_remove') of.removal = row;
    // A kind this version doesn't know, from a server that is newer: left for a compactor that does, and never taken for a removal.
    else log?.error({ contentId: postId, commentId: row.comment_id, seq: Number(row.seq), kind: row.kind }, 'a pending write of a comment is of a kind this compactor does not know; it is left as it is');
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
  // A comment whose video is yet to be processed waits for the video worker, with all of its writes: it stays unwritten,
  // so its replies wait with it, and counts as stuck, so its removal does too. Nothing is logged of it: it is no failure.
  const processing = new Set(waiting.filter((of) => of.puts.some((put) => payloadOf<CommentPutPayload>(put.payload).process)).map((of) => of.commentId));
  for (const commentId of processing) stuck.add(commentId);
  waiting = waiting.filter((of) => !processing.has(of.commentId));
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
 * Applies the likes of a comment (see applyComments), and settles their rows: those of the
 * likes that were applied, if one fails. A row is a user's like of the comment, or the taking
 * back of it (`unlike`), and a user has one for a comment: the like is made in the store, or
 * taken away from it. A comment's likes are a comment's that is there, or that an edit took back
 * to the queue; not a deleted one's, nor those of one that was never published, whose rows are
 * deleted with nothing done.
 *
 * A row that leaves the store as it is (`net` 0: a like taken back before it was made, or one
 * given again before its taking back was applied) is checked against the store, and applied
 * only if the store isn't as the row says: that is so after a run that stopped half way.
 */
async function applyLikes(deps: ApplyDeps, postId: string, { commentId, likes }: CommentWrites, slot: Slot): Promise<void> {
  const { comments, lease } = deps;
  const liked = await comments.find(postId, commentId);
  if (!liked || liked.gone === 'deleted') return settle(deps, postId, likes);
  const applied: AppliedLike[] = [];
  // From the first like applied to the last row settled, what a row asks is both in the store and a row: the
  // requests that count the two are told, and count again once this is over (see CommentStore.likesWith).
  const done = await comments.makingLikes(commentId);
  try {
    await allDone(
      likes.map((row) =>
        slot(async () => {
          await lease.check();
          const { userId, unlike = false } = payloadOf<CommentLikePayload>(row.payload);
          if (row.net !== 0 || (await comments.liked(postId, commentId, userId)) === unlike) {
            if (unlike) await comments.removeLike(postId, commentId, userId);
            else await comments.addLike(postId, commentId, userId);
          }
          applied.push({ row, unlike });
        }),
      ),
    );
  } finally {
    await settleLikes(deps, postId, applied);
  }
  // Not after a failure: a like may then be in the store with its row still there, until the next run, which is over when it says so.
  await done();
}

/**
 * Settles the rows of a comment's likes that were applied (see applyLikes). A row that still
 * says what was applied is deleted. One that the user changed meanwhile (see flipLike) stays,
 * for the next run, and is made to count for what it now is against the store, which has what
 * this run applied: a like the store lacks, or the taking back of one it has
 * (`pending_writes.net`).
 *
 * The rows are locked as they are read, and a request locks the row it changes, so each row is
 * either deleted as it was applied or left as the request made it, and never deleted with a
 * change the run didn't apply.
 */
async function settleLikes({ db, config }: ApplyDeps, postId: string, applied: AppliedLike[]): Promise<void> {
  for (let i = 0; i < applied.length; i += BATCH) {
    const batch = new Map(applied.slice(i, i + BATCH).map(({ row, unlike }) => [row.write_key, unlike]));
    await db.transaction().execute(async (trx) => {
      const rows = trx.selectFrom('pending_writes').select(['write_key', 'payload']).where('content_id', '=', postId).where('seq', '=', UNNUMBERED).where('write_key', 'in', [...batch.keys()]);
      // SQLite runs one transaction at a time, and has no rows to lock.
      const now = await (config.db.dialect === 'sqlite' ? rows : rows.forUpdate()).execute();
      const of = (keys: string[]) => trx.updateTable('pending_writes').where('content_id', '=', postId).where('seq', '=', UNNUMBERED).where('write_key', 'in', keys);
      const same: string[] = [];
      const likes: string[] = [];
      const unlikes: string[] = [];
      for (const { write_key: key, payload } of now) {
        const unlike = payloadOf<CommentLikePayload | null>(payload)?.unlike === true;
        (unlike === batch.get(key) ? same : unlike ? unlikes : likes).push(key);
      }
      if (same.length) await trx.deleteFrom('pending_writes').where('content_id', '=', postId).where('seq', '=', UNNUMBERED).where('write_key', 'in', same).execute();
      if (likes.length) await of(likes).set({ net: 1 }).execute();
      if (unlikes.length) await of(unlikes).set({ net: -1 }).execute();
    });
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
