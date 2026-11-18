import { sql, type Transaction } from 'kysely';
import { isForeignKeyViolation, type Db, type DbDialect } from './db/index.js';
import type { Database } from './db/schema.js';
import { notFound } from './http/errors.js';
import { msg } from './language.js';
import type { CommentLikePayload, CommentPutPayload, EffectiveComment, PendingComment, PendingCommentFile, PendingLike, PendingPost, PendingWrite, PostPayload, UnnumberedWrite } from './pending.types.js';
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
 * There are two sorts of write, by whether another write of the same thing may cross them.
 *
 * - **Numbered.** A write of a post, an edit or a removal of a comment, a moderator's decision
 *   on one: each has to know what the write before it left. It starts its transaction by taking
 *   the post's next number (see nextSeq), which locks the post's row, so the numbered writes of
 *   one post commit one at a time, and the compactor applies them in that order. Content set
 *   for deletion gives no number.
 * - **Unnumbered.** A new comment, and a like of a comment or its taking back (see
 *   writeUnnumbered). Nothing they say depends on the order they commit in: a new comment is
 *   before every other write of that comment, and the likes of a comment are a set, a user's
 *   once (the row's key). A user who takes a like back, or gives it again, before the compactor
 *   has applied the row, changes what that one row says (see flipLike): the order of what one
 *   user asked is the row's own, and no other user's row has a part in it. They are what a post
 *   that many people answer at once gets most of, so they take no number: they neither lock
 *   the post's row nor update it, and any number of them commit side by side. The compactor
 *   applies them before the numbered writes of what they are of.
 *
 * What an unnumbered write may cross is a removal: of its post, of the comment a like is of, of
 * the comment a reply is to. None of the three brings anything back:
 *
 * - Content that is set for deletion is never applied (see applyPending), so a comment or a
 *   like that commits as its post is deleted goes with the post, as one that committed just
 *   before does.
 * - A like of a comment that is removed is never made: the removal is applied last of the
 *   comment's writes, and a like that finds no comment is dropped, as its taking back is.
 * - A reply to a comment whose removal has committed is refused, and one that committed before
 *   it keeps the comment's place, as a placeholder. For that to hold of a reply that is under
 *   way as the removal is applied, the compactor waits for the replies under way before it
 *   decides what a removal leaves (see replying, awaitReplies).
 *
 * What a request reads of a post or a comment that it is about to write, or that it shows its
 * author, is the newest pending write, and the stores only where there is none (effectiveMeta,
 * effectiveComment). Feeds and lists read the stores, and so show a write once it is applied.
 */

/** The database, or a transaction of it, to read pending writes with. */
export type PendingReader = Pick<Db, 'selectFrom'>;

/** The `seq` of a write that took no number: before every numbered write of its post, which count from 1. */
export const UNNUMBERED = 0;

/**
 * The first key of the PostgreSQL advisory locks that replying and awaitReplies take, which
 * keeps them apart from any other advisory lock taken in the database. The second is a hash of
 * the post's id: two posts that share one wait for each other's replies, for a moment and for
 * nothing, and nothing else comes of it.
 */
const REPLY_LOCK = 1702258021;

/** What a row's `payload` holds: the JSON a write stored there, which SQLite gives back as text and the others parsed. */
export const payloadOf = <T>(payload: unknown): T => (typeof payload === 'string' ? JSON.parse(payload) : payload) as T;

/** The key of a user's like of a comment among the unnumbered writes of its post: a user's second like of the comment has the same, and fails. */
export const likeKey = (commentId: string, userId: string) => `${commentId}:${userId}`;

/**
 * Takes the post's next write number, and with it the lock on the post's row until the
 * transaction ends: what a numbered write begins with. Null for content that isn't there or is
 * set for deletion: nothing is written to it, or under it, any more. `set` is what else the
 * write changes of the row.
 */
export async function nextSeq(
  trx: Transaction<Database>,
  contentId: string,
  set: { ai_generated?: number; origin_gone_at?: number | null; origin_check_at?: number | null } = {},
): Promise<number | null> {
  const updated = await trx
    .updateTable('content')
    .set((eb) => ({ ...set, seq: eb('seq', '+', 1) }))
    .where('id', '=', contentId)
    .where('delete_requested_at', 'is', null)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) !== 1) return null;
  return Number((await trx.selectFrom('content').select('seq').where('id', '=', contentId).executeTakeFirstOrThrow()).seq);
}

/**
 * Adds a write to `pending_writes`: a numbered one, in the transaction that took its number, or
 * one that takes none, by its key (see writeUnnumbered).
 */
export async function insertPending(trx: Transaction<Database>, write: PendingWrite | UnnumberedWrite): Promise<void> {
  const { contentId, kind, commentId, payload, stagedKey, at } = write;
  await trx
    .insertInto('pending_writes')
    .values({
      content_id: contentId,
      ...('key' in write ? { seq: UNNUMBERED, write_key: write.key } : { seq: write.seq, ...(write.image !== undefined && { write_key: String(write.image) }) }),
      kind,
      comment_id: commentId ?? null,
      payload: payload === undefined ? null : JSON.stringify(payload),
      staged_key: stagedKey ?? null,
      ...('key' in write && write.net !== undefined && { net: write.net }),
      created_at: at,
    })
    .execute();
}

/**
 * Says that the transaction commits a reply to a comment of the post, until it ends: what the
 * compactor waits for before it decides what a removal leaves (see awaitReplies). To be called
 * before the reply reads the comment it replies to.
 *
 * It is a lock that every reply shares: replies neither wait for each other nor for any other
 * write, and what waits for them is the compactor alone, once a run for each post that has
 * removals. On PostgreSQL an advisory lock, which is granted in the order it is asked for; a
 * shared lock on the post's row is not, there, and a stream of replies would keep the compactor
 * waiting for good. On MySQL the shared lock on the post's row, which is: the one the reply's
 * row takes as it is inserted, for its foreign key. SQLite runs one transaction at a time.
 */
export async function replying(trx: Transaction<Database>, dialect: DbDialect, contentId: string): Promise<void> {
  if (dialect === 'postgres') await sql`select pg_advisory_xact_lock_shared(${REPLY_LOCK}::int4, hashtext(${contentId}::text))`.execute(trx);
  else if (dialect === 'mysql') await trx.selectFrom('content').select('id').where('id', '=', contentId).forShare().execute();
}

/**
 * Waits for the replies to the post's comments that are under way to commit or fail (see
 * replying), and lets the ones that begin meanwhile through once they have. The compactor's,
 * before it applies the removals it has read of a post's comments. From then on, every reply to
 * one of those comments either has committed, and is among the post's pending writes for
 * hasReplies to find, or reads the comment after its removal committed, and is refused. So no
 * reply is left under a comment of which nothing is.
 */
export async function awaitReplies(db: Db, dialect: DbDialect, contentId: string): Promise<void> {
  if (dialect === 'sqlite') return;
  await db.transaction().execute(async (trx) => {
    if (dialect === 'postgres') await sql`select pg_advisory_xact_lock(${REPLY_LOCK}::int4, hashtext(${contentId}::text))`.execute(trx);
    else await trx.selectFrom('content').select('id').where('id', '=', contentId).forUpdate().execute();
  });
}

/**
 * Commits a write under a post that takes no number: a new comment, or a like of a comment or
 * its taking back (see the top of this file). `commit` runs in a transaction and adds the write's row, with a key
 * (insertPending), and whatever else the write changes in the database. The post's row is
 * neither locked nor changed, so these writes of one post don't wait for each other.
 *
 * 404 for a post that is gone, or set for deletion when the transaction reads it. One that is
 * set a moment later is deleted with the row this commits, which is never applied.
 *
 * `reply` is for a reply to a comment, which the compactor's removals wait for (see replying):
 * `commit` then reads the comment it replies to, and refuses a reply to one that is gone.
 *
 * A write whose key is taken fails as a unique violation (isUniqueViolation), which is the
 * caller's to answer: a user's second row for their like of a comment. It is thrown once the
 * transaction is over, since PostgreSQL takes nothing more in a transaction a statement failed in.
 */
export async function writeUnnumbered<T>(db: Db, dialect: DbDialect, contentId: string, { reply = false }: { reply?: boolean }, commit: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
  try {
    return await db.transaction().execute(async (trx) => {
      if (reply) await replying(trx, dialect, contentId);
      const post = await trx.selectFrom('content').select('id').where('id', '=', contentId).where('delete_requested_at', 'is', null).executeTakeFirst();
      if (!post) throw notFound(msg('content.not_found'));
      return commit(trx);
    });
  } catch (err) {
    // The post's row went between the read and the insert: the compactor deleted the post.
    if (isForeignKeyViolation(err)) throw notFound(msg('content.not_found'));
    throw err;
  }
}

/**
 * Commits a numbered write of something under a post: an edit of a comment, a removal of one, a
 * moderator's decision on one. `commit` runs in a transaction that has taken the post's next
 * number, which it is given, and adds the write's row and whatever else the write changes in the
 * database. 404 for a post that is gone or set for deletion, which nothing is written under.
 *
 * `seen` is what the request read before it decided to write: the post's number then, and after
 * it, whatever of the post's the write depends on (`state`): the comment as it was. If the
 * number taken isn't the one after it, a numbered write was made to the post or under it
 * meanwhile, and `read` reads the state again, inside the transaction, where no other numbered
 * write of the post can commit before this one: `commit` gets that, and decides by it. What an
 * unnumbered write does meanwhile changes nothing of a comment that is there already.
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
  if (!row) return null;
  const { meta, process } = payloadOf<PostPayload>(row.payload);
  return { seq: Number(row.seq), meta, stagedKey: row.staged_key, processing: process === true };
}

/**
 * Where an image after the first waits, of a write of an image post that hasn't been applied
 * (see pendingPost, whose `seq` names the write): `image` is its place among the post's images,
 * counted from 1. Null if the write has no such image, and once the write is applied.
 */
export async function pendingImage(db: PendingReader, contentId: string, seq: number, image: number): Promise<string | null> {
  const row = await db
    .selectFrom('pending_writes')
    .select('staged_key')
    .where('content_id', '=', contentId)
    .where('seq', '=', seq)
    .where('write_key', '=', String(image))
    .where('kind', '=', 'post_file')
    .executeTakeFirst();
  return row?.staged_key ?? null;
}

/**
 * The most images a write of the post that hasn't been applied gives it: 1 if there is none,
 * and for a post that is no image post of several. A run that stopped while it applied such a
 * write may have left that many files where the post's images are kept, whatever the post's
 * meta file says, so this is what a post's deletion counts with (see Compactor).
 */
export async function pendingImages(db: PendingReader, contentId: string): Promise<number> {
  const rows = await db.selectFrom('pending_writes').select('payload').where('content_id', '=', contentId).where('kind', '=', 'post').execute();
  return Math.max(1, ...rows.map((row) => payloadOf<PostPayload>(row.payload).meta.images?.length ?? 1));
}

/**
 * The meta files of the newest writes that haven't been applied, of those of `contentIds` that
 * have one, by the post's id: `pendingPost` for many posts in one query, for whoever reads a page
 * of them (a user's export). To be read before the content store, as effectiveMeta reads them.
 */
export async function pendingMetas(db: PendingReader, contentIds: string[]): Promise<Map<string, ContentMeta>> {
  const metas = new Map<string, ContentMeta>();
  if (!contentIds.length) return metas;
  const rows = await db.selectFrom('pending_writes').select(['content_id', 'payload']).where('content_id', 'in', contentIds).where('kind', '=', 'post').orderBy('seq').execute();
  // In the order of their numbers, so a post's newest write is the one that stays.
  for (const row of rows) metas.set(row.content_id, payloadOf<PostPayload>(row.payload).meta);
  return metas;
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
 * The newest writes that haven't been applied, likes aside, of those of `comments` that have
 * one, by the comment's id: `pendingComment` for many comments in one query, for whoever reads a
 * page of them (a user's export). To be read before the comment store, as effectiveComment
 * reads them.
 */
export async function pendingComments(db: PendingReader, comments: { postId: string; commentId: string }[]): Promise<Map<string, PendingComment>> {
  const pending = new Map<string, PendingComment>();
  if (!comments.length) return pending;
  const rows = await db
    .selectFrom('pending_writes')
    .select(['seq', 'kind', 'comment_id', 'payload'])
    // The posts first: the rows are found by their post.
    .where('content_id', 'in', [...new Set(comments.map((c) => c.postId))])
    .where('comment_id', 'in', comments.map((c) => c.commentId))
    .where('kind', 'in', ['comment_put', 'comment_remove'])
    .orderBy('seq')
    .execute();
  // In the order of their numbers, so a comment's newest write is the one that stays.
  for (const row of rows) pending.set(row.comment_id!, { seq: Number(row.seq), put: row.kind === 'comment_put' ? payloadOf<CommentPutPayload>(row.payload) : null });
  return pending;
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
 * applied, and whether it is a video that is yet to be processed; null once the write is
 * applied, when the file is where comments' files are kept.
 */
export async function pendingCommentFile(db: PendingReader, postId: string, commentId: string): Promise<PendingCommentFile | null> {
  const row = await db
    .selectFrom('pending_writes')
    .select(['staged_key', 'payload'])
    .where('content_id', '=', postId)
    .where('comment_id', '=', commentId)
    .where('kind', '=', 'comment_put')
    .where('staged_key', 'is not', null)
    .orderBy('seq')
    .limit(1)
    .executeTakeFirst();
  return row?.staged_key ? { stagedKey: row.staged_key, processing: payloadOf<CommentPutPayload>(row.payload).process === true } : null;
}

/**
 * What the user last asked of their like of the comment, by a write that hasn't been applied:
 * one row, found by its key, which makes the like or takes it back. Null if there is none: the
 * content store then says whether the user likes the comment (see CommentStore.liked). The row
 * first, then the store: the compactor applies a row there before it deletes it.
 */
export async function pendingLike(db: PendingReader, postId: string, commentId: string, userId: string): Promise<PendingLike | null> {
  const row = await db
    .selectFrom('pending_writes')
    .select('payload')
    .where('content_id', '=', postId)
    .where('seq', '=', UNNUMBERED)
    .where('write_key', '=', likeKey(commentId, userId))
    .executeTakeFirst();
  return row ? { liked: !payloadOf<CommentLikePayload | null>(row.payload)?.unlike } : null;
}

/**
 * What the likes of the comment that haven't been applied come to, for whoever adds them to the
 * number the content store has: one more for each like the store doesn't have, one less for
 * each taking back of a like it has (see `pending_writes.net`). A like that was committed
 * before a row said what it comes to is one the store doesn't have.
 */
export async function pendingLikes(db: PendingReader, postId: string, commentId: string): Promise<number> {
  const { likes } = await db
    .selectFrom('pending_writes')
    .select((eb) => eb.fn.sum(eb.fn.coalesce('net', eb.lit(1))).as('likes'))
    .where('content_id', '=', postId)
    .where('comment_id', '=', commentId)
    .where('kind', '=', 'comment_like')
    .executeTakeFirstOrThrow();
  // No rows: a sum of nothing, which is null.
  return Number(likes ?? 0);
}

/**
 * Adds the row of a user's like of a comment, or of its taking back (`liked`: false), for a user
 * who has no row for the comment: in the transaction writeUnnumbered runs. A like is of a
 * comment the content store has no like of from this user, and a taking back of one it has, so
 * the row counts as one more, or one less (see `pending_writes.net`). If the user's other
 * request added a row first, this fails as a unique violation.
 */
export async function insertLike(trx: Transaction<Database>, { postId, commentId, userId, liked, at }: { postId: string; commentId: string; userId: string; liked: boolean; at: number }): Promise<void> {
  const payload: CommentLikePayload = { userId, ...(!liked && { unlike: true }) };
  await insertPending(trx, { contentId: postId, key: likeKey(commentId, userId), kind: 'comment_like', commentId, payload, net: liked ? 1 : -1, at });
}

/**
 * Makes the row of a user's like of a comment say the other thing: a like where it took one
 * back, or with `liked` false, the taking back of the like it made. In the transaction
 * writeUnnumbered runs, with the row locked, so that it and the compactor, which settles the
 * row once it has applied it (see applyPending), each see what the other did.
 *
 * The row stays the one row the user has for the comment, and what it comes to changes by one
 * (see `pending_writes.net`): the taking back of a like that was never made in the content
 * store comes to nothing, and so does a like given again before its taking back was applied.
 *
 * Returns `flipped`; or `same`, if the row says what was asked already, which the user's other
 * request made it say; or `gone`, if the compactor has applied the row and deleted it: the
 * content store then says what the user's like is, and the caller reads it again.
 */
export async function flipLike(trx: Transaction<Database>, dialect: DbDialect, { postId, commentId, userId, liked }: { postId: string; commentId: string; userId: string; liked: boolean }): Promise<'flipped' | 'same' | 'gone'> {
  const key = likeKey(commentId, userId);
  const row = trx.selectFrom('pending_writes').select(['payload', 'net']).where('content_id', '=', postId).where('seq', '=', UNNUMBERED).where('write_key', '=', key).where('kind', '=', 'comment_like');
  // SQLite runs one transaction at a time, and has no rows to lock.
  const found = await (dialect === 'sqlite' ? row : row.forUpdate()).executeTakeFirst();
  if (!found) return 'gone';
  if (!payloadOf<CommentLikePayload | null>(found.payload)?.unlike === liked) return 'same';
  const payload: CommentLikePayload = { userId, ...(!liked && { unlike: true }) };
  await trx
    .updateTable('pending_writes')
    .set({ payload: JSON.stringify(payload), net: Number(found.net ?? 1) + (liked ? 1 : -1) })
    .where('content_id', '=', postId)
    .where('seq', '=', UNNUMBERED)
    .where('write_key', '=', key)
    .execute();
  return 'flipped';
}
