import type { HotStore } from '../storage/index.js';
import { EMPTY_HEAD, headKey } from './layout.js';
import type { Head } from './layout.types.js';

/** Reads of the feed index's keys that the reader and the compactor share. */

/** The JSON value under `key`; null if there's none. */
export async function readJson<T>(hot: HotStore, key: string): Promise<T | null> {
  const buf = await hot.get(key);
  return buf ? (JSON.parse(buf.toString('utf8')) as T) : null;
}

/** A tag that was never compacted has no head, and reads as empty. */
export const readHead = async (hot: HotStore, tag: string): Promise<Head> => (await readJson<Head>(hot, headKey(tag))) ?? EMPTY_HEAD;
