import type { FastifyBaseLogger } from 'fastify';
import type { Insertable } from 'kysely';
import type { ContentTable } from './db/schema.js';
import type { AppDeps } from './deps.js';
import { conflict } from './http/errors.js';
import type { ContentMeta, Publisher, Summary } from './storage/index.js';
import { touchTags } from './tags.js';
import { authorIndex, recordSize, type TailRecord } from './tagfeed/layout.js';

export const changedConcurrently = () => conflict('content was updated or set for deletion concurrently; retry');

/** The first `maxWords` words of `text`, cut to `maxChars` characters, which bounds text written without spaces. */
export function firstWords(text: string, maxWords: number, maxChars: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  let out = words.slice(0, maxWords).join(' ');
  let cut = words.length > maxWords;
  if (out.length > maxChars) {
    // Not between the halves of a surrogate pair.
    const code = out.charCodeAt(maxChars - 1);
    out = out.slice(0, code >= 0xd800 && code <= 0xdbff ? maxChars - 1 : maxChars).trimEnd();
    cut = true;
  }
  return cut ? `${out} …` : out;
}

/** Content row columns a version sets beyond what its summary holds, on insert and on update alike. */
export type VersionColumns = Pick<Insertable<ContentTable>, 'filename' | 'size' | 'sha256' | 'origin_server' | 'origin_content_id' | 'origin_version'>;

export interface NewVersion {
  publisher: Publisher;
  /** The row an update started from; absent for new content. */
  existing?: { version: number };
  /** Names the content id and version number, which must be the write's own (see reserveVersion). */
  summary: Summary;
  meta: ContentMeta;
  columns: VersionColumns;
  /** Writes the version's bytes; federated content has none here. */
  putBytes?: () => Promise<void>;
}

/** Writes content versions for /store and /federated. */
export function versionWriter({ db, config, content, summaries, publishers, appender, now = Date.now }: AppDeps, log: FastifyBaseLogger) {
  /**
   * Reserves a version number for an update of content now at version `from`. Each write gets its own
   * number, so concurrent updates never write to the same content/<id>/<version> key, and the row shows
   * which of them committed. Committing still requires `from`, so only one of them does.
   */
  async function reserveVersion(contentId: string, from: number): Promise<number> {
    for (;;) {
      const row = await db
        .selectFrom('content')
        .select(['version', 'reserved_version', 'delete_requested_at'])
        .where('id', '=', contentId)
        .executeTakeFirst();
      if (!row || row.version !== from || row.delete_requested_at !== null) throw changedConcurrently();
      // A node that predates reserved_version can move version past it.
      const version = Math.max(row.version, row.reserved_version) + 1;
      const res = await db
        .updateTable('content')
        .set({ reserved_version: version })
        .where('id', '=', contentId)
        .where('version', '=', from)
        .where('reserved_version', '=', row.reserved_version)
        .where('delete_requested_at', 'is', null)
        .executeTakeFirst();
      if (Number(res.numUpdatedRows) === 1) return version;
    }
  }

  /**
   * Writes a version: its bytes (if any), meta file and summary, then the database commits it, and
   * only then is one entry pushed onto the tail of every hashtag and of the publisher's own index, so a
   * tail never holds a version the database rejected. The commit also records a pending_appends row,
   * cleared once every append succeeds; the compactor adds the entry itself for rows left behind. An
   * update replaces the previous version: tombstones hide it from feeds at once, and the compactor erases it.
   */
  async function write({ publisher, existing, summary, meta, columns, putBytes }: NewVersion): Promise<void> {
    const { contentId, version, createdAt, updatedAt: ts, aiGenerated } = summary;
    const entry: TailRecord = { contentId, version, createdAt, updatedAt: ts, likes: 0, size: recordSize(summary, publisher), aiGenerated };
    const row = { ...columns, mime_type: summary.mimeType, ai_generated: aiGenerated ? 1 : 0 };
    const own = authorIndex(publisher.userId);
    const tags = [...summary.tags, own];

    const previous = existing ? await content.getMeta(contentId, existing.version) : null;
    await putBytes?.();
    await content.putMeta(meta);
    // Keyed by version like the bytes, so it can be written before the commit decides which write wins.
    await summaries.put(summary).catch(async (err) => {
      await content.remove(contentId, version).catch(() => {});
      await summaries.remove([summary]).catch(() => {});
      throw err;
    });
    try {
      await db.transaction().execute(async (trx) => {
        if (existing) {
          const res = await trx
            .updateTable('content')
            .set({ version, ...row, updated_at: ts })
            .where('id', '=', contentId)
            .where('version', '=', existing.version)
            .where('delete_requested_at', 'is', null)
            .executeTakeFirst();
          if (Number(res.numUpdatedRows) !== 1) throw changedConcurrently();
          await trx.insertInto('superseded_versions').values({ content_id: contentId, version: existing.version, created_at: ts }).execute();
        } else {
          await trx
            .insertInto('content')
            .values({ id: contentId, user_id: publisher.userId, version, reserved_version: version, ...row, created_at: createdAt, updated_at: ts })
            .execute();
        }
        await touchTags(trx, config.db.dialect, [...new Set([...tags, ...(previous?.tags ?? [])])], ts);
        await trx.insertInto('pending_appends').values({ content_id: contentId, version, created_at: now() }).execute();
      });
    } catch (err) {
      const state = await commitState(contentId, version);
      if (state !== 'current') {
        // A replaced version is erased by the compactor; an unknown one may be the version the row holds.
        if (state === 'absent') {
          await content.remove(contentId, version);
          await summaries.remove([summary]);
        }
        throw err;
      }
    }

    await publishers.put(publisher).catch((err) => log.warn({ err, userId: publisher.userId }, 'could not refresh the publisher credit in Redis'));
    await appendRecord(entry, tags);
    if (previous) {
      // After the new entry, so a tag both versions carry never shows neither.
      const failed = await appender.tombstone([...previous.tags, own], { tombstone: true, contentId, below: version, createdAt });
      if (failed.length) log.warn({ contentId, version, tags: failed }, 'tombstone append failed; the compactor will remove the old version');
    }
  }

  /**
   * What the database holds of a write whose transaction reported an error; a COMMIT can fail yet still
   * be applied, e.g. if the connection dropped mid-commit. No other write uses the version number, so
   * the row holds it only if this write committed, and superseded_versions does if this write committed
   * and a later version then replaced it. 'absent': never committed, or already erased. null: unknown.
   */
  async function commitState(contentId: string, version: number): Promise<'current' | 'replaced' | 'absent' | null> {
    try {
      const row = await db.selectFrom('content').select('version').where('id', '=', contentId).executeTakeFirst();
      if (row?.version === version) return 'current';
      if (!row || row.version < version) return 'absent';
      const replaced = await db
        .selectFrom('superseded_versions')
        .select('version')
        .where('content_id', '=', contentId)
        .where('version', '=', version)
        .executeTakeFirst();
      return replaced ? 'replaced' : 'absent';
    } catch {
      return null;
    }
  }

  /** Pushes a committed version's entry onto each of its hashtags' tails; what fails is left to the compactor. */
  async function appendRecord(entry: TailRecord, tags: string[]) {
    const results = await Promise.allSettled(tags.map((tag) => appender.append(tag, entry)));
    const pending = { contentId: entry.contentId, version: entry.version };
    const failed = tags.filter((_, i) => results[i]!.status === 'rejected');
    if (failed.length) {
      const { reason: err } = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      log.warn({ err, ...pending, tags: failed }, 'tail append failed; the compactor will add the entry');
      return;
    }
    await db
      .deleteFrom('pending_appends')
      .where('content_id', '=', entry.contentId)
      .where('version', '=', entry.version)
      .execute()
      .catch((err) => log.warn({ err, ...pending }, 'could not clear the pending append; the compactor will'));
  }

  return { reserveVersion, write };
}
