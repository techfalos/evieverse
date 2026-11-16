import { HttpError } from '../http/errors.js';
import { decodeCursorJson, encodeCursorJson, invalidCursor } from '../http/listCursor.js';
import { msg } from '../language.js';
import { normalizeTag } from '../tags.js';
import { wholeSeconds } from '../time.js';
import type { CursorState, FollowingCursor } from './cursor.types.js';
import { FEED_ALGORITHMS, type FeedAlgorithm } from './plan.js';
import type { Boundary } from './plan.types.js';

/**
 * The layout of a hashtag feed's cursor, which each cursor carries as `v`. A cursor with a lower
 * one was given by an older server and is refused as expired (410); only one with this value is
 * read.
 */
const VERSION = 13;

type RawBoundary = [likes: number, createdAt: number, contentId: string] | null;

/** Whether `n` is a whole number, zero or more: what the likes, times and fresh keys of a decoded cursor must be. */
const isCount = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0;

/** A hashtag feed's cursor as the opaque string the feed returns as `nextCursor`, which `decodeCursor` reads back. */
export function encodeCursor(s: CursorState): string {
  return encodeCursorJson({
    v: VERSION,
    a: s.anchor,
    h: s.hours,
    t: s.tags,
    r: s.related,
    al: s.algorithm,
    ai: s.aiGenerated,
    mo: s.moderated,
    s: s.seed,
    p: s.after.map((b): RawBoundary => b && [b.likes, b.createdAt, b.contentId]),
    f: s.freshAfter,
  });
}

/**
 * What `encodeCursor` was given. Throws 410 for a cursor of an older version, and 400 for any other
 * string that isn't a cursor of this version, a following feed's cursor among them. Only the
 * cursor's own shape is checked: whether it is of the feed the request asks for is the caller's
 * to check.
 */
export function decodeCursor(cursor: string): CursorState {
  const raw = decodeCursorJson(cursor) as {
    v: number;
    a: number;
    h: number;
    t: string[];
    r?: string[];
    al: FeedAlgorithm;
    ai?: boolean;
    mo?: boolean;
    s: number;
    p: RawBoundary[];
    f: (number | null)[];
  };
  // Cursors from an older server version can't be continued: 410, and the client starts the feed over.
  if (raw && typeof raw.v === 'number' && raw.v < VERSION) throw new HttpError(410, msg('cursor.expired'));
  try {
    if (
      raw.v !== VERSION ||
      typeof raw.a !== 'number' ||
      typeof raw.h !== 'number' ||
      !Array.isArray(raw.t) ||
      !FEED_ALGORITHMS.includes(raw.al) ||
      !Number.isInteger(raw.s) ||
      !(
        Array.isArray(raw.p) &&
        raw.p.every((b) => b === null || (Array.isArray(b) && b.length === 3 && isCount(b[0]) && isCount(b[1]) && typeof b[2] === 'string'))
      ) ||
      !(Array.isArray(raw.f) && raw.f.every((k) => k === null || isCount(k))) ||
      (raw.r !== undefined && !(Array.isArray(raw.r) && raw.r.every((t) => typeof t === 'string' && normalizeTag(t) === t))) ||
      (raw.ai !== undefined && typeof raw.ai !== 'boolean') ||
      (raw.mo !== undefined && typeof raw.mo !== 'boolean')
    ) {
      throw new Error();
    }
    return {
      anchor: raw.a,
      hours: raw.h,
      tags: raw.t,
      related: raw.r,
      algorithm: raw.al,
      aiGenerated: raw.ai,
      moderated: raw.mo,
      after: raw.p.map((b): Boundary | null => b && { likes: b[0], createdAt: b[1], contentId: b[2] }),
      seed: raw.s,
      freshAfter: raw.f,
    };
  } catch {
    throw invalidCursor();
  }
}

/** The layout of a following feed's cursor, which each cursor carries as `fv`; one with any other value is refused (400). */
const FOLLOWING_VERSION = 1;

/** A following feed's cursor as the opaque string the feed returns as `nextCursor`: the page's last record, its time cut to whole seconds. */
export function encodeFollowingCursor(c: FollowingCursor): string {
  // Whole seconds, as compareRecent compares them.
  return encodeCursorJson({ fv: FOLLOWING_VERSION, t: wholeSeconds(c.createdAt), c: c.contentId });
}

/** What `encodeFollowingCursor` encoded; throws 400 for any other string, a hashtag feed's cursor among them. */
export function decodeFollowingCursor(cursor: string): FollowingCursor {
  try {
    const raw = decodeCursorJson(cursor) as { fv: number; t: number; c: string };
    if (raw.fv === FOLLOWING_VERSION && Number.isInteger(raw.t) && typeof raw.c === 'string') return { createdAt: raw.t, contentId: raw.c };
  } catch {}
  throw invalidCursor();
}
