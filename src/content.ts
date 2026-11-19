import type { FastifyRequest } from 'fastify';
import { authenticate } from './auth/apiKey.js';
import type { AuthUser } from './auth/apiKey.types.js';
import type { Db } from './db/index.js';
import { mentionsIn } from './format.js';
import { HttpError, notFound } from './http/errors.js';
import { msg } from './language.js';
import { moderatesServer } from './moderation/policy.js';
import { effectiveMeta, pendingPost, type PendingReader } from './pending.js';
import { altsOf, imageUrl, previewOf } from './posts.js';
import { shownAvatarUrl } from './profile.js';
import type { ContentMeta, ContentStore, Publisher, Summary } from './storage/index.js';

/** A publisher's credit with where their avatar is read, on one who has an avatar to show (see creditOf). */
export type Credit = Publisher & { avatarUrl?: string };

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

/**
 * What a response says of a post, or a comment, whose video the server is still processing
 * (src/video): `processing`, beside whatever else it says. It is stored, and is read by its id as
 * it was written, but its video isn't there to play yet, and it is in no feed or list until it
 * is. It says so no more once the video is ready, a moment or some minutes later.
 */
export const PROCESSING = { processing: true } as const;

/** 404 for a video whose bytes aren't served yet: the server is still processing it (see PROCESSING). */
export const videoProcessing = () => notFound(msg('content.video_processing'));

/** 404 for content that isn't there, and for content the caller may not know is there. */
export const contentNotFound = () => notFound(msg('content.not_found'));

/** 404 for an image past the last of a post's images, and for any after the first of a post that isn't an image post. */
export const imageNotFound = () => notFound(msg('content.image_not_found'));

/**
 * The images of an image post that is this server's own, in their order, as GET /content/:id
 * lists them: where each is read (see imageUrl), its content type and its size, and its
 * alternative text (`alt`), on one that has any. One for a post of one image. Undefined for any
 * other post, and for a repost of a post on another server, whose images are on that server:
 * its preview says how many (`imageCount`), and how they are described (`alt`).
 */
export const imagesOf = (meta: Pick<ContentMeta, 'contentId' | 'mimeType' | 'size' | 'images' | 'preview' | 'origin'>) =>
  meta.preview.kind !== 'image' || meta.origin
    ? undefined
    : (meta.images ?? [meta]).map(({ mimeType, size }, i) => ({
        url: imageUrl(`/content/${meta.contentId}/raw`, i + 1),
        mimeType,
        size,
        ...(altsOf(meta.preview)?.[i] && { alt: altsOf(meta.preview)![i]! }),
      }));

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
 * Content's row with its publisher's username, what says where their avatar is read
 * (`avatar_id`, `banned_at`: see creditOf), whether it waits in the moderation queue
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
    .select(['users.username', 'users.avatar_id', 'users.banned_at', 'moderation_queue.content_id as queued_id'])
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
 * Who reads something anyone may read, where some are given more of it: the user whose
 * credentials the request's headers carry, or null. No credentials, or wrong ones, are answered
 * like anyone else: the request is one they can make all the same.
 */
export function readerOf(db: Db, req: FastifyRequest): Promise<AuthUser | null> {
  return authenticate(db, req).catch((err) => {
    if (err instanceof HttpError && err.statusCode === 401) return null;
    throw err;
  });
}

/**
 * Whether the caller may read something that waits in the moderation queue: who sent it (`ownerId`),
 * a server moderator or an admin, by the credentials in the request's headers. No credentials, or
 * wrong ones, are answered like anyone else, so nothing says the thing is there.
 */
export async function readsHeld(db: Db, req: FastifyRequest, ownerId: string): Promise<boolean> {
  const user = await readerOf(db, req);
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

/**
 * As requireMeta, with whether the meta file is that of a write whose video the server is still
 * processing (see PROCESSING): it then describes the file as it was sent, of which nothing is
 * served yet.
 */
export async function requirePost({ db, content }: { db: PendingReader; content: ContentStore }, contentId: string): Promise<{ meta: ContentMeta; processing: boolean }> {
  // The row first, then the file, as effectiveMeta reads them.
  const pending = await pendingPost(db, contentId);
  const meta = pending?.meta ?? (await content.getMeta(contentId));
  if (!meta) throw new HttpError(500, msg('content.meta_missing'));
  return { meta, processing: pending?.processing === true };
}

/** Whether the post a meta file describes takes comments: only one whose publisher said so. */
export const takesComments = (meta: Pick<ContentMeta, 'comments'>): boolean => meta.comments === true;

/** The credit of the publisher a content row was loaded with. */
export const publisherOf = (row: { user_id: string; username: string }): Publisher => ({
  userId: row.user_id,
  username: row.username,
});

/**
 * The credit of the publisher a content row was loaded with, as a post read from the database
 * gives it (GET /content/:contentId, and the list of a user's posts): their userId and
 * username, and where their avatar is read (`avatarUrl`), on a post whose publisher has one
 * that anyone is shown (see shownAvatarUrl). A feed's credit has no avatar: it is read from
 * Redis, which holds the name alone.
 */
export const creditOf = (row: { user_id: string; username: string; avatar_id: string | null; banned_at: number | null }, publicBaseUrl: string): Credit => {
  const avatarUrl = shownAvatarUrl({ id: row.user_id, avatar_id: row.avatar_id, banned_at: row.banned_at }, publicBaseUrl);
  return { ...publisherOf(row), ...(avatarUrl !== null && { avatarUrl }) };
};

/**
 * Whom the preview of the post `meta` describes mentions, as a summary has them (`mentions`):
 * those of the post's mentions that its preview's text still has, which is the start of the
 * text they were found in. Undefined for a post whose preview mentions nobody, and for a link,
 * whose preview is its address.
 */
const previewMentions = (meta: Pick<ContentMeta, 'preview' | 'mentions'>): Pick<Summary, 'mentions'> | undefined => {
  if (!meta.mentions?.length || meta.preview.kind === 'link' || !meta.preview.text) return undefined;
  const mentions = mentionsIn(meta.preview.text, meta.mentions);
  return mentions.length > 0 ? { mentions } : undefined;
};

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
  ...previewMentions(meta),
  ...(repostedAt.length > 0 && { repostedAt }),
});
