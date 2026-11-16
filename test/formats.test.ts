import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryHotStore, SummaryStore, type Summary } from '../src/storage/index.js';
import { decodeSummary, encodeSummary, summaryKey } from '../src/storage/summaryStore.js';
import { DAY_ENTRY_BYTES, decodeTail, encodeTail, packDay, unpackDay, type IndexEntry } from '../src/tagfeed/layout.js';
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

  it('rejects truncated text and preview kinds it does not know', () => {
    const text = encodeSummary(summary());
    expect(() => decodeSummary(ID, text.slice(0, 20), '')).toThrow(/truncated/);
    expect(() => decodeSummary(ID, text.replace('\ntext\n', '\nmedia\n'), '')).toThrow(/unknown preview kind/);
  });
});

describe('day index entries', () => {
  it('packs each entry into 25 bytes, keeping whole seconds of the creation time', () => {
    const entries: IndexEntry[] = [
      { contentId: ID, createdAt: NOW + 999, likes: 4_000_000_000, aiGenerated: true, moderated: false },
      { contentId: '00000000-0000-4000-8000-000000000001', createdAt: NOW, likes: 0, aiGenerated: false, moderated: false },
      { contentId: '00000000-0000-4000-8000-000000000002', createdAt: NOW, likes: 1, aiGenerated: false, moderated: true },
      { contentId: '00000000-0000-4000-8000-000000000003', createdAt: NOW, likes: 2, aiGenerated: true, moderated: true },
    ];
    const buf = packDay(entries);
    expect(DAY_ENTRY_BYTES).toBe(25);
    expect(buf.length).toBe(4 * DAY_ENTRY_BYTES);
    expect(unpackDay(buf)).toEqual([{ ...entries[0]!, createdAt: NOW }, ...entries.slice(1)]);
    // The flags are the entry's last byte: 1 for AI-generated, 2 for moderated.
    expect(entries.map((_, i) => buf[(i + 1) * DAY_ENTRY_BYTES - 1])).toEqual([1, 0, 2, 3]);
  });

  it('clamps likes to 32 bits, and refuses ids that are not UUIDs', () => {
    const [e] = unpackDay(packDay([{ contentId: ID, createdAt: NOW, likes: 2 ** 40, aiGenerated: true, moderated: false }]));
    expect(e).toMatchObject({ likes: 0xffffffff, aiGenerated: true });
    const [none] = unpackDay(packDay([{ contentId: ID, createdAt: NOW, likes: -5, aiGenerated: false, moderated: false }]));
    expect(none).toMatchObject({ likes: 0, aiGenerated: false });
    expect(() => packDay([{ contentId: 'c-1', createdAt: NOW, likes: 0, aiGenerated: false, moderated: false }])).toThrow(/UUID/);
  });
});

describe('tail lines', () => {
  it('round-trips records, tombstones and approvals, and ignores lines it cannot read', () => {
    const record = { contentId: ID, createdAt: NOW - 5, updatedAt: NOW, likes: 0, aiGenerated: false, moderated: false };
    expect(encodeTail(record)).toBe(`r ${ID} ${NOW - 5} ${NOW} 0`);
    expect(decodeTail(encodeTail(record))).toEqual(record);
    const ai = { ...record, aiGenerated: true };
    expect(encodeTail(ai)).toBe(`r ${ID} ${NOW - 5} ${NOW} 1`);
    expect(decodeTail(encodeTail(ai))).toEqual(ai);
    const moderated = { ...ai, moderated: true };
    expect(encodeTail(moderated)).toBe(`r ${ID} ${NOW - 5} ${NOW} 3`);
    expect(decodeTail(encodeTail(moderated))).toEqual(moderated);
    const approval = { approval: true as const, contentId: ID, createdAt: NOW - 5 };
    expect(encodeTail(approval)).toBe(`a ${ID} ${NOW - 5}`);
    expect(decodeTail(encodeTail(approval))).toEqual(approval);
    expect(decodeTail(`a ${ID}`)).toBeNull();
    // A record with no flags isn't one this server wrote.
    expect(decodeTail(`r ${ID} ${NOW - 5} ${NOW}`)).toBeNull();
    for (const before of [NOW, null]) {
      const t = { tombstone: true as const, contentId: ID, before, createdAt: NOW - 5 };
      expect(encodeTail(t)).toBe(`t ${ID} ${before ?? '*'} ${NOW - 5}`);
      expect(decodeTail(encodeTail(t))).toEqual(t);
    }
    expect(decodeTail('{"contentId":"x"}')).toBeNull();
    expect(decodeTail('r x 1')).toBeNull();
  });
});

describe('MemoryHotStore', () => {
  it('expires keys by the injected clock and keeps tail windows in a sorted set', async () => {
    let now = NOW;
    const hot = new MemoryHotStore(() => now);
    await hot.set('a', 'x', 1000);
    await hot.set('b', Buffer.from('y'));
    expect(await hot.mget(['a', 'b', 'c'])).toEqual([Buffer.from('x'), Buffer.from('y'), null]);
    now += 1000;
    expect(await hot.exists(['a', 'b'])).toEqual([false, true]);

    for (const w of [300, 0, 600]) await hot.push(`tail:${w}`, `line ${w}`, { key: 'tails', score: w });
    await hot.push('tail:0', 'second', { key: 'tails', score: 0 });
    expect(await hot.scores('tails', 0, 600)).toEqual([0, 300]);
    expect(await hot.scores('tails', 300, Infinity)).toEqual([300, 600]);
    expect((await hot.lists(['tail:0', 'missing'])).map((l) => l.map(String))).toEqual([['line 0', 'second'], []]);
    await hot.expire(['tail:0'], 10);
    now += 10;
    expect(await hot.lists(['tail:0'])).toEqual([[]]);
    await hot.zrem('tails', [0, 300, 600]);
    expect(await hot.scores('tails', 0, Infinity)).toEqual([]);
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
});
