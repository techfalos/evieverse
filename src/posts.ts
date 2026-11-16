import { z } from 'zod';
import { cutFormatted } from './format.js';
import type { Preview } from './storage/contentStore.types.js';

/**
 * What a post is. An image, video or audio post is a file with an optional caption; a text post is its
 * text; a link post is a URL. Any other file (a PDF, a web page, a download) is posted as a link to it.
 */
export const POST_TYPES = ['image', 'video', 'audio', 'text', 'link'] as const;
export type PostType = (typeof POST_TYPES)[number];
export type MediaType = 'image' | 'video' | 'audio';

/** The content type of a text post, whose bytes are its text in UTF-8. */
export const TEXT_MIME = 'text/plain';
/** The content type of a link post, whose bytes are its URL. */
export const LINK_MIME = 'text/uri-list';

/** The longest text post or caption, in UTF-16 code units. */
export const MAX_TEXT_CHARS = 40_000;
/** The longest URL a `LinkUrl` can be, in characters, counted as the WHATWG parser writes it: a link post's, a repost's original, where an ad leads. */
const MAX_URL_CHARS = 2048;

/** An http or https URL, as the WHATWG parser writes it. */
export const LinkUrl = z
  .url({ protocol: /^https?$/ })
  .transform((u) => new URL(u).href)
  .pipe(z.string().max(MAX_URL_CHARS, `a link must be at most ${MAX_URL_CHARS} characters`));

/** The post type of files of `mimeType`, if they can be posted. */
export function mediaType(mimeType: string): MediaType | null {
  const type = mimeType.slice(0, mimeType.indexOf('/'));
  return type === 'image' || type === 'video' || type === 'audio' ? type : null;
}

/** Where a piece of content's bytes are read. */
export const mediaUrl = (publicBaseUrl: string, contentId: string) => `${publicBaseUrl}/content/${contentId}/raw`;

/** A preview as it's stored: an image's, video's or audio's URL is left out, or there but not used. */
export type StoredPreview =
  | { kind: 'text'; text: string }
  | { kind: MediaType; text?: string; url?: string }
  | { kind: 'link'; url: string };

/**
 * A stored preview (in a meta file or a summary) as feeds show it. An image's, video's or audio's URL
 * is always `bytesUrl`, where its bytes are read.
 */
export function readPreview(stored: StoredPreview, bytesUrl: string): Preview {
  if (stored.kind === 'text') return { kind: 'text', text: stored.text };
  if (stored.kind === 'link') return { kind: 'link', url: stored.url };
  return { kind: stored.kind, url: bytesUrl, ...(stored.text ? { text: stored.text } : {}) };
}

/** Where the bytes of the original of a repost from another server are read: on that server. */
export const originMediaUrl = (origin: { url: string }) => `${origin.url}/raw`;

/**
 * The preview of the content a meta file describes, its link to the bytes built for this server.
 * A repost of a post on another server links to the original's bytes, which this server doesn't hold.
 */
export const previewOf = (meta: { contentId: string; preview: StoredPreview; origin?: { url: string } }, publicBaseUrl: string) =>
  readPreview(meta.preview, meta.origin ? originMediaUrl(meta.origin) : mediaUrl(publicBaseUrl, meta.contentId));

/**
 * Cuts a text post's text or a caption to the length of this server's previews. The text is
 * formatted (format.ts), and so is its preview: what is bold or a link where the text is cut is
 * closed there.
 */
export const previewCutter = (feed: { previewWords: number; previewChars: number }) => (text: string) =>
  cutFormatted(text, feed.previewWords, feed.previewChars);
