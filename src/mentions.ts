import { randomUUID } from 'node:crypto';
import type { Db } from './db/index.js';
import type { AppDeps } from './deps.types.js';
import { mentionable, mentionsIn } from './format.js';
import type { Mention, Mentioning } from './mentions.types.js';

/**
 * Mentions: a user is mentioned by `@` and their name, in a post's text or caption, or in a
 * comment's text. A mention does two things. It tells the user, by a notice in their inbox, once
 * the text is published; and it is shown as a link to their profile.
 *
 * A username is a display name: any characters, spaces among them, and its user can change it.
 * So a text alone doesn't say where a name in it ends, nor whose it is for good. The server
 * finds that out once, when the text is written (resolveMentions): it looks for the users whose
 * names are written after an `@` of the text, and keeps the ones it finds beside the text, each
 * as the name and the id of the user who had it then: `mentions`, in a post's meta file and in a
 * comment. Every response that gives the text gives them with it, and whoever shows the text
 * reads it with them (parseFormatted in src/format.ts, which has the rules of what is a mention
 * where): a mention leads to GET /users/:userId, by the id. The text itself is stored as it was
 * sent, as any text is.
 *
 * A mention is of a user by the name they have: to the letter, capitals and all. A text
 * mentions MAX_MENTIONS users at most, and whatever it names after those is text.
 *
 * Who is told, and when, is in notifyMentions.
 */

/** The most users one text mentions. What it names after them mentions nobody, and is the text it is written with. */
export const MAX_MENTIONS = 10;

/** How many `@` of a text are looked at for a name, from its start: a text that has more than these reads the rest as text. */
const MAX_SITES = 50;

/** The longest a username is (routes/register.ts), and so the longest name looked for after an `@`. */
const MAX_NAME_CHARS = 64;

/** How many names one query looks for among the users. */
const NAMES_PER_QUERY = 500;

/**
 * The users a text mentions, as they are kept beside it: each with the name the text has them
 * by, in the order it first names them, MAX_MENTIONS at most. None for no text, and for a text
 * that names nobody the server has.
 *
 * Every name the text could mention (see mentionable) is looked for among the users whose
 * account isn't closed, by the index that keeps usernames unique, and the text is then read with
 * the ones that are there. A name is its user's to the letter: a database that compares names
 * more loosely than that (MySQL, by its collation) finds more, which are left out here.
 *
 * `previous` is the mentions of the text this one replaces: an update of a post, or an edit of
 * a comment. A name that was a mention there is still the same user's here, as long as that
 * user has an account, whatever they are called by now and whoever has the name since: a text
 * that is edited goes on mentioning whom it mentioned.
 */
export async function resolveMentions(db: Db, text: string | undefined, previous: readonly Mention[] = []): Promise<Mention[]> {
  if (!text?.includes('@')) return [];
  const names = [...mentionable(text, { sites: MAX_SITES, chars: MAX_NAME_CHARS })];
  const found = new Map<string, Mention>();
  for (let i = 0; i < names.length; i += NAMES_PER_QUERY) {
    const wanted = new Set(names.slice(i, i + NAMES_PER_QUERY));
    const rows = await db.selectFrom('users').select(['id', 'username']).where('username', 'in', [...wanted]).where('deleted_at', 'is', null).execute();
    for (const row of rows) if (wanted.has(row.username)) found.set(row.username, { userId: row.id, username: row.username });
  }
  const kept = previous.filter((m) => names.includes(m.username));
  if (kept.length > 0) {
    const there = await db
      .selectFrom('users')
      .select('id')
      .where('id', 'in', [...new Set(kept.map((m) => m.userId))])
      .where('deleted_at', 'is', null)
      .execute();
    for (const m of kept) if (there.some((row) => row.id === m.userId)) found.set(m.username, { userId: m.userId, username: m.username });
  }
  return mentionsIn(text, [...found.values()]).slice(0, MAX_MENTIONS);
}

/**
 * Tells the users a text mentions, once it is published: each gets a notice in their inbox
 * (`post_mention`, or `comment_mention` for a comment's text, see NOTICES in src/inbox.ts) that
 * names who wrote the text, the post, the comment if it is one, and the start of the text. The
 * routes that publish a text call it: for a new post or comment, for an update or an edit, and
 * for one accepted from the moderation queue. A text that is held there tells nobody until it
 * is accepted.
 *
 * A user is told once of a text that mentions them however often it names them, and isn't told:
 *
 * - of a mention they wrote themselves;
 * - again, of a text that already mentioned them before this write of it (`before`), nor while
 *   the notice of an earlier mention in the same post, or the same comment, is still in their
 *   inbox: so an edit tells only whom it newly mentions;
 * - if either of the two blocks the other (src/blocks.ts): the mention is still in the text,
 *   and still a link, as the text is its author's to write;
 * - if their account is closed.
 *
 * It isn't one of the messages between users, so the setting that turns those off
 * (`users.messages`) doesn't turn it off, and it counts towards no limit of theirs.
 *
 * It reports what a request has already done, so it never fails that request: notices that
 * can't be left are logged, and lost.
 */
export async function notifyMentions(
  { db, now = Date.now }: Pick<AppDeps, 'db' | 'now'>,
  { by, contentId, commentId, mentions = [], before = [], excerpt }: Mentioning,
  log: { warn: (o: object, msg?: string) => void },
): Promise<void> {
  const told = new Set(before.map((m) => m.userId));
  const mentioned = [...new Set(mentions.map((m) => m.userId))].filter((id) => id !== by && !told.has(id));
  if (!mentioned.length) return;
  const kind = commentId === undefined ? 'post_mention' : 'comment_mention';
  try {
    const [users, blocks, notices] = await Promise.all([
      db.selectFrom('users').select('id').where('id', 'in', mentioned).where('deleted_at', 'is', null).execute(),
      // Either way round.
      db
        .selectFrom('user_blocks')
        .select(['user_id', 'blocked_id'])
        .where((eb) => eb.or([eb.and([eb('user_id', '=', by), eb('blocked_id', 'in', mentioned)]), eb.and([eb('blocked_id', '=', by), eb('user_id', 'in', mentioned)])]))
        .execute(),
      db
        .selectFrom('inbox')
        .select('user_id')
        .where('user_id', 'in', mentioned)
        .where('kind', '=', kind)
        .where('content_id', '=', contentId)
        .$if(commentId !== undefined, (query) => query.where('comment_id', '=', commentId!))
        .execute(),
    ]);
    const skipped = new Set([...blocks.flatMap((row) => [row.user_id, row.blocked_id]), ...notices.map((row) => row.user_id)]);
    const tell = users.map((row) => row.id).filter((id) => !skipped.has(id));
    if (!tell.length) return;
    const at = now();
    await db
      .insertInto('inbox')
      .values(tell.map((userId) => ({ id: randomUUID(), user_id: userId, kind, sender_id: by, content_id: contentId, comment_id: commentId ?? null, tag: null, body: excerpt, created_at: at, read_at: null })))
      .execute();
  } catch (err) {
    log.warn({ err, by, contentId, commentId, mentioned }, 'could not leave the notices of a mention in the inbox; the users are not told');
  }
}
