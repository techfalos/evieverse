import type { FastifyBaseLogger } from 'fastify';
import { summaryOf, takesComments } from './content.js';
import { updateOnConflict } from './db/index.js';
import type { AppDeps } from './deps.js';
import { badRequest, conflict } from './http/errors.js';
import { msg } from './language.js';
import { previewOf } from './posts.js';
import type { ContentMeta, Publisher, StoredBytes, Summary } from './storage/index.js';
import { countTagPairs, touchTags } from './tags.js';
import { authorIndex, type TailLine, type TailRecord } from './tagfeed/layout.js';

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
   * The write's trust score sent it to the moderation queue: the content is stored, but in no feed
   * index until an admin accepts it. Absent: it is published.
   */
  queued?: { trustScore: number };
}

/** Writes content for /store, and publishes what an admin accepts from the moderation queue. */
export function contentWriter({ db, config, content, summaries, publishers, appender, now = Date.now }: AppDeps, log: FastifyBaseLogger) {
  const { dialect } = config.db;

  /** Stamps a pending_appends row for each of the content's tails that a write has a line for. */
  const pending = (trx: Pick<typeof db, 'insertInto'>, contentId: string, tags: string[], stamp: number) =>
    updateOnConflict(
      trx.insertInto('pending_appends').values(tags.map((tag) => ({ content_id: contentId, tag, created_at: stamp }))),
      dialect,
      ['content_id', 'tag'],
      { created_at: stamp },
    ).execute();

  /**
   * Pushes a committed write's lines onto the tails, in the order given, and clears the
   * pending_appends rows (stamped `stamp`) of those it pushed. The rest are left for the compactor.
   */
  async function push(contentId: string, lines: [tag: string, line: TailLine][], stamp: number): Promise<void> {
    const results = await Promise.allSettled(lines.map(([tag, line]) => appender.append(tag, line)));
    const failed = lines.filter((_, i) => results[i]!.status === 'rejected').map(([tag]) => tag);
    if (failed.length) {
      const { reason: err } = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      log.warn({ err, contentId, tags: failed }, 'tail append failed; the compactor will rebuild the entry');
    }
    const appended = lines.map(([tag]) => tag).filter((tag) => !failed.includes(tag));
    if (!appended.length) return;
    await db
      .deleteFrom('pending_appends')
      .where('content_id', '=', contentId)
      .where('tag', 'in', appended)
      .where('created_at', '=', stamp)
      .execute()
      .catch((err) => log.warn({ err, contentId }, 'could not clear the pending appends; the compactor will'));
  }

  /**
   * Writes new content, or over content that is there: content has one version, and the last write
   * wins. Its bytes, summary and meta file go to the stores (the meta file last: what it says is
   * there), then the database commits the write, and only then is one entry pushed onto the tail of
   * every hashtag and of the publisher's own index, so a tail never holds content the database
   * rejected. An update also pushes a tombstone onto the tail of each hashtag it dropped, which
   * hides the content from that hashtag's feeds at once.
   *
   * Every tail the write has a line for gets a pending_appends row, cleared once the line is
   * pushed; for rows left behind, the compactor rebuilds the content's entry in that tail's index
   * from the database and the meta file.
   *
   * New content the database doesn't take is removed from the stores. An update can't be taken
   * back, since it writes over what was there: one that stops half way, or whose commit fails, is
   * reported as failed, and sending it again completes it. It records its pending_appends rows
   * before it writes anything, so the index follows what the meta file says in the meantime.
   *
   * A write sent to the moderation queue (`queued`) is stored the same way, and its commit puts the
   * content in `moderation_queue` with its trust score, but it gets no entry anywhere: new content
   * pushes nothing, and an update pushes a tombstone onto every tail that may hold the content, so
   * what was published is hidden at once. A write that isn't queued takes the content out of the
   * queue, if it was there. Either way, an update makes the content unmoderated again under its
   * hashtags: the approvals of their moderators were of what it was.
   *
   * Last, the write's hashtags are counted in `tag_pairs`, from which related hashtags are worked
   * out: all of new content's, and those an update added. It is counted once the write is
   * committed, queued or not, and outside its transaction, which then holds no lock on rows every
   * post of a busy hashtag counts on. A count that fails is lost, and the write stands.
   */
  async function write({ publisher, previous, summary, meta, putBytes, queued }: ContentWrite): Promise<void> {
    const { contentId, createdAt, updatedAt: ts, aiGenerated } = summary;
    const entry: TailRecord = { contentId, createdAt, updatedAt: ts, likes: 0, aiGenerated, moderated: false };
    const own = authorIndex(publisher.userId);
    const tags = queued ? [] : [...summary.tags, own];
    // Queued: also the hashtags it has now, should an admin accept what it was while this is under way.
    const dropped = !previous ? [] : queued ? [...new Set([...previous.tags, ...summary.tags, own])] : previous.tags.filter((tag) => !summary.tags.includes(tag));
    const touched = [...tags, ...dropped];

    if (previous && touched.length) await pending(db, contentId, touched, now());
    try {
      const stored = await putBytes();
      await summaries.put(summary);
      await content.putMeta({ ...meta, ...stored });
    } catch (err) {
      if (!previous) await discard(summary);
      // The meta file is still the one before: feeds go back to showing what it describes.
      else await summaries.put(summaryBefore(summary, previous)).catch(() => {});
      throw err;
    }

    // When the rows were stamped: only those are cleared below, not ones a later write stamped again.
    const stamp = now();
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
        if (!touched.length) return;
        await touchTags(trx, dialect, touched, ts);
        await pending(trx, contentId, touched, stamp);
      });
    } catch (err) {
      // An update that didn't commit is in the stores all the same.
      if (previous) throw err;
      // A COMMIT can fail yet still be applied, e.g. if the connection dropped mid-commit.
      const held = await inserted(contentId);
      if (held === false) await discard(summary);
      if (held !== true) throw err;
    }

    await publishers.put(publisher).catch((err) => log.warn({ err, userId: publisher.userId }, 'could not refresh the publisher credit in Redis'));
    // A queued update hides every entry pushed until now, whenever its write was stamped: one an admin
    // accepts afterwards is stamped later, and shows.
    const before = queued ? now() : ts;
    // The entries first, so the content is never missing from a hashtag it keeps.
    await push(
      contentId,
      [
        ...tags.map((tag): [string, TailLine] => [tag, entry]),
        ...dropped.map((tag): [string, TailLine] => [tag, { tombstone: true, contentId, before, createdAt }]),
      ],
      stamp,
    );
    const added = previous ? summary.tags.filter((tag) => !previous.tags.includes(tag)) : summary.tags;
    // Stamped now, not when the write began: the compactor goes by it, and must find the rows written by then.
    await countTagPairs(db, dialect, summary.tags, added, now()).catch((err) =>
      log.warn({ err, contentId }, 'could not count the hashtags of the write; related hashtags go without it'),
    );
  }

  /**
   * Publishes content that waits in the moderation queue, as an admin accepting it does: takes it
   * out of the queue, and pushes one entry onto the tail of each of its hashtags and of its
   * publisher's own index, as the write that was held back would have. The entries are stamped now,
   * so they show whatever tombstones that write left. Returns the content's hashtags, or null if it
   * isn't in the queue (any more).
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
      const stamp = now();
      const tags = [...meta.tags, authorIndex(row.user_id)];
      await touchTags(trx, dialect, tags, stamp);
      await pending(trx, contentId, tags, stamp);
      return { meta, tags, stamp };
    });
    if (!accepted) return null;
    const { meta, tags, stamp } = accepted;

    const publisher: Publisher = { userId: row.user_id, username: row.username };
    // The write that was held back stored the summary; it is only looked for, and written again if a tier lost it.
    const summary = summaryOf({ ...row, ai_generated: meta.aiGenerated ? 1 : 0 }, meta, config.publicBaseUrl);
    await summaries.ensure(summary).catch((err) => log.warn({ err, contentId }, 'could not check the summary of accepted content'));
    await publishers.put(publisher).catch((err) => log.warn({ err, userId: publisher.userId }, 'could not refresh the publisher credit in Redis'));
    const entry: TailRecord = { contentId, createdAt: row.created_at, updatedAt: stamp, likes: 0, aiGenerated: summary.aiGenerated, moderated: false };
    await push(contentId, tags.map((tag): [string, TailLine] => [tag, entry]), stamp);
    return meta.tags;
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
