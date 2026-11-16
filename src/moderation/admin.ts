import { loadConfig } from '../config.js';
import { openDb } from '../db/index.js';
import { setAdmin } from './policy.js';

/**
 * Who the server's admins are, as its operator sets them, straight in the database: `npm run admin --
 * grant <username or userId>`, `npm run admin -- revoke <username or userId>`, and `npm run admin --
 * list`. In a container: `node dist/moderation/admin.js grant alice`. It needs no API key, so it makes
 * a server's first admin and is the way back in without one; admins otherwise use /admins, or the
 * CLI the server ships (src/cli).
 */

/** What the command line asks: `grant`, `revoke` or `list`, and for the first two, the user, by username or id. */
const [command, user] = process.argv.slice(2);

/**
 * The server's database, opened as the server opens it, so with its schema brought up to date
 * first unless `migrateOnStart` is off. Closed when the command is done.
 */
const db = await openDb(loadConfig().db);
let failed = false;
try {
  if (command === 'list') {
    const admins = await db.selectFrom('users').select(['id', 'username']).where('admin', '=', 1).orderBy('username').execute();
    for (const a of admins) console.log(`${a.id}  ${a.username}`);
    if (!admins.length) console.log('There are no admins.');
  } else if ((command === 'grant' || command === 'revoke') && user) {
    const changed = await setAdmin(db, user, command === 'grant');
    if (changed) console.log(`${changed.username} (${changed.userId}) ${command === 'grant' ? 'is now an admin' : 'is no longer an admin'}.`);
    else {
      console.error(`No user is named or has the id "${user}".`);
      failed = true;
    }
  } else {
    console.error('usage: npm run admin -- grant <username or userId> | revoke <username or userId> | list');
    failed = true;
  }
} finally {
  await db.destroy();
}
if (failed) process.exit(1);
