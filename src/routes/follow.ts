import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/apiKey.js';
import { isUniqueViolation, lockUser } from '../db/index.js';
import type { AppDeps } from '../deps.js';
import { requireShownFollows, syncFollowing } from '../follows.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../http/errors.js';
import { listPage, listQuery } from '../http/listCursor.js';
import { Credentials } from '../http/schemas.js';
import { msg } from '../language.js';
import { iso } from '../time.js';

const Params = z.object({ userId: z.string().uuid() });
const PairParams = z.object({ userId: z.string().uuid(), followeeId: z.string().uuid() });

/** Each list is the user's side of a follow, and the other user's. */
const SIDES = {
  following: { own: 'follows.follower_id', other: 'follows.followee_id' },
  followers: { own: 'follows.followee_id', other: 'follows.follower_id' },
} as const;

export function followRoutes(app: FastifyInstance, { db, config, follows, now = Date.now }: AppDeps) {
  /**
   * Following feeds read whom a user follows from Redis. Every request rewrites it, so repeating one
   * repairs a write that failed. The compactor also re-syncs users who followed someone since its last
   * run, so a follow whose write fails still succeeds. An unfollow leaves no row for it to find them
   * by, so one whose write fails says so (`unfollowing`).
   */
  const sync = (userId: string, unfollowing = false) =>
    syncFollowing(db, follows, [userId]).catch((err) => {
      app.log.warn({ err, userId }, 'could not write the follows to Redis');
      if (unfollowing) throw new HttpError(503, msg('follow.unfollowed_feed_not_updated'));
    });

  /** The caller, who must be the user named in the path. */
  async function caller(req: FastifyRequest, userId: string) {
    const user = await authenticate(db, req, Credentials.parse(req.body ?? {}));
    if (user.id !== userId) throw forbidden(msg('follow.own_only'));
    return user;
  }

  const findFollow = (followerId: string, followeeId: string) =>
    db.selectFrom('follows').select('created_at').where('follower_id', '=', followerId).where('followee_id', '=', followeeId).executeTakeFirst();

  /** Follows another user. Following them again changes nothing. */
  app.put('/users/:userId/following/:followeeId', async (req, reply) => {
    const { userId, followeeId } = PairParams.parse(req.params);
    await caller(req, userId);
    if (followeeId === userId) throw badRequest(msg('follow.yourself'));
    const followee = await db.selectFrom('users').select('id').where('id', '=', followeeId).where('deleted_at', 'is', null).executeTakeFirst();
    if (!followee) throw notFound(msg('user.not_found'));

    let followedAt = (await findFollow(userId, followeeId))?.created_at;
    const alreadyFollowing = followedAt !== undefined;
    if (!alreadyFollowing) {
      const ts = now();
      try {
        await db.transaction().execute(async (trx) => {
          // First: the user's follows then take turns, and none gets past the limit.
          await lockUser(trx, config.db.dialect, userId);
          const { n } = await trx
            .selectFrom('follows')
            .select((eb) => eb.fn.countAll().as('n'))
            .where('follower_id', '=', userId)
            .executeTakeFirstOrThrow();
          if (Number(n) >= config.maxFollowing) throw conflict(msg('follow.limit', { max: config.maxFollowing }));
          await trx.insertInto('follows').values({ follower_id: userId, followee_id: followeeId, created_at: ts }).execute();
        });
        followedAt = ts;
      } catch (err) {
        // A concurrent request followed them first; the transaction rolled back cleanly.
        if (!isUniqueViolation(err)) throw err;
        followedAt = (await findFollow(userId, followeeId))?.created_at ?? ts;
      }
    }
    await sync(userId);
    return reply.status(alreadyFollowing ? 200 : 201).send({ userId, followeeId, followedAt: iso(followedAt!), alreadyFollowing });
  });

  /** Stops following a user. Unfollowing someone not followed changes nothing. */
  app.delete('/users/:userId/following/:followeeId', async (req) => {
    const { userId, followeeId } = PairParams.parse(req.params);
    await caller(req, userId);
    const removed = await db.deleteFrom('follows').where('follower_id', '=', userId).where('followee_id', '=', followeeId).executeTakeFirst();
    await sync(userId, true);
    return { userId, followeeId, wasFollowing: Number(removed.numDeletedRows) === 1 };
  });

  /**
   * Whom a user follows, and who follows them. Each list is hidden unless its user shows it, which
   * they choose for each on its own (see requireShownFollows).
   *
   * A list goes by its own user's setting alone: one who shows who follows them shows those users,
   * whether or not they in turn show whom they follow.
   */
  for (const list of ['following', 'followers'] as const) {
    app.get(`/users/:userId/${list}`, async (req) => {
      const { userId } = Params.parse(req.params);
      const page = listQuery(req.query);
      await requireShownFollows(db, req, userId, list);

      const { own, other } = SIDES[list];
      const query = db
        .selectFrom('follows')
        .innerJoin('users', 'users.id', other)
        .select(['users.id', 'users.username', 'follows.created_at'])
        .where(own, '=', userId);
      const { rows, nextCursor } = await listPage(query, { createdAt: 'follows.created_at', userId: other }, page);
      return {
        userId,
        [list]: rows.map((r) => ({ userId: r.id, username: r.username, followedAt: iso(r.created_at) })),
        nextCursor,
      };
    });
  }
}
