import { loadConfig } from '../config.js';
import { bootstrapAdmin, describeAdmin } from '../moderation/bootstrap.js';
import { createDb } from './index.js';
import { migrateToLatest } from './migrator.js';

/**
 * `npm run migrate`: brings the schema up to date, whatever DB_MIGRATE_ON_START says, and then sets
 * up the admin account in BOOTSTRAP_ADMIN, if there is one (moderation/bootstrap.ts).
 */
const config = loadConfig();
const db = await createDb(config.db);
try {
  await migrateToLatest(db);
  console.log(`Migrations complete (${config.db.dialect}).`);
  const admin = await bootstrapAdmin(db);
  if (admin) console.log(describeAdmin(admin));
} finally {
  await db.destroy();
}
