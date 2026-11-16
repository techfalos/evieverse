import type { HotStore } from '../storage/index.js';
import { decodeTail, EMPTY_HEAD, headKey, tailKey, type Head, type TailLine } from './layout.js';

/** Reads of the feed index's keys that the reader and the compactor share. */

/** The JSON value under `key`; null if there's none. */
export async function readJson<T>(hot: HotStore, key: string): Promise<T | null> {
  const buf = await hot.get(key);
  return buf ? (JSON.parse(buf.toString('utf8')) as T) : null;
}

/** A tag that was never compacted has no head, and reads as empty: only its tails are visible. */
export const readHead = async (hot: HotStore, tag: string): Promise<Head> => (await readJson<Head>(hot, headKey(tag))) ?? EMPTY_HEAD;

/** The lines of each of a tag's tail windows, in push order; null for a line that isn't one. */
export async function readTails(hot: HotStore, tag: string, windows: number[]): Promise<(TailLine | null)[][]> {
  const lists = await hot.lists(windows.map((w) => tailKey(tag, w)));
  return lists.map((list) => list.map((line) => decodeTail(line.toString('utf8'))));
}
