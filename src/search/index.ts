import { ignoreConflicts, type Db, type DbDialect } from '../db/index.js';
import type { ContentMeta } from '../storage/index.js';
import { keywordsOf } from './keywords.js';

/** The most terms one statement names: the rows of a post it inserts, or deletes. */
const BATCH = 500;

/**
 * Has `search_terms` hold the terms the post is found by, as the meta file `meta` has it (see
 * keywordsOf, which `max` is the most words for): the rows of the terms it has no more are
 * deleted, and those of the ones it has since are inserted, in one transaction, so a search
 * finds the post by what it was or by what it is. A post whose terms are the ones it has rows
 * for is left as it is, and costs one read.
 *
 * Whatever writes a post's meta file calls this first, with what it is about to write: the
 * compactor, which is one process at a time (see CompactorLease), and `npm run reindex`, which
 * holds the compactor's lease while it does. So a post's rows have one writer, and are those of
 * its meta file, or of the one a run that stopped here was about to write, which the next run
 * writes. It can be made again: the second time finds nothing to change.
 *
 * `created_at` is the post's own, which its rows are ordered by.
 *
 * A database may hold two terms to be one (MySQL's collation takes "ß" for "ss"): the row that
 * is there then stands for both, and the insert of the other is let go. What is deleted is
 * deleted first, so that it never takes a row that stands for a term the post still has.
 */
export async function indexContent(
  db: Db,
  dialect: DbDialect,
  post: { id: string; created_at: number },
  meta: Pick<ContentMeta, 'text' | 'preview' | 'tags'>,
  max: number,
): Promise<void> {
  const wanted = new Set(keywordsOf(meta, max));
  const had = new Set((await db.selectFrom('search_terms').select('term').where('content_id', '=', post.id).execute()).map((r) => r.term));
  const stale = [...had].filter((term) => !wanted.has(term));
  const missing = [...wanted].filter((term) => !had.has(term));
  if (stale.length === 0 && missing.length === 0) return;
  await db.transaction().execute(async (trx) => {
    for (let i = 0; i < stale.length; i += BATCH) {
      await trx
        .deleteFrom('search_terms')
        .where('content_id', '=', post.id)
        .where('term', 'in', stale.slice(i, i + BATCH))
        .execute();
    }
    for (let i = 0; i < missing.length; i += BATCH) {
      await ignoreConflicts(
        trx.insertInto('search_terms').values(missing.slice(i, i + BATCH).map((term) => ({ term, content_id: post.id, created_at: post.created_at }))),
        dialect,
      ).execute();
    }
  });
}
