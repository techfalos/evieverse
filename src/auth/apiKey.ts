import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Db } from '../db/index.js';
import { unauthorized } from '../http/errors.js';

const KEY_PATTERN = /^tu_([0-9a-f]{12})_[A-Za-z0-9_-]{43}$/;

export interface AuthUser {
  id: string;
  username: string;
  publisherUrl: string | null;
  admin: boolean;
}

function hashKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

/** Keys are 256-bit random secrets, so a fast hash is sufficient (no password-style stretching needed). */
export async function issueApiKey(db: Db, userId: string, now = Date.now()): Promise<string> {
  const prefix = randomBytes(6).toString('hex');
  const apiKey = `tu_${prefix}_${randomBytes(32).toString('base64url')}`;
  await db
    .insertInto('api_keys')
    .values({ id: randomUUID(), user_id: userId, key_prefix: prefix, key_hash: hashKey(apiKey), created_at: now, revoked_at: null })
    .execute();
  return apiKey;
}

export function verifyApiKey(db: Db, userId: string, apiKey: string): Promise<AuthUser> {
  return verify(db, apiKey, { userId });
}

/**
 * The user named by `user`, either a username or a userId, as servers federating content here send it.
 * The key decides which user it is, so a username that looks like another user's id can't be mistaken for it.
 */
export function verifyUserApiKey(db: Db, user: string, apiKey: string): Promise<AuthUser> {
  return verify(db, apiKey, { usernameOrId: user });
}

async function verify(db: Db, apiKey: string, user: { userId: string } | { usernameOrId: string }): Promise<AuthUser> {
  const match = KEY_PATTERN.exec(apiKey);
  if (!match) throw unauthorized();
  const rows = await db
    .selectFrom('api_keys')
    .innerJoin('users', 'users.id', 'api_keys.user_id')
    .select(['api_keys.key_hash', 'users.id', 'users.username', 'users.publisher_url', 'users.admin'])
    .where((eb) =>
      'userId' in user
        ? eb('api_keys.user_id', '=', user.userId)
        : eb.or([eb('users.username', '=', user.usernameOrId), eb('users.id', '=', user.usernameOrId)]),
    )
    .where('api_keys.key_prefix', '=', match[1]!)
    .where('api_keys.revoked_at', 'is', null)
    .execute();
  const expected = Buffer.from(hashKey(apiKey), 'hex');
  const row = rows.find((r) => timingSafeEqual(Buffer.from(r.key_hash, 'hex'), expected));
  if (!row) throw unauthorized();
  return { id: row.id, username: row.username, publisherUrl: row.publisher_url, admin: row.admin === 1 };
}

/**
 * Credentials may come from the body/form fields (userId + apiKey) or from headers
 * (Authorization: Bearer <apiKey> and X-User-Id: <userId>).
 */
export function credentialsFrom(
  req: FastifyRequest,
  fields: { userId?: unknown; apiKey?: unknown } = {},
): { userId: string; apiKey: string } {
  const header = req.headers.authorization;
  const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
  const headerUser = req.headers['x-user-id'];
  const userId = typeof fields.userId === 'string' ? fields.userId : typeof headerUser === 'string' ? headerUser : undefined;
  const apiKey = typeof fields.apiKey === 'string' ? fields.apiKey : bearer;
  if (!userId || !apiKey) throw unauthorized('userId and apiKey are required');
  return { userId, apiKey };
}

export async function authenticate(
  db: Db,
  req: FastifyRequest,
  fields: { userId?: unknown; apiKey?: unknown } = {},
): Promise<AuthUser> {
  const { userId, apiKey } = credentialsFrom(req, fields);
  return verifyApiKey(db, userId, apiKey);
}
