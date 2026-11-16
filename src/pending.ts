import type { Transaction } from 'kysely';
import type { Db } from './db/index.js';
import type { Database } from './db/schema.js';
import { notFound } from './http/errors.js';
import { msg } from './language.js';
import type { CommentLikePayload, CommentPutPayload, EffectiveComment, PendingComment, PendingPost, PendingWrite, PostPayload } from './pending.types.js';
import { LINK_MIME } from './posts.js';
import type { CommentStore, ContentMeta, ContentStore } from './storage/index.js';

/**
 * Writes that have committed and that the compactor hasn't applied yet (`pending_writes`).
 *
 * A request never writes a post's bytes, meta file or summary, nor a comment, its likes or its
 * image or video: it commits a row here, in one transaction with whatever else it changes in the
 * database, and the compactor, which is one process, writes the stores from the rows (see
 * applyPending). So no two writers ever write one object, and a write that didn't commit wrote
 * nothing.
 *
 * Every write of a post, or of anything under it, starts its transaction by taking the post's
 * next number (see nextSeq), which locks the post's row: the writes of one post commit one at a
 * time, each with a number of its own, and the compactor applies them in that order. Content set
 * for deletion gives no number, so nothing is written to a post, or under it, once it is.
 *
 * What a request reads of a post or a comment that it is about to write, or that it shows its
 * author, is the newest pending write, and the stores only where there is none (effectiveMeta,
 * effectiveComment). Feeds and lists read the stores, and so show a write once it is applied.
 */

/** The database, or a transaction of it, to read pending writes with. */
export type PendingReader = Pick<Db, 'selectFrom'>;

/** What a row's `payload` holds: the JSON a write stored there, which SQLite gives back as text and the others parsed. */
export const payloadOf = <T>(payload: unknown): T => (typeof payload === 'string' ? JSON.parse(payload) : payload) as T;

/**
 * Takes the post's next write number, and with it the lock on the post's row until the
 * transaction ends. Null for content that isn't there or is set for deletion: nothing is written
 * to it, or under it, any more. `set` is what else the write changes of the row.
 */
export async function nextSeq(trx: Transaction<Database>, contentId: string, set: { ai_generated?: number } = {}): Promise<number | null> {
  const updated = await trx
    .updateTable('content')
    .set((eb) => ({ ...set, seq: eb('seq', '+', 1) }))
    .where('id', '=', contentId)
    .where('delete_requested_at', 'is', null)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) !== 1) return null;
  return Number((await trx.selectFrom('content').select('seq').where('id', '=', contentId).executeTakeFirstOrThrow()).seq);
}

/** Adds a write to `pending_writes`, in the transaction that took its number. */
export async function insertPending(trx: Transaction<Database>, { contentId, seq, kind, commentId, payload, stagedKey, at }: PendingWrite): Promise<void> {
  await trx
    .insertInto('pending_writes')
    .values({
      content_id: contentId,
      seq,
      kind,
      comment_id: commentId ?? null,
      payload: payload === undefined ? null : JSON.stringify(payload),
      staged_key: stagedKey ?? null,
      created_at: at,
    })
    .execute();
}

/**
 * Commits a write of something under a post: a comment, a removal of one, a like of one. `commit`
 * runs in a transaction that has taken the post's next number, which it is given, and adds the
 * write's row and whatever else the write changes in the database. 404 for a post that is gone or
 * set for deletion, which nothing is written under.
 *
 * `seen` is what the request read before it decided to write: the post's number then, and after
 * it, whatever of the post's the write depends on (`state`): a comment as it was, the comment a
 * reply is to. If the number taken isn't the one after it, something was written to the post or
 * under it meanwhile, and `read` reads the state again, inside the transaction, where no other
 * write of the post can commit before this one: `commit` gets that, and decides by it.
 */
export async function writePending<S, T>(
  db: Db,
  contentId: string,
  seen: { seq: number; state: S },
  read: (reader: PendingReader) => Promise<S>,
  commit: (trx: Transaction<Database>, seq: number, state: S) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    const seq = await nextSeq(trx, contentId);
    if (seq === null) throw notFound(msg('content.not_found'));
    return commit(trx, seq, seq === Number(seen.seq) + 1 ? seen.state : await read(trx));
  });
}

/** The newest write of the post that hasn't been applied; null if there is none. */
export async function pendingPost(db: PendingReader, contentId: string): Promise<PendingPost | null> {
  const row = await db
    .selectFrom('pending_writes')
    .select(['seq', 'payload', 'staged_key'])
    .where('content_id', '=', contentId)
    .where('kind', '=', 'post')
    .orderBy('seq', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row ? { seq: Number(row.seq), meta: payloadOf<PostPayload>(row.payload).meta, stagedKey: row.staged_key } : null;
}

/**
 * The post's meta file as it is with every write that has committed: the newest pending write's,
 * or with none, the one in the content store. Null for a post that has neither.
 *
 * The rows first, then the file: the compactor writes the file before it deletes the row, so a
 * write that is in neither when its row is looked for is in the file by the time that is read.
 * The hashtags of a pending write are the ones the write said; the compactor settles them when
 * it applies it (a hashtag a moderator removed meanwhile comes off, one a repost gave meanwhile
 * is added).
 */
export async function effectiveMeta(db: PendingReader, content: ContentStore, contentId: string): Promise<ContentMeta | null> {
  return (await pendingPost(db, contentId))?.meta ?? (await content.getMeta(contentId));
}

/**
 * The bytes of a post that came with no file, which its meta file holds: a text post's text, a
 * link's URL, and for a repost of a post on another server the original's address, stored as a
 * link's is. With the content type they are stored as. Throws for a post whose bytes are a file.
 */
export function payloadBytes(meta: ContentMeta): { bytes: Buffer; mimeType: string } {
  if (meta.origin) return { bytes: Buffer.from(meta.origin.url), mimeType: LINK_MIME };
  if (meta.preview.kind === 'link') return { bytes: Buffer.from(meta.preview.url), mimeType: LINK_MIME };
  if (meta.preview.kind === 'text' && meta.text !== undefined) return { bytes: Buffer.from(meta.text), mimeType: meta.mimeType };
  throw new Error(`the bytes of ${meta.contentId} are a file, which its write has to stage`);
}

/** The newest write of the comment that hasn't been applied, likes aside; null if there is none. */
export async function pendingComment(db: PendingReader, postId: string, commentId: string): Promise<PendingComment | null> {
  const row = await db
    .selectFrom('pending_writes')
    .select(['seq', 'kind', 'payload'])
    .where('content_id', '=', postId)
    .where('comment_id', '=', commentId)
    .where('kind', 'in', ['comment_put', 'comment_remove'])
    .orderBy('seq', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row ? { seq: Number(row.seq), put: row.kind === 'comment_put' ? payloadOf<CommentPutPayload>(row.payload) : null } : null;
}

/**
 * The comment as it is with every write that has committed: what its newest pending write says
 * (a removal: null), or with none, what the comment store has, published or waiting in the
 * moderation queue. Null for a comment that isn't there, or of which only a placeholder is.
 * The rows first, then the store, as effectiveMeta reads a post.
 */
export async function effectiveComment(db: PendingReader, comments: CommentStore, postId: string, commentId: string): Promise<EffectiveComment | null> {
  const pending = await pendingComment(db, postId, commentId);
  if (pending) return pending.put;
  const published = await comments.get(postId, commentId);
  if (published) return { comment: published, held: false };
  const held = await comments.getHeld(postId, commentId);
  return held && { comment: held, held: true };
}

/**
 * Where the image or video of a comment waits, for a comment whose first write hasn't been
 * applied; null once it has, when the file is where comments' files are kept.
 */
export async function pendingCommentFile(db: PendingReader, postId: string, commentId: string): Promise<string | null> {
  const row = await db
    .selectFrom('pending_writes')
    .select('staged_key')
    .where('content_id', '=', postId)
    .where('comment_id', '=', commentId)
    .where('kind', '=', 'comment_put')
    .where('staged_key', 'is not', null)
    .orderBy('seq')
    .limit(1)
    .executeTakeFirst();
  return row?.staged_key ?? null;
}

/** Who likes the comment by a write that hasn't been applied: the users of its pending likes. */
export async function pendingLikers(db: PendingReader, postId: string, commentId: string): Promise<Set<string>> {
  const rows = await db
    .selectFrom('pending_writes')
    .select('payload')
    .where('content_id', '=', postId)
    .where('comment_id', '=', commentId)
    .where('kind', '=', 'comment_like')
    .execute();
  return new Set(rows.map((row) => payloadOf<CommentLikePayload>(row.payload).userId));
}
