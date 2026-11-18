import type { FastifyRequest } from 'fastify';
import { authenticate } from './auth/apiKey.js';
import type { AuthUser } from './auth/apiKey.types.js';
import type { Db } from './db/index.js';
import { HttpError } from './http/errors.js';

/**
 * Blocks: a user blocks whom they choose (the table `user_blocks`), and ends the block, by the
 * routes in routes/inbox.ts. What a block does is in the routes it changes, each of which asks
 * here who blocks whom:
 *
 *   messages   none goes between the two, either way (routes/inbox.ts);
 *   follows    neither follows the other: the block ends the follows there were, either way, and
 *              none is made while it stands (routes/inbox.ts, routes/follow.ts);
 *   comments   the blocked user comments on none of the blocker's posts, and edits none of the
 *              comments they made there (routes/comments.ts);
 *   mentions   neither is told that the other mentioned them, in a post or in a comment: the text
 *              mentions them all the same (mentions.ts);
 *   reading    what the blocked user wrote is left out of what the blocker is listed: the
 *              following feed, and a post's comments (routes/feed.ts, routes/comments.ts).
 *
 * Reading is the one that goes by who asks: it applies to a request that carries the blocker's
 * credentials, and to no other, so nothing a request without them is answered says whom a user
 * blocks. What is read by its id is given as it is: a post, a comment, a profile.
 *
 * Ending a block ends all of it from then on, and brings no follow back.
 */

/** Whether `userId` blocks `otherId`: one lookup by the primary key. */
export async function blocks(db: Db, userId: string, otherId: string): Promise<boolean> {
  return (await db.selectFrom('user_blocks').select('user_id').where('user_id', '=', userId).where('blocked_id', '=', otherId).executeTakeFirst()) !== undefined;
}

/**
 * Which of two users blocks the other: `mine` if `userId` blocks `otherId`, and `theirs` if
 * `otherId` blocks `userId`. One query, of two lookups by the primary key.
 */
export async function blocksBetween(db: Db, userId: string, otherId: string): Promise<{ mine: boolean; theirs: boolean }> {
  const rows = await db
    .selectFrom('user_blocks')
    .select('user_id')
    .where((eb) =>
      eb.or([
        eb.and([eb('user_id', '=', userId), eb('blocked_id', '=', otherId)]),
        eb.and([eb('user_id', '=', otherId), eb('blocked_id', '=', userId)]),
      ]),
    )
    .execute();
  return { mine: rows.some((row) => row.user_id === userId), theirs: rows.some((row) => row.user_id === otherId) };
}

/** Whom of `userIds` the user `userId` blocks: one query, by the primary key, however many they block in all. */
export async function blockedAmong(db: Db, userId: string, userIds: Iterable<string>): Promise<Set<string>> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return new Set();
  const rows = await db.selectFrom('user_blocks').select('blocked_id').where('user_id', '=', userId).where('blocked_id', 'in', ids).execute();
  return new Set(rows.map((row) => row.blocked_id));
}

/**
 * The user a read that needs no key is for, by the credentials in its headers: the one whose
 * blocks it is held to. Null for a request with none, and for one with wrong ones, which is
 * answered like anyone's (as readsHeld answers it): the read is anyone's to make.
 */
export async function readerOf(db: Db, req: FastifyRequest): Promise<AuthUser | null> {
  return authenticate(db, req).catch((err) => {
    if (err instanceof HttpError && err.statusCode === 401) return null;
    throw err;
  });
}
