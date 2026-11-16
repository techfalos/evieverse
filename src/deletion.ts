import type { AppDeps } from './deps.js';
import { touchTags } from './tags.js';
import { authorIndex } from './tagfeed/layout.js';

/**
 * Sets content for deletion, and returns when that was requested. /content stops serving it and
 * tombstones hide it from feeds at once, but nothing is removed yet: the compactor removes it from
 * every day index, then deletes its row, bytes and summary in the same run. Repeating it appends the
 * tombstones again.
 */
export async function setForDeletion(
  { db, config, content, appender, now = Date.now }: Pick<AppDeps, 'db' | 'config' | 'content' | 'appender' | 'now'>,
  row: { id: string; user_id: string; delete_requested_at: number | null },
  log: { warn: (o: object, msg?: string) => void },
): Promise<number> {
  const contentId = row.id;
  if (row.delete_requested_at === null) {
    await db.updateTable('content').set({ delete_requested_at: now() }).where('id', '=', contentId).where('delete_requested_at', 'is', null).execute();
  }
  // Once the deletion is set no update commits, so these hashtags are final; no row means the compactor already finished.
  const marked = await db.selectFrom('content').select(['created_at', 'delete_requested_at']).where('id', '=', contentId).executeTakeFirst();
  if (marked) {
    const meta = await content.getMeta(contentId);
    const tags = [...(meta?.tags ?? []), authorIndex(row.user_id)];
    await touchTags(db, config.db.dialect, tags, now());
    const failed = await appender.tombstone(tags, { tombstone: true, contentId, before: null, createdAt: marked.created_at });
    if (failed.length) log.warn({ contentId, tags: failed }, 'tombstone append failed; feeds show the content until the compactor deletes it');
  }
  return marked?.delete_requested_at ?? row.delete_requested_at ?? now();
}
