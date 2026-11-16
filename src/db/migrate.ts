import { loadConfig } from '../config.js';
import { createDb } from './index.js';
import { migrateToLatest } from './migrator.js';

const config = loadConfig();
const db = await createDb(config.db);
try {
  await migrateToLatest(db);
  console.log(`Migrations complete (${config.db.dialect}).`);
} finally {
  await db.destroy();
}
