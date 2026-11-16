import type { Config } from '../config.js';
import type { EnsuredAdmin } from '../moderation/bootstrap.types.js';

/**
 * What `migrateDeployment` reports once the step succeeded: the schema is up to date, in which
 * dialect, and what was done about the admin account in BOOTSTRAP_ADMIN, if there is one. On AWS
 * Lambda it is the `migrate` function's result, which the deploy that invoked it gets; migrate.ts
 * prints it.
 */
export interface Deployed {
  migrated: true;
  dialect: Config['db']['dialect'];
  admin?: EnsuredAdmin;
}
