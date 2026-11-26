import { parseFormatted, plainText, type Inline } from '../format.js';
import type { Mention } from '../mentions.types.js';
import type { FeedAd } from '../monetization.types.js';
import { imageCount, imageUrl, postAddress } from '../posts.js';
import type { FeedRecord } from '../tagfeed/layout.types.js';
import type { RssChannel } from './rss.types.js';

/**
 * A page of a hashtag feed as an RSS 2.0 document (GET /feed, `format=rss`), for the readers that
 * take one: the same records as the JSON has, in the same order, each an
 * item. A post's text is formatted (src/format.ts), which a client reads to show it; a feed
 * reader reads HTML, so an item's description is the text as HTML, with the post's images.
 *
 * An item has no title unless its post has text: its title is then how the text starts.
 */

/** The most characters of a post's text that an item's title has. */
const TITLE_CHARS = 100;
/** What no XML 1.0 document may hold, escaped or not: the control characters but for tab and the two line ends, and half a surrogate pair. */
const NOT_XML = /[^\x09\x0A\x0D\x20-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;
/** The characters that are markup, in XML and in HTML alike, each with what it is written as where it is meant as itself. */
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` as the content of an element or the value of an attribute, in XML or in HTML: nothing in it is markup. */
const esc = (text: string) => text.replace(NOT_XML, '').replace(/[&<>"']/g, (c) => ESCAPES[c]!);

/** An element with `text` as its content; none at all for a text that is empty or isn't there. */
const element = (name: string, text: string | undefined, attributes = '') => (text ? `<${name}${attributes}>${esc(text)}</${name}>` : '');

/** What is within a block of a formatted text, as HTML. A mention is the name it is written with: a feed reader has no profile to lead to. */
const inline = (nodes: Inline[]): string =>
  nodes
    .map((node): string => {
      switch (node.type) {
        case 'text':
          return esc(node.text);
        case 'code':
          return `<code>${esc(node.text)}</code>`;
        case 'break':
          return '<br>';
        case 'bold':
          return `<strong>${inline(node.children)}</strong>`;
        case 'italic':
          return `<em>${inline(node.children)}</em>`;
        case 'strike':
          return `<del>${inline(node.children)}</del>`;
        case 'link':
          return `<a href="${esc(node.url)}">${inline(node.children)}</a>`;
        case 'mention':
          return esc(`@${node.username}`);
      }
    })
    .join('');

/** A formatted text as HTML: its paragraphs, quotes and lists. `mentions` is who it mentions (see parseFormatted). */
function html(text: string, mentions: readonly Mention[] = []): string {
  return parseFormatted(text, mentions)
    .map((block) => {
      if (block.type !== 'list') return block.type === 'quote' ? `<blockquote>${inline(block.children)}</blockquote>` : `<p>${inline(block.children)}</p>`;
      const items = block.items.map((item) => `<li>${inline(item)}</li>`).join('');
      return block.ordered ? `<ol start="${block.start}">${items}</ol>` : `<ul>${items}</ul>`;
    })
    .join('');
}

/** How a post's text starts, on one line, as a reader reads it: what its item is titled. Cut to TITLE_CHARS, and then it ends in "…". */
function titleOf(text: string): string {
  const chars = [...plainText(text).replace(/\s+/g, ' ').trim()];
  return chars.length > TITLE_CHARS ? `${chars.slice(0, TITLE_CHARS).join('').trimEnd()}…` : chars.join('');
}

/** A link to `url`, shown as `shown` (HTML), or as the address itself. */
const anchor = (url: string, shown = esc(url)) => `<p><a href="${esc(url)}">${shown}</a></p>`;

/**
 * What a record's item describes it with, as HTML: its text, then what it is a post of. An
 * image post's images, each with its alternative text; a video's poster, where the server made
 * one, as a link to the video; a link to an audio file, or to what a link post links to. It is
 * never empty, which an item that has no title needs.
 */
function describe({ preview, mentions }: FeedRecord): string {
  if (preview.kind === 'text') return html(preview.text, mentions);
  if (preview.kind === 'link') return anchor(preview.url);
  const text = preview.text ? html(preview.text, mentions) : '';
  if (preview.kind === 'image') {
    const images = Array.from({ length: imageCount(preview) }, (_, i) => `<p><img src="${esc(imageUrl(preview.url, i + 1))}" alt="${esc(preview.alt?.[i] ?? '')}"></p>`);
    return text + images.join('');
  }
  return text + anchor(preview.url, preview.video && `<img src="${esc(preview.video.poster)}" alt="">`);
}

/**
 * A record as an item. It links to the post's own address on this server (`base` is the
 * server's, PUBLIC_BASE_URL), and is told from every other item by the post's id. Its date is
 * when the post was placed in the feed: its repost's, for a record a repost put there. An
 * image's, video's or audio's file is its enclosure, with no length: a record doesn't say one.
 */
function recordItem(record: FeedRecord, base: string): string {
  const { preview } = record;
  const text = preview.kind === 'link' ? undefined : preview.text;
  return [
    '<item>',
    element('title', text && titleOf(text)),
    element('link', postAddress(base, record.contentId)),
    element('guid', record.contentId, ' isPermaLink="false"'),
    element('pubDate', new Date(record.repost?.at ?? record.createdAt).toUTCString()),
    element('dc:creator', record.publisher.username),
    ...record.tags.map((tag) => element('category', tag)),
    element('description', describe(record)),
    preview.kind === 'text' || preview.kind === 'link' ? '' : `<enclosure url="${esc(preview.url)}" type="${esc(record.mimeType)}" length="0"/>`,
    '</item>\n',
  ].join('');
}

/**
 * An ad as an item, titled with its label ("Sponsored"): its image and its text, and the link
 * that counts the click, where it leads anywhere. An ad is one item to a feed reader however
 * many of a page's places it takes, and whichever pages it is on: its id tells it from the others.
 */
function adItem(ad: FeedAd): string {
  const image = ad.imageUrl ? `<p><img src="${esc(ad.imageUrl)}" alt="${esc(ad.imageAlt ?? '')}"></p>` : '';
  return [
    '<item>',
    element('title', ad.label),
    element('link', ad.url),
    element('guid', `ad:${ad.adId}`, ' isPermaLink="false"'),
    element('description', image + (ad.text ? `<p>${esc(ad.text)}</p>` : '')),
    '</item>\n',
  ].join('');
}

/**
 * Streams a page of a feed as an RSS 2.0 document: the channel, then an item for each of
 * `records`, in their order (see `pageRecords`). `ads` are the page's ads, where the server shows
 * ads in feeds: each is an item before the record its `position` names, counted from 1.
 *
 * A page that has one after it says where, as feeds that come in pages do (RFC 5005): a link
 * with `rel="next"`, beside the one to the page itself.
 */
export function* renderRss(channel: RssChannel, records: FeedRecord[], ads: FeedAd[], base: string): Generator<Buffer> {
  const link = (rel: string, url: string) => `<atom:link rel="${rel}" type="application/rss+xml" href="${esc(url)}"/>\n`;
  yield Buffer.from(
    [
      '<?xml version="1.0" encoding="UTF-8"?>\n',
      '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">\n<channel>\n',
      `${element('title', channel.title)}\n`,
      `${element('link', channel.url)}\n`,
      `${element('description', channel.description)}\n`,
      `${element('language', channel.language)}\n`,
      link('self', channel.url),
      channel.next === null ? '' : link('next', channel.next),
    ].join(''),
  );
  for (const [i, record] of records.entries()) {
    yield Buffer.from(
      ads
        .filter((ad) => ad.position === i + 1)
        .map(adItem)
        .join('') + recordItem(record, base),
    );
  }
  yield Buffer.from('</channel>\n</rss>\n');
}
