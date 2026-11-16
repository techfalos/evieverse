import { sql, type SelectQueryBuilder } from 'kysely';
import { msg } from '../language.js';
import { badRequest } from './errors.js';
import type { ListPage } from './listCursor.types.js';
import { ListQuery } from './schemas.js';

/** A cursor's value as the opaque string clients pass back. */
export const encodeCursorJson = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** 400 for a cursor the server didn't give, or didn't give for this request. */
export const invalidCursor = () => badRequest(msg('cursor.invalid'));

/** What encodeCursorJson was given; 400 for a string that isn't one of its. */
export function decodeCursorJson(cursor: string): unknown {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
}

function decodeListCursor(cursor: string): { createdAt: number; userId: string } {
  const raw = decodeCursorJson(cursor);
  if (Array.isArray(raw) && raw.length === 2 && Number.isInteger(raw[0]) && typeof raw[1] === 'string') return { createdAt: raw[0], userId: raw[1] };
  throw invalidCursor();
}

/** `Query` is ListQuery, or the same with other bounds on `limit`. */
export function listQuery(query: unknown, Query: typeof ListQuery = ListQuery): ListPage {
  const q = Query.parse(query);
  return { limit: q.limit, after: q.cursor ? decodeListCursor(q.cursor) : undefined };
}

/**
 * A page of `query`'s rows, newest first (or, for a queue, oldest first), then by the user's id, and
 * the cursor of the page after it. `by` names the columns that order the list; each row's `id` is
 * that user's (or whatever else the list is of, named by `by.userId`).
 */
export async function listPage<DB, TB extends keyof DB, O extends { id: string; created_at: number }>(
  query: SelectQueryBuilder<DB, TB, O>,
  by: { createdAt: string; userId: string },
  { limit, after }: ListPage,
  order: 'newest' | 'oldest' = 'newest',
): Promise<{ rows: O[]; nextCursor: string | null }> {
  const createdAt = sql.ref<number>(by.createdAt);
  const userId = sql.ref<string>(by.userId);
  let paged = query.orderBy(createdAt, order === 'newest' ? 'desc' : 'asc').orderBy(userId, 'asc').limit(limit + 1);
  if (after) {
    paged = paged.where(
      sql<boolean>`(${createdAt} ${order === 'newest' ? sql`<` : sql`>`} ${after.createdAt} or (${createdAt} = ${after.createdAt} and ${userId} > ${after.userId}))`,
    );
  }
  const found = await paged.execute();
  const rows = found.slice(0, limit);
  const last = rows.at(-1);
  // Cursors of lists ordered by when something happened, then by an id: the user's, in a list of users.
  return { rows, nextCursor: found.length > limit && last ? encodeCursorJson([last.created_at, last.id]) : null };
}
