import { HttpError } from '../http/errors.js';
import { decodeCursorJson, encodeCursorJson, invalidCursor } from '../http/listCursor.js';
import { msg } from '../language.js';
import { normalizeTag } from '../tags.js';
import { wholeSeconds } from '../time.js';
import type { CursorState, EngagedCursor, FollowingCursor } from './cursor.types.js';
import { ENGAGED_TAGS, ENGAGED_USERS, USER_ID, WEIGHT_SCALE } from './engagement.js';
import { ENGAGED_LEAD, FEED_ALGORITHMS, type FeedAlgorithm } from './plan.js';
import type { Boundary, EngagedBoundary } from './plan.types.js';

/**
 * The layout of a hashtag feed's cursor, which each cursor carries as `v`. A cursor with a lower
 * one was given by an older server and is refused as expired (410); only one with this value is
 * read.
 */
const VERSION = 13;

/** The layout of a following feed's cursor, which each cursor carries as `fv`; one with any other value is refused (400). */
const FOLLOWING_VERSION = 1;

type RawBoundary = [likes: number, createdAt: number, contentId: string] | null;
type RawEngagedBoundary = [score: number, key: number, contentId: string] | null;
/** What a cursor carries for an engaged feed that goes by an engagement (see EngagedCursor): the weights of its hashtags and of its users, its places, and what it led with. */
type RawEngaged = { t: [tag: string, weight: number][]; u: [userId: string, weight: number][]; p: RawEngagedBoundary[]; l: string[] };

/** Whether `n` is a whole number, zero or more: what the likes, times and fresh keys of a decoded cursor must be. */
const isCount = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0;

/** Whether `b` is a place in a list as a cursor writes one: two counts and a content id, or null for a list nothing was taken from. */
const isPlace = (b: unknown) => b === null || (Array.isArray(b) && b.length === 3 && isCount(b[0]) && isCount(b[1]) && typeof b[2] === 'string');

/**
 * Whether `pairs` is at most `most` names with their weights, as `engagementWeights` gives them,
 * each name one that `named` holds for. A cursor is the client's to hold, and the feed reads an
 * index for each name: so only as many as a first page could have read, and only names of indexes.
 */
const isWeights = (pairs: unknown, most: number, named: (name: string) => boolean) =>
  Array.isArray(pairs) &&
  pairs.length <= most &&
  pairs.every((pair) => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && named(pair[0]) && isCount(pair[1]) && pair[1] >= 1 && pair[1] <= WEIGHT_SCALE);

/** What a decoded cursor carries for an engaged feed, if it is that (see RawEngaged) and nothing else. */
function readEngaged(raw: RawEngaged): EngagedCursor | null {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !isWeights(raw.t, ENGAGED_TAGS, (tag) => normalizeTag(tag) === tag) ||
    !isWeights(raw.u, ENGAGED_USERS, (userId) => USER_ID.test(userId)) ||
    raw.t.length + raw.u.length === 0 ||
    !(Array.isArray(raw.p) && raw.p.every(isPlace)) ||
    !(Array.isArray(raw.l) && raw.l.length <= ENGAGED_LEAD && raw.l.every((contentId) => typeof contentId === 'string'))
  ) {
    return null;
  }
  return {
    weights: { tags: raw.t, users: raw.u },
    after: raw.p.map((b): EngagedBoundary | null => b && { score: b[0], key: b[1], contentId: b[2] }),
    led: raw.l,
  };
}

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
    // Only on the cursor of a feed that goes by an engagement: every other cursor is as it was before there were any.
    e: s.engaged && {
      t: s.engaged.weights.tags,
      u: s.engaged.weights.users,
      p: s.engaged.after.map((b): RawEngagedBoundary => b && [b.score, b.key, b.contentId]),
      l: s.engaged.led,
    } satisfies RawEngaged,
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
    e?: RawEngaged;
  };
  // Cursors from an older server version can't be continued: 410, and the client starts the feed over.
  if (raw && typeof raw.v === 'number' && raw.v < VERSION) throw new HttpError(410, msg('cursor.expired'));
  try {
    const engaged = raw.e === undefined ? undefined : readEngaged(raw.e);
    if (
      engaged === null ||
      // Only an engaged feed goes by an engagement.
      (engaged && raw.al !== 'engaged') ||
      raw.v !== VERSION ||
      typeof raw.a !== 'number' ||
      typeof raw.h !== 'number' ||
      !Array.isArray(raw.t) ||
      !FEED_ALGORITHMS.includes(raw.al) ||
      !Number.isInteger(raw.s) ||
      !(Array.isArray(raw.p) && raw.p.every(isPlace)) ||
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
      engaged,
    };
  } catch {
    throw invalidCursor();
  }
}

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
