import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { lockUser, type Db, type DbDialect } from '../db/index.js';
import { forbidden, notFound, unauthorized } from '../http/errors.js';
import { msg, type Languages } from '../language.js';
import type { AuthUser } from './apiKey.types.js';

/**
 * An API key as `issueApiKey` makes one: `tu_`, 12 hex digits, `_`, and the 43 base64url characters
 * of its 32 random bytes. Anything else is refused with 401 before the database is asked.
 */
const KEY_PATTERN = /^tu_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/;

/**
 * The language a user is answered in: the one they registered in or changed to since. The server's
 * default for a user who has none (an account the operator set up), or whose language the server
 * no longer speaks.
 */
const languageOf = (languages: Languages, stored: string | null): string =>
  (stored === null ? undefined : languages.find(stored)) ?? languages.default;

function hashKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

/**
 * Makes the user a new API key and returns it. Only its hash is stored, so this is the one time the
 * key can be read. Keys are 256-bit random secrets, so a fast hash is sufficient (no password-style
 * stretching needed).
 */
export async function issueApiKey(db: Db, userId: string, now = Date.now()): Promise<string> {
  const apiKey = `tu_${randomBytes(6).toString('hex')}_${randomBytes(32).toString('base64url')}`;
  await db
    .insertInto('api_keys')
    .values({ id: randomUUID(), user_id: userId, key_hash: hashKey(apiKey), created_at: now, revoked_at: null })
    .execute();
  return apiKey;
}

/**
 * Replaces the key a request carries with a new one, which is then its user's only key: the one
 * presented stops working as this commits, and so does any other the user had.
 *
 * A user's replacements take turns, and revoking the presented key is what checks it: of two sent at
 * once with the same key, the second finds the key revoked when its turn comes, and gets 401.
 * Otherwise both would get a key, and whoever held a leaked one could keep the account by replacing
 * it at the moment its owner does.
 */
export async function reissueApiKey(
  db: Db,
  dialect: DbDialect,
  req: FastifyRequest,
  fields: { userId?: unknown; apiKey?: unknown } = {},
  now = Date.now(),
): Promise<string> {
  const { userId, apiKey } = credentialsFrom(req, fields);
  if (!userId || !apiKey) throw unauthorized(msg('auth.required'));
  if (!KEY_PATTERN.test(apiKey)) throw unauthorized();
  return db.transaction().execute(async (trx) => {
    // The user's row, not the key's: MySQL's locks on the keys' index deadlock two replacements that each go on to insert a key.
    await lockUser(trx, dialect, userId);
    const revokeLive = () => trx.updateTable('api_keys').set({ revoked_at: now }).where('user_id', '=', userId).where('revoked_at', 'is', null);
    if (Number((await revokeLive().where('key_hash', '=', hashKey(apiKey)).executeTakeFirst()).numUpdatedRows) === 0) throw unauthorized();
    await revokeLive().execute();
    return issueApiKey(trx, userId, now);
  });
}

/**
 * Replaces the key of `userId`, a user other than the one the request's credentials are of, which
 * an admin does for them: for a user who lost their key, or whose key someone else holds. The new
 * key is the user's only one, and goes to the admin to pass on: every key the user had stops
 * working as this commits. The admin's own key is left as it is. The user can be an admin too.
 *
 * Both users' rows are locked first, in the order of their ids (as revoking an admin does), so two
 * of these can't deadlock, and the caller is checked only then: an admin, whose key still works.
 * What ends either through the API locks the caller's row too (replacing their key, revoking their
 * role, deleting their account), so it comes before this or after it, never during. Otherwise
 * whoever held an admin's leaked key could take another admin's account at the moment its owner
 * replaces it.
 *
 * 401 for credentials that aren't a user's, 403 for a caller who isn't an admin, and 404 for a user
 * who isn't there.
 */
export async function reissueApiKeyFor(
  db: Db,
  dialect: DbDialect,
  req: FastifyRequest,
  userId: string,
  fields: { userId?: unknown; apiKey?: unknown } = {},
  now = Date.now(),
): Promise<string> {
  const { userId: callerId, apiKey } = credentialsFrom(req, fields);
  if (!callerId || !apiKey) throw unauthorized(msg('auth.required'));
  if (!KEY_PATTERN.test(apiKey)) throw unauthorized();
  return db.transaction().execute(async (trx) => {
    for (const id of [callerId, userId].sort()) await lockUser(trx, dialect, id);
    const caller = await trx
      .selectFrom('api_keys')
      .innerJoin('users', 'users.id', 'api_keys.user_id')
      .select('users.admin')
      .where('api_keys.user_id', '=', callerId)
      .where('api_keys.key_hash', '=', hashKey(apiKey))
      .where('api_keys.revoked_at', 'is', null)
      .where('users.deleted_at', 'is', null)
      .executeTakeFirst();
    if (!caller) throw unauthorized();
    if (caller.admin !== 1) throw forbidden(msg('user.key_own_only'));
    if (!(await trx.selectFrom('users').select('id').where('id', '=', userId).where('deleted_at', 'is', null).executeTakeFirst())) throw notFound(msg('user.not_found'));
    await trx.updateTable('api_keys').set({ revoked_at: now }).where('user_id', '=', userId).where('revoked_at', 'is', null).execute();
    return issueApiKey(trx, userId, now);
  });
}

async function verifyApiKey(db: Db, userId: string, apiKey: string, languages: Languages): Promise<AuthUser> {
  if (!KEY_PATTERN.test(apiKey)) throw unauthorized();
  // Looked up by the key's hash: only the whole key gives it, so there is nothing left to compare.
  const row = await db
    .selectFrom('api_keys')
    .innerJoin('users', 'users.id', 'api_keys.user_id')
    .select([
      'users.id',
      'users.username',
      'users.admin',
      'users.moderator',
      'users.language',
      'users.messages',
      'users.show_following',
      'users.show_followers',
      'users.banned_at',
    ])
    .where('api_keys.user_id', '=', userId)
    .where('api_keys.key_hash', '=', hashKey(apiKey))
    .where('api_keys.revoked_at', 'is', null)
    // Deleting an account revokes its keys too; this holds for a request that was under way when it did.
    .where('users.deleted_at', 'is', null)
    .executeTakeFirst();
  if (!row) throw unauthorized();
  return {
    id: row.id,
    username: row.username,
    admin: row.admin === 1,
    moderator: row.moderator === 1,
    language: languageOf(languages, row.language),
    messages: row.messages === 1,
    showFollowing: row.show_following === 1,
    showFollowers: row.show_followers === 1,
    banned: row.banned_at !== null,
  };
}

/**
 * Credentials may come from the body/form fields (userId + apiKey) or from headers
 * (Authorization: Bearer <apiKey> and X-User-Id: <userId>).
 *
 * A gateway that signs in to the server with its own Authorization header (Google's API Gateway
 * does) moves the client's to X-Forwarded-Authorization, so that one is read first.
 */
function credentialsFrom(
  req: FastifyRequest,
  fields: { userId?: unknown; apiKey?: unknown } = {},
): { userId?: string; apiKey?: string } {
  const forwarded = req.headers['x-forwarded-authorization'];
  const header = typeof forwarded === 'string' ? forwarded : req.headers.authorization;
  const headerUser = req.headers['x-user-id'];
  return {
    userId: typeof fields.userId === 'string' ? fields.userId : typeof headerUser === 'string' ? headerUser : undefined,
    apiKey: typeof fields.apiKey === 'string' ? fields.apiKey : header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined,
  };
}

/**
 * The user whose credentials the request carries; 401 if they aren't a user's. From here on the
 * request is answered in the user's language, whatever its Accept-Language header asked for.
 */
export async function authenticate(
  db: Db,
  req: FastifyRequest,
  fields: { userId?: unknown; apiKey?: unknown } = {},
): Promise<AuthUser> {
  const { userId, apiKey } = credentialsFrom(req, fields);
  if (!userId || !apiKey) throw unauthorized(msg('auth.required'));
  const user = await verifyApiKey(db, userId, apiKey, req.server.languages);
  req.language = user.language;
  if (req.audit) req.audit.userId = user.id;
  return user;
}

/**
 * For an endpoint anyone may call, which does more for some users: the user the request names, held
 * to their key as anywhere else (see authenticate), or null for a request that names none.
 *
 * It goes by the user id, not the key: behind a gateway that signs in with its own Authorization
 * header, every request carries one, and it says nothing about who the client is.
 */
export async function authenticateIfNamed(
  db: Db,
  req: FastifyRequest,
  fields: { userId?: unknown; apiKey?: unknown } = {},
): Promise<AuthUser | null> {
  if (!credentialsFrom(req, fields).userId) return null;
  return authenticate(db, req, fields);
}
