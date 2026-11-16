import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db/index.js';

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

export interface EnsuredAdmin {
  userId: string;
  /** The account's name now, which is `username` only if this created it: it may have been renamed since. */
  username: string;
  created: boolean;
  /** Whether the key was added, or other keys of the account revoked. */
  keyChanged: boolean;
}

/**
 * Makes sure the account exists, is an admin, and has the key as its only one, so a deploy can run it
 * every time: with the same values it changes nothing, and with a new key it replaces the old one.
 * Throws if the account has to be created and another user has its username.
 */
export function ensureAdmin(db: Db, admin: BootstrapAdmin, now = Date.now()): Promise<EnsuredAdmin> {
  const { userId, keyHash } = admin;
  return db.transaction().execute(async (trx) => {
    const user = await trx.selectFrom('users').select(['username', 'admin']).where('id', '=', userId).executeTakeFirst();
    if (!user) {
      const holder = await trx.selectFrom('users').select('id').where('username', '=', admin.username).executeTakeFirst();
      if (holder) throw new Error(`the admin account can't be created: the username "${admin.username}" belongs to user ${holder.id}; choose another`);
      // updated_at makes the compactor write the publisher credit to Redis, as it does for a changed profile.
      await trx
        .insertInto('users')
        .values({ id: userId, username: admin.username, created_at: now, updated_at: now, admin: 1 })
        .execute();
    } else if (user.admin !== 1) {
      await trx.updateTable('users').set({ admin: 1 }).where('id', '=', userId).execute();
    }

    const key = await trx.selectFrom('api_keys').select(['id', 'revoked_at']).where('user_id', '=', userId).where('key_hash', '=', keyHash).executeTakeFirst();
    if (!key) {
      await trx
        .insertInto('api_keys')
        .values({ id: randomUUID(), user_id: userId, key_hash: keyHash, created_at: now, revoked_at: null })
        .execute();
    } else if (key.revoked_at !== null) {
      await trx.updateTable('api_keys').set({ revoked_at: null }).where('id', '=', key.id).execute();
    }
    const others = await trx
      .updateTable('api_keys')
      .set({ revoked_at: now })
      .where('user_id', '=', userId)
      .where('key_hash', '<>', keyHash)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();

    return {
      userId,
      username: user?.username ?? admin.username,
      created: !user,
      keyChanged: !key || key.revoked_at !== null || Number(others.numUpdatedRows) > 0,
    };
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

export const describeAdmin = ({ username, userId, created, keyChanged }: EnsuredAdmin) =>
  `Admin account ${username} (${userId}) ${created ? 'created' : 'is in place'}${keyChanged && !created ? ', with a new API key' : ''}.`;
