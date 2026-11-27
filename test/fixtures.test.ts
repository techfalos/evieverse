import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';
import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { cutFormatted, mentionsIn, plainText } from '../src/format.js';
import type { Mention } from '../src/mentions.types.js';
import { likeKey, payloadBytes, payloadOf, UNNUMBERED } from '../src/pending.js';
import type { CommentLikePayload, CommentPutPayload, CommentRemovePayload, PostPayload } from '../src/pending.types.js';
import { CommentStore, ContentStore, createHotStore, SummaryStore, stagedKey, type BytesOwner, type Comment, type ContentMeta, type Summary, type SummaryRef } from '../src/storage/index.js';
import { decodeSummary, encodeSummary, summaryKey, summaryObjectKey } from '../src/storage/summaryStore.js';
import { authorIndex, compareRecent, compareRecords, DAY_ENTRY_BYTES, dayEntryBytes, dayKey, dayQuota, headKey, indexAuthor, LAYOUT_VERSION, manifestKey, packDay, unpackDay } from '../src/tagfeed/layout.js';
import type { Head, IndexEntry, Manifest } from '../src/tagfeed/layout.types.js';
import { DAY, HOUR } from '../src/time.js';
import { TEST_REDIS_URL } from './helpers.js';

/**
 * The formats the API and the compactor both read and write, held together: what is stored in
 * Redis, in the object stores and in `pending_writes` is written by this code and by the Rust
 * crates (compactor/crates/core), each of which keeps the format on its own.
 *
 * The files of `fixtures/` say what each format is of a set of inputs, as this code makes it.
 * These tests make them again and compare, and the tests of that crate
 * (compactor/crates/core/tests/fixtures.rs) read the same files and make the same of the same
 * inputs. So a change of a format on one side fails here or there until the other side has it too.
 *
 * `fixtures/from-rust.json` goes the other way: what the Rust code wrote, which this code reads.
 *
 * To write the files again after a change that is meant:
 *
 *   UPDATE_FIXTURES=1 npx vitest run test/fixtures.test.ts
 *   (cd compactor && UPDATE_FIXTURES=1 cargo test -p evieverse-core --test fixtures)
 */
const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const UPDATE = process.env.UPDATE_FIXTURES === '1';

/** What a fixture file holds. */
const read = (name: string): unknown => JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8'));

/** Holds `made` to fixtures/<name>.json; with UPDATE_FIXTURES=1, writes it there instead. */
function golden(name: string, made: unknown) {
  // Through JSON, as the file has it: what is undefined is left out.
  const text = `${JSON.stringify(made, null, 2)}\n`;
  if (UPDATE) {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(join(DIR, `${name}.json`), text);
    return;
  }
  expect(read(name), `fixtures/${name}.json is not what the code makes: if the change is meant, see the top of test/fixtures.test.ts`).toEqual(JSON.parse(text));
}

/** Ids as the server makes them, fixed: users, posts, comments (which sort by when they were sent), a video, a staged write. */
const U1 = '0198c0de-0000-4000-8000-0000000000a1';
const U2 = '0198c0de-0000-4000-8000-0000000000a2';
const P1 = '0198c0de-1111-4000-8000-000000000001';
const P2 = '0198c0de-1111-4000-8000-000000000002';
const P3 = '0198c0de-1111-4000-8000-000000000003';
const C1 = '0198c0de-aaaa-7000-8000-000000000001';
const C2 = '0198c0de-aaaa-7000-8000-000000000002';
const C3 = '0198c0de-aaaa-7000-8000-000000000003';
const C4 = '0198c0df-bbbb-7000-8000-000000000004';
const V1 = '0198c0de-2222-4000-8000-000000000001';
const W1 = '0198c0de-3333-4000-8000-000000000001';

/** The time the fixtures are made at: every time in them is told from it. */
const NOW = Date.UTC(2026, 10, 6, 12);
const BASE = 'https://api.example.com';

describe('the feed index', () => {
  it('is laid out as the fixture has it', () => {
    const entries: IndexEntry[] = [
      { contentId: P1, createdAt: NOW - 1234, likes: 0, views: 0, dislikes: 0, aiGenerated: false, moderated: false, repost: false },
      { contentId: P2, createdAt: NOW - HOUR, likes: 7, views: 1234, dislikes: 2, aiGenerated: true, moderated: false, repost: false },
      { contentId: P3, createdAt: NOW - HOUR + 999, likes: 7, views: 70_000, dislikes: 0, aiGenerated: false, moderated: true, repost: true },
      { contentId: U1, createdAt: 0, likes: 5_000_000_000, views: 6_000_000_000, dislikes: 7_000_000_000, aiGenerated: true, moderated: true, repost: true },
      { contentId: U2, createdAt: -5000, likes: 1, views: -3, dislikes: -1, aiGenerated: false, moderated: false, repost: false },
    ];
    const hex = packDay(entries).toString('hex');
    // The same day as version 5 of the layout held it, before entries had views and dislikes: the start of each entry.
    const v5Hex = entries.map((_, i) => hex.slice(i * DAY_ENTRY_BYTES * 2, i * DAY_ENTRY_BYTES * 2 + dayEntryBytes(5) * 2)).join('');
    const head: Head = { v: LAYOUT_VERSION, manifest: '1794052800000-0a1b2c3d', compactedAt: NOW };
    const manifest: Manifest = {
      v: LAYOUT_VERSION,
      tag: 'news',
      id: '1794052800000-0a1b2c3d',
      createdAt: NOW,
      days: [
        { day: 20763, gen: '20763-1794052800000-99887766', quota: 400, count: 3 },
        { day: 20762, gen: '20762-1794000000000-00112233', quota: 200, count: 200 },
      ],
    };
    golden('layout', {
      day: {
        entries,
        entryBytes: dayEntryBytes(LAYOUT_VERSION),
        hex,
        unpacked: unpackDay(Buffer.from(hex, 'hex')),
        withBytesLeftOver: unpackDay(Buffer.from(`${hex}ffff`, 'hex')).length,
        v5: { entryBytes: dayEntryBytes(5), hex: v5Hex, unpacked: unpackDay(Buffer.from(v5Hex, 'hex'), 5) },
      },
      order: {
        byRecords: [...entries].sort(compareRecords).map((e) => e.contentId),
        byRecent: [...entries].sort(compareRecent).map((e) => e.contentId),
      },
      quotas: [
        [0, 400, 40],
        [1, 400, 40],
        [3, 400, 40],
        [4, 400, 40],
        [9, 400, 40],
        [89, 400, 40],
        [-2, 400, 40],
        [2, 1001, 1],
        [1, 5, 40],
      ].map(([ageDays, max, min]) => ({ ageDays, max, min, quota: dayQuota(ageDays!, max!, min!) })),
      keys: {
        tag: 'news',
        userId: U1,
        authorIndex: authorIndex(U1),
        indexAuthor: [indexAuthor(authorIndex(U1)), indexAuthor('news')],
        headKey: headKey('news'),
        authorHeadKey: headKey(authorIndex(U1)),
        manifestKey: manifestKey('news', manifest.id),
        dayKey: dayKey('news', manifest.days[0]!.gen),
      },
      // As they are stored: the text itself.
      head: JSON.stringify(head),
      emptyHead: JSON.stringify({ v: LAYOUT_VERSION, manifest: null, compactedAt: 0 } satisfies Head),
      manifest: JSON.stringify(manifest),
    });
  });
});

/** The summaries the fixtures are of, each by a name that says what it has. */
const SUMMARIES: Record<string, Summary> = {
  text: {
    contentId: P1,
    createdAt: NOW - DAY,
    updatedAt: NOW - DAY,
    userId: U1,
    mimeType: 'text/plain',
    aiGenerated: false,
    comments: true,
    tags: ['news', 'world'],
    preview: { kind: 'text', text: 'hello #news\nand a second line, with "quotes" and ünïcödé 🎉' },
  },
  mentions: {
    contentId: P1,
    createdAt: NOW - DAY,
    updatedAt: NOW - HOUR,
    userId: U1,
    mimeType: 'text/markdown',
    aiGenerated: true,
    comments: false,
    tags: ['news'],
    preview: { kind: 'text', text: 'hi @bob' },
    mentions: [{ userId: U2, username: 'bob' }],
  },
  noTags: {
    contentId: P1,
    createdAt: NOW,
    updatedAt: NOW,
    userId: U1,
    mimeType: 'text/plain',
    aiGenerated: false,
    comments: false,
    tags: [],
    preview: { kind: 'text', text: '' },
  },
  link: {
    contentId: P2,
    createdAt: NOW - 2 * DAY,
    updatedAt: NOW - 2 * DAY,
    userId: U2,
    mimeType: 'text/uri-list',
    aiGenerated: false,
    comments: true,
    tags: ['links'],
    preview: { kind: 'link', url: 'https://example.com/a?b=c d' },
  },
  image: {
    contentId: P2,
    createdAt: NOW - 3 * DAY,
    updatedAt: NOW - 3 * DAY,
    userId: U2,
    mimeType: 'image/png',
    aiGenerated: false,
    comments: true,
    tags: ['art'],
    preview: { kind: 'image', url: `${BASE}/content/${P2}/raw`, text: 'a caption' },
  },
  album: {
    contentId: P2,
    createdAt: NOW - 3 * DAY,
    updatedAt: NOW - 3 * DAY,
    userId: U2,
    mimeType: 'image/jpeg',
    aiGenerated: false,
    comments: true,
    tags: ['art'],
    preview: { kind: 'image', url: `${BASE}/content/${P2}/raw`, text: '', imageCount: 3 },
  },
  described: {
    contentId: P2,
    createdAt: NOW - 3 * DAY,
    updatedAt: NOW - 3 * DAY,
    userId: U2,
    mimeType: 'image/jpeg',
    aiGenerated: false,
    comments: true,
    tags: ['art'],
    preview: { kind: 'image', url: `${BASE}/content/${P2}/raw`, text: 'three of them, for @bob', imageCount: 3, alt: ['a cat', '', 'a "dog"\n'] },
    mentions: [{ userId: U2, username: 'bob' }],
  },
  video: {
    contentId: P3,
    createdAt: NOW - 4 * DAY,
    updatedAt: NOW - 4 * DAY + 5,
    userId: U1,
    mimeType: 'video/mp4',
    aiGenerated: false,
    comments: true,
    tags: ['clips'],
    preview: {
      kind: 'video',
      url: `${BASE}/content/${P3}/raw`,
      text: 'a clip',
      video: { id: V1, width: 1280, height: 720, duration: 12.5, poster: `${BASE}/content/${P3}/media/${V1}/poster.jpg`, hls: `${BASE}/content/${P3}/media/${V1}/master.m3u8` },
    },
  },
  audio: {
    contentId: P3,
    createdAt: NOW - 4 * DAY,
    updatedAt: NOW - 4 * DAY,
    userId: U1,
    mimeType: 'audio/mpeg',
    aiGenerated: false,
    comments: false,
    tags: ['music'],
    preview: { kind: 'audio', url: `${BASE}/content/${P3}/raw`, text: 'a song' },
  },
  origin: {
    contentId: P3,
    createdAt: NOW - 5 * DAY,
    updatedAt: NOW - 5 * DAY,
    userId: U1,
    mimeType: 'image/png',
    aiGenerated: true,
    comments: false,
    tags: ['art'],
    preview: { kind: 'image', url: `https://other.example/content/${P1}/raw`, text: 'theirs', imageCount: 2 },
    origin: { url: `https://other.example/content/${P1}`, publisher: { userId: U2, username: 'a name with spaces' } },
  },
  reposted: {
    contentId: P1,
    createdAt: NOW - 200 * DAY,
    updatedAt: NOW - 200 * DAY,
    userId: U1,
    mimeType: 'text/plain',
    aiGenerated: false,
    comments: true,
    tags: ['news', 'again'],
    preview: { kind: 'text', text: 'old news' },
    repostedAt: [NOW - 2 * DAY, NOW - 2 * DAY + HOUR, NOW - HOUR],
  },
} as Record<string, Summary>;

/** Summaries as earlier versions wrote them, which are read as they always were: by their text, and the id it is of. */
const STORED: Record<string, { contentId: string; text: string }> = {
  beforeComments: { contentId: P1, text: `${NOW} ${NOW} 1\n${U1}\ntext/plain\nnews\ntext\nfrom before posts took comments` },
  fourNumbers: { contentId: P1, text: `${NOW} ${NOW + 1} 0 1\n${U1}\ntext/plain\n\ntext\nno hashtags\n\nand two lines` },
};

const SUMMARY_QUALITY = 5;

describe('a summary', () => {
  it('is written and read as the fixture has it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'evieverse-fixture-'));
    const hot = createHotStore({ url: TEST_REDIS_URL, keyPrefix: `test:${randomUUID()}:` });
    try {
      const store = new SummaryStore(hot, { scheme: 'fs', options: { root: dir } }, { hotDays: 8, quality: SUMMARY_QUALITY, cacheSize: 0, cacheSeconds: 0, publicBaseUrl: BASE }, () => NOW);
      const written = await Promise.all(
        Object.entries(SUMMARIES).map(async ([name, summary]) => {
          const text = encodeSummary(summary);
          const blob = await store.compress(summary);
          expect(brotliDecompressSync(blob).toString('utf8')).toBe(text);
          return {
            name,
            summary,
            text,
            // As this code compresses it, for the other side to read. The other side's own bytes may differ, and read the same.
            brotli: blob.toString('base64'),
            decoded: decodeSummary(summary.contentId, text, BASE),
            redisKey: summaryKey(summary),
            objectKey: summaryObjectKey(summary),
          };
        }),
      );
      const stored = Object.entries(STORED).map(([name, { contentId, text }]) => ({ name, contentId, text, decoded: decodeSummary(contentId, text, BASE) }));
      golden('summaries', { publicBaseUrl: BASE, quality: SUMMARY_QUALITY, written, stored });
    } finally {
      await hot.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** A post's meta file, as the fixtures have them. */
const META: Record<string, ContentMeta> = {
  text: {
    contentId: P1,
    mimeType: 'text/plain',
    size: 11,
    aiGenerated: false,
    comments: true,
    preview: { kind: 'text', text: 'hello #news' },
    text: 'hello #news',
    mentions: [{ userId: U2, username: 'bob' }],
    tags: ['news'],
    updatedAt: NOW - DAY,
  },
  album: {
    contentId: P2,
    mimeType: 'image/png',
    size: 8,
    sha256: 'ab'.repeat(32),
    images: [
      { mimeType: 'image/png', size: 8, sha256: 'ab'.repeat(32) },
      { mimeType: 'image/jpeg', size: 8, sha256: 'cd'.repeat(32) },
    ],
    aiGenerated: true,
    preview: { kind: 'image', url: `${BASE}/content/${P2}/raw`, text: 'two of them', imageCount: 2, alt: ['one', 'two'] },
    text: 'two of them',
    tags: ['art', 'cats'],
    updatedAt: NOW - HOUR,
  },
  video: {
    contentId: P3,
    mimeType: 'video/mp4',
    size: 1234567,
    sha256: 'ef'.repeat(32),
    aiGenerated: false,
    comments: false,
    // As a meta file keeps a processed video: what is stored of it, without the addresses a reader is given (see StoredVideo).
    preview: { kind: 'video', url: `${BASE}/content/${P3}/raw`, text: 'a clip', video: { id: V1, width: 1280, height: 720, duration: 12.5 } } as ContentMeta['preview'],
    text: 'a clip',
    tags: ['clips'],
    updatedAt: NOW,
  },
  origin: {
    contentId: P3,
    mimeType: 'text/uri-list',
    size: 58,
    aiGenerated: false,
    preview: { kind: 'text', text: 'theirs' },
    tags: ['news'],
    updatedAt: NOW,
    origin: { url: `https://other.example/content/${P1}`, publisher: { userId: U2, username: 'them' } },
    originAttestedAt: NOW - 5,
  },
  link: {
    contentId: P2,
    mimeType: 'text/uri-list',
    size: 19,
    aiGenerated: false,
    preview: { kind: 'link', url: 'https://example.com' },
    tags: ['links'],
    updatedAt: NOW,
  },
} as Record<string, ContentMeta>;

/** A post's comments, as the fixtures have them. */
const COMMENTS: Record<string, Comment> = {
  first: { commentId: C1, contentId: P1, userId: U1, text: 'the first, for @bob', mentions: [{ userId: U2, username: 'bob' }], createdAt: NOW - 3000 },
  reply: { commentId: C2, contentId: P1, parentId: C1, userId: U2, text: '', aiGenerated: true, media: { kind: 'image', mimeType: 'image/png', size: 3, alt: 'a cat' }, createdAt: NOW - 2000 },
  held: { commentId: C3, contentId: P1, userId: U2, text: 'this one waits', createdAt: NOW - 1000 },
  later: { commentId: C4, contentId: P1, parentId: C1, userId: U1, text: 'a later reply', createdAt: NOW - 500, editedAt: NOW - 100 },
} as Record<string, Comment>;

describe('a stored document', () => {
  it('is the JSON the fixture has', () => {
    // As the stores hold them: the text itself.
    const texts = (documents: Record<string, unknown>) => Object.fromEntries(Object.entries(documents).map(([name, document]) => [name, JSON.stringify(document)]));
    golden('documents', { metas: texts(META), comments: texts(COMMENTS) });
  });
});

describe('a pending write', () => {
  it('holds what the fixture has', () => {
    const payloads = {
      post: { meta: META.text! } satisfies PostPayload,
      postToProcess: { meta: META.video!, process: true } satisfies PostPayload,
      postKeepingBytes: { meta: META.video!, keepBytes: true } satisfies PostPayload,
      commentPut: { comment: COMMENTS.reply!, held: false } satisfies CommentPutPayload,
      commentHeld: { comment: COMMENTS.held!, held: true, process: true } satisfies CommentPutPayload,
      commentRemove: { parentId: C1 } satisfies CommentRemovePayload,
      commentRemoveTopLevel: {} satisfies CommentRemovePayload,
      commentLike: { userId: U2 } satisfies CommentLikePayload,
      commentUnlike: { userId: U2, unlike: true } satisfies CommentLikePayload,
    };
    golden('pending', {
      unnumbered: UNNUMBERED,
      likeKey: { commentId: C1, userId: U2, key: likeKey(C1, U2) },
      stagedKey: { writeId: W1, key: stagedKey(W1) },
      // As SQLite gives a row's payload back: the text that was stored. The other databases give it parsed, which reads the same.
      payloads: Object.fromEntries(Object.entries(payloads).map(([name, payload]) => [name, JSON.stringify(payload)])),
      bytes: Object.fromEntries(
        (['text', 'link', 'origin'] as const).map((name) => {
          const { bytes, mimeType } = payloadBytes(payloadOf<PostPayload>(JSON.stringify({ meta: META[name]! })).meta);
          return [name, { text: bytes.toString('utf8'), mimeType }];
        }),
      ),
    });
  });
});

/**
 * One thing done to the stores, as the compactor does it: what both sides run, in the order of
 * the fixture, each with its own code.
 */
type Op =
  | { op: 'content.putBytes'; of: BytesOwner; text: string; mimeType: string }
  | { op: 'content.putMeta'; meta: ContentMeta }
  | { op: 'content.adopt'; staged: string; of: BytesOwner; mimeType: string }
  | { op: 'content.removeStaged'; staged: string }
  | { op: 'content.remove'; contentId: string; images: number }
  | { op: 'content.removeImage'; contentId: string; image: number }
  | { op: 'content.removeMedia'; contentId: string; videoId?: string }
  | { op: 'comments.put'; comment: Comment; held: boolean }
  | { op: 'comments.publish'; comment: Comment }
  | { op: 'comments.hold'; comment: Comment }
  | { op: 'comments.remove'; postId: string; commentId: string; keepPlace: boolean }
  | { op: 'comments.addLike'; postId: string; commentId: string; userId: string }
  | { op: 'comments.removeLike'; postId: string; commentId: string; userId: string }
  | { op: 'comments.makingLikes'; commentId: string; done: boolean }
  | { op: 'comments.removeAll'; postId: string }
  | { op: 'comments.counting'; postId: string }
  | { op: 'comments.counted'; postId: string; recount: boolean }
  | { op: 'summaries.put'; summary: Summary }
  | { op: 'summaries.ensureMany'; summaries: Summary[] }
  | { op: 'summaries.erase'; ref: SummaryRef }
  | { op: 'summaries.eraseCopies'; ref: SummaryRef; gone: number[] }
  | { op: 'summaries.remove'; refs: SummaryRef[] }
  | { op: 'summaries.purgeBefore'; day: number }
  // What the stores hold now, under this name among the fixture's snapshots.
  | { op: 'snapshot'; name: string };

/** What a store holds under a name: text, or what the JSON or the compressed text it holds says. */
type Held = { text: string } | { json: unknown } | { brotli: string } | { members: string[] } | { making: boolean };
/** What the stores hold: every object by its key, and every key of Redis, with whether it expires. */
type Snapshot = { objects: Record<string, Held>; redis: Record<string, Held & { expires: boolean }> };

const ref = ({ contentId, createdAt, repostedAt }: Summary): SummaryRef => ({ contentId, createdAt, ...(repostedAt && { repostedAt }) });
const staged = stagedKey(W1);

/** What the compactor does to the stores, of each kind, and what they hold at three points of it. */
const OPS: Op[] = [
  // A text post, and an album whose two images were staged as one file each.
  { op: 'content.putBytes', of: P1, text: 'hello #news', mimeType: 'text/plain' },
  { op: 'content.putMeta', meta: META.text! },
  { op: 'content.putBytes', of: { staged }, text: 'PNGBYTES', mimeType: 'image/png' },
  { op: 'content.adopt', staged, of: P2, mimeType: 'image/png' },
  { op: 'content.adopt', staged, of: { contentId: P2, image: 2 }, mimeType: 'image/jpeg' },
  { op: 'content.putMeta', meta: META.album! },
  // What was made of a video, and a comment's image.
  { op: 'content.putBytes', of: { contentId: P3, video: V1, file: 'poster.jpg' }, text: 'JPG', mimeType: 'image/jpeg' },
  { op: 'content.putBytes', of: { contentId: P3, video: V1, file: '720p_00001.ts' }, text: 'TS', mimeType: 'video/mp2t' },
  { op: 'content.putBytes', of: { postId: P1, commentId: C2 }, text: 'IMG', mimeType: 'image/png' },
  // Comments: one on the post, a reply with an image, one that waits, and likes. The post's number of comments is
  // counted from the store once the first is written, as after a run's writes, and the reply is added to it.
  { op: 'comments.counting', postId: P1 },
  { op: 'comments.put', comment: COMMENTS.first!, held: false },
  { op: 'comments.counted', postId: P1, recount: false },
  { op: 'comments.put', comment: COMMENTS.reply!, held: false },
  { op: 'comments.put', comment: COMMENTS.held!, held: true },
  { op: 'comments.makingLikes', commentId: C1, done: false },
  { op: 'comments.addLike', postId: P1, commentId: C1, userId: U2 },
  { op: 'comments.addLike', postId: P1, commentId: C1, userId: U1 },
  { op: 'comments.addLike', postId: P1, commentId: C1, userId: U1 },
  { op: 'comments.removeLike', postId: P1, commentId: C1, userId: U1 },
  { op: 'comments.addLike', postId: P1, commentId: C2, userId: U1 },
  { op: 'comments.makingLikes', commentId: C2, done: true },
  // Summaries: one that Redis keeps too, one that is past it, and one whose reposts keep it there and under their days.
  { op: 'summaries.put', summary: SUMMARIES.text! },
  { op: 'summaries.put', summary: SUMMARIES.video! },
  { op: 'summaries.put', summary: { ...SUMMARIES.origin!, createdAt: NOW - 30 * DAY, updatedAt: NOW - 30 * DAY } },
  { op: 'summaries.put', summary: { ...SUMMARIES.reposted!, contentId: P2 } },
  { op: 'snapshot', name: 'written' },

  // The comment that waited is published, edited; the first is edited into the queue; the reply is removed, and then the first.
  // Each adds to the post's number of comments or takes from it, and the writes are not said to be over: as a run that stopped leaves it.
  { op: 'comments.counting', postId: P1 },
  { op: 'comments.publish', comment: { ...COMMENTS.held!, text: 'this one waited', editedAt: NOW } as Comment },
  { op: 'comments.put', comment: COMMENTS.later!, held: false },
  { op: 'comments.hold', comment: { ...COMMENTS.first!, text: 'the first, edited', editedAt: NOW } as Comment },
  { op: 'comments.remove', postId: P1, commentId: C2, keepPlace: false },
  { op: 'comments.remove', postId: P1, commentId: C1, keepPlace: true },
  { op: 'comments.remove', postId: P1, commentId: C1, keepPlace: true },
  // The staged file goes, the album loses its second image, the video its files.
  { op: 'content.removeStaged', staged },
  { op: 'content.removeImage', contentId: P2, image: 2 },
  { op: 'content.removeMedia', contentId: P3, videoId: V1 },
  // A repost is taken back, a summary is erased, and the ones that are missing a tier get it back.
  { op: 'summaries.eraseCopies', ref: ref({ ...SUMMARIES.reposted!, contentId: P2, repostedAt: [NOW - HOUR] }), gone: [NOW - 2 * DAY, NOW - 2 * DAY + HOUR] },
  { op: 'summaries.erase', ref: ref(SUMMARIES.video!) },
  { op: 'summaries.ensureMany', summaries: [SUMMARIES.text!, SUMMARIES.audio!, { ...SUMMARIES.link!, createdAt: NOW - 40 * DAY }] },
  { op: 'snapshot', name: 'changed' },

  // The posts are deleted, with all that is under them.
  { op: 'comments.removeAll', postId: P1 },
  { op: 'content.remove', contentId: P1, images: 1 },
  { op: 'content.remove', contentId: P2, images: 2 },
  { op: 'content.removeMedia', contentId: P3 },
  { op: 'summaries.remove', refs: [ref(SUMMARIES.text!), ref({ ...SUMMARIES.reposted!, contentId: P2, repostedAt: [NOW - HOUR] })] },
  { op: 'summaries.purgeBefore', day: Math.floor((NOW - 35 * DAY) / DAY) },
  { op: 'snapshot', name: 'removed' },
];

const STORES = { now: NOW, hotDays: 8, quality: SUMMARY_QUALITY, commentHotMs: 24 * HOUR, publicBaseUrl: BASE };

/** What bytes held under a name say: an object's, by its key, or a key's of Redis. */
function held(name: string, bytes: Buffer): Held {
  if (name.startsWith('cmtlm:')) return { making: bytes.toString('utf8').startsWith('making:') };
  if (name.endsWith('.br') || name.startsWith('sum:')) return { brotli: brotliDecompressSync(bytes).toString('utf8') };
  if ((name.endsWith('.json') || name.startsWith('cmt:')) && bytes.length > 0) return { json: JSON.parse(bytes.toString('utf8')) };
  return { text: bytes.toString('utf8') };
}

/** Runs the fixture's operations on stores of the test's own, with this code, and returns what they held at each snapshot. */
async function run(ops: Op[]): Promise<Record<string, Snapshot>> {
  const dir = await mkdtemp(join(tmpdir(), 'evieverse-fixture-'));
  const keyPrefix = `test:${randomUUID()}:`;
  const hot = createHotStore({ url: TEST_REDIS_URL, keyPrefix });
  const redis = new Redis(TEST_REDIS_URL);
  const cfg = { scheme: 'fs', options: { root: dir } };
  const content = new ContentStore({ ...cfg, signedUrlSeconds: 900 }, () => STORES.now);
  const comments = new CommentStore(hot, cfg, { hotMs: STORES.commentHotMs });
  const summaries = new SummaryStore(hot, cfg, { hotDays: STORES.hotDays, quality: STORES.quality, cacheSize: 0, cacheSeconds: 0, publicBaseUrl: STORES.publicBaseUrl }, () => STORES.now);

  const snapshot = async (): Promise<Snapshot> => {
    const objects: [string, Held][] = [];
    for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = join(entry.parentPath, entry.name);
      const key = relative(dir, file).split(sep).join('/');
      // Where a write is made before it is moved into place.
      if (!key.startsWith('.tmp/')) objects.push([key, held(key, await readFile(file))]);
    }
    const keys: string[] = [];
    for await (const page of redis.scanStream({ match: `${keyPrefix}*`, count: 500 }) as AsyncIterable<string[]>) keys.push(...page);
    const inRedis: [string, Held & { expires: boolean }][] = [];
    for (const key of [...new Set(keys)]) {
      const name = key.slice(keyPrefix.length);
      const expires = (await redis.pttl(key)) > 0;
      if ((await redis.type(key)) === 'zset') inRedis.push([name, { members: await redis.zrange(key, 0, -1), expires }]);
      else inRedis.push([name, { ...held(name, (await redis.getBuffer(key)) ?? Buffer.alloc(0)), expires }]);
    }
    const sorted = <T>(entries: [string, T][]) => Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    return { objects: sorted(objects), redis: sorted(inRedis) };
  };

  const snapshots: Record<string, Snapshot> = {};
  try {
    for (const o of ops) {
      if (o.op === 'content.putBytes') await content.putBytes(o.of, Buffer.from(o.text), o.mimeType);
      else if (o.op === 'content.putMeta') await content.putMeta(o.meta);
      else if (o.op === 'content.adopt') await content.adopt(o.staged, o.of, o.mimeType);
      else if (o.op === 'content.removeStaged') await content.removeStaged(o.staged);
      else if (o.op === 'content.remove') await content.remove(o.contentId, o.images);
      else if (o.op === 'content.removeImage') await content.removeImage(o.contentId, o.image);
      else if (o.op === 'content.removeMedia') await content.removeMedia(o.contentId, o.videoId);
      else if (o.op === 'comments.put') await comments.put(o.comment, { held: o.held });
      else if (o.op === 'comments.publish') await comments.publish(o.comment);
      else if (o.op === 'comments.hold') await comments.hold(o.comment);
      else if (o.op === 'comments.remove') await comments.remove(o.postId, o.commentId, { keepPlace: o.keepPlace });
      else if (o.op === 'comments.addLike') await comments.addLike(o.postId, o.commentId, o.userId);
      else if (o.op === 'comments.removeLike') await comments.removeLike(o.postId, o.commentId, o.userId);
      else if (o.op === 'comments.makingLikes') {
        const done = await comments.makingLikes(o.commentId);
        if (o.done) await done();
      } else if (o.op === 'comments.removeAll') await comments.removeAll(o.postId);
      else if (o.op === 'comments.counting') await comments.counting(o.postId);
      else if (o.op === 'comments.counted') await comments.counted(o.postId, o.recount);
      else if (o.op === 'summaries.put') await summaries.put(o.summary);
      else if (o.op === 'summaries.ensureMany') expect(await summaries.ensureMany(o.summaries)).toEqual(o.summaries.map(() => null));
      else if (o.op === 'summaries.erase') await summaries.erase(o.ref);
      else if (o.op === 'summaries.eraseCopies') await summaries.eraseCopies(o.ref, o.gone);
      else if (o.op === 'summaries.remove') await summaries.remove(o.refs);
      else if (o.op === 'summaries.purgeBefore') await summaries.purgeBefore(o.day);
      else snapshots[o.name] = await snapshot();
    }
    return snapshots;
  } finally {
    await hot.clear();
    await hot.close();
    redis.disconnect();
    await rm(dir, { recursive: true, force: true });
  }
}

describe('the stores', () => {
  it('hold what the fixture has once the compactor has written them', async () => {
    const snapshots = await run(OPS);
    // Each point holds something the others don't, so that none of them compares nothing with nothing.
    expect(Object.keys(snapshots.written!.objects).length).toBeGreaterThan(20);
    expect(snapshots.changed).not.toEqual(snapshots.written);
    expect(Object.keys(snapshots.removed!.objects)).not.toHaveLength(0);
    golden('stores', { ...STORES, ops: OPS, snapshots });
  });
});

describe('a formatted text', () => {
  /** fixtures/format.json: texts, the users that could be mentioned in them, and what each text is read as. */
  type Format = { note: string; users: Mention[]; cases: { text: string; plain?: string; addresses?: string; mentions?: Mention[]; cuts?: { words: number; chars: number; cut: string }[] }[] };

  /** The lengths each text is cut to: the most words, and the most characters. */
  const CUTS = [
    [3, 20],
    [5, 40],
    [8, 30],
    [50, 500],
  ] as const;

  // The file's texts and users are written by hand, and what each text is read as by this code, with UPDATE_FIXTURES=1: a
  // text that is added needs no more than its `text`. compactor/crates/core/src/format.rs is held to the same file.
  it('is read as the fixture has it', () => {
    const { note, users, cases } = read('format') as Format;
    expect(cases.length).toBeGreaterThan(60);
    const made = cases.map(({ text }) => ({
      text,
      plain: plainText(text),
      addresses: plainText(text, true),
      mentions: mentionsIn(text, users),
      cuts: CUTS.map(([words, chars]) => ({ words, chars, cut: cutFormatted(text, words, chars, users) })),
    }));
    if (UPDATE) return writeFileSync(join(DIR, 'format.json'), `${JSON.stringify({ note, users, cases: made }, null, 1)}\n`);
    for (const [i, read] of made.entries()) expect(read, `what ${JSON.stringify(read.text)} is read as`).toEqual(cases[i]);
  });
});

describe('what the Rust code wrote', () => {
  /** fixtures/from-rust.json: what compactor/crates/core/tests/fixtures.rs made of the inputs of the other fixtures. */
  type FromRust = {
    day: string;
    summaries: { name: string; brotli: string }[];
    metas: Record<string, string>;
    comments: Record<string, string>;
    payloads: Record<string, string>;
    head: string;
    manifest: string;
  };

  // Written by the Rust tests, once this file's fixtures are there for them to read.
  it.skipIf(UPDATE && !existsSync(join(DIR, 'from-rust.json')))('is read by this code as what it is', () => {
    const rust = read('from-rust') as FromRust;
    const layout = read('layout') as { day: { hex: string; unpacked: IndexEntry[] }; head: string; manifest: string };
    expect(unpackDay(Buffer.from(rust.day, 'hex'))).toEqual(layout.day.unpacked);
    expect(JSON.parse(rust.head)).toEqual(JSON.parse(layout.head));
    expect(JSON.parse(rust.manifest)).toEqual(JSON.parse(layout.manifest));

    const summaries = read('summaries') as { written: { name: string; summary: Summary; decoded: Summary }[] };
    expect(rust.summaries.map((s) => s.name)).toEqual(summaries.written.map((s) => s.name));
    for (const { name, brotli } of rust.summaries) {
      const { summary, decoded } = summaries.written.find((s) => s.name === name)!;
      expect(decodeSummary(summary.contentId, brotliDecompressSync(Buffer.from(brotli, 'base64')).toString('utf8'), BASE), name).toEqual(decoded);
    }

    // Through JSON, as a stored one is read: what is undefined is left out.
    const stored = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
    expect(Object.keys(rust.metas)).toEqual(Object.keys(META));
    for (const [name, text] of Object.entries(rust.metas)) expect(JSON.parse(text), name).toEqual(stored(META[name]));
    expect(Object.keys(rust.comments)).toEqual(Object.keys(COMMENTS));
    for (const [name, text] of Object.entries(rust.comments)) expect(JSON.parse(text), name).toEqual(stored(COMMENTS[name]));

    const pending = read('pending') as { payloads: Record<string, string> };
    expect(Object.keys(rust.payloads)).toEqual(Object.keys(pending.payloads));
    for (const [name, text] of Object.entries(rust.payloads)) expect(payloadOf(text), name).toEqual(JSON.parse(pending.payloads[name]!));
  });
});
