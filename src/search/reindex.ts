import { loadConfig } from '../config.js';
import { openDb } from '../db/index.js';
import { ContentStore } from '../storage/index.js';
import { reindex } from './backfill.js';

/**
 * `npm run reindex`: makes every post and every user findable by GET /search (see `reindex` in
 * backfill.ts). Run it once after upgrading a server that had posts before it had search: until
 * then those posts are found by no search, and a user whose name has capitals or accents beyond
 * ASCII's is found only by the name as it is written. It can be run while the server and the
 * compactor are up, and run again: it changes only what isn't right yet.
 *
 * It opens the database, which it brings to the latest schema first unless DB_MIGRATE_ON_START
 * is off, and the content store, where the posts' meta files are. It needs no Redis.
 */

/** The server's settings, as `loadConfig` read them from the config file and the environment: the database and the content store they name are the ones reindexed. */
const config = loadConfig();
/** The database of the settings, at the latest schema unless DB_MIGRATE_ON_START is off. It is closed whether the reindex succeeds or fails. */
const db = await openDb(config.db);
try {
  const done = await reindex({ db, config, content: new ContentStore(config.storage.content, Date.now) }, ({ posts, pending }) => console.log(`${posts + pending} posts read...`));
  console.log(`Reindex complete: ${done.posts} posts indexed, ${done.pending} not yet applied by the compactor (it indexes them), ${done.usernames} usernames folded.`);
} finally {
  await db.destroy();
}
