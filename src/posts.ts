import { z } from 'zod';
import type { Preview } from './storage/contentStore.js';

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

/** The preview of the content a meta file describes, its link to the bytes built for this server. */
export const previewOf = (meta: { contentId: string; preview: StoredPreview }, publicBaseUrl: string) =>
  readPreview(meta.preview, mediaUrl(publicBaseUrl, meta.contentId));

/** The first `maxWords` words of `text`, cut to `maxChars` characters, which bounds text written without spaces. */
function firstWords(text: string, maxWords: number, maxChars: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  let out = words.slice(0, maxWords).join(' ');
  let cut = words.length > maxWords;
  if (out.length > maxChars) {
    // Not between the halves of a surrogate pair.
    const code = out.charCodeAt(maxChars - 1);
    out = out.slice(0, code >= 0xd800 && code <= 0xdbff ? maxChars - 1 : maxChars).trimEnd();
    cut = true;
  }
  return cut ? `${out} …` : out;
}

/** Cuts a text post's text or a caption to the length of this server's previews. */
export const previewCutter = (feed: { previewWords: number; previewChars: number }) => (text: string) =>
  firstWords(text, feed.previewWords, feed.previewChars);
