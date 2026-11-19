import { randomUUID } from 'node:crypto';
import { MAX_MESSAGE_CHARS, type NoticeKind } from '../../../inbox.js';
import { MIN_TRUST_SCORE, routeOf } from '../../../moderation/trust.js';
import type { TrustContext } from '../../../moderation/trust.types.js';
import { quarantineFile, quarantines } from '../../../quarantine.js';
import { iso } from '../../../time.js';
import type { Found, MatchFacts, Sent } from './report.types.js';

/** The notice an admin is left of an image that matched, by what became of what was sent (src/inbox.ts). */
const KINDS = { refused: 'csam_match_refused', held: 'csam_match_held' } as const satisfies Record<MatchFacts['outcome'], NoticeKind>;
/** The notice an admin is left of a video that matched, which is always refused. */
const VIDEO_KIND = 'csam_video_refused' satisfies NoticeKind;
/** How much of a filename and of a User-Agent header a notice keeps, in characters: enough to tell them by, and little enough that the notice fits an inbox row. */
const MAX_TEXT_CHARS = 160;

/** `text` on one line, without its control characters, and no longer than MAX_TEXT_CHARS. Undefined for none. */
function brief(text: string | null | undefined): string | undefined {
  // By code point, so the cut never splits a character in two.
  const chars = [...(text ?? '').replace(/\p{Cc}+/gu, ' ').trim()];
  if (!chars.length) return undefined;
  return chars.length > MAX_TEXT_CHARS ? `${chars.slice(0, MAX_TEXT_CHARS - 1).join('')}…` : chars.join('');
}

/**
 * Tells the server's admins that an image matched the list, or a picture of a video: who sent
 * it, when and from where, what it was, and which listed hash it is near. That is what a report
 * to the authorities is written from (in the United States, to NCMEC's CyberTipline), which is
 * the operator's to make: the server reports nothing to anyone itself.
 *
 * On a server that has a quarantine (QUARANTINE_SCHEME, src/quarantine.ts) the file is kept
 * there first, as the plugin read it, and what the admins are told names it (`quarantineId`):
 * a report has the file sent with it, and the law may have it kept afterwards. A file that
 * can't be kept is logged as an error, and refused all the same. Without a quarantine nothing
 * of the file is kept.
 *
 * The admins are told twice. The log gets a warning with the facts, whatever else happens. And
 * every admin gets a notice in their inbox (csam_match_refused or csam_match_held, or
 * csam_video_refused for a video: src/inbox.ts), whose body is the facts as JSON. An admin who
 * has an unread notice of the same user and the same listed hash gets no second one, so
 * sending a file over and over doesn't fill their inbox: the log has each time, and the
 * quarantine counts them.
 *
 * It never fails the request, which is refusing the file: a notice that can't be left is logged
 * as an error.
 */
export async function report(post: Sent, { db, config, now, log, client }: Pick<TrustContext, 'db' | 'config' | 'now' | 'log' | 'client'>, found: Found): Promise<void> {
  const { video } = found;
  // An avatar is refused whatever the thresholds are: a profile has no moderation queue to hold it in. So is a video, which is found after its request was answered.
  const outcome = video || post.profile || routeOf(MIN_TRUST_SCORE, config.trust) === 'delete' ? 'refused' : 'held';
  const kind = video ? VIDEO_KIND : KINDS[outcome];
  const what = video ? 'a video' : 'an image';
  const contentId = post.contentId ?? post.commentOn ?? post.created;
  const facts = (username: string): MatchFacts => ({
    userId: post.userId,
    listed: found.listed,
    username,
    at: iso(video?.sentAt ?? now()),
    ip: client?.ip ?? 'unknown',
    userAgent: brief(client?.userAgent),
    sentAs: post.profile ? 'avatar' : post.commentOn !== undefined ? 'comment' : post.contentId !== undefined ? 'update' : 'post',
    contentId,
    filename: brief(found.image.filename),
    mimeType: found.image.mimeType,
    sha256: found.sha256,
    pdq: found.pdq,
    quality: found.quality,
    distance: found.distance,
    frame: found.frame,
    outcome,
    ...(video && { media: 'video' as const, seconds: video.seconds }),
  });

  /** The facts with the item the file is kept as, on a server that keeps it. They are as they were if it can't be kept. */
  const kept = async (match: MatchFacts): Promise<MatchFacts> => {
    if (!quarantines(config)) return match;
    try {
      const quarantineId = await quarantineFile({ db, config, now }, { userId: post.userId, path: await found.image.file(), sha256: found.sha256, mimeType: found.image.mimeType, facts: match });
      return quarantineId === null ? match : { ...match, quarantineId };
    } catch (err) {
      log?.error({ err, match }, `pdq: ${what} matches the list of hashes of known child sexual abuse material, and couldn't be kept in the quarantine: nothing of the file is kept`);
      return match;
    }
  };

  // Their name is left out where it can't be read: the file is kept, and the log told, with their id, whatever the database does.
  const named = async () => db.selectFrom('users').select('username').where('id', '=', post.userId).executeTakeFirst();
  const sender = await named().catch(() => undefined);
  const match = await kept(facts(sender?.username ?? ''));
  try {
    const admins = await db.selectFrom('users').select('id').where('admin', '=', 1).where('deleted_at', 'is', null).execute();
    log?.warn({ match }, `pdq: ${what} matches the list of hashes of known child sexual abuse material; the admins are told in their inboxes`);
    if (!admins.length) {
      log?.error({ match }, 'pdq: this server has no admin to tell of the match: make one (npm run admin)');
      return;
    }
    let body = JSON.stringify(match);
    // What a client sent can't make the notice too long to keep.
    if (body.length > MAX_MESSAGE_CHARS) body = JSON.stringify({ ...match, userAgent: undefined, filename: undefined });
    // How the body of every notice of this user and this listed hash starts.
    const start = `${JSON.stringify({ userId: match.userId, listed: match.listed }).slice(0, -1)},`;
    const told = new Set(
      (
        await db
          .selectFrom('inbox')
          .select('user_id')
          .where('user_id', 'in', admins.map(({ id }) => id))
          .where('kind', 'in', [...Object.values(KINDS), VIDEO_KIND])
          .where('read_at', 'is', null)
          .where('body', 'like', `${start}%`)
          .execute()
      ).map((row) => row.user_id),
    );
    const untold = admins.filter(({ id }) => !told.has(id));
    if (!untold.length) return;
    const at = now();
    await db
      .insertInto('inbox')
      .values(untold.map(({ id }) => ({ id: randomUUID(), user_id: id, kind, sender_id: null, content_id: contentId ?? null, tag: null, body, created_at: at, read_at: null })))
      .execute();
  } catch (err) {
    log?.error({ err, match }, `pdq: ${what} matches the list of hashes of known child sexual abuse material, and the admins couldn't be told in their inboxes`);
  }
}
