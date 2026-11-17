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

/**
 * What a response says of the server's entry for a post on another server that the other server
 * says it no longer publishes: the `status` it carries. The entry is hidden, and only its owner,
 * server moderators and admins get to read it (see `withheld`).
 */
export const ORIGIN_GONE = { status: 'origin_gone' } as const;

/** 404 for content that isn't there, and for content the caller may not know is there. */
export const contentNotFound = () => notFound(msg('content.not_found'));

/**
 * Whether content that is there is kept from readers. It is for one of two reasons: it waits in
 * the moderation queue (`queued_id`), or it is the server's entry for a post on another server,
 * and that server says it publishes no post at the address (`origin_gone_at`), which it says of
 * a post it deleted and of one that only waits in its own moderation queue. Either way the
 * content has no summary and is in no index, and it is 404 to everyone but its owner, server
 * moderators and admins. It keeps its hashtags and the places reposts gave it, and is back in
 * feeds with them once it is published again: accepted from the queue, or attested again by the
 * original's server.
 */
export const withheld = (row: { queued_id: string | null; origin_gone_at: number | null }): boolean => row.queued_id !== null || row.origin_gone_at !== null;

/**
 * Content's row with its publisher's username, whether it waits in the moderation queue
 * (`queued`), and whether it is an entry for a post on another server that the other server says
 * is gone (`gone`): either way it is unpublished (see `withheld`), and only its publisher, server
 * moderators and admins may know of it. Content set for deletion is already gone as far as
 * readers are concerned, so it's 404 like content that was never there.
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
  return { ...content, queued: queued_id !== null, gone: content.origin_gone_at !== null };
}

/**
 * Published content's row: 404 for content that waits in the moderation queue, and for an entry
 * whose original is gone from its own server, as for content that isn't there.
 */
export async function loadPublished(db: Db, contentId: string) {
  const row = await loadContent(db, contentId);
  if (row.queued || row.gone) throw contentNotFound();
  return row;
}

type LoadedContent = Awaited<ReturnType<typeof loadContent>>;

/**
 * The content, for whoever may read it. Published content is anyone's to read, with no key. Content
 * that waits in the moderation queue is read only by its publisher and by those who decide on it
 * there (server moderators and admins), who send their credentials in the headers: to anyone else
 * it is 404, like content that isn't there. The same goes for an entry whose original is gone
 * from its own server. Who may read a post may read its comments.
 */
export async function loadReadable(db: Db, req: FastifyRequest, contentId: string): Promise<LoadedContent> {
  const row = await loadContent(db, contentId);
  if (!row.queued && !row.gone) return row;
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
