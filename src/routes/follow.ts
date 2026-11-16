import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/apiKey.js';
import { isUniqueViolation } from '../db/index.js';
import type { AppDeps } from '../deps.js';
import { syncFollowing } from '../follows.js';
import { badRequest, conflict, forbidden, notFound } from '../http/errors.js';
import { decodeListCursor, encodeListCursor } from '../http/listCursor.js';

const Params = z.object({ userId: z.string().uuid() });
const PairParams = z.object({ userId: z.string().uuid(), followeeId: z.string().uuid() });
const Credentials = z.object({ userId: z.string().optional(), apiKey: z.string().optional() });
const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  cursor: z.string().optional(),
});

/** Each list is the user's side of a follow, and the other user's. */
const SIDES = {
  following: { own: 'follows.follower_id', other: 'follows.followee_id' },
  followers: { own: 'follows.followee_id', other: 'follows.follower_id' },
} as const;

const iso = (ms: number) => new Date(ms).toISOString();

export function followRoutes(app: FastifyInstance, { db, config, follows, now = Date.now }: AppDeps) {
  /**
   * Following feeds read whom a user follows from Redis. Every request rewrites it, so repeating one
   * repairs a write that failed; the compactor also re-syncs users whose follows changed.
   */
  const sync = (userId: string) =>
    syncFollowing(db, follows, [userId]).catch((err) => app.log.warn({ err, userId }, 'could not write the follows to Redis'));

  /** The caller, who must be the user named in the path. */
  async function caller(req: FastifyRequest, userId: string) {
    const user = await authenticate(db, req, Credentials.parse(req.body ?? {}));
    if (user.id !== userId) throw forbidden('you can only change whom you follow');
    return user;
  }

  const findFollow = (followerId: string, followeeId: string) =>
    db.selectFrom('follows').select('created_at').where('follower_id', '=', followerId).where('followee_id', '=', followeeId).executeTakeFirst();

  /** Follows another user. Following them again changes nothing. */
  app.put('/users/:userId/following/:followeeId', async (req, reply) => {
    const { userId, followeeId } = PairParams.parse(req.params);
    await caller(req, userId);
    if (followeeId === userId) throw badRequest("you can't follow yourself");
    const followee = await db.selectFrom('users').select('id').where('id', '=', followeeId).executeTakeFirst();
    if (!followee) throw notFound('user not found');

    let followedAt = (await findFollow(userId, followeeId))?.created_at;
    const alreadyFollowing = followedAt !== undefined;
    if (!alreadyFollowing) {
      const ts = now();
      try {
        await db.transaction().execute(async (trx) => {
          // First, so the user's row is locked: their follows take turns, and none gets past the limit.
          await trx.updateTable('users').set({ following_changed_at: ts }).where('id', '=', userId).execute();
          const { n } = await trx
            .selectFrom('follows')
            .select((eb) => eb.fn.countAll().as('n'))
            .where('follower_id', '=', userId)
            .executeTakeFirstOrThrow();
          if (Number(n) >= config.maxFollowing) throw conflict(`you can follow at most ${config.maxFollowing} users`);
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
    const wasFollowing = (await findFollow(userId, followeeId)) !== undefined;
    if (wasFollowing) {
      await db.transaction().execute(async (trx) => {
        // The user's row before the follows row, as when following, so the two can't deadlock.
        await trx.updateTable('users').set({ following_changed_at: now() }).where('id', '=', userId).execute();
        await trx.deleteFrom('follows').where('follower_id', '=', userId).where('followee_id', '=', followeeId).execute();
      });
    }
    await sync(userId);
    return { userId, followeeId, wasFollowing };
  });

  /** Follows are public, like posts: anyone can list whom a user follows, and who follows them. */
  for (const list of ['following', 'followers'] as const) {
    app.get(`/users/:userId/${list}`, async (req) => {
      const { userId } = Params.parse(req.params);
      const q = ListQuery.parse(req.query);
      const after = q.cursor ? decodeListCursor(q.cursor) : undefined;
      const user = await db.selectFrom('users').select('id').where('id', '=', userId).executeTakeFirst();
      if (!user) throw notFound('user not found');

      const { own, other } = SIDES[list];
      let query = db
        .selectFrom('follows')
        .innerJoin('users', 'users.id', other)
        .select(['users.id', 'users.username', 'users.publisher_url', 'follows.created_at'])
        .where(own, '=', userId)
        .orderBy('follows.created_at', 'desc')
        .orderBy(other, 'asc')
        .limit(q.limit + 1);
      if (after) {
        query = query.where((eb) =>
          eb.or([eb('follows.created_at', '<', after.createdAt), eb.and([eb('follows.created_at', '=', after.createdAt), eb(other, '>', after.userId)])]),
        );
      }
      const rows = await query.execute();
      const page = rows.slice(0, q.limit);
      const last = page.at(-1);
      return {
        userId,
        [list]: page.map((r) => ({ userId: r.id, username: r.username, publisherUrl: r.publisher_url, followedAt: iso(r.created_at) })),
        nextCursor: rows.length > q.limit && last ? encodeListCursor(last.created_at, last.id) : null,
      };
    });
  }
}
