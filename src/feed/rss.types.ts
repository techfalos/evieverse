/** What an RSS document says of the feed it is a page of, apart from its records: GET /feed makes it from the request. */
export interface RssChannel {
  /** The feed's name: the hashtags it is of. */
  title: string;
  /** What the feed is, in the language the request is answered in. */
  description: string;
  /** Where this page is read: the address the request was made at. */
  url: string;
  /** Where the next page is read; null for a page the window has nothing after. */
  next: string | null;
  /** The code of the language the request is answered in, which the channel's own words are in. */
  language: string;
}
