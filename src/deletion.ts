import type { AppDeps } from './deps.types.js';

/**
 * Sets content for deletion, and returns when that was requested. /content stops serving it at
 * once, and no write of it commits from then on, but nothing is removed yet: the compactor's next
 * run finds it by its row, removes it from every day index, then deletes its row, bytes and summary
 * in the same run, which is when feeds stop returning it. Repeating it changes nothing.
 */
export async function setForDeletion(
  { db, now = Date.now }: Pick<AppDeps, 'db' | 'now'>,
  row: { id: string; delete_requested_at: number | null },
): Promise<number> {
  if (row.delete_requested_at !== null) return row.delete_requested_at;
  const at = now();
  await db.updateTable('content').set({ delete_requested_at: at }).where('id', '=', row.id).where('delete_requested_at', 'is', null).execute();
  // Another request may have set it first, and then theirs stands; no row means the compactor already finished.
  return (await db.selectFrom('content').select('delete_requested_at').where('id', '=', row.id).executeTakeFirst())?.delete_requested_at ?? at;
}
