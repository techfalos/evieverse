import { describe, expect, it } from 'vitest';
import { renderRss } from '../src/feed/rss.js';
import type { FeedAd } from '../src/monetization.types.js';
import type { FeedRecord } from '../src/tagfeed/layout.types.js';

const BASE = 'https://api.example';
const ALICE = { userId: '0a6f1c9e-3b1d-4c55-9a0e-1f2d3c4b5a69', username: 'alice' };
const ANN = { userId: '7d2b8e4f-9c3a-4e1b-8f6d-5a4c3b2e1d0f', username: 'Ann Lee' };

let seq = 0;
/** A feed record of a text post, with what a test says of it. */
const record = (over: Partial<FeedRecord> = {}): FeedRecord => ({
  contentId: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
  publisher: ALICE,
  mimeType: 'text/plain',
  aiGenerated: false,
  comments: false,
  preview: { kind: 'text', text: 'hello' },
  tags: ['news'],
  likes: 0,
  views: 0,
  dislikes: null,
  createdAt: '2026-11-06T12:00:00.000Z',
  updatedAt: '2026-11-06T12:00:00.000Z',
  ...over,
});

/** The document of a page of `records`. */
const render = (records: FeedRecord[], { ads = [] as FeedAd[], next = null as string | null, base = BASE } = {}) =>
  Buffer.concat([...renderRss({ title: '#news, #cats', description: 'Posts under #news, #cats', url: `${base}/feed?tags=news%2Ccats&format=rss`, next, language: 'en' }, records, ads, base)]).toString('utf8');

/** What an escaped text or attribute says. */
const unescape = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
/** What each `name` element of `xml` holds, as it reads. */
const all = (xml: string, name: string) => [...xml.matchAll(new RegExp(`<${name}(?: [^>]*)?>(.*?)</${name}>`, 'gs'))].map((m) => unescape(m[1]!));
const one = (xml: string, name: string) => {
  const found = all(xml, name);
  expect(found, name).toHaveLength(1);
  return found[0]!;
};
const items = (xml: string) => [...xml.matchAll(/<item>(.*?)<\/item>/gs)].map((m) => m[1]!);
/** The one item of a page of one record. */
const itemOf = (r: FeedRecord) => {
  const found = items(render([r]));
  expect(found).toHaveLength(1);
  return found[0]!;
};

/** Holds a document to what an XML parser holds it to, as far as a test can: its elements nest, and nothing else in it is markup. */
function expectWellFormed(xml: string) {
  expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
  const body = xml.slice(xml.indexOf('\n') + 1);
  const TAG = /<(\/?)([\w:]+)((?:\s+[\w:]+="[^"<]*")*)\s*(\/?)>/g;
  const open: string[] = [];
  for (const [, closes, name, , empty] of body.matchAll(TAG)) {
    if (empty) continue;
    if (closes) expect(open.pop()).toBe(name);
    else open.push(name!);
  }
  expect(open).toEqual([]);
  expect(body.replace(TAG, '')).not.toContain('<');
  expect(body).not.toMatch(/&(?!(?:amp|lt|gt|quot|#39);)/);
  expect(body).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/);
}

describe('a feed as RSS', () => {
  it('names the feed, says where the page and the one after it are read, and has an item for each record in their order', () => {
    const records = [record(), record(), record()];
    const next = `${BASE}/feed?tags=news%2Ccats&format=rss&cursor=abc`;
    const xml = render(records, { next });
    expectWellFormed(xml);
    expect(xml).toContain('<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">');
    const channel = xml.slice(0, xml.indexOf('<item>'));
    expect([one(channel, 'title'), one(channel, 'description'), one(channel, 'language')]).toEqual(['#news, #cats', 'Posts under #news, #cats', 'en']);
    expect(one(channel, 'link')).toBe(`${BASE}/feed?tags=news%2Ccats&format=rss`);
    // The `&` of an address is written as XML has it.
    expect(channel).toContain(`<atom:link rel="self" type="application/rss+xml" href="${BASE}/feed?tags=news%2Ccats&amp;format=rss"/>`);
    expect(channel).toContain(`<atom:link rel="next" type="application/rss+xml" href="${next.replace(/&/g, '&amp;')}"/>`);
    expect(items(xml).map((item) => one(item, 'guid'))).toEqual(records.map((r) => r.contentId));

    // The last page names none after it, and a page with no record is a channel alone.
    expect(render(records)).not.toContain('rel="next"');
    const empty = render([]);
    expectWellFormed(empty);
    expect(items(empty)).toEqual([]);
  });

  it('gives an item its post: where it is read, when it was posted, who by, and its hashtags', () => {
    const r = record({ tags: ['news', 'cats'], preview: { kind: 'text', text: 'A quiet morning in #news' } });
    const item = itemOf(r);
    expect(one(item, 'title')).toBe('A quiet morning in #news');
    expect(one(item, 'link')).toBe(`${BASE}/content/${r.contentId}`);
    expect(item).toContain(`<guid isPermaLink="false">${r.contentId}</guid>`);
    expect(one(item, 'pubDate')).toBe('Fri, 06 Nov 2026 12:00:00 GMT');
    expect(one(item, 'dc:creator')).toBe('alice');
    expect(all(item, 'category')).toEqual(['news', 'cats']);
    expect(one(item, 'description')).toBe('<p>A quiet morning in #news</p>');
    expect(item).not.toContain('<enclosure');

    // A record a repost put in the feed is dated when it was reposted, which is where the feed has it.
    expect(one(itemOf(record({ repost: { at: '2026-11-07T08:30:00.000Z' } })), 'pubDate')).toBe('Sat, 07 Nov 2026 08:30:00 GMT');
    // A publisher the server has no credit for is not named, and a server with no address of its own links from its root.
    expect(itemOf(record({ publisher: { userId: ALICE.userId, username: '' } }))).not.toContain('dc:creator');
    const local = record();
    expect(one(items(render([local], { base: '' }))[0]!, 'link')).toBe(`/content/${local.contentId}`);
  });

  it("writes a post's formatted text as HTML, and titles the item with how the text starts", () => {
    const text = '**Big** news, _really_: ~~old~~ `code` [the story](https://example.com/a?b=1&c=2) by @Ann Lee and @nobody https://example.org/x.';
    const item = itemOf(record({ preview: { kind: 'text', text }, mentions: [ANN] }));
    expect(one(item, 'description')).toBe(
      '<p><strong>Big</strong> news, <em>really</em>: <del>old</del> <code>code</code> <a href="https://example.com/a?b=1&amp;c=2">the story</a> by @Ann Lee and @nobody <a href="https://example.org/x">https://example.org/x</a>.</p>',
    );
    expect(one(item, 'title')).toBe('Big news, really: old code the story by @Ann Lee and @nobody https://example.org/x.');

    // Blocks: a quote, a list of each kind, and a line break within a paragraph.
    const blocks = itemOf(record({ preview: { kind: 'text', text: '> said\n\n- one\n- two\n\n3. three\n4. four\n\nfirst line\nsecond' } }));
    expect(one(blocks, 'description')).toBe('<blockquote>said</blockquote><ul><li>one</li><li>two</li></ul><ol start="3"><li>three</li><li>four</li></ol><p>first line<br>second</p>');

    // A long text is cut for its title, between characters and not within one.
    const long = itemOf(record({ preview: { kind: 'text', text: `${'ab '.repeat(40)}😀😀` } }));
    expect(one(long, 'title')).toBe(`${'ab '.repeat(33)}a…`);
    const emoji = one(itemOf(record({ preview: { kind: 'text', text: '😀'.repeat(150) } })), 'title');
    expect(emoji).toBe(`${'😀'.repeat(100)}…`);
  });

  it('writes what a post says as text, never as markup, and leaves out what no XML document can hold', () => {
    const text = '<script>alert("1")</script> & <b>bold</b> it\'s \u0000null\u0008 and \u001Fmore \uD800half';
    const xml = render([record({ preview: { kind: 'text', text }, publisher: { ...ALICE, username: '<al&ice>' }, tags: ['news'] })]);
    expectWellFormed(xml);
    const [item] = items(xml);
    // What a feed reader shows, once it has read the XML and then the HTML: the characters of the post.
    expect(unescape(one(item!, 'description'))).toBe('<p><script>alert("1")</script> & <b>bold</b> it\'s null and more half</p>');
    expect(one(item!, 'description')).not.toMatch(/<(script|b)>/);
    expect(one(item!, 'dc:creator')).toBe('<al&ice>');
    expect(xml).not.toContain('<script>');
    expect(xml).not.toContain('<al&ice>');
  });

  it('shows an image post its images with their alternative texts, and gives a file as an enclosure', () => {
    const url = `${BASE}/content/abc/raw`;
    const album = itemOf(record({ mimeType: 'image/png', preview: { kind: 'image', url, text: 'Two *views*', imageCount: 2, alt: ['A "red" door', ''] } }));
    expect(one(album, 'title')).toBe('Two views');
    expect(one(album, 'description')).toBe(`<p>Two <em>views</em></p><p><img src="${url}" alt="A &quot;red&quot; door"></p><p><img src="${url}/2" alt=""></p>`);
    expect(album).toContain(`<enclosure url="${url}" type="image/png" length="0"/>`);

    // With no caption there is nothing to title it with: the description is all it has.
    const bare = itemOf(record({ mimeType: 'image/jpeg', preview: { kind: 'image', url } }));
    expect(bare).not.toContain('<title>');
    expect(one(bare, 'description')).toBe(`<p><img src="${url}" alt=""></p>`);
  });

  it('links a video, by its poster where it has one, an audio file, and what a link post links to', () => {
    const url = `${BASE}/content/abc/raw`;
    const video = { id: 'v1', width: 640, height: 360, duration: 12, poster: `${BASE}/content/abc/video/v1/poster.jpg`, hls: `${BASE}/content/abc/video/v1/master.m3u8` };
    const processed = itemOf(record({ mimeType: 'video/mp4', preview: { kind: 'video', url, video } }));
    expect(one(processed, 'description')).toBe(`<p><a href="${url}"><img src="${video.poster}" alt=""></a></p>`);
    expect(processed).toContain(`<enclosure url="${url}" type="video/mp4" length="0"/>`);

    const audio = itemOf(record({ mimeType: 'audio/mpeg', preview: { kind: 'audio', url, text: 'Episode 1' } }));
    expect(one(audio, 'description')).toBe(`<p>Episode 1</p><p><a href="${url}">${url}</a></p>`);
    expect(audio).toContain(`<enclosure url="${url}" type="audio/mpeg" length="0"/>`);

    const link = itemOf(record({ mimeType: 'text/uri-list', preview: { kind: 'link', url: 'https://example.com/?a=1&b=2' } }));
    expect(link).not.toContain('<title>');
    expect(link).not.toContain('<enclosure');
    expect(one(link, 'description')).toBe('<p><a href="https://example.com/?a=1&amp;b=2">https://example.com/?a=1&amp;b=2</a></p>');
  });

  it("puts the page's ads before the records their positions name, each under its label", () => {
    const records = Array.from({ length: 4 }, () => record());
    const text: FeedAd = { adId: 'ad-1', label: 'Sponsored', kind: 'text', text: 'Fresh <coffee>', url: `${BASE}/monetization/ads/ad-1/click`, position: 3 };
    const image: FeedAd = { adId: 'ad-2', label: 'Sponsored', kind: 'image', imageUrl: `${BASE}/monetization/ads/ad-2/image`, imageAlt: 'A cup', position: 1 };
    const xml = render(records, { ads: [text, image] });
    expectWellFormed(xml);
    const found = items(xml);
    expect(found.map((item) => one(item, 'guid'))).toEqual(['ad:ad-2', records[0]!.contentId, records[1]!.contentId, 'ad:ad-1', records[2]!.contentId, records[3]!.contentId]);
    expect([one(found[3]!, 'title'), one(found[3]!, 'link'), one(found[3]!, 'description')]).toEqual(['Sponsored', text.url, '<p>Fresh &lt;coffee&gt;</p>']);
    // An ad that leads nowhere has no link.
    expect(found[0]).not.toContain('<link>');
    expect(one(found[0]!, 'description')).toBe(`<p><img src="${image.imageUrl}" alt="A cup"></p>`);
  });
});
