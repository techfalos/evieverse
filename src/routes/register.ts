import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, authenticateIfNamed, issueApiKey, reissueApiKey } from '../auth/apiKey.js';
import { ChallengeFields } from '../challenge/challenges.js';
import { isUniqueViolation } from '../db/index.js';
import type { RouteDeps } from '../deps.js';
import { badRequest, conflict, forbidden, notFound } from '../http/errors.js';
import { say } from '../http/language.js';
import { Credentials, Flag } from '../http/schemas.js';
import { msg } from '../language.js';
import { iso } from '../time.js';

const Username = z.string().trim().min(1).max(64);
/** The code of one of the server's languages (GET /languages), in any case. */
const LanguageCode = z.string().trim().min(1).max(35);

/** The credentials are an admin's, who registers a user for someone else; anyone else sends none. */
const RegisterBody = Credentials.extend({
  /** Unique display name; users are identified by the returned userId (UUID). */
  username: Username,
  /** The language the server answers the user in. Omitted: the one this request is answered in. */
  language: LanguageCode.optional(),
  ...ChallengeFields,
});

const UpdateBody = Credentials.extend({
  username: Username.optional(),
  language: LanguageCode.optional(),
  /** Whether the user takes part in messages between users (see routes/inbox.ts). */
  messages: Flag.optional(),
});

const Params = z.object({ userId: z.string().uuid() });

function usernameTaken(err: unknown): never {
  if (isUniqueViolation(err)) throw conflict(msg('user.username_taken'));
  throw err;
}

export function registerRoutes(app: FastifyInstance, { db, config, publishers, challenges, now = Date.now }: RouteDeps) {
  const { languages } = app;

  /** Feeds read credits from Redis; the compactor re-syncs changed users if this write fails. */
  const putPublisher = (p: { userId: string; username: string }) =>
    publishers.put(p).catch((err) => app.log.warn({ err, userId: p.userId }, 'could not write the publisher credit to Redis'));

  /** The server's code for the language a request names; 400, with the ones there are, if it isn't one of them. */
  function chosen(language: string): string {
    const code = languages.find(language);
    if (!code) throw badRequest(msg('language.unknown', { language, available: languages.list().map((l) => l.code).join(', ') }));
    return code;
  }

  /**
   * Creates a user, once the same request, sent again, solves the challenge the first one was answered
   * with. A name already taken is refused before that, so nobody solves a challenge for nothing.
   *
   * An admin registers users without a challenge: a request with an admin's credentials creates the
   * user at once. The challenge tells people from robots, and an admin's key already says who is
   * asking. Any other user's credentials spare the request no challenge, and wrong ones are 401,
   * as anywhere else. The per-IP limit counts an admin's requests like anyone's.
   *
   * The user registers in the language the request names, which can be any of the server's: this
   * request is answered in it, challenge and all, and so is every request the user makes from then
   * on. A request that names none registers in the language it is answered in, which is the one its
   * Accept-Language header asks for, or the server's default; or, sent with credentials, their user's.
   */
  app.post(
    '/register',
    { config: { rateLimit: { max: config.registerRateLimitPerHour, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const body = RegisterBody.parse(req.body ?? {});
      // Before the language the request names, which is the one it is answered in whoever sent it.
      const caller = await authenticateIfNamed(db, req, body);
      if (body.language !== undefined) req.language = chosen(body.language);
      const { language } = req;
      const taken = await db.selectFrom('users').select('id').where('username', '=', body.username).executeTakeFirst();
      if (taken) throw conflict(msg('user.username_taken'));
      if (!caller?.admin) await challenges.register(body);
      const userId = randomUUID();
      const ts = now();
      await db
        .insertInto('users')
        .values({ id: userId, username: body.username, created_at: ts, updated_at: ts, language })
        .execute()
        .catch(usernameTaken);
      await putPublisher({ userId, username: body.username });
      const apiKey = await issueApiKey(db, userId, ts);
      return reply.status(201).send({
        userId,
        username: body.username,
        language,
        apiKey,
        note: say(req, msg('user.api_key_note')),
      });
    },
  );

  /** The hashtags a user moderates. */
  const moderatedBy = async (userId: string) =>
    (await db.selectFrom('tag_moderators').select('tag').where('user_id', '=', userId).execute()).map((r) => r.tag).sort();

  /**
   * A public profile, with the user's roles: whether they're an admin or a server moderator, and the
   * hashtags they moderate. Not whether they take messages from other users: with it, someone
   * refused could tell a block from the setting (see routes/inbox.ts).
   */
  app.get('/users/:userId', async (req) => {
    const { userId } = Params.parse(req.params);
    const user = await db
      .selectFrom('users')
      .select(['id', 'username', 'created_at', 'admin', 'moderator'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user) throw notFound(msg('user.not_found'));
    return {
      userId: user.id,
      username: user.username,
      createdAt: iso(user.created_at),
      admin: user.admin === 1,
      moderator: user.moderator === 1,
      moderates: await moderatedBy(userId),
    };
  });

  /**
   * Whose key the caller's is, with their roles, the language they are answered in and whether they
   * take part in messages between users: what a client checks a key with, and learns what it may do.
   */
  app.get('/whoami', async (req) => {
    const user = await authenticate(db, req, Credentials.parse(req.body ?? {}));
    return {
      userId: user.id,
      username: user.username,
      language: user.language,
      admin: user.admin,
      moderator: user.moderator,
      moderates: await moderatedBy(user.id),
      messages: user.messages,
    };
  });

  /**
   * Updates the caller's own profile: their username, their language, whether they take part in
   * messages between users, or any of them at once. Feeds show the new name at once: they read it
   * from Redis. The new language is the one the server answers the user in from this response on.
   * Neither it nor `messages` is part of their credit, so they leave `updated_at` as it is.
   */
  app.patch('/users/:userId', async (req) => {
    const { userId } = Params.parse(req.params);
    const body = UpdateBody.parse(req.body ?? {});
    const user = await authenticate(db, req, body);
    if (user.id !== userId) throw forbidden(msg('user.update_own_only'));
    if (body.username === undefined && body.language === undefined && body.messages === undefined) throw badRequest(msg('user.nothing_to_update'));
    const username = body.username ?? user.username;
    const language = body.language === undefined ? user.language : chosen(body.language);
    const messages = body.messages ?? user.messages;
    const renamed = username !== user.username;
    // One statement, so a request that changes several things changes them all or, its username taken, none.
    const changes = {
      ...(renamed && { username, updated_at: now() }),
      ...(body.language !== undefined && { language }),
      ...(body.messages !== undefined && { messages: messages ? 1 : 0 }),
    };
    if (Object.keys(changes).length > 0) await db.updateTable('users').set(changes).where('id', '=', userId).execute().catch(usernameTaken);
    if (renamed) await putPublisher({ userId, username });
    req.language = language;
    return { userId, username, language, messages };
  });

  /**
   * Replaces the caller's own API key with a new one, which is the account's only key from then on:
   * the key the request was sent with is revoked, with any other the account had, so a key that
   * leaked stops working here. Like the key of a new account, the new one is returned this once.
   */
  app.post('/users/:userId/key', async (req, reply) => {
    const { userId } = Params.parse(req.params);
    const body = Credentials.parse(req.body ?? {});
    const user = await authenticate(db, req, body);
    if (user.id !== userId) throw forbidden(msg('user.key_own_only'));
    const apiKey = await reissueApiKey(db, config.db.dialect, req, body, now());
    return reply.status(201).send({ userId, apiKey, note: say(req, msg('user.api_key_replaced_note')) });
  });
}
