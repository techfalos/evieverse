import type { PublishedAd } from '../monetization.js';
import { TtlCache } from '../util.js';
import type { HotStore } from './hotStore.js';

const ADS_KEY = 'ads';

/** What the key holds. Bump `v` if a published ad changes shape: readers take another version for no ads. */
interface Published {
  v: 1;
  ads: PublishedAd[];
}

/**
 * The ads feeds and posts show (src/monetization.ts), in Redis, so a feed that shows them reads no
 * database: one key with every ad that hasn't ended, with no expiry. The compactor writes it from
 * the `monetization` table, on every run. Each ad is published with its schedule, which whoever
 * reads it holds it to: an ad starts and ends on time, whenever the key was last written.
 */
export class AdStore {
  private readonly cache: TtlCache<PublishedAd[]>;

  constructor(
    private readonly hot: HotStore,
    opts: { cacheMs: number },
    now: () => number = Date.now,
  ) {
    this.cache = new TtlCache(opts.cacheMs, now);
  }

  /** The ads that hadn't ended when the compactor last published them. None, as far as readers can tell, where Redis has none. */
  get(): Promise<PublishedAd[]> {
    return this.cache.get(ADS_KEY, async () => {
      const buf = await this.hot.get(ADS_KEY);
      if (!buf) return [];
      const published = JSON.parse(buf.toString('utf8')) as Published;
      return published.v === 1 ? published.ads : [];
    });
  }

  /**
   * Publishes `ads` in place of the ones there, and returns whether that changed anything: the
   * key is written only if it would hold something else, and deleted where there are no ads.
   */
  async sync(ads: PublishedAd[]): Promise<boolean> {
    const next = ads.length ? JSON.stringify({ v: 1, ads } satisfies Published) : null;
    const current = (await this.hot.get(ADS_KEY))?.toString('utf8') ?? null;
    if (current === next) return false;
    if (next === null) await this.hot.del([ADS_KEY]);
    else await this.hot.set(ADS_KEY, next);
    return true;
  }
}
