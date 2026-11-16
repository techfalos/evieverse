import { badRequest } from './errors.js';

/** Cursors of lists of users ordered by when something happened, newest first, then by the user's id. */
export const encodeListCursor = (createdAt: number, userId: string) => Buffer.from(JSON.stringify([createdAt, userId])).toString('base64url');

export function decodeListCursor(cursor: string): { createdAt: number; userId: string } {
  try {
    const raw: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(raw) && raw.length === 2 && Number.isInteger(raw[0]) && typeof raw[1] === 'string') return { createdAt: raw[0], userId: raw[1] };
  } catch {}
  throw badRequest('invalid cursor');
}
