import { randomUUID } from 'node:crypto';
import type { Transaction } from 'kysely';
import type { Config } from '../config.js';
import type { Database } from '../db/schema.js';
import type { TrustClient } from '../moderation/trust.types.js';
import type { VideoJobWrite } from './jobs.types.js';

/** How much of a request's address a job keeps, in characters: any address fits. */
const CLIENT_IP_CHARS = 64;
/** How much of a request's User-Agent header a job keeps, in characters. */
const CLIENT_USER_AGENT_CHARS = 255;

/**
 * The videos that wait to be processed (`media_jobs`): the video worker's queue
 * (compactor/src/video/worker.rs), and nothing else. Whether a write waits for its video is said by the
 * write's own row of `pending_writes` (see PostPayload.process), which is what the compactor
 * and the routes go by. A job only names that row, so that the worker finds the videos to
 * process without reading every pending write.
 *
 * A job is added in the transaction that commits its write, and deleted in the one that puts
 * the processed file in the write's row, or gives the video up. In between, a worker takes it
 * for a while (compactor/src/video/jobs.rs), and a worker that died with it loses it when that time is
 * over. A job whose post is deleted goes with the post's row.
 */

/**
 * Adds the job for the video a write staged, in the write's transaction. Returns the job's id,
 * which for a post's video is the id its processed version is kept under (see StoredVideo.id).
 */
export async function addVideoJob(trx: Transaction<Database>, { contentId, seq, key = '', commentId, at, client }: VideoJobWrite): Promise<string> {
  const id = randomUUID();
  await trx
    .insertInto('media_jobs')
    .values({
      id,
      content_id: contentId,
      seq,
      write_key: key,
      comment_id: commentId ?? null,
      created_at: at,
      client_ip: client?.ip.slice(0, CLIENT_IP_CHARS) ?? null,
      client_user_agent: client?.userAgent?.slice(0, CLIENT_USER_AGENT_CHARS) ?? null,
    })
    .execute();
  return id;
}

/**
 * Who sent a request that came with a video, for the write to keep with the video's job; nothing
 * on a server that checks no videos against a list (the pdq trust plugin), which is where a
 * notice of a match says it. So a request's address is kept with a job only where it is used,
 * and goes with the job.
 */
export function jobClient(config: Config, client: TrustClient): TrustClient | undefined {
  return config.video.processing && config.trust.optionalPlugins.includes('pdq') ? client : undefined;
}
