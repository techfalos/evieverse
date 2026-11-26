import { randomUUID } from 'node:crypto';
import type { AuthUser } from '../auth/apiKey.types.js';
import { isUniqueViolation } from '../db/index.js';
import type { AppDeps } from '../deps.types.js';
import { badRequest, conflict, forbidden, tooManyRequests } from '../http/errors.js';
import { msg } from '../language.js';
import { DAY, HOUR } from '../time.js';
import type { Claimed } from './claims.types.js';
import { moderatesServer, refuseBanned } from './policy.js';

/**
 * Claiming a hashtag, to moderate it. Where publishers choose their posts' hashtags
 * (TAGGING_MODE=user), hashtags come to be as posts use them, and no admin was there to appoint a
 * moderator for each. So a user can claim one that has no moderator (POST /tags/:tag/claim).
 *
 * A claim is granted at once: the user is a moderator of the hashtag as the request is answered,
 * as one an admin appointed is (a row of `tag_moderators`, which says it was claimed). Nothing
 * waits, and nobody has to agree. The server's admins and server moderators are told of it, each
 * by a notice in their inbox (`tag_claimed`), and any of them can take it back whenever they see
 * fit, as they can end any moderator's time on a hashtag (DELETE /tags/:tag/moderators/:userId).
 * It also ends by itself if the user then leaves the hashtag unmoderated for long enough
 * (src/moderation/activity.ts), which is what keeps a claim from holding a hashtag for good.
 *
 * A user they don't want claiming hashtags is barred from it (PUT /claim-barred/:userId, a flag on
 * the user's row as a ban is): a barred user's claims are refused, and nothing else is. The
 * hashtags they moderate already stay theirs until someone ends that, and an admin or a
 * hashtag's moderators can still appoint them.
 *
 * A hashtag is claimed only while it has no moderator: the first to moderate a hashtag claims it,
 * and whoever joins them is appointed, by them or by an admin (PUT /tags/:tag/moderators/:userId).
 * Admins and server moderators moderate every hashtag already, and claim none.
 *
 * Where the server chooses the hashtags (TAGGING_MODE=server) there are none to claim: its
 * operator chose them, and an admin appoints their moderators.
 */

type ClaimDeps = Pick<AppDeps, 'db' | 'config' | 'hot' | 'now'>;
type Log = { info: (o: object, msg?: string) => void; warn: (o: object, msg?: string) => void };

/**
 * Tells the server's admins and server moderators of a claim, each by a notice in their inbox
 * that says who claimed which hashtag, and how to take it back. It reports a claim that is made,
 * so it never fails the request: a notice that can't be left is logged.
 */
async function tellStaff({ db, now = Date.now }: ClaimDeps, user: AuthUser, tag: string, log: Log): Promise<void> {
  try {
    const staff = await db
      .selectFrom('users')
      .select('id')
      .where((eb) => eb.or([eb('admin', '=', 1), eb('moderator', '=', 1)]))
      .where('deleted_at', 'is', null)
      .execute();
    if (!staff.length) {
      log.warn({ tag, userId: user.id }, 'a hashtag was claimed, and this server has no admin or server moderator to tell: nobody can take the claim back');
      return;
    }
    const body = JSON.stringify({ userId: user.id, username: user.username });
    const at = now();
    await db
      .insertInto('inbox')
      .values(staff.map(({ id }) => ({ id: randomUUID(), user_id: id, kind: 'tag_claimed', sender_id: null, content_id: null, tag, body, created_at: at, read_at: null })))
      .execute();
  } catch (err) {
    log.warn({ err, tag, userId: user.id }, 'could not tell the admins and server moderators of a claim to a hashtag in their inboxes');
  }
}

/**
 * Claims `tag` for `user`, who moderates it from then on, and tells the admins and server
 * moderators. Returns since when they moderate it, and whether they did already: claiming a
 * hashtag one moderates changes nothing, and tells nobody.
 *
 * Refused: 403 for a user who is banned, and for one who is barred from claiming, 400 where the
 * server chooses the hashtags, 409 for an admin or a server moderator (who moderate it already)
 * and for a hashtag that has a moderator, and 429 past the claims a user can make in a day
 * (`tagging.claimsPerDay`), which only a claim that is made counts towards.
 */
export async function claimTag(deps: ClaimDeps, user: AuthUser, tag: string, log: Log): Promise<Claimed> {
  const { db, config, hot, now = Date.now } = deps;
  refuseBanned(user);
  if (config.tagging.mode !== 'user') throw badRequest(msg('claim.off'));
  if (moderatesServer(user)) throw conflict(msg('claim.staff'));
  if (user.claimsBarred) throw forbidden(msg('claim.barred'));

  /** Since when this user moderates the hashtag, if they do; undefined if nobody does, and 409 if only others do. */
  const theirs = async (): Promise<number | undefined> => {
    const moderators = await db.selectFrom('tag_moderators').select(['user_id', 'created_at']).where('tag', '=', tag).execute();
    const own = moderators.find((m) => m.user_id === user.id);
    if (!own && moderators.length) throw conflict(msg('claim.has_moderators', { tag }));
    return own?.created_at;
  };
  const since = await theirs();
  if (since !== undefined) return { since, already: true };

  const counter = `claims:${user.id}`;
  if (config.tagging.claimsPerDay > 0) {
    const { count, ttlMs } = await hot.incr(counter, DAY);
    if (count > config.tagging.claimsPerDay) {
      throw tooManyRequests(msg('claim.rate_limited', { count: Math.max(1, Math.ceil(ttlMs / HOUR)) }), Math.max(1, Math.ceil(ttlMs / 1000)));
    }
  }
  const at = now();
  try {
    // The time they have to do something as its moderator starts now (src/moderation/activity.ts).
    await db.insertInto('tag_moderators').values({ tag, user_id: user.id, created_at: at, acted_at: at, claimed: 1 }).execute();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Another request claimed it meanwhile: this user's own, sent twice, or another user's. Neither is a claim this one made.
    if (config.tagging.claimsPerDay > 0) await hot.bump(counter, -1);
    const first = await theirs();
    // Or it was claimed and is unclaimed again, which the next request finds out more about.
    if (first === undefined) throw conflict(msg('claim.has_moderators', { tag }));
    return { since: first, already: true };
  }
  log.info({ tag, userId: user.id }, 'a hashtag was claimed: its user moderates it now');
  await tellStaff(deps, user, tag, log);
  return { since: at, already: false };
}
