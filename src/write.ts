import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { summaryOf, takesComments } from './content.js';
import { updateOnConflict } from './db/index.js';
import type { AppDeps } from './deps.js';
import { badRequest, conflict } from './http/errors.js';
import { msg } from './language.js';
import { previewOf } from './posts.js';
import type { ContentMeta, Publisher, StoredBytes, Summary } from './storage/index.js';
import { countTagPairs, touchTags } from './tags.js';
import { authorIndex } from './tagfeed/layout.js';

export const pendingDeletion = () => conflict(msg('content.pending_deletion'));

/** Refuses an update, of content type `mimeType`, that the content can't take. `meta` is its meta file as it is. */
export function assertUpdatable(existing: { delete_requested_at: number | null }, meta: { mimeType: string }, mimeType: string) {
  if (existing.delete_requested_at !== null) throw pendingDeletion();
  if (mimeType !== meta.mimeType) {
    throw badRequest(msg('content.type_changed', { original: meta.mimeType, mimeType }));
  }
}

export interface ContentWrite {
  publisher: Publisher;
  /** The meta file an update writes over; absent for new content. */
  previous?: ContentMeta;
  /** Names the content id; `updatedAt` is when this write is made. */
  summary: Summary;
  meta: ContentMeta;
  /** Writes the content's bytes, and returns their size as stored, which is the one recorded in the meta file. */
  putBytes: () => Promise<StoredBytes>;
  /**
   * The write's trust score sent it to the moderation queue: the content is stored, but has no
   * summary and is in no feed index until an admin accepts it. Absent: it is published.
   */
  queued?: { trustScore: number };
}

/** Writes content for /store, and publishes what an admin accepts from the moderation queue. */
export function contentWriter({ db, config, content, summaries, publishers, now = Date.now }: AppDeps, log: FastifyBaseLogger) {
  const { dialect } = config.db;

  /**
   * Queues the content's entry in each of these indexes (see `feed_queue`): the compactor rebuilds it
   * there on its next run. The rows are stamped as one write's, over what an earlier write queued.
   * `committed` is false for the rows an update queues before it writes anything, which a run
   * leaves alone until the update has had the grace period to commit, and stamp them again.
   */
  const enqueue = (trx: Pick<typeof db, 'insertInto'>, contentId: string, tags: string[], committed: boolean) => {
    const stamp = { token: randomUUID(), committed: committed ? 1 : 0, created_at: now() };
    return updateOnConflict(
      trx.insertInto('feed_queue').values(tags.map((tag) => ({ content_id: contentId, tag, ...stamp }))),
      dialect,
      ['content_id', 'tag'],
      stamp,
    ).execute();
  };

  /**
   * Writes new content, or over content that is there: content has one version, and the last write
   * wins. Its bytes, summary and meta file go to the stores (the meta file last: what it says is
   * there), then the database commits the write, and with it a row in the feed queue for every
   * hashtag of the content and for the publisher's own index. Nothing is written to the feed index
   * here: the compactor's next run takes the rows and rebuilds the content's entries, so the index
   * never holds content the database rejected, and a write is queued if and only if it committed.
   *
   * So a new post is in feeds once that run has published its indexes. An update shows at once
   * where the content already is, since feeds read its summary, which is written over; and it is
   * left out of the feeds of a hashtag it dropped at once too, since a feed leaves out a record
   * whose summary doesn't carry the hashtag it is listed under (see renderFeed). The hashtags it
   * dropped are queued with the ones it has, which is what takes its entries out of their indexes.
   *
   * New content the database doesn't take is removed from the stores. An update can't be taken
   * back, since it writes over what was there: one that stops half way, or whose commit fails, is
   * reported as failed, and sending it again completes it. It queues its rows before it writes
   * anything, uncommitted, so that if it stops there the index is still brought into line with
   * what the meta file says, once the grace period has passed.
   *
   * A write sent to the moderation queue (`queued`) is stored the same way, and its commit puts the
   * content in `moderation_queue` with its trust score, but it gets no entry anywhere: new content
   * queues nothing, and an update queues every index that may hold the content, which the compactor
   * then takes it out of. Such an update also erases the content's summary, in place of writing it:
   * that is what hides the content from feeds at once, and keeps what is yet to be reviewed out of
   * them, in the indexes the compactor hasn't rebuilt yet and in the ones feed sessions under way
   * still read. Accepting the content writes its summary again (see publish). A write that isn't
   * queued takes the content out of the queue, if it was there. Either way, an update makes the
   * content unmoderated again under its hashtags: the approvals of their moderators were of what
   * it was.
   *
   * Last, the write's hashtags are counted in `tag_pairs`, from which related hashtags are worked
   * out: all of new content's, and those an update added. It is counted once the write is
   * committed, queued or not, and outside its transaction, which then holds no lock on rows every
   * post of a busy hashtag counts on. A count that fails is lost, and the write stands.
   */
  async function write({ publisher, previous, summary, meta, putBytes, queued }: ContentWrite): Promise<void> {
    const { contentId, createdAt, updatedAt: ts, aiGenerated } = summary;
    const own = authorIndex(publisher.userId);
    const tags = queued ? [] : [...summary.tags, own];
    // Queued: also the hashtags it has now, should an admin accept what it was while this is under way.
    const dropped = !previous ? [] : queued ? [...new Set([...previous.tags, ...summary.tags, own])] : previous.tags.filter((tag) => !summary.tags.includes(tag));
    const touched = [...tags, ...dropped];

    if (previous && touched.length) await enqueue(db, contentId, touched, false);
    try {
      const stored = await putBytes();
      // A held update: erased, and the request fails if it can't be, since feeds would go on showing the content.
      if (queued && previous) await summaries.erase(summary);
      else if (!queued) await summaries.put(summary);
      await content.putMeta({ ...meta, ...stored });
    } catch (err) {
      if (!previous) await discard(summary);
      // Content that waited in the moderation queue still does, and has no summary, whatever this write had stored.
      else if (await isHeld(contentId).catch(() => false)) await summaries.erase(summary).catch(() => {});
      // The meta file is still the one before: feeds go back to showing what it describes.
      else await summaries.put(summaryBefore(summary, previous)).catch(() => {});
      throw err;
    }

    try {
      await db.transaction().execute(async (trx) => {
        if (previous) {
          const res = await trx
            .updateTable('content')
            .set({ ai_generated: aiGenerated ? 1 : 0 })
            .where('id', '=', contentId)
            .where('delete_requested_at', 'is', null)
            .executeTakeFirst();
          // MySQL counts the rows it changed, not those it matched, so a row it left as it was is looked for.
          if (Number(res.numUpdatedRows) !== 1 && !(await isLive(trx, contentId))) throw pendingDeletion();
        } else {
          await trx
            .insertInto('content')
            .values({ id: contentId, user_id: publisher.userId, ai_generated: aiGenerated ? 1 : 0, created_at: createdAt, delete_requested_at: null })
            .execute();
        }
        if (queued) {
          // Content that was waiting keeps its place in the queue.
          const row = { content_id: contentId, trust_score: queued.trustScore, created_at: ts };
          await updateOnConflict(trx.insertInto('moderation_queue').values(row), dialect, 'content_id', { trust_score: queued.trustScore }).execute();
        } else if (previous) {
          await trx.deleteFrom('moderation_queue').where('content_id', '=', contentId).execute();
        }
        if (previous) await trx.deleteFrom('tag_moderation').where('content_id', '=', contentId).where('decision', '=', 'approved').execute();
        // The hashtags it is published under, not the ones it dropped: this is what /tags lists them by.
        if (tags.length) await touchTags(trx, dialect, tags, ts);
        if (touched.length) await enqueue(trx, contentId, touched, true);
      });
    } catch (err) {
      if (previous) {
        // An update that didn't commit is in the stores all the same. One that would have taken the
        // content out of the moderation queue wrote its summary, which content that waits there doesn't have.
        if (!queued && (await isHeld(contentId).catch(() => false))) await summaries.erase(summary).catch(() => {});
        throw err;
      }
      // A COMMIT can fail yet still be applied, e.g. if the connection dropped mid-commit.
      const held = await inserted(contentId);
      if (held === false) await discard(summary);
      if (held !== true) throw err;
    }

    await publishers.put(publisher).catch((err) => log.warn({ err, userId: publisher.userId }, 'could not refresh the publisher credit in Redis'));
    const added = previous ? summary.tags.filter((tag) => !previous.tags.includes(tag)) : summary.tags;
    // Stamped now, not when the write began: the compactor goes by it, and must find the rows written by then.
    await countTagPairs(db, dialect, summary.tags, added, now()).catch((err) =>
      log.warn({ err, contentId }, 'could not count the hashtags of the write; related hashtags go without it'),
    );
  }

  /**
   * Publishes content that waits in the moderation queue, as an admin accepting it does: takes it
   * out of the queue, queues its entry in the index of each of its hashtags and in its publisher's
   * own, as the write that was held back would have, and writes its summary, which content that
   * waits has none of. Returns the content's hashtags, or null if it isn't in the queue (any more).
   *
   * The content's row is locked first, as an update of it does, so the two take turns: whichever
   * commits last decides whether the content is in the queue.
   */
  async function publish(row: { id: string; user_id: string; username: string; created_at: number; ai_generated: number }): Promise<string[] | null> {
    const contentId = row.id;
    const accepted = await db.transaction().execute(async (trx) => {
      await trx.updateTable('content').set((eb) => ({ ai_generated: eb.ref('ai_generated') })).where('id', '=', contentId).execute();
      if (!(await isLive(trx, contentId))) return null;
      const res = await trx.deleteFrom('moderation_queue').where('content_id', '=', contentId).executeTakeFirst();
      if (Number(res.numDeletedRows) === 0) return null;
      // Read with the row locked: a write that commits after this one has it as its `previous`, or wrote it.
      const meta = await content.getMeta(contentId);
      if (!meta) throw new Error(`the meta file of ${contentId} is missing`);
      const tags = [...meta.tags, authorIndex(row.user_id)];
      await touchTags(trx, dialect, tags, now());
      await enqueue(trx, contentId, tags, true);
      return { meta };
    });
    if (!accepted) return null;
    const { meta } = accepted;

    const publisher: Publisher = { userId: row.user_id, username: row.username };
    // Written, not only looked for: whatever summary a write that failed may have left is not of what was accepted.
    // The compactor writes it when it rebuilds the content's entries, should this fail.
    const summary = summaryOf({ ...row, ai_generated: meta.aiGenerated ? 1 : 0 }, meta, config.publicBaseUrl);
    await summaries.put(summary).catch((err) => log.warn({ err, contentId }, 'could not write the summary of accepted content; the compactor will'));
    await publishers.put(publisher).catch((err) => log.warn({ err, userId: publisher.userId }, 'could not refresh the publisher credit in Redis'));
    return meta.tags;
  }

  /** Whether the content waits in the moderation queue. */
  async function isHeld(contentId: string): Promise<boolean> {
    return (await db.selectFrom('moderation_queue').select('content_id').where('content_id', '=', contentId).executeTakeFirst()) !== undefined;
  }

  /** Whether the content is there and not set for deletion. */
  async function isLive(trx: Pick<typeof db, 'selectFrom'>, contentId: string): Promise<boolean> {
    const row = await trx.selectFrom('content').select('id').where('id', '=', contentId).where('delete_requested_at', 'is', null).executeTakeFirst();
    return row !== undefined;
  }

  /** Whether the database holds new content whose insert reported an error; null if it can't say. */
  async function inserted(contentId: string): Promise<boolean | null> {
    try {
      return (await db.selectFrom('content').select('id').where('id', '=', contentId).executeTakeFirst()) !== undefined;
    } catch {
      return null;
    }
  }

  /** The summary of content before an update, which its meta file then (`previous`) still describes. */
  const summaryBefore = (summary: Summary, previous: ContentMeta): Summary => ({
    ...summary,
    updatedAt: previous.updatedAt,
    mimeType: previous.mimeType,
    aiGenerated: previous.aiGenerated,
    comments: takesComments(previous),
    tags: previous.tags,
    preview: previewOf(previous, config.publicBaseUrl),
  });

  /** Removes what was stored of new content that the database doesn't hold. */
  async function discard(summary: Summary): Promise<void> {
    await content.remove(summary.contentId).catch(() => {});
    await summaries.remove([summary]).catch(() => {});
  }

  return { write, publish };
}

export type ContentWriter = ReturnType<typeof contentWriter>;
