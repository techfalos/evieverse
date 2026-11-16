import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, issueApiKey } from '../auth/apiKey.js';
import { ChallengeFields, Challenges } from '../challenge/challenges.js';
import { isUniqueViolation } from '../db/index.js';
import type { AppDeps } from '../deps.js';
import { badRequest, conflict, forbidden, notFound } from '../http/errors.js';

const Username = z.string().trim().min(1).max(64);
const PublisherUrl = z.string().url().max(2048);

const RegisterBody = z.object({
  /** Unique display name; users are identified by the returned userId (UUID). */
  username: Username,
  publisherUrl: PublisherUrl.optional(),
  ...ChallengeFields,
});

const UpdateBody = z.object({
  userId: z.string().optional(),
  apiKey: z.string().optional(),
  username: Username.optional(),
  publisherUrl: PublisherUrl.optional(),
});

const Params = z.object({ userId: z.string().uuid() });

function usernameTaken(err: unknown): never {
  if (isUniqueViolation(err)) throw conflict('username is already taken');
  throw err;
}

export function registerRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, config, publishers, now = Date.now } = deps;
  const challenges = new Challenges(deps);
  /** Feeds read credits from Redis; the compactor re-syncs changed users if this write fails. */
  const putPublisher = (p: { userId: string; username: string; publisherUrl: string | null }) =>
    publishers.put(p).catch((err) => app.log.warn({ err, userId: p.userId }, 'could not write the publisher credit to Redis'));

  /**
   * Creates a user, once the same request, sent again, solves the challenge the first one was answered
   * with. A name already taken is refused before that, so nobody solves a challenge for nothing.
   */
  app.post(
    '/register',
    { config: { rateLimit: { max: config.registerRateLimitPerHour, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const body = RegisterBody.parse(req.body ?? {});
      const taken = await db.selectFrom('users').select('id').where('username', '=', body.username).executeTakeFirst();
      if (taken) throw conflict('username is already taken');
      await challenges.register(body);
      const userId = randomUUID();
      const ts = now();
      await db
        .insertInto('users')
        .values({ id: userId, username: body.username, publisher_url: body.publisherUrl ?? null, created_at: ts, updated_at: ts })
        .execute()
        .catch(usernameTaken);
      await putPublisher({ userId, username: body.username, publisherUrl: body.publisherUrl ?? null });
      const apiKey = await issueApiKey(db, userId, ts);
      return reply.status(201).send({
        userId,
        username: body.username,
        publisherUrl: body.publisherUrl ?? null,
        apiKey,
        note: 'Store this apiKey now; it cannot be retrieved again.',
      });
    },
  );

  app.get('/users/:userId', async (req) => {
    const { userId } = Params.parse(req.params);
    const user = await db
      .selectFrom('users')
      .select(['id', 'username', 'publisher_url', 'created_at'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user) throw notFound('user not found');
    return {
      userId: user.id,
      username: user.username,
      publisherUrl: user.publisher_url,
      createdAt: new Date(user.created_at).toISOString(),
    };
  });

  /** Updates the caller's own profile. Feeds show the new credit at once: they read it from Redis. */
  app.patch('/users/:userId', async (req) => {
    const { userId } = Params.parse(req.params);
    const body = UpdateBody.parse(req.body ?? {});
    const user = await authenticate(db, req, body);
    if (user.id !== userId) throw forbidden('you can only update your own profile');
    if (body.username === undefined && body.publisherUrl === undefined) {
      throw badRequest('nothing to update: provide username or publisherUrl');
    }
    const changed =
      (body.username !== undefined && body.username !== user.username) ||
      (body.publisherUrl !== undefined && body.publisherUrl !== user.publisherUrl);
    if (changed) {
      await db
        .updateTable('users')
        .set({
          ...(body.username !== undefined ? { username: body.username } : {}),
          ...(body.publisherUrl !== undefined ? { publisher_url: body.publisherUrl } : {}),
          updated_at: now(),
        })
        .where('id', '=', userId)
        .execute()
        .catch(usernameTaken);
    }
    const updated = await db.selectFrom('users').select(['id', 'username', 'publisher_url']).where('id', '=', userId).executeTakeFirstOrThrow();
    if (changed) await putPublisher({ userId: updated.id, username: updated.username, publisherUrl: updated.publisher_url });
    return { userId: updated.id, username: updated.username, publisherUrl: updated.publisher_url };
  });
}
