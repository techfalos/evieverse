import type { AdKind, MonetizationTable } from './db/schema.js';

/**
 * Monetization: the ads the server shows, which its admins keep in the `monetization` table
 * (routes/monetization.ts). An ad is text or an image, has a schedule, and either appears all the
 * time or is targeted at hashtags. Where the server turns each on, ads come with hashtag feeds, to
 * show between their posts, and with a post, to show at its end, always with the word "Sponsored".
 *
 * Feeds read no database, so ads are shown from Redis: each compactor run publishes the ads that
 * haven't ended there (AdStore), and whoever shows one picks from those.
 */

export const AD_KINDS = ['text', 'image'] as const satisfies readonly AdKind[];

/** The longest text ad, or caption of an image ad, in UTF-16 code units. */
export const MAX_AD_TEXT_CHARS = 500;
/** The most hashtags an ad can be targeted at. */
export const MAX_AD_TAGS = 10;
/** The largest image an ad can have, in bytes: it goes out with every feed that shows the ad. */
export const MAX_AD_IMAGE_BYTES = 10 * 1024 * 1024;
/**
 * The most ads the server holds that haven't ended, those that are yet to start among them. They
 * are published as one key in Redis, which every feed reads, and this is what bounds it.
 */
export const MAX_OPEN_ADS = 100;

/**
 * Where a page of a feed has ads: before its 3rd, its 10th and its 17th post, counting the page's
 * posts from 1 in the order they are shown in. A page too short for one of them has no ad there.
 */
export const AD_POSITIONS: readonly number[] = [3, 10, 17];

/** An ad as the compactor publishes it and feeds and posts read it: what is shown, and what decides whether it is. */
export interface PublishedAd {
  adId: string;
  kind: AdKind;
  /** A text ad's text, or an image ad's caption. */
  text?: string;
  /** Where the ad leads when it is followed. */
  url?: string;
  /** The hashtags it is targeted at; null for one that appears all the time. */
  tags: string[] | null;
  /** It is shown from this instant (UTC epoch ms)... */
  startsAt: number;
  /** ...until this one; null for an ad with no end. */
  endsAt: number | null;
}

/** An ad as a response carries it. */
export interface AdRecord {
  adId: string;
  /** "Sponsored", in the language the request is answered in: what discloses that this is an ad. */
  label: string;
  kind: AdKind;
  /** An image ad's image. */
  imageUrl?: string;
  text?: string;
  url?: string;
}

/** An ad of a feed's page, and the post of the page it goes before (see AD_POSITIONS). */
export interface FeedAd extends AdRecord {
  position: number;
}

type AdRow = Pick<MonetizationTable, 'id' | 'kind' | 'text' | 'url' | 'tags' | 'starts_at' | 'ends_at'>;

/** The hashtags a row is targeted at, as a list; null for one that appears all the time. */
export const adTags = (tags: string | null): string[] | null => (tags === null ? null : tags.split(' ').filter(Boolean));

/** An ad's row as it is published. */
export const publishedAd = (row: AdRow): PublishedAd => ({
  adId: row.id,
  kind: row.kind,
  ...(row.text !== null && { text: row.text }),
  ...(row.url !== null && { url: row.url }),
  tags: adTags(row.tags),
  startsAt: row.starts_at,
  endsAt: row.ends_at,
});

/** Where its schedule has an ad at `at`: yet to start, being shown, or over. */
export function adStatus(ad: { startsAt: number; endsAt: number | null }, at: number): 'scheduled' | 'live' | 'ended' {
  if (ad.endsAt !== null && at >= ad.endsAt) return 'ended';
  return at >= ad.startsAt ? 'live' : 'scheduled';
}

/**
 * The ads to choose from where `tags` are shown, at `at`: those whose schedule has them shown
 * then, and that appear all the time or are targeted at one of `tags`. For a feed, `tags` are the
 * hashtags it reads; for a post, the ones it carries.
 */
export function eligibleAds(ads: PublishedAd[], tags: string[], at: number): PublishedAd[] {
  const shown = new Set(tags);
  return ads.filter((ad) => adStatus(ad, at) === 'live' && (ad.tags === null || ad.tags.some((tag) => shown.has(tag))));
}

/** Where an image ad's image is read. */
export const adImageUrl = (publicBaseUrl: string, adId: string) => `${publicBaseUrl}/monetization/ads/${adId}/image`;

/** An ad as a response carries it, under `label`. */
export const adRecord = (ad: Pick<PublishedAd, 'adId' | 'kind' | 'text' | 'url'>, label: string, publicBaseUrl: string): AdRecord => ({
  adId: ad.adId,
  label,
  kind: ad.kind,
  ...(ad.kind === 'image' && { imageUrl: adImageUrl(publicBaseUrl, ad.adId) }),
  ...(ad.text !== undefined && { text: ad.text }),
  ...(ad.url !== undefined && { url: ad.url }),
});

/** A 32-bit hash of `text` (FNV-1a, then murmur3's final mix), which spreads similar strings apart. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * `ads` in the order a page shows them in, which goes by `page`: whatever tells one page from
 * another (a feed's session seed and the cursor its page was asked with). The same page gets the
 * same order, so a request sent again shows the same ads, and each other page an order of its
 * own, so the ads of a feed take turns with no count kept of what was shown.
 */
export function orderAds(ads: PublishedAd[], page: string): PublishedAd[] {
  return ads
    .map((ad) => ({ ad, key: hash(`${page} ${ad.adId}`) }))
    .sort((a, b) => a.key - b.key || (a.ad.adId < b.ad.adId ? -1 : 1))
    .map(({ ad }) => ad);
}

/**
 * The ads of a page of `count` posts: one before each post that AD_POSITIONS names and the page
 * has, taken from `ads` in order, and from its start again where there are fewer ads than places.
 * None where there are no ads.
 */
export function placeAds<A>(ads: A[], count: number): { ad: A; position: number }[] {
  if (!ads.length) return [];
  return AD_POSITIONS.filter((position) => position <= count).map((position, i) => ({ ad: ads[i % ads.length]!, position }));
}
