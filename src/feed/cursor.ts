import { decodeCursorJson, encodeCursorJson, invalidCursor } from '../http/listCursor.js';
import { cursorExpired, type Pin, type TailPin } from '../tagfeed/reader.js';
import { normalizeTag } from '../tags.js';
import { wholeSeconds } from '../time.js';
import { FEED_ALGORITHMS, type FeedAlgorithm } from './plan.js';

export interface CursorState {
  /** The instant the first page was computed for; later pages reuse it so slices stay aligned. */
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
  /** The manifest (in Redis) each tag was read from, and the tail lines, so every page sees the same records. */
  pins: Record<string, Required<Pin>>;
  /** Per slice index, how far into each requested tag's ordered list the feed has consumed. */
  positions: Record<number, number[]>;
  /** Shuffles the fresh pool; fixed for the session so pages never repeat or skip fresh records. */
  seed: number;
  /** Per tag, how far into the newest slice's fresh pool the feed has consumed. */
  freshPositions: number[];
}

const VERSION = 10;

const isPositions = (v: unknown): v is number[] => Array.isArray(v) && v.every((n) => Number.isInteger(n) && n >= 0);
const isTags = (v: unknown): v is string[] => Array.isArray(v) && v.every((t) => typeof t === 'string' && normalizeTag(t) === t);
/** Windows no older than the pin's mergedThrough, each with a positive line count. */
const isTails = (v: unknown, mergedThrough: number): v is TailPin =>
  Array.isArray(v) &&
  v.every((t) => Array.isArray(t) && t.length === 2 && Number.isInteger(t[0]) && t[0] >= mergedThrough && Number.isInteger(t[1]) && t[1] > 0);

export function encodeCursor(s: CursorState): string {
  const g = Object.fromEntries(Object.entries(s.pins).map(([tag, p]) => [tag, [p.manifest, p.mergedThrough, p.tails]]));
  return encodeCursorJson({ v: VERSION, a: s.anchor, h: s.hours, t: s.tags, r: s.related, al: s.algorithm, ai: s.aiGenerated, mo: s.moderated, g, p: s.positions, s: s.seed, f: s.freshPositions });
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
    g: Record<string, [string | null, number, TailPin]>;
    p: Record<string, number[]>;
    s: number;
    f: number[];
  };
  // Cursors from an older server version can't be continued; the client starts over.
  if (raw && typeof raw.v === 'number' && raw.v < VERSION) throw cursorExpired();
  try {
    if (raw.v !== VERSION || typeof raw.a !== 'number' || typeof raw.h !== 'number' || !Array.isArray(raw.t)) throw new Error();
    if (!FEED_ALGORITHMS.includes(raw.al) || !Number.isInteger(raw.s) || !isPositions(raw.f)) throw new Error();
    if (raw.r !== undefined && !isTags(raw.r)) throw new Error();
    if (raw.ai !== undefined && typeof raw.ai !== 'boolean') throw new Error();
    if (raw.mo !== undefined && typeof raw.mo !== 'boolean') throw new Error();
    const pins: Record<string, Required<Pin>> = {};
    for (const [tag, pin] of Object.entries(raw.g ?? {})) {
      if (!Array.isArray(pin) || (pin[0] !== null && typeof pin[0] !== 'string') || typeof pin[1] !== 'number' || !isTails(pin[2], pin[1])) {
        throw new Error();
      }
      pins[tag] = { manifest: pin[0], mergedThrough: pin[1], tails: pin[2] };
    }
    const positions: Record<number, number[]> = {};
    for (const [k, v] of Object.entries(raw.p ?? {})) {
      if (!isPositions(v)) throw new Error();
      positions[Number(k)] = v;
    }
    return { anchor: raw.a, hours: raw.h, tags: raw.t, related: raw.r, algorithm: raw.al, aiGenerated: raw.ai, moderated: raw.mo, pins, positions, seed: raw.s, freshPositions: raw.f };
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
