import { badRequest } from '../http/errors.js';
import { cursorExpired, type Pin } from '../tagfeed/reader.js';
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
  /** The manifest (in Redis) each tag was read from, so every page sees the same records. */
  pins: Record<string, Pin>;
  /** Per slice index, how far into each requested tag's ordered list the feed has consumed. */
  positions: Record<number, number[]>;
  /** Shuffles the fresh pool; fixed for the session so pages never repeat or skip fresh records. */
  seed: number;
  /** Per tag, how far into the newest slice's fresh pool the feed has consumed. */
  freshPositions: number[];
}

const VERSION = 7;

const isPositions = (v: unknown): v is number[] => Array.isArray(v) && v.every((n) => Number.isInteger(n) && n >= 0);

export function encodeCursor(s: CursorState): string {
  const g = Object.fromEntries(Object.entries(s.pins).map(([tag, p]) => [tag, [p.manifest, p.mergedThrough]]));
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
    g: Record<string, [string | null, number]>;
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
    const pins: Record<string, Pin> = {};
    for (const [tag, pin] of Object.entries(raw.g ?? {})) {
      if (!Array.isArray(pin) || (pin[0] !== null && typeof pin[0] !== 'string') || typeof pin[1] !== 'number') throw new Error();
      pins[tag] = { manifest: pin[0], mergedThrough: pin[1] };
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
