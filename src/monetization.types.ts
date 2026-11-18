import type { AdKind } from './db/schema.js';

/** An ad as the compactor publishes it and feeds and posts read it: what is shown, and what decides whether it is. */
export interface PublishedAd {
  adId: string;
  kind: AdKind;
  /** A text ad's text, or an image ad's caption. */
  text?: string;
  /** An image ad's alternative text: what describes its image to those who can't see it. Absent on one that was given none. */
  imageAlt?: string;
  /** Where the ad leads when it is followed. Whoever shows the ad only reads whether it leads anywhere: what it sends is adClickUrl. */
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
  /** The alternative text to give that image, for those who can't see it. Absent on an ad that was given none: its caption is then all that says what it is. */
  imageAlt?: string;
  text?: string;
  /** Where the ad is followed, if it leads anywhere: the server's link, which counts the click and redirects to where the ad leads (adClickUrl). */
  url?: string;
}

/** An ad of a feed's page, and the post of the page it goes before (see AD_POSITIONS). */
export interface FeedAd extends AdRecord {
  position: number;
}
