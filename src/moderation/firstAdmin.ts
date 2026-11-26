import { randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { issueApiKey } from '../auth/apiKey.js';
import type { Profile } from '../cli/profiles.types.js';
import type { Config } from '../config.js';
import { isUniqueViolation, type Db } from '../db/index.js';
import { foldUsername } from '../search/keywords.js';
import type { FirstAdmin } from './firstAdmin.types.js';

/** The name of the admin account a server creates the first time it starts. Its owner can change it since (PATCH /users/:userId). */
export const FIRST_ADMIN_USERNAME = 'admin';

/**
 * Creates the server's first admin, if it has none: an account named `admin`, with a new API key.
 * Null if the server has an admin, which is every start but the first, and `{ takenBy }`, with
 * nothing created, if it has none and another user has the name: nobody is made an admin for
 * the name they chose.
 *
 * `keep` is given the account with its key before anything is committed, to put the key where its
 * owner finds it: the database keeps the key's hash alone, so a key that was not kept is a key
 * nobody has. If it throws, nothing is created, and this throws what it threw.
 *
 * Of two servers that start at once on one database, one creates the account, and the other is
 * refused the name it has taken, finds an admin, and returns null.
 */
export async function createFirstAdmin(db: Db, keep: (admin: FirstAdmin) => Promise<void>, now = Date.now()): Promise<FirstAdmin | { takenBy: string } | null> {
  const hasAdmin = async (from: Db) => (await from.selectFrom('users').select('id').where('admin', '=', 1).where('deleted_at', 'is', null).limit(1).executeTakeFirst()) !== undefined;
  try {
    return await db.transaction().execute(async (trx) => {
      if (await hasAdmin(trx)) return null;
      const holder = await trx.selectFrom('users').select('id').where('username', '=', FIRST_ADMIN_USERNAME).executeTakeFirst();
      if (holder) return { takenBy: holder.id };
      const userId = randomUUID();
      // updated_at makes the compactor write the publisher credit to Redis, as it does for a changed profile.
      await trx
        .insertInto('users')
        .values({ id: userId, username: FIRST_ADMIN_USERNAME, username_folded: foldUsername(FIRST_ADMIN_USERNAME), created_at: now, updated_at: now, admin: 1 })
        .execute();
      const admin: FirstAdmin = { userId, username: FIRST_ADMIN_USERNAME, apiKey: await issueApiKey(trx, userId, now) };
      await keep(admin);
      return admin;
    });
  } catch (err) {
    // The name was taken between this transaction's look and its insert: by the server that started beside this one, if there is an admin now.
    if (isUniqueViolation(err) && (await hasAdmin(db))) return null;
    throw err;
  }
}

/** Writes a file that holds a key, for its owner alone to read, in a directory that is made if it isn't there. */
async function writeSecret(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, { mode: 0o600 });
  // The mode above only applies to a file that wasn't there.
  await chmod(path, 0o600);
}

/**
 * What the long-running server does about its admin as it starts, where `firstAdminProfile`
 * (FIRST_ADMIN_PROFILE) names a file, as the Docker image does: on a database with no admin, it
 * creates one (see `createFirstAdmin`) and writes the account's profile to that file, which is
 * what the server's CLI signs in with once it is copied to ~/.evieverse/profiles on the
 * operator's machine. The profile names the server by `publicBaseUrl`, or by its port on
 * localhost where that isn't set.
 *
 * The account is committed only once the file is written, so a file that can't be written stops
 * the server with nothing created. On a server that has an admin it does nothing, and the file a
 * first start wrote is left as it is: it holds the key the account had then, which its owner may
 * have replaced since.
 *
 * Returns the account it created, or null. A server with no admin whose name `admin` is another
 * user's is left without one, with a warning that says how to make one.
 */
export async function setUpFirstAdmin({ db, config }: { db: Db; config: Pick<Config, 'firstAdminProfile' | 'publicBaseUrl' | 'port'> }, log: FastifyBaseLogger, now = Date.now()): Promise<FirstAdmin | null> {
  if (!config.firstAdminProfile) return null;
  const path = resolve(config.firstAdminProfile);
  const server = config.publicBaseUrl || `http://localhost:${config.port}`;
  const made = await createFirstAdmin(
    db,
    ({ userId, username, apiKey }) => {
      const profile: Profile = { server, userId, username, apiKey };
      return writeSecret(path, `${JSON.stringify(profile, null, 2)}\n`);
    },
    now,
  );
  if (made === null) return null;
  if ('takenBy' in made) {
    log.warn(
      `the server has no admin, and none was created: the name "${FIRST_ADMIN_USERNAME}" belongs to user ${made.takenBy}. Make a user an admin with \`node dist/moderation/admin.js grant <username or userId>\``,
    );
    return null;
  }
  log.info(
    `created the server's first admin, ${made.username} (${made.userId}). Its profile for the CLI, which holds its API key, is in ${path}: copy it to ~/.evieverse/profiles/<name>.json on your machine, and \`evieverse --profile <name> whoami\` is signed in as it`,
  );
  return made;
}
