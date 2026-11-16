import { badRequest } from '../http/errors.js';
import { cursorExpired, type Pin, type TailPin } from '../tagfeed/reader.js';
import { FEED_MODES, type FeedMode } from './plan.js';

export interface CursorState {
  /** The instant the first page was computed for; later pages reuse it so slices stay aligned. */
  anchor: number;
  hours: number;
  tags: string[];
  /** Positions index the mode's order, so later pages must use the same mode. */
  mode: FeedMode;
  /** Positions index the filtered lists too; undefined when the feed isn't filtered by it. */
  aiGenerated?: boolean;
  /** The manifest (in Redis) each tag was read from, and the tail lines, so every page sees the same records. */
  pins: Record<string, Required<Pin>>;
  /** Per slice index, how far into each requested tag's ordered list the feed has consumed. */
  positions: Record<number, number[]>;
  /** Shuffles the fresh pool; fixed for the session so pages never repeat or skip fresh records. */
  seed: number;
  /** Per tag, how far into the newest slice's fresh pool the feed has consumed. */
  freshPositions: number[];
}

const VERSION = 8;

const isPositions = (v: unknown): v is number[] => Array.isArray(v) && v.every((n) => Number.isInteger(n) && n >= 0);
/** Windows no older than the pin's mergedThrough, each with a positive line count. */
const isTails = (v: unknown, mergedThrough: number): v is TailPin =>
  Array.isArray(v) &&
  v.every((t) => Array.isArray(t) && t.length === 2 && Number.isInteger(t[0]) && t[0] >= mergedThrough && Number.isInteger(t[1]) && t[1] > 0);

export function encodeCursor(s: CursorState): string {
  const g = Object.fromEntries(Object.entries(s.pins).map(([tag, p]) => [tag, [p.manifest, p.mergedThrough, p.tails]]));
  return Buffer.from(
    JSON.stringify({ v: VERSION, a: s.anchor, h: s.hours, t: s.tags, m: s.mode, ai: s.aiGenerated, g, p: s.positions, s: s.seed, f: s.freshPositions }),
  ).toString('base64url');
}

export function decodeCursor(cursor: string): CursorState {
  let raw: {
    v: number;
    a: number;
    h: number;
    t: string[];
    m: FeedMode;
    ai?: boolean;
    g: Record<string, [string | null, number, TailPin]>;
    p: Record<string, number[]>;
    s: number;
    f: number[];
  };
  try {
    raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw badRequest('invalid cursor');
  }
  // Cursors from an older server version can't be continued; the client starts over.
  if (raw && typeof raw.v === 'number' && raw.v < VERSION) throw cursorExpired();
  try {
    if (raw.v !== VERSION || typeof raw.a !== 'number' || typeof raw.h !== 'number' || !Array.isArray(raw.t)) throw new Error();
    if (!FEED_MODES.includes(raw.m) || !Number.isInteger(raw.s) || !isPositions(raw.f)) throw new Error();
    if (raw.ai !== undefined && typeof raw.ai !== 'boolean') throw new Error();
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
    return { anchor: raw.a, hours: raw.h, tags: raw.t, mode: raw.m, aiGenerated: raw.ai, pins, positions, seed: raw.s, freshPositions: raw.f };
  } catch {
    throw badRequest('invalid cursor');
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
  return Buffer.from(JSON.stringify({ fv: FOLLOWING_VERSION, t: Math.floor(c.createdAt / 1000) * 1000, c: c.contentId })).toString('base64url');
}

export function decodeFollowingCursor(cursor: string): FollowingCursor {
  try {
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { fv: number; t: number; c: string };
    if (raw.fv === FOLLOWING_VERSION && Number.isInteger(raw.t) && typeof raw.c === 'string') return { createdAt: raw.t, contentId: raw.c };
  } catch {}
  throw badRequest('invalid cursor');
}
