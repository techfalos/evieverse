import type { FastifyRequest } from 'fastify';
import { authenticate } from './auth/apiKey.js';
import type { Db } from './db/index.js';
import { HttpError, notFound } from './http/errors.js';
import { msg } from './language.js';
import { moderatesServer } from './moderation/policy.js';
import { effectiveMeta, type PendingReader } from './pending.js';
import { previewOf } from './posts.js';
import type { ContentMeta, ContentStore, Publisher, Summary } from './storage/index.js';

/**
 * What a response says of a post or a comment that waits in the moderation queue: the `status` it
 * carries, beside 202 where the request wrote it. Only its author, server moderators and admins get to read it.
 */
export const PENDING_REVIEW = { status: 'pending_review' } as const;

/** 404 for content that isn't there, and for content the caller may not know is there. */
export const contentNotFound = () => notFound(msg('content.not_found'));

/**
 * Content's row with its publisher's username, and whether it waits in the moderation queue
 * (`queued`): it is then unpublished, and only its publisher, server moderators and admins may know of it. Content set
 * for deletion is already gone as far as readers are concerned, so it's 404 like content that was
 * never there.
 */
export async function loadContent(db: Db, contentId: string) {
  const row = await db
    .selectFrom('content')
    .innerJoin('users', 'users.id', 'content.user_id')
    .leftJoin('moderation_queue', 'moderation_queue.content_id', 'content.id')
    .selectAll('content')
    .select(['users.username', 'moderation_queue.content_id as queued_id'])
    .where('content.id', '=', contentId)
    .where('content.delete_requested_at', 'is', null)
    .executeTakeFirst();
  if (!row) throw contentNotFound();
  const { queued_id, ...content } = row;
  return { ...content, queued: queued_id !== null };
}

/** Published content's row: 404 for content that waits in the moderation queue, as for content that isn't there. */
export async function loadPublished(db: Db, contentId: string) {
  const row = await loadContent(db, contentId);
  if (row.queued) throw contentNotFound();
  return row;
}

type LoadedContent = Awaited<ReturnType<typeof loadContent>>;

/**
 * The content, for whoever may read it. Published content is anyone's to read, with no key. Content
 * that waits in the moderation queue is read only by its publisher and by those who decide on it
 * there (server moderators and admins), who send their credentials in the headers: to anyone else
 * it is 404, like content that isn't there. Who may read a post may read its comments.
 */
export async function loadReadable(db: Db, req: FastifyRequest, contentId: string): Promise<LoadedContent> {
  const row = await loadContent(db, contentId);
  if (!row.queued) return row;
  if (!(await readsHeld(db, req, row.user_id))) throw contentNotFound();
  return row;
}

/**
 * Whether the caller may read something that waits in the moderation queue: who sent it (`ownerId`),
 * a server moderator or an admin, by the credentials in the request's headers. No credentials, or
 * wrong ones, are answered like anyone else, so nothing says the thing is there.
 */
export async function readsHeld(db: Db, req: FastifyRequest, ownerId: string): Promise<boolean> {
  const user = await authenticate(db, req).catch((err) => {
    if (err instanceof HttpError && err.statusCode === 401) return null;
    throw err;
  });
  return user !== null && (user.id === ownerId || moderatesServer(user));
}

/**
 * The content's meta file, which all content has: it holds what the row doesn't (content type,
 * size, text, hashtags). As it is with every write that has committed: the one the newest write
 * made, where the compactor hasn't applied it yet, else the one in the content store (see
 * effectiveMeta). So content just written is read as written, by its publisher and by the next
 * write of it, before the compactor's next run.
 */
export async function requireMeta({ db, content }: { db: PendingReader; content: ContentStore }, contentId: string): Promise<ContentMeta> {
  const meta = await effectiveMeta(db, content, contentId);
  if (!meta) throw new HttpError(500, msg('content.meta_missing'));
  return meta;
}

/** Whether the post a meta file describes takes comments: only one whose publisher said so. */
export const takesComments = (meta: Pick<ContentMeta, 'comments'>): boolean => meta.comments === true;

/** The credit of the publisher a content row was loaded with. */
export const publisherOf = (row: { user_id: string; username: string }): Publisher => ({
  userId: row.user_id,
  username: row.username,
});

/**
 * The summary of the content `meta` describes, rebuilt from the database and the meta file, which
 * outlives the summary store's retention. `repostedAt` is when the content was reposted, once for
 * each repost (see repostTimes): it says where the summary is kept, beside the content's own day.
 */
export const summaryOf = (
  row: { id: string; user_id: string; created_at: number; ai_generated: number },
  meta: ContentMeta,
  publicBaseUrl: string,
  repostedAt: number[] = [],
): Summary => ({
  contentId: row.id,
  createdAt: row.created_at,
  updatedAt: meta.updatedAt,
  userId: row.user_id,
  mimeType: meta.mimeType,
  aiGenerated: row.ai_generated === 1,
  comments: takesComments(meta),
  tags: meta.tags,
  preview: previewOf(meta, publicBaseUrl),
  ...(meta.origin && { origin: meta.origin }),
  ...(repostedAt.length > 0 && { repostedAt }),
});
