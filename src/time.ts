/** Every timestamp is UTC epoch milliseconds. */
export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

/** UTC day number. */
export const utcDay = (ms: number) => Math.floor(ms / DAY);

/** Cut to the whole seconds day indexes keep. */
export const wholeSeconds = (ms: number) => Math.floor(ms / 1000) * 1000;

export const iso = (ms: number) => new Date(ms).toISOString();
