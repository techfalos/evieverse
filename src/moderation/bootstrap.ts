import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { foldUsername } from '../search/keywords.js';
import type { EnsuredAdmin } from './bootstrap.types.js';

/**
 * The admin account a deployment is set up with, as BOOTSTRAP_ADMIN holds it (JSON). The key itself
 * never comes here: whoever made it keeps it, and sends the SHA-256 that api_keys stores.
 */
const BootstrapAdmin = z.object({
  userId: z.string().uuid(),
  username: z.string().trim().min(1).max(64),
  keyHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type BootstrapAdmin = z.infer<typeof BootstrapAdmin>;

/**
 * Makes sure the account exists and is an admin, and gives it the key, as its only one, if the key
 * is new to it. So a deploy can run it every time: with the same values it changes nothing, and with
 * a new key it replaces the one the account has.
 *
 * A key the account had, and which was replaced through the API since (POST /users/:id/key), is
 * left revoked. The replacement lasts, whichever deploys follow, and a key that was replaced
 * because it leaked never works again. The key's revoked row in api_keys is what says it was
 * replaced, so this depends on those rows being kept. A deployment that needs the account back
 * issues a new key.
 *
 * Throws if the account has to be created and another user has its username.
 */
export function ensureAdmin(db: Db, admin: BootstrapAdmin, now = Date.now()): Promise<EnsuredAdmin> {
  const { userId, keyHash } = admin;
  return db.transaction().execute(async (trx) => {
    const user = await trx.selectFrom('users').select(['username', 'admin', 'deleted_at']).where('id', '=', userId).executeTakeFirst();
    // Deleted, and not yet gone (the compactor deletes its posts first): it can't be put back in place, and it can't be made anew under the same id.
    if (user?.deleted_at != null) throw new Error(`the admin account ${userId} was deleted and is not gone yet: run the migration step again once the compactor has deleted its posts`);
    if (!user) {
      const holder = await trx.selectFrom('users').select('id').where('username', '=', admin.username).executeTakeFirst();
      if (holder) throw new Error(`the admin account can't be created: the username "${admin.username}" belongs to user ${holder.id}; choose another`);
      // updated_at makes the compactor write the publisher credit to Redis, as it does for a changed profile.
      await trx
        .insertInto('users')
        .values({ id: userId, username: admin.username, username_folded: foldUsername(admin.username), created_at: now, updated_at: now, admin: 1 })
        .execute();
    } else if (user.admin !== 1) {
      await trx.updateTable('users').set({ admin: 1 }).where('id', '=', userId).execute();
    }

    const key = await trx.selectFrom('api_keys').select('revoked_at').where('user_id', '=', userId).where('key_hash', '=', keyHash).executeTakeFirst();
    // Revoked: the account replaced it, or another admin did. Bringing it back would undo that.
    const keyReplaced = key != null && key.revoked_at !== null;
    let keyChanged = false;
    if (!keyReplaced) {
      const others = await trx
        .updateTable('api_keys')
        .set({ revoked_at: now })
        .where('user_id', '=', userId)
        .where('key_hash', '<>', keyHash)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (!key) {
        await trx
          .insertInto('api_keys')
          .values({ id: randomUUID(), user_id: userId, key_hash: keyHash, created_at: now, revoked_at: null })
          .execute();
      }
      keyChanged = !key || Number(others.numUpdatedRows) > 0;
    }

    return { userId, username: user?.username ?? admin.username, created: !user, keyChanged, keyReplaced };
  });
}

/** ensureAdmin for the account in BOOTSTRAP_ADMIN, if it's set: what the migration step of a deploy runs after the migrations. */
export async function bootstrapAdmin(db: Db, env: NodeJS.ProcessEnv = process.env): Promise<EnsuredAdmin | null> {
  const raw = env.BOOTSTRAP_ADMIN;
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('BOOTSTRAP_ADMIN is not JSON');
  }
  const parsed = BootstrapAdmin.safeParse(value);
  if (!parsed.success) {
    throw new Error(`BOOTSTRAP_ADMIN needs userId (a UUID), username and keyHash (the key's SHA-256, in hex): ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  }
  return ensureAdmin(db, parsed.data);
}

/**
 * What the migration step prints of the account `ensureAdmin` made sure of, in one sentence:
 * whether it was created or was in place already, whether it got a new API key, and, for a key
 * that was replaced and so stays revoked, how to give the account a new one.
 */
export const describeAdmin = ({ username, userId, created, keyChanged, keyReplaced }: EnsuredAdmin) =>
  `Admin account ${username} (${userId}) ${created ? 'created' : 'is in place'}${
    keyReplaced
      ? ". The key in BOOTSTRAP_ADMIN is not its key any more: it was replaced, and stays revoked. To give the account a new key from here, put a new key's hash in BOOTSTRAP_ADMIN"
      : keyChanged && !created
        ? ', with a new API key'
        : ''
  }.`;
