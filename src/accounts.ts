import type { Db } from './db/index.js';
import type { AppDeps } from './deps.js';
import { syncFollowing } from './follows.js';
import { conflict, forbidden, notFound } from './http/errors.js';
import { msg } from './language.js';

/**
 * Deleting an account. A user deletes their own, and an admin any (DELETE /users/:userId).
 *
 * The `users` row can't just be deleted: the user's content references it and cascades, so the
 * rows would go while their entries are still in the feed index and their bytes in the content
 * store, and a feed would show content the database doesn't have. Content is deleted in two steps
 * (see setForDeletion), and so is the account:
 *
 *   1. closeAccount, which the request does. The user is marked deleted (`users.deleted_at`) and
 *      is gone from then on: their keys are revoked, no lookup finds them, they hold no role, and
 *      their follows, blocks, mutes, reports and moderation of hashtags are removed. Their content
 *      is set for deletion, so it is 404 at once, and gone from feeds once the compactor has run.
 *   2. purgeAccounts, which deletes the row once none of their content is left, and what still
 *      cascades goes with it (likes, inbox, keys). The request does it when there is no content to
 *      wait for, and the compactor does it otherwise, after it has deleted the content.
 *
 * What they reposted is in their own index (`reposts`, src/reposts.ts), which following feeds read,
 * and goes the same way: nobody follows them from step 1 on, the compactor's next run drops those
 * entries and deletes their rows (see markGoneReposters), and the account's row waits for that
 * like it waits for content. The hashtags their reposts gave other users' posts stay on the posts,
 * with nobody named as who added them.
 *
 * What an account leaves behind: its comments on other users' posts, which comments' own store has
 * no index by author to find them by, and which are shown with no username from then on; and the
 * messages it sent, which stay in their recipients' inboxes without a sender.
 */

type Log = { warn: (o: object, msg?: string) => void };

/** What setting the content of an account for deletion needs. */
export type SweepDeps = Pick<AppDeps, 'db' | 'now'>;
export type AccountDeps = SweepDeps & Pick<AppDeps, 'follows' | 'publishers'>;

/** How many times deleting an admin's account looks again for an admin to leave in place, when the one it chose stopped being one meanwhile. */
const KEEPER_ATTEMPTS = 3;

/** Users per read of their follows, well within every dialect's limit on parameters. */
const SYNC_BATCH = 500;

type Closed =
  | { kind: 'closed'; at: number; followers: string[] }
  | { kind: 'already'; at: number }
  | { kind: 'gone' }
  /** An admin is being deleted and the admin chosen to stay in place isn't one any more (or there was none). */
  | { kind: 'keeper_gone' }
  | { kind: 'needs_keeper' };

/**
 * The database's part of closing an account, in one transaction. The two rows are locked first,
 * in the order of their ids (as revoking an admin does), so two changes to them take turns:
 * deleting an admin names an admin it leaves in place, and goes through only if that one still is
 * one when the rows are read. The server always has an admin.
 */
function retire(db: Db, userId: string, keeperId: string | null, at: number): Promise<Closed> {
  return db.transaction().execute(async (trx): Promise<Closed> => {
    const ids = keeperId ? [userId, keeperId].sort() : [userId];
    for (const id of ids) await trx.updateTable('users').set((eb) => ({ admin: eb.ref('admin') })).where('id', '=', id).execute();
    const rows = await trx.selectFrom('users').select(['id', 'admin', 'deleted_at']).where('id', 'in', ids).execute();
    const user = rows.find((r) => r.id === userId);
    if (!user) return { kind: 'gone' };
    if (user.deleted_at !== null) return { kind: 'already', at: user.deleted_at };
    if (user.admin === 1) {
      // They became an admin since the caller looked: there is no keeper chosen yet.
      if (keeperId === null) return { kind: 'needs_keeper' };
      const keeper = rows.find((r) => r.id === keeperId);
      if (keeper?.admin !== 1 || keeper.deleted_at !== null) return { kind: 'keeper_gone' };
    }

    const followers = (await trx.selectFrom('follows').select('follower_id').where('followee_id', '=', userId).execute()).map((r) => r.follower_id);
    // The roles go with the account, so no list of admins or moderators names it.
    await trx.updateTable('users').set({ deleted_at: at, admin: 0, moderator: 0 }).where('id', '=', userId).execute();
    await trx.updateTable('api_keys').set({ revoked_at: at }).where('user_id', '=', userId).where('revoked_at', 'is', null).execute();
    await trx.deleteFrom('follows').where((eb) => eb.or([eb('follower_id', '=', userId), eb('followee_id', '=', userId)])).execute();
    await trx.deleteFrom('user_blocks').where((eb) => eb.or([eb('user_id', '=', userId), eb('blocked_id', '=', userId)])).execute();
    await trx.deleteFrom('tag_mutes').where('user_id', '=', userId).execute();
    await trx.deleteFrom('tag_moderators').where('user_id', '=', userId).execute();
    await trx.deleteFrom('reports').where('user_id', '=', userId).execute();
    await trx.deleteFrom('comment_reports').where('user_id', '=', userId).execute();
    // The messages the user sent stay with their recipients, as one from an account that is gone.
    await trx.updateTable('inbox').set({ sender_id: null }).where('sender_id', '=', userId).execute();

    // All of their content, in one statement, whatever the account holds: it is 404 from here on, and the compactor finds it by this.
    await trx.updateTable('content').set({ delete_requested_at: at }).where('user_id', '=', userId).where('delete_requested_at', 'is', null).execute();
    return { kind: 'closed', at, followers };
  });
}

/**
 * Closes `userId`'s account (see above, step 1) for `caller`, who is the user, or an admin, and
 * has been checked to be one of them. Repeating it for an account that is closed but not gone yet
 * (an admin does) finishes what an earlier request left undone. 404 for one that isn't there, 409
 * for the only admin, which is an admin's alone to be rid of once another is in place.
 *
 * Returns when the account was closed, and whether it is gone altogether: the compactor deletes
 * an account that still has content when that content is deleted.
 */
export async function closeAccount(
  deps: AccountDeps,
  userId: string,
  caller: { id: string },
  log: Log,
): Promise<{ deletedAt: number; removed: boolean }> {
  const { db, follows, publishers, now = Date.now } = deps;
  for (let attempt = 0; attempt < KEEPER_ATTEMPTS; attempt++) {
    const user = await db.selectFrom('users').select(['admin', 'deleted_at']).where('id', '=', userId).executeTakeFirst();
    if (!user) throw notFound(msg('user.not_found'));
    let keeperId: string | null = null;
    if (user.admin === 1) {
      // The caller, if it is an admin deleting another account; else (an admin deleting their own) any other.
      keeperId =
        caller.id !== userId
          ? caller.id
          : ((await db.selectFrom('users').select('id').where('admin', '=', 1).where('id', '<>', userId).where('deleted_at', 'is', null).limit(1).executeTakeFirst())?.id ?? null);
      if (keeperId === null) throw conflict(msg('moderation.only_admin'));
    }
    const closed = await retire(db, userId, keeperId, now());
    if (closed.kind === 'gone') throw notFound(msg('user.not_found'));
    if (closed.kind === 'keeper_gone' || closed.kind === 'needs_keeper') {
      // The caller was revoked while this request was under way.
      if (keeperId === caller.id && closed.kind === 'keeper_gone') throw forbidden(msg('moderation.admin_only'));
      continue;
    }

    if (closed.kind === 'already') {
      await sweepContent(deps, userId);
    } else {
      // Redis is a copy of the database: a failure here is logged, and what is left is harmless (a
      // stale credit shows a name where a comment's author was, and a stale list of follows names
      // a user whose posts are all gone) until a `--rebuild` writes them again.
      await publishers.remove(userId).catch((err) => log.warn({ err, userId }, 'could not remove the publisher credit of a deleted account from Redis'));
      const affected = [userId, ...closed.followers];
      for (let i = 0; i < affected.length; i += SYNC_BATCH) {
        await syncFollowing(db, follows, affected.slice(i, i + SYNC_BATCH)).catch((err) => log.warn({ err, userId }, 'could not write the follows of a deleted account to Redis'));
      }
    }
    const removed = (await purgeAccounts(db, [userId])).length > 0;
    return { deletedAt: closed.at, removed };
  }
  throw conflict(msg('moderation.admins_changed'));
}

/**
 * Sets for deletion the content of a deleted account that isn't yet: what a request that was under
 * way when the account closed wrote, or what a request that closed it didn't get to. Nothing new is
 * written by an account whose keys are revoked, so this ends.
 */
export async function sweepContent({ db, now = Date.now }: SweepDeps, userId: string): Promise<void> {
  await db.updateTable('content').set({ delete_requested_at: now() }).where('user_id', '=', userId).where('delete_requested_at', 'is', null).execute();
}

/**
 * Deletes the rows of deleted accounts (all of them, or `userIds`') that have no content left, and
 * nothing they reposted left in their own index, and returns whose. What references a user and
 * doesn't cascade is set to null (who moderated a hashtag's post, who banned a user, who sent a
 * message, who gave a post a hashtag by reposting it).
 *
 * The check is part of the DELETE, not before it: an insert of content for the user that comes
 * between a check and a delete would be cascaded away, with the post's entries still in the index.
 */
export async function purgeAccounts(db: Db, userIds?: string[]): Promise<string[]> {
  let query = db.selectFrom('users').select('id').where('deleted_at', 'is not', null);
  if (userIds) {
    if (!userIds.length) return [];
    query = query.where('id', 'in', userIds);
  }
  const purged: string[] = [];
  for (const { id } of await query.execute()) {
    const res = await db
      .deleteFrom('users')
      .where('id', '=', id)
      .where('deleted_at', 'is not', null)
      .where((eb) => eb.not(eb.exists(eb.selectFrom('content').select('content.id').whereRef('content.user_id', '=', 'users.id'))))
      // Nor a post of someone else's that they reposted, still in their own index: the compactor finds those by this row.
      .where((eb) => eb.not(eb.exists(eb.selectFrom('reposts').select('reposts.content_id').whereRef('reposts.user_id', '=', 'users.id').where('reposts.tag', 'like', '@%'))))
      .executeTakeFirst();
    if (Number(res.numDeletedRows) > 0) purged.push(id);
  }
  return purged;
}
