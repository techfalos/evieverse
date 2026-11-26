import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { closeAccount } from '../accounts.js';
import { authenticate, authenticateIfNamed, issueApiKey, reissueApiKey, reissueApiKeyFor } from '../auth/apiKey.js';
import { ChallengeFields } from '../challenge/challenges.js';
import { isUniqueViolation } from '../db/index.js';
import type { RouteDeps } from '../deps.types.js';
import { badRequest, conflict, forbidden, notFound } from '../http/errors.js';
import { say } from '../http/language.js';
import { Credentials, Flag } from '../http/schemas.js';
import { msg } from '../language.js';
import { moderateProfile } from '../moderation/policy.js';
import { LinkUrl } from '../posts.js';
import { MAX_BIO_CHARS, MAX_PROFILE_LINKS, pinnedPosts, profileOf, shownProfile, storedLinks } from '../profile.js';
import { foldUsername } from '../search/keywords.js';
import { iso } from '../time.js';

/** A username as a request gives it, for a new user or a rename: 1 to 64 characters once trimmed. Whether it is taken is the database's to say. */
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

/** What PATCH /users/:userId can change of the caller's own profile. A field left out is left as it is. */
const UpdateBody = Credentials.extend({
  username: Username.optional(),
  language: LanguageCode.optional(),
  /** Whether the user takes part in messages between users (see routes/inbox.ts). */
  messages: Flag.optional(),
  /** Whether anyone can list whom the user follows, and who follows them (see routes/follow.ts). */
  showFollowing: Flag.optional(),
  showFollowers: Flag.optional(),
  /**
   * What the user says of themselves on their profile (src/profile.ts), in the format a post's text
   * is in. Null takes it away, and so does an empty string, which is all a form field can send.
   * Not the character no text has, which a database refuses to store.
   */
  bio: z
    .string()
    .trim()
    .max(MAX_BIO_CHARS)
    .refine((bio) => !bio.includes('\0'))
    .nullable()
    .optional(),
  /** Where else the user is found: the links of their profile, all of them, in the order it shows them. Null takes them away, and so does an empty list. */
  links: z.array(LinkUrl).max(MAX_PROFILE_LINKS).nullable().optional(),
});

/** The user a path names (/users/:userId): the one whose profile is read or updated, whose key is replaced, or whose account is deleted. */
const Params = z.object({ userId: z.string().uuid() });

function usernameTaken(err: unknown): never {
  if (isUniqueViolation(err)) throw conflict(msg('user.username_taken'));
  throw err;
}

/**
 * Accounts: registering a user (POST /register), a user's public profile, whose key the caller's
 * is (GET /whoami), and what a user does with their own account: update its profile, replace its
 * API key, delete it. An admin registers users for other people, replaces any user's key and
 * deletes any account.
 */
export function registerRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { db, config, publishers, challenges, trust, now = Date.now } = deps;
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
   * as anywhere else.
   *
   * One address makes `registerRateLimitPerHour` requests an hour, and is refused (429) from then
   * on. Every request counts, the one that is answered with a challenge and an admin's like anyone's.
   *
   * The user registers in the language the request names, which can be any of the server's: this
   * request is answered in it, challenge and all, and so is every request the user makes from then
   * on. A request that names none registers in the language it is answered in, which is the one its
   * Accept-Language header asks for, or the server's default; or, sent with credentials, their user's.
   */
  app.post('/register', { config: { rateLimit: { max: config.registerRateLimitPerHour, timeWindow: '1 hour' } } }, async (req, reply) => {
    const body = RegisterBody.parse(req.body ?? {});
    // Before the language the request names, which is the one it is answered in whoever sent it.
    const caller = await authenticateIfNamed(db, req, body);
    if (body.language !== undefined) req.language = chosen(body.language);
    const { language } = req;
    if (await db.selectFrom('users').select('id').where('username', '=', body.username).executeTakeFirst()) throw conflict(msg('user.username_taken'));
    if (!caller?.admin) await challenges.register(body, language);
    const userId = randomUUID();
    const ts = now();
    await db
      .insertInto('users')
      .values({ id: userId, username: body.username, username_folded: foldUsername(body.username), created_at: ts, updated_at: ts, language })
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
  });

  /** The hashtags a user moderates. */
  const moderatedBy = async (userId: string) =>
    (await db.selectFrom('tag_moderators').select('tag').where('user_id', '=', userId).execute()).map((r) => r.tag).sort();

  /**
   * A public profile: the user's name, when their account was created (`createdAt`), what they say
   * of themselves (`bio`, null for one who says nothing), where else they are found (`links`),
   * where their avatar is read (`avatarUrl`, null for one who has none), and the posts they pinned
   * to it, the one pinned last first (`pinnedContentIds`, without those nobody may read: see
   * pinnedPosts). GET /users/:userId/posts lists their posts (routes/profile.ts).
   *
   * `banned` says whether the user is banned. A banned user's profile says so and shows nothing
   * else they put on it (see shownProfile): no bio, no links, no avatar and no pinned post.
   *
   * With the user's roles: whether they're an admin or a server moderator, and the
   * hashtags they moderate. Not whether they take messages from other users: with it, someone
   * refused could tell a block from the setting (see routes/inbox.ts). Nor whether they show whom
   * they follow or who follows them, which asking for either list answers (see routes/follow.ts).
   */
  app.get('/users/:userId', async (req) => {
    const { userId } = Params.parse(req.params);
    const user = await db
      .selectFrom('users')
      .select(['id', 'username', 'created_at', 'admin', 'moderator', 'bio', 'links', 'avatar_id', 'banned_at'])
      .where('id', '=', userId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!user) throw notFound(msg('user.not_found'));
    return {
      userId: user.id,
      username: user.username,
      createdAt: iso(user.created_at),
      ...shownProfile(user, config.publicBaseUrl),
      pinnedContentIds: user.banned_at === null ? (await pinnedPosts(db, userId)).map((post) => post.id) : [],
      admin: user.admin === 1,
      moderator: user.moderator === 1,
      moderates: await moderatedBy(userId),
    };
  });

  /**
   * Whose key the caller's is, with their roles, the language they are answered in, whether they
   * take part in messages between users, whether they show whom they follow and who follows
   * them, whether they are banned, and whether they are barred from claiming hashtags
   * (`claimsBarred`): what a client checks a key with, and learns what it may do.
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
      showFollowing: user.showFollowing,
      showFollowers: user.showFollowers,
      banned: user.banned,
      claimsBarred: user.claimsBarred,
    };
  });

  /**
   * Updates the caller's own profile: their username, their language, whether they take part in
   * messages between users, whether they show whom they follow, whether they show who follows
   * them, their bio, their links, or any of them at once. Feeds show the new name at once: they
   * read it from Redis. The new language is the one the server answers the user in from this
   * response on. Only the name is part of their credit, so nothing else changes `updated_at`.
   *
   * A bio and links (src/profile.ts) are read by anyone, so they go through the trust plugins
   * first, as a post does (see moderateProfile): the request is refused (422), all of it, if they
   * aren't trusted. A banned user sets neither (403), and can take them away. `links` is all of
   * the profile's links: the ones sent take the place of the ones there were. The same link sent
   * twice is there once. The avatar is a file, and has routes of its own (routes/profile.ts).
   *
   * The answer gives the profile as the user's row has it (see profileOf), to the user whose it
   * is: a banned user is given theirs here, which nobody is shown while they are banned.
   */
  app.patch('/users/:userId', async (req) => {
    const { userId } = Params.parse(req.params);
    const body = UpdateBody.parse(req.body ?? {});
    const user = await authenticate(db, req, body);
    if (user.id !== userId) throw forbidden(msg('user.update_own_only'));
    if ([body.username, body.language, body.messages, body.showFollowing, body.showFollowers, body.bio, body.links].every((value) => value === undefined)) {
      throw badRequest(msg('user.nothing_to_update'));
    }
    // What the request makes of each, where it names it: null for a bio or links that are taken away.
    const bio = body.bio === undefined ? undefined : body.bio || null;
    const links = body.links === undefined ? undefined : [...new Set(body.links ?? [])];
    if (bio || links?.length) {
      if (user.banned) throw forbidden(msg('user.banned_profile'));
      await moderateProfile({ trust, now, log: req.log, client: { ip: req.ip, userAgent: req.headers['user-agent'] ?? null } }, { userId, bio, links });
    }
    const username = body.username ?? user.username;
    const language = body.language === undefined ? user.language : chosen(body.language);
    const messages = body.messages ?? user.messages;
    const showFollowing = body.showFollowing ?? user.showFollowing;
    const showFollowers = body.showFollowers ?? user.showFollowers;
    const renamed = username !== user.username;
    // One statement, so a request that changes several things changes them all or, its username taken, none.
    const changes = {
      // With the name as a search compares it (GET /search), which is found by the new one from here on.
      ...(renamed && { username, username_folded: foldUsername(username), updated_at: now() }),
      ...(body.language !== undefined && { language }),
      ...(body.messages !== undefined && { messages: messages ? 1 : 0 }),
      ...(body.showFollowing !== undefined && { show_following: showFollowing ? 1 : 0 }),
      ...(body.showFollowers !== undefined && { show_followers: showFollowers ? 1 : 0 }),
      ...(bio !== undefined && { bio }),
      ...(links !== undefined && { links: storedLinks(links) }),
    };
    if (Object.keys(changes).length > 0) await db.updateTable('users').set(changes).where('id', '=', userId).execute().catch(usernameTaken);
    if (renamed) await putPublisher({ userId, username });
    req.language = language;
    // The profile as the row now has it: what this request set of it, and what it left as it was.
    const profile = await db.selectFrom('users').select(['id', 'bio', 'links', 'avatar_id']).where('id', '=', userId).where('deleted_at', 'is', null).executeTakeFirst();
    // Deleted while this request was under way.
    if (!profile) throw notFound(msg('user.not_found'));
    return { userId, username, language, messages, showFollowing, showFollowers, ...profileOf(profile, config.publicBaseUrl) };
  });

  /**
   * Replaces an account's API key with a new one, which is its only key from then on: the caller's
   * own, or any user's for an admin, whether that user is an admin or not.
   *
   * A user's own: the key the request was sent with is revoked, with any other the account had, so
   * a key that leaked stops working here. Like the key of a new account, the new one is returned
   * this once.
   *
   * Another user's, by an admin (see reissueApiKeyFor): every key that user had is revoked, and the
   * new one is returned to the admin, this once, to pass on. That is the way back for a user who
   * lost their key, and the way to shut out whoever else holds it. The admin's own key is untouched.
   */
  app.post('/users/:userId/key', async (req, reply) => {
    const { userId } = Params.parse(req.params);
    const body = Credentials.parse(req.body ?? {});
    const user = await authenticate(db, req, body);
    const own = user.id === userId;
    if (!own && !user.admin) throw forbidden(msg('user.key_own_only'));
    const { dialect } = config.db;
    const apiKey = own ? await reissueApiKey(db, dialect, req, body, now()) : await reissueApiKeyFor(db, dialect, req, userId, body, now());
    if (!own) req.log.info({ userId, by: user.id }, "replaced a user's API key");
    return reply.status(201).send({ userId, apiKey, note: say(req, msg(own ? 'user.api_key_replaced_note' : 'user.api_key_passed_on_note')) });
  });

  /**
   * Deletes an account (see src/accounts.ts): the caller's own, or any for an admin. The account is
   * gone at once, as far as anyone can tell: its keys stop working, and its posts are 404 and leave
   * the feeds. It is `200` and `status: "deleted"` when nothing of it is left, and `202` with
   * `status: "pending_deletion"` while the compactor deletes its posts, after which it deletes
   * the account. Repeating it, as an admin, for an account that is on its way out gives the same answer.
   * The only admin's account isn't deleted (409): make another user an admin first.
   */
  app.delete('/users/:userId', async (req, reply) => {
    const { userId } = Params.parse(req.params);
    const user = await authenticate(db, req, Credentials.parse(req.body ?? {}));
    if (user.id !== userId && !user.admin) throw forbidden(msg('user.delete_own_only'));
    const { deletedAt, removed } = await closeAccount(deps, userId, user, req.log);
    req.log.info({ userId, by: user.id, removed }, 'deleted an account');
    if (removed) return reply.status(200).send({ userId, status: 'deleted' });
    return reply.status(202).send({ userId, status: 'pending_deletion', requestedAt: iso(deletedAt) });
  });
}
