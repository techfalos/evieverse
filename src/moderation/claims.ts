import { randomUUID } from 'node:crypto';
import type { AuthUser } from '../auth/apiKey.types.js';
import { ignoreConflicts, isUniqueViolation, type Db } from '../db/index.js';
import type { AppDeps } from '../deps.types.js';
import { badRequest, conflict, forbidden, tooManyRequests } from '../http/errors.js';
import { notify } from '../inbox.js';
import { msg } from '../language.js';
import { DAY, HOUR, iso } from '../time.js';
import type { Claim, EndedClaim } from './claims.types.js';
import { moderatesServer, refuseBanned } from './policy.js';

/**
 * Claiming a hashtag, to moderate it. Where publishers choose their posts' hashtags
 * (TAGGING_MODE=user), hashtags come to be as posts use them, and no admin was there to appoint a
 * moderator for each. So a user can claim one that has no moderator (POST /tags/:tag/claim).
 *
 * A claim isn't granted at once. It waits for `tagging.claimReviewHours`, and the server's admins
 * and server moderators are told of it, each by a notice in their inbox (`tag_claimed`), so that
 * any of them can stop it: refusing the claim (DELETE /tags/:tag/claim) ends it, and its user is
 * told. A claim nobody refused is granted by the compactor's first run after the wait
 * (see grantClaim): its user becomes a moderator of the hashtag, as one an admin appointed is (a
 * row of `tag_moderators`), and is told so. An admin can end that like any moderator's time
 * (DELETE /tags/:tag/moderators/:userId), and it ends by itself if they then leave the hashtag
 * unmoderated for long enough (src/moderation/activity.ts), which is what keeps a claim from
 * holding a hashtag for good.
 *
 * A hashtag has one claim at a time, and only while it has no moderator: the first to moderate a
 * hashtag claims it, and whoever joins them is appointed, by them or by an admin (PUT
 * /tags/:tag/moderators/:userId), which ends a claim that waits (see closeClaim). Admins and server moderators
 * moderate every hashtag already, and claim none. A row of `tag_claims` is a claim that waits;
 * nothing is kept of one that was granted, refused or withdrawn.
 *
 * Where the server chooses the hashtags (TAGGING_MODE=server) there are none to claim: its
 * operator chose them, and an admin appoints their moderators. A claim made before the server was
 * set so is still granted, unless it is refused.
 */

type ClaimDeps = Pick<AppDeps, 'db' | 'config' | 'hot' | 'content' | 'now'>;
type Log = { info: (o: object, msg?: string) => void; warn: (o: object, msg?: string) => void };

/** The log of a compactor that was given none: what is said to it goes nowhere. */
const NO_LOG: Log = { info: () => {}, warn: () => {} };

/** The claims that wait, each with who made it, for the routes to narrow down. */
const claims = (db: Db) =>
  db
    .selectFrom('tag_claims')
    .innerJoin('users', 'users.id', 'tag_claims.user_id')
    .select(['tag_claims.tag', 'tag_claims.user_id', 'users.username', 'tag_claims.created_at', 'tag_claims.review_until']);

/** The claim to `tag` that waits, if there is one. */
export const pendingClaim = (db: Db, tag: string): Promise<Claim | undefined> => claims(db).where('tag_claims.tag', '=', tag).executeTakeFirst();

/** A claim that waits, as responses give it: the hashtag, who claims it, since when, and until when it can be refused (`reviewUntil`), after which it is granted. */
export const claimItem = (claim: Claim) => ({
  tag: claim.tag,
  userId: claim.user_id,
  username: claim.username,
  claimedAt: iso(claim.created_at),
  reviewUntil: iso(claim.review_until),
});

/**
 * Tells the server's admins and server moderators of a claim, each by a notice in their inbox
 * that says who claims which hashtag, and until when the claim can be refused. It reports a claim
 * that is made, so it never fails the request: a notice that can't be left is logged.
 */
async function tellStaff({ db, now = Date.now }: ClaimDeps, claim: Claim, log: Log): Promise<void> {
  try {
    const staff = await db
      .selectFrom('users')
      .select('id')
      .where((eb) => eb.or([eb('admin', '=', 1), eb('moderator', '=', 1)]))
      .where('deleted_at', 'is', null)
      .execute();
    if (!staff.length) {
      log.warn({ tag: claim.tag, userId: claim.user_id }, 'a hashtag was claimed, and this server has no admin or server moderator to tell: nobody can refuse the claim');
      return;
    }
    const body = JSON.stringify({ userId: claim.user_id, username: claim.username, reviewUntil: iso(claim.review_until) });
    const at = now();
    await db
      .insertInto('inbox')
      .values(staff.map(({ id }) => ({ id: randomUUID(), user_id: id, kind: 'tag_claimed', sender_id: null, content_id: null, tag: claim.tag, body, created_at: at, read_at: null })))
      .execute();
  } catch (err) {
    log.warn({ err, tag: claim.tag, userId: claim.user_id }, 'could not tell the admins and server moderators of a claim to a hashtag in their inboxes');
  }
}

/**
 * Claims `tag` for `user`, and tells the admins and server moderators. Returns the claim, and
 * whether it was the user's already: claiming a hashtag again changes nothing, and tells nobody.
 *
 * Refused: 403 for a user who is banned, 400 where the server chooses the hashtags, 409 for an
 * admin or a server moderator (who moderate it already), for a hashtag that has a moderator, and
 * for one another user's claim waits on, and 429 past the claims a user can make in a day
 * (`tagging.claimsPerDay`), which only a claim that is made counts towards.
 */
export async function claimTag(deps: ClaimDeps, user: AuthUser, tag: string, log: Log): Promise<{ claim: Claim; already: boolean }> {
  const { db, config, hot, now = Date.now } = deps;
  refuseBanned(user);
  if (config.tagging.mode !== 'user') throw badRequest(msg('claim.off'));
  if (moderatesServer(user)) throw conflict(msg('claim.staff'));
  if (await db.selectFrom('tag_moderators').select('tag').where('tag', '=', tag).limit(1).executeTakeFirst()) throw conflict(msg('claim.has_moderators', { tag }));

  /** The claim that is there, if it is this user's; 409 if it is another's. */
  const theirs = (found: Claim | undefined) => {
    if (found && found.user_id !== user.id) throw conflict(msg('claim.taken', { tag }));
    return found;
  };
  const found = theirs(await pendingClaim(db, tag));
  if (found) return { claim: found, already: true };

  if (config.tagging.claimsPerDay > 0) {
    const { count, ttlMs } = await hot.incr(`claims:${user.id}`, DAY);
    if (count > config.tagging.claimsPerDay) {
      throw tooManyRequests(msg('claim.rate_limited', { count: Math.max(1, Math.ceil(ttlMs / HOUR)) }), Math.max(1, Math.ceil(ttlMs / 1000)));
    }
  }
  const at = now();
  const claim: Claim = { tag, user_id: user.id, username: user.username, created_at: at, review_until: at + config.tagging.claimReviewHours * HOUR };
  try {
    await db.insertInto('tag_claims').values({ tag, user_id: user.id, created_at: at, review_until: claim.review_until }).execute();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Another request claimed it meanwhile: this user's own, sent twice, or another user's.
    const first = theirs(await pendingClaim(db, tag));
    // Or it was there and is gone again, which the next request finds out more about.
    if (!first) throw conflict(msg('claim.taken', { tag }));
    return { claim: first, already: true };
  }
  log.info({ tag, userId: user.id, reviewUntil: iso(claim.review_until) }, 'a hashtag was claimed');
  await tellStaff(deps, claim, log);
  return { claim, already: false };
}

/**
 * Ends the claim to `tag` that waits, for `user`: an admin or a server moderator refuses it,
 * which its user is told of, or its own user withdraws it. 403 for anyone else. A hashtag nobody
 * claims is left as it is, whoever asks.
 */
export async function endClaim(deps: ClaimDeps, user: AuthUser, tag: string, log: Log): Promise<EndedClaim> {
  const { db } = deps;
  const claim = await db.selectFrom('tag_claims').select('user_id').where('tag', '=', tag).executeTakeFirst();
  if (!claim) return { wasClaimed: false, refused: false };
  const own = claim.user_id === user.id;
  if (!own && !moderatesServer(user)) throw forbidden(msg('claim.not_allowed'));
  // That user's claim, and not one made since this one was read.
  const ended = Number((await db.deleteFrom('tag_claims').where('tag', '=', tag).where('user_id', '=', claim.user_id).executeTakeFirst()).numDeletedRows) > 0;
  if (!ended) return { wasClaimed: false, refused: false };
  if (own) return { wasClaimed: true, userId: claim.user_id, refused: false };
  log.info({ tag, userId: claim.user_id, moderator: user.id }, 'refused a claim to a hashtag');
  await notify(deps, { userId: claim.user_id, kind: 'tag_claim_refused', tag, by: user.id }, log);
  return { wasClaimed: true, userId: claim.user_id, refused: true };
}

/**
 * Ends the claim to `tag` that waits, if there is one, as `by` makes `userId` a moderator of the
 * hashtag: a hashtag that has a moderator isn't claimed, and whoever else is to moderate it is
 * appointed by its moderators, or by an admin. If the claim is the appointed user's own, they have
 * what it asked for; another user is told theirs was refused.
 */
export async function closeClaim(deps: ClaimDeps, tag: string, userId: string, by: AuthUser, log: Log): Promise<void> {
  const { db } = deps;
  const claim = await db.selectFrom('tag_claims').select('user_id').where('tag', '=', tag).executeTakeFirst();
  if (!claim) return;
  // That user's claim, and not one made since this one was read.
  const ended = Number((await db.deleteFrom('tag_claims').where('tag', '=', tag).where('user_id', '=', claim.user_id).executeTakeFirst()).numDeletedRows) > 0;
  if (!ended || claim.user_id === userId) return;
  log.info({ tag, userId: claim.user_id, appointed: userId, by: by.id }, 'a claim to a hashtag ended: the hashtag was given a moderator');
  await notify(deps, { userId: claim.user_id, kind: 'tag_claim_refused', tag, by: by.id }, log);
}

/** The claims nobody refused by `until`, which are the compactor's to grant, longest due first: at most `limit` of them. */
export const dueClaims = (db: Db, until: number, limit: number) =>
  db.selectFrom('tag_claims').select(['tag', 'user_id']).where('review_until', '<=', until).orderBy('review_until').orderBy('tag').limit(limit).execute();

/**
 * Grants a claim whose wait is over, for the compactor: the claim's row goes, and its user becomes
 * a moderator of the hashtag, in one commit, and is told. A user who was banned while the claim
 * waited isn't made one: the claim ends as one that was refused, which they are told instead.
 * Nothing is done for a claim that is gone, which was refused or withdrawn since it was read.
 */
export async function grantClaim(deps: Pick<AppDeps, 'db' | 'config' | 'content' | 'now'>, claim: { tag: string; user_id: string }, log: Log = NO_LOG): Promise<void> {
  const { db, config, now = Date.now } = deps;
  const { tag, user_id: userId } = claim;
  const granted = await db.transaction().execute(async (trx) => {
    if (Number((await trx.deleteFrom('tag_claims').where('tag', '=', tag).where('user_id', '=', userId).executeTakeFirst()).numDeletedRows) === 0) return null;
    const user = await trx.selectFrom('users').select('banned_at').where('id', '=', userId).where('deleted_at', 'is', null).executeTakeFirst();
    // An account that was closed has no claim left (see retire); one that is there and banned has.
    if (!user || user.banned_at !== null) return false;
    // They may moderate it already: they were appointed as the claim was being granted.
    const at = now();
    // The time they have to do something as its moderator starts now (src/moderation/activity.ts).
    await ignoreConflicts(trx.insertInto('tag_moderators').values({ tag, user_id: userId, created_at: at, acted_at: at }), config.db.dialect).execute();
    return true;
  });
  if (granted === null) return;
  log.info({ tag, userId }, granted ? 'granted a claim to a hashtag: its user moderates it now' : 'a claim to a hashtag ended without a grant: its user is banned');
  // Nobody did this to them: `by` is nobody's id.
  await notify(deps, { userId, kind: granted ? 'tag_claim_granted' : 'tag_claim_refused', tag, by: '' }, log);
}
