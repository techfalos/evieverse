import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { rowCounts, summaryOf } from '../content.js';
import type { AppDeps } from '../deps.types.js';
import { badRequest } from '../http/errors.js';
import { decodeCursorJson, encodeCursorJson, invalidCursor } from '../http/listCursor.js';
import { perMinute } from '../http/rateLimitStore.js';
import { msg } from '../language.js';
import { foldUsername, queryTerms } from '../search/keywords.js';
import type { Summary } from '../storage/index.js';
import { toFeedRecord } from '../tagfeed/layout.js';
import type { FeedRecord } from '../tagfeed/layout.types.js';
import { mapLimit } from '../util.js';

/** The longest a search's `q` is, in characters. */
const MAX_QUERY_CHARS = 200;

/** The most users or posts one page of a search holds. */
const MAX_PAGE = 50;

/** Meta files read at once, for the posts of a page that have no summary to be shown with. */
const META_READS = 8;

/**
 * The character that says, in the pattern of a LIKE, that the one after it is itself and matches
 * nothing else. Not the backslash, which is also what a string is written with in MySQL.
 */
const LIKE_ESCAPE = '!';

/**
 * The query of GET /search: what to search (`type`), what for (`q`), and the page asked for
 * (`limit`, 20 unless the request says and MAX_PAGE at most, and the `cursor` the page before
 * came with).
 */
const Query = z.object({
  /** users: the users whose username starts with `q`. content: the posts that have every word of `q`. */
  type: z.enum(['users', 'content']),
  /** Not the character no text has, which a database refuses to compare anything with. */
  q: z
    .string()
    .trim()
    .min(1)
    .max(MAX_QUERY_CHARS)
    .refine((q) => !q.includes('\0')),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(20),
  cursor: z.string().optional(),
});

/** Whether a value a cursor holds is a string a database can be asked about. */
const isText = (value: unknown): value is string => typeof value === 'string' && !value.includes('\0');

/** Where a page of users ended, as its cursor says: the last user's folded name and id. 400 for a cursor that isn't a page of users'. */
function decodeUserCursor(cursor: string): { folded: string; id: string } {
  const raw = decodeCursorJson(cursor);
  if (Array.isArray(raw) && raw.length === 2 && isText(raw[0]) && isText(raw[1])) return { folded: raw[0], id: raw[1] };
  throw invalidCursor();
}

/** Where a page of posts ended, as its cursor says: when the last post was created, and its id. 400 for a cursor that isn't a page of posts'. */
function decodePostCursor(cursor: string): { createdAt: number; id: string } {
  const raw = decodeCursorJson(cursor);
  if (Array.isArray(raw) && raw.length === 2 && Number.isSafeInteger(raw[0]) && isText(raw[1])) return { createdAt: raw[0], id: raw[1] };
  throw invalidCursor();
}

/**
 * Search: GET /search, and nothing else. With `type=users` it finds users by the start of their
 * username, and with `type=content`, posts by the words of their text or caption and by their
 * hashtags. It is for anyone, with no key, as the feeds of hashtags and the posts themselves
 * are, and finds only what those show: no account that is closed, and no post that is withheld
 * or set for deletion.
 *
 * It reads the database, which a hashtag feed never does, so it is in the group of routes that
 * open one (see functions/groups.ts), and one address gets `search.rateLimitPerMinute` requests
 * a minute, and is refused past that (429) before anything is read for it (see app.ts).
 */
export function searchRoutes(app: FastifyInstance, { db, config, content, summaries }: AppDeps) {
  const { dialect } = config.db;

  /**
   * The users whose username starts with `q`, whatever its case and accents ("jos" finds José),
   * in the order of their names as a search compares them, then of their ids: `users`, each with
   * its `userId` and `username`, and `nextCursor` if there are more. Not a user whose account is
   * closed. A user who is banned has their account, and is found.
   *
   * It reads `users_username_folded_idx`, which holds the names as they are compared
   * (`users.username_folded`), in the order they are listed in. MySQL takes the pattern for the
   * part of that index it stands for. SQLite doesn't, for a pattern with an ESCAPE, so there the
   * part is named beside the pattern: it sorts text byte by byte, and the names that start with
   * the prefix are the ones between two it can be given. Postgres takes the pattern for a part
   * of the index only where the database sorts text byte by byte (the "C" collation): with any
   * other, no two names bound the ones a prefix starts, and it checks the pattern against names
   * it reads outside that part too.
   */
  async function users(q: string, limit: number, cursor: string | undefined) {
    const prefix = foldUsername(q);
    if (!prefix) throw badRequest(msg('search.no_words'));
    const after = cursor === undefined ? undefined : decodeUserCursor(cursor);
    const folded = sql.ref<string>('users.username_folded');
    const id = sql.ref<string>('users.id');
    // The name's characters as they are: a `%` or a `_` of it is no wildcard.
    const pattern = `${prefix.replace(/[!%_]/g, `${LIKE_ESCAPE}$&`)}%`;
    let query = db
      .selectFrom('users')
      .select(['users.id', 'users.username', 'users.username_folded'])
      .where(sql<boolean>`${folded} like ${pattern} escape ${sql.lit(LIKE_ESCAPE)}`)
      .orderBy('users.username_folded')
      .orderBy('users.id')
      .limit(limit + 1);
    if (dialect === 'sqlite') {
      query = query
        // The names that start with the prefix are those from it up to it followed by the last character there is.
        .where('users.username_folded', '>=', prefix)
        .where('users.username_folded', '<', `${prefix}\u{10ffff}`)
        // With a `+`, which keeps SQLite from reading every account that isn't closed by the index of those that are, and sorting them.
        .where(sql<boolean>`+${sql.ref('users.deleted_at')} is null`);
    } else query = query.where('users.deleted_at', 'is', null);
    if (after) query = query.where(sql<boolean>`(${folded} > ${after.folded} or (${folded} = ${after.folded} and ${id} > ${after.id}))`);
    const found = await query.execute();
    const rows = found.slice(0, limit);
    const last = rows.at(-1);
    return {
      users: rows.map((row) => ({ userId: row.id, username: row.username })),
      nextCursor: found.length > limit && last ? encodeCursorJson([last.username_folded, last.id]) : null,
    };
  }

  /**
   * The posts that have every word of `q`, newest first: `results`, each as a feed gives a post
   * (see toFeedRecord), with its counts as the database has them now (see rowCounts), all of its
   * likes among them, and `nextCursor` if there are more. A word of `q`
   * is one of a post's if it is among the post's keywords, which are the most frequent words of
   * its text or caption, or is one of its hashtags (see keywordsOf and queryTerms): whole words,
   * whatever their case and accents.
   *
   * Only posts anyone can read: not one set for deletion, one that waits in the moderation
   * queue, an entry whose original is gone from its own server, nor one of an account that is
   * closed. And only as the compactor last wrote them, which is when it writes their keywords:
   * a post is found once it is in feeds, and by what an update made it once feeds show that.
   *
   * The posts are found in the database alone. The rows of the longest of the words, which is
   * likely the one the fewest posts have, are read in the order of the page, from the index
   * that holds them in it (`search_terms_newest_idx`), and each is kept if the post has a row
   * for every other word, which is a lookup by the primary key, and may be read. So a page costs
   * what it reads of the first word's rows, which for words that seldom come together is more
   * than the page holds.
   *
   * Each post is shown with its summary, as in a feed. A post older than summaries are kept
   * (`feed.tagRetentionDays`) has none, and is shown with the one its meta file makes.
   */
  async function posts(q: string, limit: number, cursor: string | undefined) {
    const terms = queryTerms(q);
    const [lead, ...others] = [...terms].sort((a, b) => b.length - a.length);
    if (lead === undefined) throw badRequest(msg('search.no_words'));
    const after = cursor === undefined ? undefined : decodePostCursor(cursor);
    const createdAt = sql.ref<number>('hit.created_at');
    const id = sql.ref<string>('hit.content_id');
    let query = db
      .selectFrom('search_terms as hit')
      .innerJoin('content', 'content.id', 'hit.content_id')
      .innerJoin('users', 'users.id', 'content.user_id')
      .leftJoin('moderation_queue', 'moderation_queue.content_id', 'content.id')
      .select(['content.id', 'content.user_id', 'content.created_at', 'content.ai_generated', 'content.like_count', 'content.view_count', 'content.dislike_count', 'users.username'])
      .where('hit.term', '=', lead)
      .where('content.delete_requested_at', 'is', null)
      .where('content.origin_gone_at', 'is', null)
      .where('moderation_queue.content_id', 'is', null)
      .where('users.deleted_at', 'is', null)
      // Both the same way, which is the order the index has them in, read from its end.
      .orderBy('hit.created_at', 'desc')
      .orderBy('hit.content_id', 'desc')
      .limit(limit + 1);
    for (const term of others) {
      query = query.where((eb) => eb.exists(eb.selectFrom('search_terms as other').select('other.content_id').whereRef('other.content_id', '=', 'hit.content_id').where('other.term', '=', term)));
    }
    if (after) query = query.where(sql<boolean>`(${createdAt} < ${after.createdAt} or (${createdAt} = ${after.createdAt} and ${id} < ${after.id}))`);
    const found = await query.execute();
    const rows = found.slice(0, limit);
    const last = rows.at(-1);

    const shown: (Summary | null)[] = await summaries.getMany(rows.map((row) => ({ contentId: row.id, createdAt: Number(row.created_at) })));
    await mapLimit(
      [...rows.keys()].filter((i) => !shown[i]),
      META_READS,
      async (i) => {
        const row = rows[i]!;
        const meta = await content.getMeta(row.id);
        if (meta) shown[i] = summaryOf(row, meta, config.publicBaseUrl);
      },
    );
    const results: FeedRecord[] = rows.flatMap((row, i) => {
      const summary = shown[i];
      // Neither a summary nor a meta file: deleted since the rows were read.
      return summary ? [toFeedRecord(summary, rowCounts(row, config.dislikes), { userId: row.user_id, username: row.username })] : [];
    });
    return { results, nextCursor: found.length > limit && last ? encodeCursorJson([Number(last.created_at), last.id]) : null };
  }

  /**
   * search: of users (`type=users`) or of posts (`type=content`), for `q`, a page at a time (see
   * `users` and `posts`). 400 for a `q` with nothing in it to search for: no word, for posts,
   * and for users, no character a name is compared by.
   */
  app.get('/search', { config: perMinute(config.search.rateLimitPerMinute) }, async (req) => {
    const { type, q, limit, cursor } = Query.parse(req.query);
    return type === 'users' ? users(q, limit, cursor) : posts(q, limit, cursor);
  });
}
