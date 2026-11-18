import { z } from 'zod';
import { cutFormatted } from './format.js';
import type { Mention } from './mentions.types.js';
import type { Preview, StoredVideo } from './storage/contentStore.types.js';

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
/** The most images an image post can have: one, or an album of up to this many, in the order they were sent. */
export const MAX_POST_IMAGES = 10;
/**
 * The longest alternative text of an image, in UTF-16 code units: what describes the image to
 * those who can't see it, which a screen reader reads out in its place. Long enough for a chart
 * or a screenshot of text, and short enough to be read out.
 */
export const MAX_ALT_CHARS = 1500;
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

/**
 * Where an image of an image post is read, given where the post's bytes are (`bytesUrl`, see
 * mediaUrl): its place among the post's images, counted from 1, after that address. The first is
 * the post's bytes, and is read at the address itself too.
 */
export const imageUrl = (bytesUrl: string, image: number) => (image === 1 ? bytesUrl : `${bytesUrl}/${image}`);

/**
 * How many images a post has, by its preview: one, unless it is an image post of several. Any
 * other post has its bytes, which are read as the first image's are.
 */
export const imageCount = (preview: StoredPreview): number => (preview.kind === 'image' && preview.imageCount !== undefined && preview.imageCount > 1 ? preview.imageCount : 1);

/**
 * The alternative texts a preview has of its post's images, one for each image in their order
 * ('' for an image that has none): what `alt` of a preview holds. Undefined where no image has
 * any, and for a post that is no image post, which is how a preview without `alt` reads.
 */
export const altsOf = (preview: StoredPreview): string[] | undefined =>
  preview.kind === 'image' && preview.alt?.some((alt) => alt !== '') ? Array.from({ length: imageCount(preview) }, (_, i) => preview.alt![i] ?? '') : undefined;

/**
 * Where a file of a processed video is read (see StoredVideo), given where the post's bytes are
 * (`bytesUrl`, see mediaUrl, which ends in /raw): beside them, under the id of that version of
 * the video. `file` is `poster.jpg`, `master.m3u8`, or a file the master playlist leads to.
 */
export const videoFileUrl = (bytesUrl: string, videoId: string, file: string) => `${bytesUrl.replace(/\/raw$/, '')}/video/${videoId}/${file}`;

/**
 * A preview as it's stored: an image's, video's or audio's URL is left out, or there but not
 * used, and so are the addresses of a processed video's poster and stream.
 */
export type StoredPreview =
  | { kind: 'text'; text: string }
  | { kind: MediaType; text?: string; url?: string; imageCount?: number; alt?: string[]; video?: StoredVideo }
  | { kind: 'link'; url: string };

/**
 * A stored preview (in a meta file or a summary) as feeds show it. An image's, video's or audio's URL
 * is always `bytesUrl`, where its bytes are read. An image post of several images says how many,
 * and one whose images are described says how (see altsOf). A processed video says what it is,
 * with where its poster and its stream are read, beside its bytes (see videoFileUrl).
 */
export function readPreview(stored: StoredPreview, bytesUrl: string): Preview {
  if (stored.kind === 'text') return { kind: 'text', text: stored.text };
  if (stored.kind === 'link') return { kind: 'link', url: stored.url };
  const images = stored.kind === 'image' && stored.imageCount !== undefined && stored.imageCount > 1 ? { imageCount: stored.imageCount } : {};
  const alt = altsOf(stored);
  const video = stored.kind === 'video' ? stored.video : undefined;
  return {
    kind: stored.kind,
    url: bytesUrl,
    ...(stored.text ? { text: stored.text } : {}),
    ...images,
    ...(alt && { alt }),
    ...(video && {
      video: {
        id: video.id,
        width: video.width,
        height: video.height,
        duration: video.duration,
        poster: videoFileUrl(bytesUrl, video.id, 'poster.jpg'),
        hls: videoFileUrl(bytesUrl, video.id, 'master.m3u8'),
      },
    }),
  };
}

/**
 * This server's own address (PUBLIC_BASE_URL) as the URL parser writes it, with no slash at its
 * end: what the address of each of its posts starts with. Null where the setting names none, and
 * no address is then known to be the server's own.
 */
export function ownAddress(publicBaseUrl: string): string | null {
  if (!publicBaseUrl) return null;
  try {
    return new URL(publicBaseUrl).href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** A post's address on the server at `base`, where GET /content/:id reads it. */
export const postAddress = (base: string, contentId: string) => `${base}/content/${contentId}`;

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
 * closed there. `mentions` is who the text mentions (src/mentions.ts), which its preview is then
 * read with too: it has each of them whole, or not at all.
 */
export const previewCutter = (feed: { previewWords: number; previewChars: number }) => (text: string, mentions?: readonly Mention[]) =>
  cutFormatted(text, feed.previewWords, feed.previewChars, mentions);
