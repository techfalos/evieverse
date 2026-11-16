/** Every timestamp is UTC epoch milliseconds. */

/** A minute, in milliseconds: what the limits counted by the minute count over, and what a wait is told in. */
export const MINUTE = 60 * 1000;
/** An hour, in milliseconds: what turns the settings and the feed windows given in hours into a time. */
export const HOUR = 60 * MINUTE;
/** A day, in milliseconds: what a UTC day number counts (`utcDay`), and what turns the settings given in days into a time (retention, a feed's lookback). */
export const DAY = 24 * HOUR;

/** UTC day number. */
export const utcDay = (ms: number) => Math.floor(ms / DAY);

/** Cut to the whole seconds day indexes keep. */
export const wholeSeconds = (ms: number) => Math.floor(ms / 1000) * 1000;

/** A timestamp as responses give it: ISO 8601, in UTC, to the millisecond ("2026-01-31T12:00:00.000Z"). */
export const iso = (ms: number) => new Date(ms).toISOString();
