import { loadConfig } from '../config.js';
import { createDb } from '../db/index.js';
import { migrateToLatest } from '../db/migrator.js';
import { setAdmin } from './policy.js';

/**
 * Who the server's admins are, which only its operator decides: `npm run admin -- grant <username or
 * userId>`, `npm run admin -- revoke <username or userId>`, and `npm run admin -- list`. In a container:
 * `node dist/moderation/admin.js grant alice`.
 */
const [command, user] = process.argv.slice(2);
const usage = 'usage: npm run admin -- grant <username or userId> | revoke <username or userId> | list';

const config = loadConfig();
const db = await createDb(config.db);
let failed = false;
try {
  await migrateToLatest(db);
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
    console.error(usage);
    failed = true;
  }
} finally {
  await db.destroy();
}
if (failed) process.exit(1);
