import { loadConfig } from '../config.js';
import { bootstrapAdmin, describeAdmin } from '../moderation/bootstrap.js';
import { createDb } from './index.js';
import { migrateToLatest } from './migrator.js';

/**
 * `npm run migrate`: brings the schema up to date, whatever DB_MIGRATE_ON_START says, and then sets
 * up the admin account in BOOTSTRAP_ADMIN, if there is one (moderation/bootstrap.ts).
 */

/** The server's settings, as `loadConfig` read them from the config file and the environment: the step migrates the database they name. */
const config = loadConfig();
/** The database of the settings, opened as it is: the migrations run on it below, and it is closed whether they succeed or fail. */
const db = await createDb(config.db);
try {
  await migrateToLatest(db);
  console.log(`Migrations complete (${config.db.dialect}).`);
  const admin = await bootstrapAdmin(db);
  if (admin) console.log(describeAdmin(admin));
} finally {
  await db.destroy();
}
