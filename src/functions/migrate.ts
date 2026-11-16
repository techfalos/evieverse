import { describeAdmin } from '../moderation/bootstrap.js';
import { migrateDeployment } from './deploy.js';

/**
 * `node dist/functions/migrate.js`: the step a deployment of functions runs before it updates them,
 * as a job on a platform that runs containers (Cloud Run, Azure Container Apps). It is given the
 * functions' settings, checks that they start with them, and only then brings the schema up to date
 * and sets up the admin account in BOOTSTRAP_ADMIN (deploy.ts). A setting the server refuses ends
 * it with an error, which fails the deploy that waits for it.
 *
 * `npm run migrate` (src/db/migrate.ts) is the same step for the long-running server, which checks
 * its settings itself when it starts.
 */
const { dialect, admin } = await migrateDeployment();
console.log(`The functions start with these settings. Migrations complete (${dialect}).`);
if (admin) console.log(describeAdmin(admin));
