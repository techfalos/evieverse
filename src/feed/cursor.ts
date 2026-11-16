import { decodeCursorJson, encodeCursorJson, invalidCursor } from '../http/listCursor.js';
import { cursorExpired, type Pin } from '../tagfeed/reader.js';
import { normalizeTag } from '../tags.js';
import { wholeSeconds } from '../time.js';
import { FEED_ALGORITHMS, type FeedAlgorithm } from './plan.js';

export interface CursorState {
  /** The instant the first page was computed for, which ends the window; later pages reuse it so the window stays the same. */
  anchor: number;
  hours: number;
  tags: string[];
  /**
   * The related hashtags the first page added to `tags` (addRelated), which every page reads after
   * them: what has been counted since could name others, and the positions index these. Undefined
   * when the feed didn't ask for them.
   */
  related?: string[];
  /** Positions index the algorithm's order, so later pages must use the same algorithm. */
  algorithm: FeedAlgorithm;
  /** Positions index the filtered lists too; undefined when the feed isn't filtered by it. */
  aiGenerated?: boolean;
  /** The same for the filter on moderated records. */
  moderated?: boolean;
  /** The manifest (in Redis) each tag was read from, so every page sees the same records; null for a tag that had none. */
  pins: Record<string, Pin>;
  /** How far into each tag's ordered list the feed has consumed. */
  positions: number[];
  /** Shuffles the fresh pool; fixed for the session so pages never repeat or skip fresh records. */
  seed: number;
  /** Per tag, how far into its fresh pool the feed has consumed. */
  freshPositions: number[];
}

const VERSION = 12;

const isPositions = (v: unknown): v is number[] => Array.isArray(v) && v.every((n) => Number.isInteger(n) && n >= 0);
const isTags = (v: unknown): v is string[] => Array.isArray(v) && v.every((t) => typeof t === 'string' && normalizeTag(t) === t);

export function encodeCursor(s: CursorState): string {
  return encodeCursorJson({ v: VERSION, a: s.anchor, h: s.hours, t: s.tags, r: s.related, al: s.algorithm, ai: s.aiGenerated, mo: s.moderated, g: s.pins, p: s.positions, s: s.seed, f: s.freshPositions });
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
    g: Record<string, string | null>;
    p: number[];
    s: number;
    f: number[];
  };
  // Cursors from an older server version can't be continued; the client starts over.
  if (raw && typeof raw.v === 'number' && raw.v < VERSION) throw cursorExpired();
  try {
    if (raw.v !== VERSION || typeof raw.a !== 'number' || typeof raw.h !== 'number' || !Array.isArray(raw.t)) throw new Error();
    if (!FEED_ALGORITHMS.includes(raw.al) || !Number.isInteger(raw.s) || !isPositions(raw.p) || !isPositions(raw.f)) throw new Error();
    if (raw.r !== undefined && !isTags(raw.r)) throw new Error();
    if (raw.ai !== undefined && typeof raw.ai !== 'boolean') throw new Error();
    if (raw.mo !== undefined && typeof raw.mo !== 'boolean') throw new Error();
    const pins: Record<string, Pin> = {};
    for (const [tag, pin] of Object.entries(raw.g ?? {})) {
      if (pin !== null && typeof pin !== 'string') throw new Error();
      pins[tag] = pin;
    }
    return { anchor: raw.a, hours: raw.h, tags: raw.t, related: raw.r, algorithm: raw.al, aiGenerated: raw.ai, moderated: raw.mo, pins, positions: raw.p, seed: raw.s, freshPositions: raw.f };
  } catch {
    throw invalidCursor();
  }
}

/**
 * A following feed's cursor is the last record of the page: the next page starts after it in
 * compareRecent order, whatever has changed since, so it pins nothing and never expires.
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
