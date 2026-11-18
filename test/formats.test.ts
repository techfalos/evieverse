import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryHotStore, SummaryStore, type Summary } from '../src/storage/index.js';
import { decodeSummary, encodeSummary, summaryKey } from '../src/storage/summaryStore.js';
import { DAY_ENTRY_BYTES, packDay, unpackDay } from '../src/tagfeed/layout.js';
import type { IndexEntry } from '../src/tagfeed/layout.types.js';
import { DAY } from '../src/time.js';

const NOW = Date.UTC(2026, 10, 6, 12);
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

const summary = (o: Partial<Summary> = {}): Summary => ({
  contentId: ID,
  createdAt: NOW - 1234,
  updatedAt: NOW,
  userId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  mimeType: 'text/plain',
  aiGenerated: false,
  comments: false,
  tags: ['news', 'mumbai'],
  preview: { kind: 'text', text: 'Flooding closes roads.\n\nMore below.' },
  ...o,
});

describe('summary text', () => {
  it('round-trips multi-line summaries and previews', () => {
    const s = summary();
    expect(decodeSummary(ID, encodeSummary(s), '')).toEqual(s);
  });

  it('round-trips the AI-generated flag', () => {
    const s = summary({ aiGenerated: true });
    expect(decodeSummary(ID, encodeSummary(s), '')).toEqual(s);
  });

  it('round-trips the comments flag, which a summary written before it reads as off', () => {
    const s = summary({ comments: true });
    const text = encodeSummary(s);
    expect(decodeSummary(ID, text, '')).toEqual(s);
    expect(decodeSummary(ID, text.replace(`${NOW} 0 1\n`, `${NOW} 0\n`), '')).toEqual(summary());
  });

  it('round-trips empty texts and no hashtags', () => {
    const s = summary({ tags: [], preview: { kind: 'text', text: '' } });
    expect(decodeSummary(ID, encodeSummary(s), '')).toEqual(s);
  });

  it("writes five header lines, then the preview's text", () => {
    const header = `${NOW - 1234} ${NOW} 0 0\n7c9e6679-7425-40de-944b-e07fc1f90ae7\ntext/plain\nnews mumbai\ntext\n`;
    expect(encodeSummary(summary())).toBe(`${header}Flooding closes roads.\n\nMore below.`);
  });

  it("stores an image's, video's or audio's caption but not its URL, which is built when read", () => {
    const s = summary({ mimeType: 'image/png', preview: { kind: 'image', url: 'https://old.example/ignored', text: 'Sunset over the bay' } });
    const text = encodeSummary(s);
    expect(text).not.toContain('ignored');
    const url = `https://api.example.com/content/${ID}/raw`;
    expect(decodeSummary(ID, text, 'https://api.example.com').preview).toEqual({ kind: 'image', url, text: 'Sunset over the bay' });
    for (const [mimeType, kind] of [['video/mp4', 'video'], ['audio/mpeg', 'audio']] as const) {
      const media = summary({ mimeType, preview: { kind, url: 'https://old.example/ignored' } });
      expect(decodeSummary(ID, encodeSummary(media), 'https://api.example.com').preview).toEqual({ kind, url });
    }
  });

  it("round-trips a link's URL", () => {
    const s = summary({ mimeType: 'text/uri-list', preview: { kind: 'link', url: 'https://news.example/a?b=c#d' } });
    expect(decodeSummary(ID, encodeSummary(s), 'https://api.example.com')).toEqual(s);
  });

  it('adds a line for the original to the summary of a repost from another server, whose file is read there', () => {
    const origin = { url: `https://other.example/content/${ID}`, publisher: { userId: '11111111-1111-4111-8111-111111111111', username: 'Dana of the North' } };
    const text = summary({ origin });
    const encoded = encodeSummary(text);
    expect(encoded).toBe(
      `${NOW - 1234} ${NOW} 0 0 1\n7c9e6679-7425-40de-944b-e07fc1f90ae7\ntext/plain\nnews mumbai\ntext\n` +
        `https://other.example/content/${ID} 11111111-1111-4111-8111-111111111111 Dana of the North\nFlooding closes roads.\n\nMore below.`,
    );
    expect(decodeSummary(ID, encoded, 'https://api.example.com')).toEqual(text);

    // Its image is the original's: the link is to the server that has the bytes, not to this one.
    const image = summary({ origin, mimeType: 'image/png', aiGenerated: true, preview: { kind: 'image', url: `${origin.url}/raw`, text: 'Sunset' } });
    expect(encodeSummary(image)).not.toContain('/raw');
    expect(decodeSummary(ID, encodeSummary(image), 'https://api.example.com')).toEqual(image);
    expect(() => decodeSummary(ID, encoded.replace(` ${origin.publisher.userId} Dana of the North`, ''), '')).toThrow(/names no original/);

    // When it was reposted says where a summary is kept, and is no part of what it says.
    expect(encodeSummary(summary({ repostedAt: [NOW] }))).toBe(encodeSummary(summary()));
  });

  it('says how many images an image post of several has, in a sixth number, and nothing of it for a post of one', () => {
    const url = `https://api.example.com/content/${ID}/raw`;
    const album = summary({ mimeType: 'image/jpeg', preview: { kind: 'image', url, text: 'Three of the bay', imageCount: 3 } });
    const encoded = encodeSummary(album);
    expect(encoded).toBe(`${NOW - 1234} ${NOW} 0 0 0 3\n7c9e6679-7425-40de-944b-e07fc1f90ae7\nimage/jpeg\nnews mumbai\nimage\nThree of the bay`);
    expect(decodeSummary(ID, encoded, 'https://api.example.com')).toEqual(album);

    // A post of one image is written as it was before there were albums, whatever its preview says of one.
    const one = summary({ mimeType: 'image/jpeg', preview: { kind: 'image', url, text: 'The bay' } });
    expect(encodeSummary(one).split('\n')[0]).toBe(`${NOW - 1234} ${NOW} 0 0`);
    expect(encodeSummary({ ...one, preview: { kind: 'image', url, text: 'The bay', imageCount: 1 } })).toBe(encodeSummary(one));
    expect(decodeSummary(ID, encodeSummary(one), 'https://api.example.com')).toEqual(one);

    // A repost of an album on another server: the original's line is there, and the images are read on its server.
    const origin = { url: `https://other.example/content/${ID}`, publisher: { userId: '11111111-1111-4111-8111-111111111111', username: 'Dana' } };
    const reposted = summary({ origin, mimeType: 'image/png', preview: { kind: 'image', url: `${origin.url}/raw`, imageCount: 2 } });
    expect(encodeSummary(reposted).split('\n')[0]).toBe(`${NOW - 1234} ${NOW} 0 0 1 2`);
    expect(decodeSummary(ID, encodeSummary(reposted), 'https://api.example.com')).toEqual(reposted);
  });

  it('keeps whom its preview mentions on a line of its own, and nothing of it for a preview that mentions nobody', () => {
    const mentions = [
      { userId: '11111111-1111-4111-8111-111111111111', username: 'Dana of the North' },
      { userId: '22222222-2222-4222-8222-222222222222', username: 'a "quoted"\\name' },
    ];
    const mentioning = summary({ mentions, preview: { kind: 'text', text: 'Thanks @Dana of the North\n\nand @a "quoted"\\\\name' } });
    const encoded = encodeSummary(mentioning);
    expect(encoded).toBe(
      `${NOW - 1234} ${NOW} 0 0 0 0 1\n7c9e6679-7425-40de-944b-e07fc1f90ae7\ntext/plain\nnews mumbai\ntext\n` +
        `${JSON.stringify({ mentions })}\nThanks @Dana of the North\n\nand @a "quoted"\\\\name`,
    );
    expect(decodeSummary(ID, encoded, '')).toEqual(mentioning);
    expect(encodeSummary(summary({ mentions: [] }))).toBe(encodeSummary(summary()));

    // After the original's line, in the summary of a repost from another server.
    const origin = { url: `https://other.example/content/${ID}`, publisher: { userId: '11111111-1111-4111-8111-111111111111', username: 'Dana' } };
    const reposted = summary({ origin, mentions });
    expect(encodeSummary(reposted).split('\n').slice(5, 7)).toEqual([`${origin.url} ${origin.publisher.userId} Dana`, JSON.stringify({ mentions })]);
    expect(decodeSummary(ID, encodeSummary(reposted), 'https://api.example.com')).toEqual(reposted);
  });

  it('rejects truncated text and preview kinds it does not know', () => {
    const text = encodeSummary(summary());
    expect(() => decodeSummary(ID, text.slice(0, 20), '')).toThrow(/truncated/);
    expect(() => decodeSummary(ID, text.replace('\ntext\n', '\nmedia\n'), '')).toThrow(/unknown preview kind/);
  });
});

describe('day index entries', () => {
  it('packs each entry into 25 bytes, keeping whole seconds of the creation time', () => {
    const entries: IndexEntry[] = [
      { contentId: ID, createdAt: NOW + 999, likes: 4_000_000_000, aiGenerated: true, moderated: false, repost: false },
      { contentId: '00000000-0000-4000-8000-000000000001', createdAt: NOW, likes: 0, aiGenerated: false, moderated: false, repost: false },
      { contentId: '00000000-0000-4000-8000-000000000002', createdAt: NOW, likes: 1, aiGenerated: false, moderated: true, repost: false },
      { contentId: '00000000-0000-4000-8000-000000000003', createdAt: NOW, likes: 2, aiGenerated: true, moderated: true, repost: false },
      { contentId: '00000000-0000-4000-8000-000000000004', createdAt: NOW, likes: 3, aiGenerated: false, moderated: false, repost: true },
      { contentId: '00000000-0000-4000-8000-000000000005', createdAt: NOW, likes: 4, aiGenerated: true, moderated: true, repost: true },
    ];
    const buf = packDay(entries);
    expect(DAY_ENTRY_BYTES).toBe(25);
    expect(buf.length).toBe(6 * DAY_ENTRY_BYTES);
    expect(unpackDay(buf)).toEqual([{ ...entries[0]!, createdAt: NOW }, ...entries.slice(1)]);
    // The flags are the entry's last byte: 1 for AI-generated, 2 for moderated, 4 for an entry a repost made.
    expect(entries.map((_, i) => buf[(i + 1) * DAY_ENTRY_BYTES - 1])).toEqual([1, 0, 2, 3, 4, 7]);
  });

  it('clamps likes to 32 bits, and refuses ids that are not UUIDs', () => {
    const flags = { moderated: false, repost: false };
    const [e] = unpackDay(packDay([{ contentId: ID, createdAt: NOW, likes: 2 ** 40, aiGenerated: true, ...flags }]));
    expect(e).toMatchObject({ likes: 0xffffffff, aiGenerated: true });
    const [none] = unpackDay(packDay([{ contentId: ID, createdAt: NOW, likes: -5, aiGenerated: false, ...flags }]));
    expect(none).toMatchObject({ likes: 0, aiGenerated: false });
    expect(() => packDay([{ contentId: 'c-1', createdAt: NOW, likes: 0, aiGenerated: false, ...flags }])).toThrow(/UUID/);
  });
});

describe('MemoryHotStore', () => {
  it('expires keys by the injected clock', async () => {
    let now = NOW;
    const hot = new MemoryHotStore(() => now);
    await hot.set('a', 'x', 1000);
    await hot.set('b', Buffer.from('y'));
    expect(await hot.mget(['a', 'b', 'c'])).toEqual([Buffer.from('x'), Buffer.from('y'), null]);
    now += 1000;
    expect(await hot.exists(['a', 'b'])).toEqual([false, true]);

    await hot.expire(['b'], 10);
    now += 10;
    expect(await hot.mget(['a', 'b'])).toEqual([null, null]);

    await hot.setMany([{ key: 'c', value: 'x', ttlMs: 1000 }, { key: 'd', value: Buffer.from('y') }]);
    expect(await hot.mget(['c', 'd'])).toEqual([Buffer.from('x'), Buffer.from('y')]);
    now += 1000;
    expect(await hot.exists(['c', 'd'])).toEqual([false, true]);
  });

  it('keeps a set in the order of its members, read a range at a time from either end, which lasts from when it was begun', async () => {
    let now = NOW;
    const hot = new MemoryHotStore(() => now);
    expect(await hot.lexRange('ids', { limit: 10 })).toEqual([]);
    expect([await hot.lexCount('ids'), await hot.lexHas('ids', 'b')]).toEqual([0, false]);
    await hot.lexAdd('ids', [], 1000);
    expect(await hot.exists(['ids'])).toEqual([false]);

    await hot.lexAdd('ids', ['d', 'b', '~'], 1000);
    now += 600;
    // Adding to it doesn't make it last longer; adding a member again changes nothing.
    await hot.lexAdd('ids', ['a', 'c', 'b'], 1000);
    expect(await hot.lexRange('ids', { limit: 10 })).toEqual(['a', 'b', 'c', 'd', '~']);
    expect(await hot.lexRange('ids', { before: '~', limit: 2 })).toEqual(['a', 'b']);
    expect(await hot.lexRange('ids', { after: 'b', before: '~', limit: 10 })).toEqual(['c', 'd']);
    expect(await hot.lexRange('ids', { before: '~', limit: 2, reverse: true })).toEqual(['d', 'c']);
    expect(await hot.lexRange('ids', { after: 'a', before: 'c', limit: 10, reverse: true })).toEqual(['b']);
    expect([await hot.lexCount('ids'), await hot.lexCount('ids', { before: '~' }), await hot.lexCount('ids', { after: 'b', before: 'd' })]).toEqual([5, 4, 1]);
    expect([await hot.lexHas('ids', '~'), await hot.lexHas('ids', 'e')]).toEqual([true, false]);

    await hot.lexRem('ids', ['b', 'e']);
    expect(await hot.lexRange('ids', { before: '~', limit: 10 })).toEqual(['a', 'c', 'd']);
    now += 400;
    expect(await hot.lexRange('ids', { limit: 10 })).toEqual([]);

    // A set left with no member is gone, and begins again with the next.
    await hot.lexAdd('ids', ['a'], 1000);
    await hot.lexRem('ids', ['a']);
    expect(await hot.exists(['ids'])).toEqual([false]);
  });
});

describe('SummaryStore', () => {
  let dir: string;
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const create = async (now: () => number) => {
    dir = await mkdtemp(join(tmpdir(), 'evieverse-summaries-'));
    const hot = new MemoryHotStore(now);
    const store = new SummaryStore(hot, { scheme: 'fs', options: { root: dir } }, { hotDays: 8, quality: 11, cacheSize: 16, cacheSeconds: 60, publicBaseUrl: '' }, now);
    return { hot, store };
  };

  it('keeps a summary in Redis only while its post is younger than the hot window', async () => {
    const { hot, store } = await create(() => NOW);
    const recent = summary({ createdAt: NOW - 7 * DAY });
    const old = summary({ contentId: '00000000-0000-4000-8000-000000000002', createdAt: NOW - 8 * DAY });
    await store.put(recent);
    await store.put(old);
    expect(await hot.exists([summaryKey(recent), summaryKey(old)])).toEqual([true, false]);
    expect(await store.getMany([recent, old])).toEqual([recent, old]);
  });

  it('writes an update over the summary, in both tiers', async () => {
    const { store } = await create(() => NOW);
    const posts = [summary({ createdAt: NOW - DAY }), summary({ contentId: '00000000-0000-4000-8000-000000000002', createdAt: NOW - 9 * DAY })];
    for (const s of posts) await store.put(s);
    expect(await store.getMany(posts)).toEqual(posts);
    const updated = posts.map((s) => ({ ...s, updatedAt: NOW + 5, tags: ['news'], preview: { kind: 'text' as const, text: 'Roads reopen.' } }));
    for (const s of updated) await store.put(s);
    expect(await store.getMany(posts)).toEqual(updated);
    const files = await readdir(join(dir, 'summaries'), { recursive: true, withFileTypes: true });
    expect(files.filter((f) => f.isFile()).map((f) => f.name).sort()).toEqual(posts.map((s) => `${s.contentId}.br`).sort());
  });

  it('restores a missing tier with ensure, and deletes whole days past retention', async () => {
    const { hot, store } = await create(() => NOW);
    const days = [12, 10, 0].map((age, i) => summary({ contentId: `00000000-0000-4000-8000-00000000001${i}`, createdAt: NOW - age * DAY }));
    for (const s of days) await store.put(s);
    await hot.del([summaryKey(days[2]!)]);
    await store.ensure(days[2]!);
    expect(await hot.exists([summaryKey(days[2]!)])).toEqual([true]);

    const today = Math.floor(NOW / DAY);
    const dirName = (day: number) => String(day).padStart(5, '0');
    expect(await store.purgeBefore(today - 11)).toEqual([today - 12]);
    expect((await readdir(join(dir, 'summaries'))).sort()).toEqual([dirName(today - 10), dirName(today)]);
    expect(await store.getMany(days)).toEqual([null, days[1], days[2]]);
  });

  it('keeps the summary of reposted content under the day of each repost too, and in Redis while the latest is recent', async () => {
    const clock = { now: NOW };
    const { hot, store } = await create(() => clock.now);
    const today = Math.floor(NOW / DAY);
    const dirName = (day: number) => String(day).padStart(5, '0');
    const filesOf = async () =>
      (await readdir(join(dir, 'summaries'), { recursive: true, withFileTypes: true }))
        .filter((f) => f.isFile())
        .map((f) => `${f.parentPath.split('/').pop()}/${f.name}`)
        .sort();

    // A post of 100 days ago, reposted 20 days ago and again yesterday.
    const createdAt = NOW - 100 * DAY;
    const repostedAt = [NOW - 20 * DAY, NOW - DAY, NOW - DAY + 5];
    const { repostedAt: _, ...read } = summary({ createdAt, repostedAt });
    await store.put({ ...read, repostedAt });
    const copies = [today - 100, today - 20, today - 1].map((day) => `${dirName(day)}/${ID}.br`);
    expect(await filesOf()).toEqual(copies);
    expect(await hot.exists([summaryKey(read)])).toEqual([true]);
    // An entry finds it by its own time: the post's, or a repost's.
    for (const at of [createdAt, ...repostedAt]) expect(await store.getMany([{ contentId: ID, createdAt: at }])).toEqual([read]);
    expect(await store.getMany([{ contentId: ID, createdAt: NOW - 50 * DAY }])).toEqual([null]);

    // The post's own day goes with retention; the reposts' copies stay, and ensure writes whichever is missing.
    expect(await store.purgeBefore(today - 90)).toEqual([today - 100]);
    await rm(join(dir, 'summaries', dirName(today - 20)), { recursive: true });
    await hot.del([summaryKey(read)]);
    expect(await store.ensureMany([{ ...read, repostedAt }])).toEqual([null]);
    expect(await filesOf()).toEqual(copies);
    expect(await hot.exists([summaryKey(read)])).toEqual([true]);

    // An update writes every copy, and Redis lets go of it once the latest repost is past the hot window.
    const updated = { ...read, updatedAt: NOW + 5, tags: ['news', 'sports'] };
    await store.put({ ...updated, repostedAt });
    clock.now += 61_000;
    for (const at of [createdAt, ...repostedAt]) expect(await store.getMany([{ contentId: ID, createdAt: at }])).toEqual([updated]);
    clock.now = NOW + 7 * DAY + 10;
    expect(await hot.exists([summaryKey(read)])).toEqual([false]);

    // Erasing it erases every copy.
    await store.erase({ contentId: ID, createdAt, repostedAt });
    expect(await filesOf()).toEqual([]);
    await store.put({ ...updated, repostedAt });
    await store.remove([{ contentId: ID, createdAt, repostedAt }]);
    expect(await filesOf()).toEqual([]);
  });
});
