import { TtlCache } from '../util.js';
import type { HotStore } from './hotStore.types.js';

/** The Redis key of a hashtag's related hashtags: most related first, with a space between them. A hashtag that has none has no key. */
const relatedKey = (tag: string) => `rel:${tag}`;

/**
 * Each hashtag's related hashtags, in Redis, so a feed that adds them (`addRelated`) reads no
 * database: one key per hashtag that has any, most related first, with no expiry. The compactor
 * works them out from the counts in `tag_pairs` and writes them: for the hashtags whose counts
 * changed, and with --all or --rebuild for every hashtag.
 */
export class RelatedTagStore {
  private readonly cache: TtlCache<string[]>;

  constructor(
    private readonly hot: HotStore,
    opts: { cacheMs: number },
    now: () => number = Date.now,
  ) {
    this.cache = new TtlCache(opts.cacheMs, now);
  }

  /** The hashtags related to `tag`, most related first. A hashtag Redis has none for has none, as far as feeds can tell. */
  get(tag: string): Promise<string[]> {
    return this.cache.get(tag, async () => {
      const buf = await this.hot.get(relatedKey(tag));
      return buf ? buf.toString('utf8').split(' ').filter(Boolean) : [];
    });
  }

  async put(tag: string, related: string[]): Promise<void> {
    if (related.length) await this.hot.set(relatedKey(tag), related.join(' '));
    else await this.hot.del([relatedKey(tag)]);
  }
}
