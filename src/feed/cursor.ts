import { HttpError } from '../http/errors.js';
import { decodeCursorJson, encodeCursorJson, invalidCursor } from '../http/listCursor.js';
import { msg } from '../language.js';
import { normalizeTag } from '../tags.js';
import { wholeSeconds } from '../time.js';
import { FEED_ALGORITHMS, type Boundary, type FeedAlgorithm } from './plan.js';

/**
 * A hashtag feed's cursor says where the feed has got to, not what it read: the last record taken
 * from each tag's list, and from its fresh pool. The next page is planned over the index as it is
 * by then and carries on after those, so the cursor pins nothing and doesn't expire.
 */
export interface CursorState {
  /** The instant the first page was computed for, which ends the window; later pages reuse it so the window stays the same. */
  anchor: number;
  hours: number;
  tags: string[];
  /**
   * The related hashtags the first page added to `tags` (addRelated), which every page reads after
   * them: what has been counted since could name others, and `after` is in the order of these.
   * Undefined when the feed didn't ask for them.
   */
  related?: string[];
  /** `after` is a place in the algorithm's order, so later pages must use the same algorithm. */
  algorithm: FeedAlgorithm;
  /** The feed's filter on content created with AI, which later pages must keep; undefined when it has none. */
  aiGenerated?: boolean;
  /** The same for the filter on moderated records. */
  moderated?: boolean;
  /** Per tag, the last record the feed took from its ordered list or passed over; null when it took none. */
  after: (Boundary | null)[];
  /** Orders the fresh pools; fixed for the session, so each page carries on in the order of the last. */
  seed: number;
  /** Per tag, the key of the last record the feed took from its fresh pool; null when it took none. */
  freshAfter: (number | null)[];
}

const VERSION = 13;

/** 410 for a cursor an earlier release issued, which can't be carried on: the client starts the feed over. */
const cursorExpired = () => new HttpError(410, msg('cursor.expired'));

type RawBoundary = [likes: number, createdAt: number, contentId: string] | null;

const isCount = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0;
const isBoundaries = (v: unknown): v is RawBoundary[] =>
  Array.isArray(v) && v.every((b) => b === null || (Array.isArray(b) && b.length === 3 && isCount(b[0]) && isCount(b[1]) && typeof b[2] === 'string'));
const isKeys = (v: unknown): v is (number | null)[] => Array.isArray(v) && v.every((k) => k === null || isCount(k));
const isTags = (v: unknown): v is string[] => Array.isArray(v) && v.every((t) => typeof t === 'string' && normalizeTag(t) === t);

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
  // Cursors from an older server version can't be continued; the client starts over.
  if (raw && typeof raw.v === 'number' && raw.v < VERSION) throw cursorExpired();
  try {
    if (raw.v !== VERSION || typeof raw.a !== 'number' || typeof raw.h !== 'number' || !Array.isArray(raw.t)) throw new Error();
    if (!FEED_ALGORITHMS.includes(raw.al) || !Number.isInteger(raw.s) || !isBoundaries(raw.p) || !isKeys(raw.f)) throw new Error();
    if (raw.r !== undefined && !isTags(raw.r)) throw new Error();
    if (raw.ai !== undefined && typeof raw.ai !== 'boolean') throw new Error();
    if (raw.mo !== undefined && typeof raw.mo !== 'boolean') throw new Error();
    const after = raw.p.map((b): Boundary | null => b && { likes: b[0], createdAt: b[1], contentId: b[2] });
    return { anchor: raw.a, hours: raw.h, tags: raw.t, related: raw.r, algorithm: raw.al, aiGenerated: raw.ai, moderated: raw.mo, after, seed: raw.s, freshAfter: raw.f };
  } catch {
    throw invalidCursor();
  }
}

/**
 * A following feed's cursor is the last record of the page: the next page starts after it in
 * compareRecent order, whatever has changed since, so it never expires.
 */
export interface FollowingCursor {
  createdAt: number;
  contentId: string;
}

const FOLLOWING_VERSION = 1;

export function encodeFollowingCursor(c: FollowingCursor): string {
  // Whole seconds, as compareRecent compares them.
  return encodeCursorJson({ fv: FOLLOWING_VERSION, t: wholeSeconds(c.createdAt), c: c.contentId });
}

export function decodeFollowingCursor(cursor: string): FollowingCursor {
  try {
    const raw = decodeCursorJson(cursor) as { fv: number; t: number; c: string };
    if (raw.fv === FOLLOWING_VERSION && Number.isInteger(raw.t) && typeof raw.c === 'string') return { createdAt: raw.t, contentId: raw.c };
  } catch {}
  throw invalidCursor();
}
