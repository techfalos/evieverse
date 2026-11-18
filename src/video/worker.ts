import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import type { FastifyBaseLogger } from 'fastify';
import { setForDeletion } from '../deletion.js';
import type { AppDeps } from '../deps.types.js';
import { notify } from '../inbox.js';
import { nextSeq, payloadOf } from '../pending.js';
import type { CommentPutPayload, PostPayload } from '../pending.types.js';
import { MEDIA_FILE, type ContentMeta, type StoredVideo } from '../storage/index.js';
import { isNotFound } from '../storage/opendal.js';
import { MINUTE } from '../time.js';
import { mapLimit } from '../util.js';
import { encodeVideo, masterPlaylist, missingTools, posterOf, probeVideo, renditionSizes, segmentVideo, VideoError } from './ffmpeg.js';
import type { ProbedVideo, Rendition } from './ffmpeg.types.js';
import { videoFileType } from './files.js';
import { claimVideoJob, releaseVideoJob, removeVideoJob, renewVideoJob } from './jobs.js';
import type { VideoJob } from './jobs.types.js';
import type { VideoOutcome, VideoWorker } from './worker.types.js';

/**
 * What makes the videos users send into videos that play: the video worker. Where the server
 * processes videos (`video.processing`), a video is not published as it was sent. Its write
 * waits (see PostPayload.process), and the worker, which runs beside the compactor
 * (src/compact/main.ts, or the server's own with COMPACT_IN_PROCESS), takes its job
 * (src/video/jobs.ts), reads the staged file, and makes of it, with ffmpeg (src/video/ffmpeg.ts):
 *
 * - **an MP4** of H.264 and AAC, which every browser and phone plays, whatever the phone that
 *   filmed it wrote (HEVC, a MOV, a picture on its side), no larger than 720p, with its index
 *   at its start so that it plays as it downloads. It becomes the post's bytes, in place of the
 *   file that was sent, which is deleted;
 * - **an adaptive stream** (HLS): the video at each of `video.heights` that it is large enough
 *   for, cut into segments of a few seconds, with a master playlist that lists them. A player
 *   takes the size its connection carries, and changes as that changes;
 * - **a poster**: a JPEG of a frame near its start, to show before anything of it is read.
 *
 * None of them has anything of the file's metadata: not where it was filmed, nor when, nor
 * with what (see encodeVideo). That is why the write waits, and the file that was sent is
 * never served: it is published once it is stripped, as an image is.
 *
 * The stream and the poster are written beside the posts' bytes, under an id of the job's own
 * (see ContentStore). Then one commit makes the write ready: it puts the MP4 in the write's
 * row, in place of the file that was sent, with what the post's preview says of the video
 * (see StoredVideo), and takes the mark off. The compactor's next run applies it as it would
 * any write, and from then on the post is in feeds, and its video is there to play.
 *
 * An update that sends the file its post's video was made from, with another caption or
 * other hashtags, is not processed again: the post keeps the video it has (see keepVideo).
 *
 * A comment's video is made the MP4 alone, no larger than `video.commentHeight`.
 *
 * A video that can't be processed (see VideoError), or that failed MAX_ATTEMPTS times, is
 * given up, and its author is told by a notice:
 *
 * - a new post is deleted, as nothing of it can be published;
 * - an update keeps the video the post had, and is made in everything else it said;
 * - a comment is published with its text alone, or not at all if the video was all of it.
 *
 * Several processes may run a worker: a job is one worker's at a time (see claimVideoJob), and
 * each takes one at a time, since one ffmpeg already uses every core there is.
 */

/** How long a worker has a job before another may take it, unless it says it is still at it: every third of this. */
const LEASE_MS = 2 * MINUTE;

/** How long a worker that found nothing to do waits before it looks again. */
const IDLE_MS = 2000;

/** How long a worker waits after a failure that isn't the video's (the database, the store), before it takes a job again. */
const RETRY_MS = 15_000;

/** How many times a video is tried before it is given up: the times after the first are for a worker that died, or a store that failed. */
const MAX_ATTEMPTS = 3;

/** The size of the MP4 that is a post's bytes, by its shorter side: the largest rendition no larger than this. */
const FALLBACK_SHORT = 720;

/** The size of a poster, by its shorter side: no larger than this. */
const POSTER_SHORT = 720;

/** How far into a video its poster is taken: this share of its length, and no later than POSTER_SECONDS. A first frame is often black. */
const POSTER_AT = 0.1;

/** The latest a poster is taken, in seconds from the start. */
const POSTER_SECONDS = 3;

/** How many of a video's files are written to the content store at a time. */
const UPLOADS = 8;

/**
 * The tags a file the server made has that say nothing of the file it was made from: what the
 * MP4 container itself is described by, the same in every file ffmpeg writes.
 */
const HARMLESS_TAGS: ReadonlySet<string> = new Set(['major_brand', 'minor_version', 'compatible_brands', 'handler_name', 'vendor_id', 'language', 'encoder']);

/** What stops a job whose write is gone: nothing of it is anybody's any more. */
class Dropped extends Error {}

/** The SHA-256 of a local file, in hex. */
async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** What a meta file says of the file its post's bytes are, and of what the server made of it: what a write that keeps another's video takes of that one. */
const fileOf = (meta: ContentMeta): Pick<ContentMeta, 'mimeType' | 'size' | 'sha256'> & { video?: StoredVideo } => ({
  mimeType: meta.mimeType,
  size: meta.size,
  sha256: meta.sha256,
  video: meta.preview.kind === 'video' ? stored(meta.preview.video) : undefined,
});

/** What is stored of a processed video, without the addresses a preview that was read has beside it. */
const stored = (video: StoredVideo | undefined): StoredVideo | undefined => video && { id: video.id, width: video.width, height: video.height, duration: video.duration };

/** A post's meta file as a write said it, with the file of `file` in place of its own (see fileOf). */
function withFile(meta: ContentMeta, { mimeType, size, sha256, video }: ReturnType<typeof fileOf>): ContentMeta {
  const { sha256: _, ...rest } = meta;
  // A video post's preview: no other post's write waits for a video.
  const { video: __, ...preview } = meta.preview as { kind: 'video'; url: string; text?: string; video?: StoredVideo };
  return { ...rest, mimeType, size, ...(sha256 !== undefined && { sha256 }), preview: { ...preview, ...(video && { video }) } as ContentMeta['preview'] };
}

/**
 * The video worker of a process (see the top of this file). `runOnce` processes one video, for
 * whoever runs it by hand (the tests); `start` is what a process that runs the compactor calls.
 *
 * `check` is to be called first: it fails in a process that has no ffmpeg to work with, since
 * a server that takes videos it can never publish is worse than one that doesn't start. The
 * remedy is in the error: install ffmpeg, or turn processing off (`VIDEO_PROCESSING=false`),
 * and videos are stored and served as they are sent.
 */
export function createVideoWorker(deps: Pick<AppDeps, 'config' | 'db' | 'content' | 'now'>, log: FastifyBaseLogger): VideoWorker {
  const { config, db, content, now = Date.now } = deps;
  const { video: settings } = config;

  /** The write's row of a post's job, if it is there and still waits for its video. */
  async function postWrite(job: VideoJob): Promise<{ meta: ContentMeta; staged: string } | null> {
    const row = await db
      .selectFrom('pending_writes')
      .select(['payload', 'staged_key'])
      .where('content_id', '=', job.contentId)
      .where('seq', '=', job.seq)
      .where('write_key', '=', job.key)
      .where('kind', '=', 'post')
      .executeTakeFirst();
    if (!row || row.staged_key === null) return null;
    const { meta, process } = payloadOf<PostPayload>(row.payload);
    return process ? { meta, staged: row.staged_key } : null;
  }

  /** Whether a newer write of the post than the job's has committed: the job's is then never applied. */
  async function superseded(reader: Pick<typeof db, 'selectFrom'>, job: VideoJob): Promise<boolean> {
    return (await reader.selectFrom('pending_writes').select('seq').where('content_id', '=', job.contentId).where('kind', '=', 'post').where('seq', '>', job.seq).limit(1).executeTakeFirst()) !== undefined;
  }

  /** Whether the post is there, and not set for deletion. */
  async function live(contentId: string): Promise<boolean> {
    return (await db.selectFrom('content').select('id').where('id', '=', contentId).where('delete_requested_at', 'is', null).executeTakeFirst()) !== undefined;
  }

  /** Deletes a staged file that is nobody's any more. One that can't be deleted is the bucket's to expire. */
  const unstage = (key: string, contentId: string) => content.removeStaged(key).catch((err) => log.warn({ err, contentId, staged: key }, 'could not delete a staged video that is no longer needed'));

  /** Deletes what a job wrote of a post's video beside the posts' bytes, which no write names. What can't be deleted goes with the post. */
  const unwrite = (job: VideoJob) => content.removeMedia(job.contentId, job.id).catch((err) => log.warn({ err, contentId: job.contentId, video: job.id }, 'could not delete the files of a video that no write names'));

  /**
   * Makes the renditions of a video, largest first, each an MP4 in `dir`. One after another:
   * each encoder uses every core, and the memory of one is all a small machine has.
   */
  async function renditions(source: string, video: ProbedVideo, sizes: number[], dir: string, signal: AbortSignal): Promise<Rendition[]> {
    const made: Rendition[] = [];
    for (const short of sizes) made.push(await encodeVideo(settings, source, video, short, join(dir, `${short}.mp4`), signal));
    // None of them says anything the file said of itself: checked of what was made, not trusted of how it was made.
    for (const { path, name } of made) {
      const { tags } = await probeVideo(settings, path, { signal });
      const kept = Object.keys(tags).filter((tag) => !HARMLESS_TAGS.has(tag));
      if (kept.length) throw new Error(`the ${name} rendition still has metadata (${kept.join(', ')}); nothing of the video is published`);
    }
    return made;
  }

  /**
   * Processes a post's video (see the top of this file). `dir` is a folder of the job's own,
   * which is deleted when it is over.
   */
  async function processPost(job: VideoJob, dir: string, signal: AbortSignal): Promise<VideoOutcome> {
    const write = await postWrite(job);
    if (!write || !(await live(job.contentId)) || (await superseded(db, job))) throw new Dropped();
    const { meta, staged } = write;

    const source = join(dir, 'source');
    await content.fetchTo({ staged }, source);
    const sha256 = meta.sha256 ?? (await hashFile(source));
    // The file the post's video was made from, sent again with an update of something else: the post keeps the video it has.
    const kept = await keepVideo(job, write, sha256);
    if (kept === null) throw new Dropped();
    if (kept) {
      await unstage(staged, job.contentId);
      return 'kept';
    }
    const video = await probeVideo(settings, source, { sent: true, signal });

    const out = join(dir, 'out');
    await mkdir(out);
    const made = await renditions(source, video, renditionSizes(video, settings.heights), out, signal);
    for (const rendition of made) await segmentVideo(settings, rendition, signal);
    await writeFile(join(out, 'master.m3u8'), masterPlaylist(made));
    const [largest] = made;
    await posterOf(settings, largest!, Math.min(video.duration * POSTER_AT, POSTER_SECONDS), POSTER_SHORT, join(out, 'poster.jpg'), signal);

    // The stream and the poster, under the job's id, which no write names yet. Then the MP4, where a write's file waits.
    const files = (await readdir(out)).filter((file) => MEDIA_FILE.test(file));
    await mapLimit(files, UPLOADS, async (file) => {
      signal.throwIfAborted();
      await content.putFile({ contentId: job.contentId, video: job.id, file }, join(out, file), videoFileType(file));
    });
    const fallback = made.find((r) => r.short <= FALLBACK_SHORT) ?? made.at(-1)!;
    signal.throwIfAborted();
    const mp4 = await content.stageFile(randomUUID(), fallback.path, 'video/mp4');

    const next = withFile(meta, { mimeType: 'video/mp4', size: fallback.size, sha256, video: { id: job.id, width: largest!.width, height: largest!.height, duration: Math.round(video.duration * 1000) / 1000 } });
    const done = await db.transaction().execute(async (trx) => {
      // The post's row is locked, as a write of the post locks it: none commits between this check and this commit.
      await trx.updateTable('content').set((eb) => ({ ai_generated: eb.ref('ai_generated') })).where('id', '=', job.contentId).execute();
      if (await superseded(trx, job)) return false;
      const updated = await trx
        .updateTable('pending_writes')
        .set({ staged_key: mp4, payload: JSON.stringify({ meta: next } satisfies PostPayload) })
        .where('content_id', '=', job.contentId)
        .where('seq', '=', job.seq)
        .where('write_key', '=', job.key)
        .where('kind', '=', 'post')
        .where('staged_key', '=', staged)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) !== 1) return false;
      await removeVideoJob(trx, job.id);
      return true;
    });
    if (!done) {
      await unstage(mp4, job.contentId);
      throw new Dropped();
    }
    // The file as it was sent, which nothing names any more, and nobody was ever given a link to.
    await unstage(staged, job.contentId);
    return 'processed';
  }

  /**
   * Has the job's write keep a video the post already has, in place of the file it came with:
   * the write is then ready, with everything else it said, and the job is over. The video is
   * the one of the write before it, if that is still to be applied and is processed, which
   * this write then takes the file of; else the one the store has, whose bytes the compactor
   * leaves as they are (see PostPayload.keepBytes).
   *
   * `sha256` narrows it to a processed video made from the file with that hash: the same file,
   * sent again with an update of something else, is not processed again. Without it, any video
   * the post has will do: what an update whose video can't be processed falls back to.
   *
   * True if the write keeps one; false if the post has none to keep, with nothing changed; null
   * if a newer write has superseded this one, which is then never applied.
   */
  async function keepVideo(job: VideoJob, { meta, staged }: { meta: ContentMeta; staged: string }, sha256?: string): Promise<boolean | null> {
    const stored = await content.getMeta(job.contentId);
    const keeps = (had: ContentMeta) => sha256 === undefined || (had.sha256 === sha256 && fileOf(had).video !== undefined);
    return db.transaction().execute(async (trx) => {
      // The post's row is locked, as a write of the post locks it: none commits between these reads and this commit.
      await trx.updateTable('content').set((eb) => ({ ai_generated: eb.ref('ai_generated') })).where('id', '=', job.contentId).execute();
      if (await superseded(trx, job)) return null;
      const mine = () => trx.updateTable('pending_writes').where('content_id', '=', job.contentId).where('seq', '=', job.seq).where('write_key', '=', job.key).where('kind', '=', 'post').where('staged_key', '=', staged);
      const earlier = await trx.selectFrom('pending_writes').select(['seq', 'payload', 'staged_key']).where('content_id', '=', job.contentId).where('kind', '=', 'post').where('seq', '<', job.seq).orderBy('seq', 'desc').limit(1).executeTakeFirst();
      const waiting = earlier && payloadOf<PostPayload>(earlier.payload);
      let next: { staged: string | null; payload: PostPayload } | undefined;
      if (earlier && waiting && !waiting.process && (earlier.staged_key !== null || waiting.keepBytes)) {
        // The write before it has the file, or keeps the store's: this one takes its place, so that the file is still one row's.
        if (keeps(waiting.meta)) next = { staged: earlier.staged_key, payload: { meta: withFile(meta, fileOf(waiting.meta)), ...(waiting.keepBytes && { keepBytes: true }) } };
      } else if (stored && keeps(stored)) {
        next = { staged: null, payload: { meta: withFile(meta, fileOf(stored)), keepBytes: true } };
      }
      if (!next) return false;
      const updated = await mine().set({ staged_key: next.staged, payload: JSON.stringify(next.payload) }).executeTakeFirst();
      if (Number(updated.numUpdatedRows) !== 1) return null;
      if (earlier && next.staged !== null) {
        await trx.updateTable('pending_writes').set({ staged_key: null }).where('content_id', '=', job.contentId).where('seq', '=', Number(earlier.seq)).where('kind', '=', 'post').execute();
      }
      await removeVideoJob(trx, job.id);
      return true;
    });
  }

  /**
   * Gives up a post's video (see the top of this file). An update keeps the video the post
   * had (see keepVideo). A post that has none is a new one, and is deleted.
   */
  async function failPost(job: VideoJob): Promise<void> {
    const write = await postWrite(job);
    if (!write) return removeVideoJob(db, job.id);
    const { staged } = write;
    const userId = (await db.selectFrom('content').select('user_id').where('id', '=', job.contentId).executeTakeFirst())?.user_id;

    const kept = await keepVideo(job, write);
    if (kept === null) return removeVideoJob(db, job.id);
    // Set for deletion before its file goes: from then on nothing reads the write that names the file.
    if (!kept) {
      await setForDeletion(deps, { id: job.contentId, delete_requested_at: null });
      await removeVideoJob(db, job.id);
    }
    await unstage(staged, job.contentId);
    await unwrite(job);
    // Nobody did this to them: `by` is nobody's id.
    if (userId) await notify(deps, { userId, kind: kept ? 'video_update_failed' : 'video_failed', contentId: job.contentId, by: '' }, log);
  }

  /** The rows that put the job's comment as it is, oldest first, and whether a removal of it has committed. */
  async function commentWrites(reader: Pick<typeof db, 'selectFrom'>, job: VideoJob) {
    const rows = await reader
      .selectFrom('pending_writes')
      .select(['seq', 'write_key', 'kind', 'payload', 'staged_key'])
      .where('content_id', '=', job.contentId)
      .where('comment_id', '=', job.commentId)
      .where('kind', 'in', ['comment_put', 'comment_remove'])
      .orderBy('seq')
      .execute();
    const puts = rows.filter((row) => row.kind === 'comment_put').map((row) => ({ seq: Number(row.seq), key: row.write_key, staged: row.staged_key, payload: payloadOf<CommentPutPayload>(row.payload) }));
    // The one that made the comment, which is the one that staged its file.
    const first = puts.find((put) => put.seq === job.seq && put.key === job.key && put.staged !== null && put.payload.process);
    return { puts, first, removed: rows.some((row) => row.kind === 'comment_remove') };
  }

  /**
   * Writes every put of the job's comment again, each as `change` makes it, and deletes the
   * job: in one commit, after the post's next number is taken, so that an edit of the comment
   * that read it before this reads it again (see writePending). False, with nothing written,
   * if the comment's first write is no longer as `staged` names it, or the post is going.
   */
  async function rewriteComment(job: VideoJob, staged: string, newStaged: string | null, change: (payload: CommentPutPayload) => CommentPutPayload): Promise<boolean> {
    return db.transaction().execute(async (trx) => {
      await removeVideoJob(trx, job.id);
      if ((await nextSeq(trx, job.contentId)) === null) return false;
      const { puts, first } = await commentWrites(trx, job);
      if (!first || first.staged !== staged) return false;
      for (const put of puts) {
        await trx
          .updateTable('pending_writes')
          .set({ payload: JSON.stringify(change(put.payload)), ...(put === first && newStaged !== null && { staged_key: newStaged }) })
          .where('content_id', '=', job.contentId)
          .where('seq', '=', put.seq)
          .where('write_key', '=', put.key)
          .execute();
      }
      return true;
    });
  }

  /** Processes a comment's video: the MP4 alone (see the top of this file). */
  async function processComment(job: VideoJob, dir: string, signal: AbortSignal): Promise<VideoOutcome> {
    const { first, removed } = await commentWrites(db, job);
    if (!first || !(await live(job.contentId))) throw new Dropped();
    const staged = first.staged!;
    if (removed) {
      // Removed before it was ever published: nothing of the video is, and the comment's writes go their way without it.
      await content.removeStaged(staged);
      await rewriteComment(job, staged, null, ({ process: _, ...payload }) => payload);
      return 'dropped';
    }

    const source = join(dir, 'source');
    await content.fetchTo({ staged }, source);
    const video = await probeVideo(settings, source, { sent: true, signal });
    const out = join(dir, 'out');
    await mkdir(out);
    const [made] = await renditions(source, video, renditionSizes(video, [settings.commentHeight]).slice(0, 1), out, signal);
    signal.throwIfAborted();
    const mp4 = await content.stageFile(randomUUID(), made!.path, 'video/mp4');

    const done = await rewriteComment(job, staged, mp4, ({ process: _, comment, held }) => ({
      comment: { ...comment, media: { kind: 'video', mimeType: 'video/mp4', size: made!.size } },
      held,
    }));
    if (!done) {
      await unstage(mp4, job.contentId);
      throw new Dropped();
    }
    await unstage(staged, job.contentId);
    return 'processed';
  }

  /**
   * Gives up a comment's video: the file is deleted from where it waits, and the comment's
   * writes are the compactor's to apply, which publishes a comment whose file is gone with its
   * text alone, or removes it if it had none (see applyComments).
   */
  async function failComment(job: VideoJob): Promise<void> {
    const { first } = await commentWrites(db, job);
    if (!first) return removeVideoJob(db, job.id);
    const { comment } = first.payload;
    // The file first: once the mark is off, the compactor publishes whatever is there.
    await content.removeStaged(first.staged!);
    if (!(await rewriteComment(job, first.staged!, null, ({ process: _, ...payload }) => payload))) return;
    await notify(deps, { userId: comment.userId, kind: 'comment_video_failed', contentId: job.contentId, comment: comment.text, by: '' }, log);
  }

  /** Works on a job the worker has taken, in a folder of its own, for no longer than `video.timeoutSeconds`, and keeps the job its own meanwhile. */
  async function work(job: VideoJob, stop?: AbortSignal): Promise<VideoOutcome> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new VideoError(`the video took longer than ${settings.timeoutSeconds} seconds to process`)), settings.timeoutSeconds * 1000);
    const gone = new AbortController();
    const renewal = setInterval(() => {
      renewVideoJob(db, job.id, now(), LEASE_MS).then(
        (there) => there || gone.abort(new Dropped()),
        (err) => log.warn({ err, job: job.id }, 'could not keep hold of a video job; it is tried again'),
      );
    }, LEASE_MS / 3);
    const signal = AbortSignal.any([timeout.signal, gone.signal, ...(stop ? [stop] : [])]);
    // Where the server keeps the files it works on (`storage.tmpPath`, or the system's folder for them): a video needs room for itself and for every size it is made in.
    const tmp = config.storage.tmpPath ?? tmpdir();
    await mkdir(tmp, { recursive: true });
    const dir = await mkdtemp(join(tmp, 'video-'));
    try {
      return await (job.commentId === null ? processPost(job, dir, signal) : processComment(job, dir, signal));
    } finally {
      clearTimeout(timer);
      clearInterval(renewal);
      await rm(dir, { recursive: true, force: true }).catch((err) => log.warn({ err, dir }, 'could not delete the folder a video was processed in'));
    }
  }

  /** Takes the oldest job that waits and sees it through (see VideoWorker.runOnce). `stop` is what a process that shuts down stops it with. */
  async function runOnce(stop?: AbortSignal): Promise<boolean> {
    const job = await claimVideoJob(db, now(), LEASE_MS);
    if (!job) return false;
    const about = { job: job.id, contentId: job.contentId, ...(job.commentId !== null && { commentId: job.commentId }), attempt: job.attempts };
    const fail = job.commentId === null ? failPost : failComment;
    try {
      // Taken more often than a video is tried: the worker that had it died of it, each time.
      if (job.attempts > MAX_ATTEMPTS) throw new VideoError(`the video was tried ${MAX_ATTEMPTS} times, and no worker finished it`);
      const started = now();
      const outcome = await work(job, stop);
      if (outcome === 'processed') log.info({ ...about, ms: now() - started }, 'processed a video');
    } catch (err) {
      if (err instanceof Dropped) {
        // Whatever it wrote is nobody's; the staged file is its write's, and goes with that.
        if (job.commentId === null) await unwrite(job);
        await removeVideoJob(db, job.id);
        return true;
      }
      if (stop?.aborted) {
        // The process is shutting down: the job is the next worker's, at once, and this try doesn't count against the video.
        if (job.commentId === null) await unwrite(job);
        await db.updateTable('media_jobs').set((eb) => ({ claimed_until: 0, attempts: eb('attempts', '-', 1) })).where('id', '=', job.id).execute();
        return true;
      }
      // The staged file is gone: expired, after a week with no worker. There is nothing to try again with.
      const final = err instanceof VideoError || isNotFound(err) || job.attempts >= MAX_ATTEMPTS;
      if (job.commentId === null) await unwrite(job);
      if (!final) {
        log.error({ err, ...about }, 'could not process a video; it is tried again');
        await releaseVideoJob(db, job.id, now() + RETRY_MS);
        return true;
      }
      log.error({ err, ...about }, 'could not process a video; it is given up, and its author is told');
      try {
        await fail(job);
      } catch (cause) {
        log.error({ err: cause, ...about }, 'could not give up a video that can not be processed; it is tried again');
        await releaseVideoJob(db, job.id, now() + RETRY_MS);
      }
    }
    return true;
  }

  async function check(): Promise<void> {
    const missing = await missingTools(settings);
    if (missing) {
      throw new Error(
        `${missing}. This server processes the videos users send (VIDEO_PROCESSING), which needs ffmpeg and ffprobe in the process that runs the compactor: install ffmpeg there, or set VIDEO_PROCESSING=false to store and serve videos as they are sent.`,
      );
    }
  }

  function start(): () => Promise<void> {
    const stop = new AbortController();
    const stopped = () => stop.signal.aborted;
    const loop = (async () => {
      while (!stopped()) {
        try {
          if (await runOnce(stop.signal)) continue;
          await sleep(IDLE_MS, undefined, { signal: stop.signal }).catch(() => {});
        } catch (err) {
          log.error({ err }, 'the video worker failed; trying again in a moment');
          await sleep(RETRY_MS, undefined, { signal: stop.signal }).catch(() => {});
        }
      }
    })();
    return async () => {
      stop.abort();
      await loop;
    };
  }

  return { check, runOnce: () => runOnce(), start };
}

/**
 * Starts the video worker of a process that runs the compactor, where the server processes
 * videos, and returns what stops it (see VideoWorker.start); what does nothing, where it
 * processes none. Throws, before anything is started, in a process that has no ffmpeg (see
 * VideoWorker.check): whoever starts the process sees why it didn't.
 */
export async function startVideoWorker(deps: Pick<AppDeps, 'config' | 'db' | 'content' | 'now'>, log: FastifyBaseLogger): Promise<() => Promise<void>> {
  if (!deps.config.video.processing) return async () => {};
  const worker = createVideoWorker(deps, log);
  await worker.check();
  return worker.start();
}