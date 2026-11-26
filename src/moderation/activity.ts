import type { AppDeps } from '../deps.types.js';

/**
 * A hashtag's moderator stays one by moderating it. One who did nothing as its moderator for
 * `tagging.moderatorInactiveDays` (a year, unless the server says otherwise) is its moderator no
 * more: a hashtag isn't held by someone who left it, and one whose last moderator went this way
 * has none, and can be claimed again (src/moderation/claims.ts).
 *
 * A moderator's row says when they last did something (`tag_moderators.acted_at`): it starts at
 * when they became the hashtag's moderator, and every request they make as one that is more than
 * reading sets it, once the server has done what it asked (see recordAction). That is approving
 * a post under the hashtag or removing the hashtag from one, muting a user on it or ending a
 * mute, adding to its blocked words or taking from them, adding, changing or removing one of its
 * rules, and appointing or removing another of its moderators. A request that found nothing to
 * change counts all the same (approving a post that was approved already): the moderator was
 * there. One that was refused doesn't, and nor does reading: the hashtag's mutes, its blocked
 * words, its log.
 *
 * It is counted by hashtag: what a moderator does on one hashtag says nothing of another they
 * moderate, which they lose on its own.
 *
 * The compactor ends the time of those whose row is that old (compactor/src/activity.rs),
 * and each is told (`tag_moderator_lapsed`). Admins and server moderators
 * moderate every hashtag by their role, with no row to lose; one who has a row too loses the
 * row, and nothing of what the role lets them do.
 */

type Log = { info: (o: object, msg?: string) => void; warn: (o: object, msg?: string) => void };

/**
 * Notes that `userId` just did something as a moderator of `tag`, which is what keeps them one.
 * For a caller with no row for the hashtag (an admin or a server moderator, who needs none) it
 * changes nothing. It reports what a request has already done, so it never fails the request:
 * one that can't be noted is logged, and the moderator is counted from their action before.
 */
export async function recordAction({ db, now = Date.now }: Pick<AppDeps, 'db' | 'now'>, userId: string, tag: string, log: Pick<Log, 'warn'>): Promise<void> {
  const at = now();
  try {
    await db
      .updateTable('tag_moderators')
      .set({ acted_at: at })
      .where('tag', '=', tag)
      .where('user_id', '=', userId)
      // Never back: the clocks of two nodes may differ.
      .where((eb) => eb.or([eb('acted_at', 'is', null), eb('acted_at', '<', at)]))
      .execute();
  } catch (err) {
    log.warn({ err, tag, userId }, "could not note a moderator's action on their hashtag; they are counted from the one before");
  }
}
