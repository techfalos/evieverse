import type { HotStore } from '../storage/index.js';
import { encodeTail, tailIndexKey, tailKey, type TailLine, type Tombstone } from './layout.js';

/**
 * "Prepends" entries to a tag by pushing one line onto the tag's Redis list for the current window;
 * readers treat tails as the newest part of the tag. Every node pushes onto the same list (RPUSH is
 * atomic), after registering the window in the tag's sorted set of tail windows.
 */
export class TagAppender {
  constructor(
    private readonly hot: HotStore,
    private readonly opts: { windowMs: number },
    private readonly now: () => number = Date.now,
  ) {}

  append(tag: string, entry: TailLine): Promise<void> {
    const window = Math.floor(this.now() / this.opts.windowMs) * this.opts.windowMs;
    return this.hot.push(tailKey(tag, window), encodeTail(entry), { key: tailIndexKey(tag), score: window });
  }

  /** Appends a tombstone to each tag's tail; returns the tags whose append failed. */
  async tombstone(tags: string[], tombstone: Tombstone): Promise<string[]> {
    const results = await Promise.allSettled(tags.map((tag) => this.append(tag, tombstone)));
    return tags.filter((_, i) => results[i]!.status === 'rejected');
  }
}
