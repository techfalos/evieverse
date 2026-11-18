import { randomUUID } from 'node:crypto';
import type { Transaction } from 'kysely';
import type { Db } from '../db/index.js';
import type { Database } from '../db/schema.js';
import type { VideoJob, VideoJobWrite } from './jobs.types.js';

/**
 * The videos that wait to be processed (`media_jobs`): the video worker's queue (see
 * createVideoWorker), and nothing else. Whether a write waits for its video is said by the
 * write's own row of `pending_writes` (see PostPayload.process), which is what the compactor
 * and the routes go by. A job only names that row, so that the worker finds the videos to
 * process without reading every pending write.
 *
 * A job is added in the transaction that commits its write, and deleted in the one that puts
 * the processed file in the write's row, or gives the video up. In between, a worker takes it
 * for a while (see claimVideoJob), and a worker that died with it loses it when that time is
 * over. A job whose post is deleted goes with the post's row.
 */

/**
 * Adds the job for the video a write staged, in the write's transaction. Returns the job's id,
 * which for a post's video is the id its processed version is kept under (see StoredVideo.id).
 */
export async function addVideoJob(trx: Transaction<Database>, { contentId, seq, key = '', commentId, at }: VideoJobWrite): Promise<string> {
  const id = randomUUID();
  await trx.insertInto('media_jobs').values({ id, content_id: contentId, seq, write_key: key, comment_id: commentId ?? null, created_at: at }).execute();
  return id;
}

/**
 * Takes the oldest job that nobody has, until `leaseMs` from now: null if there is none. Taken
 * by an update that only the worker whose it becomes makes, so two workers never have one job.
 * A job a worker took and never finished, since it died, is taken again once its time is over,
 * and counts how many times it was (`attempts`).
 */
export async function claimVideoJob(db: Db, now: number, leaseMs: number): Promise<VideoJob | null> {
  // A few of the oldest, so that a job another worker takes first doesn't leave this one with none.
  const due = await db.selectFrom('media_jobs').select(['id', 'claimed_until']).where('claimed_until', '<=', now).orderBy('created_at').orderBy('id').limit(5).execute();
  for (const { id, claimed_until } of due) {
    const taken = await db
      .updateTable('media_jobs')
      .set((eb) => ({ claimed_until: now + leaseMs, attempts: eb('attempts', '+', 1) }))
      .where('id', '=', id)
      .where('claimed_until', '=', claimed_until)
      .executeTakeFirst();
    if (Number(taken.numUpdatedRows) !== 1) continue;
    const job = await db.selectFrom('media_jobs').selectAll().where('id', '=', id).executeTakeFirst();
    if (!job) continue;
    return { id, contentId: job.content_id, seq: Number(job.seq), key: job.write_key, commentId: job.comment_id, attempts: Number(job.attempts) };
  }
  return null;
}

/**
 * Keeps a job its worker has for `leaseMs` more, while it works on it. False if the job is no
 * longer there: its post was deleted, and whatever the worker makes of it is for nothing.
 */
export async function renewVideoJob(db: Db, id: string, now: number, leaseMs: number): Promise<boolean> {
  const renewed = await db.updateTable('media_jobs').set({ claimed_until: now + leaseMs }).where('id', '=', id).executeTakeFirst();
  return Number(renewed.numUpdatedRows) === 1;
}

/** Gives a job back before its time is over, for whoever takes it next: at `at`, which is now unless the job is to wait first. */
export async function releaseVideoJob(db: Db, id: string, at: number): Promise<void> {
  await db.updateTable('media_jobs').set({ claimed_until: at }).where('id', '=', id).execute();
}

/** Deletes a job: its video is processed, or given up. In the transaction that says so of the write, where there is one. */
export async function removeVideoJob(db: Pick<Db, 'deleteFrom'>, id: string): Promise<void> {
  await db.deleteFrom('media_jobs').where('id', '=', id).execute();
}
