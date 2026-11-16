import { z } from 'zod';
import type { Origin, Preview } from './storage/contentStore.js';

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

/** Text that content stored before post types was previewed by, which still reads as a text post. */
const isPlainText = (mimeType: string) => mimeType === TEXT_MIME || mimeType === 'text/markdown';

export const mediaUrl = (publicBaseUrl: string, contentId: string, version: number) =>
  `${publicBaseUrl}/content/${contentId}/raw?version=${version}`;

/** Where a version's bytes are read: here, or for federated content, on its origin server. */
export const bytesUrl = (publicBaseUrl: string, v: { contentId: string; version: number; origin?: Origin }) =>
  v.origin ? mediaUrl(v.origin.server, v.origin.contentId, v.origin.version) : mediaUrl(publicBaseUrl, v.contentId, v.version);

/**
 * A stored preview (in a meta file, a summary or a federated record) as feeds show it. An image's,
 * video's or audio's URL is always `bytesUrl`, where its bytes are read. Content stored before post
 * types has a "media" preview, or a text preview of a document: an image, video or audio file reads as
 * that type, plain text as a text post, and any other file (HTML, PDF, JSON, ...) as a link to its bytes.
 */
export function readPreview(stored: { kind: string; text?: string; url?: string }, mimeType: string, bytesUrl: string): Preview {
  const media = mediaType(mimeType);
  if (media) return { kind: media, url: bytesUrl, ...(stored.kind === media && stored.text ? { text: stored.text } : {}) };
  if (stored.kind === 'link' && mimeType === LINK_MIME && stored.url) return { kind: 'link', url: stored.url };
  if (stored.kind === 'text' && isPlainText(mimeType)) return { kind: 'text', text: stored.text ?? '' };
  return { kind: 'link', url: bytesUrl };
}

/** The preview of the version a meta file describes, its links to the bytes built for that version. */
export const previewOf = (
  meta: { contentId: string; version: number; mimeType: string; preview: { kind: string; text?: string; url?: string }; origin?: Origin },
  publicBaseUrl: string,
) => readPreview(meta.preview, meta.mimeType, bytesUrl(publicBaseUrl, meta));
