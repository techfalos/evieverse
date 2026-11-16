import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryHotStore, SummaryStore, type Summary } from '../src/storage/index.js';
import { decodeSummary, encodeSummary, summaryKey } from '../src/storage/summaryStore.js';
import { DAY, DAY_ENTRY_BYTES, decodeTail, encodeTail, packDay, unpackDay, type IndexEntry } from '../src/tagfeed/layout.js';

const NOW = Date.UTC(2026, 10, 6, 12);
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

const summary = (o: Partial<Summary> = {}): Summary => ({
  contentId: ID,
  version: 3,
  createdAt: NOW - 1234,
  updatedAt: NOW,
  userId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  mimeType: 'text/plain',
  aiGenerated: false,
  tags: ['news', 'mumbai'],
  preview: { kind: 'text', text: 'Flooding closes roads.\n\nMore below.' },
  ...o,
});

describe('summary text', () => {
  it('round-trips multi-line summaries and previews', () => {
    const s = summary();
    expect(decodeSummary(ID, encodeSummary(s), '')).toEqual(s);
  });

  it('round-trips the AI-generated flag, and reads summaries written before it as not AI-generated', () => {
    const s = summary({ aiGenerated: true });
    expect(decodeSummary(ID, encodeSummary(s), '')).toEqual(s);
    const before = encodeSummary(summary()).replace(/^(\d+ \d+ \d+) 0\n/, '$1\n');
    expect(before.split('\n')[0]).toBe(`3 ${NOW - 1234} ${NOW}`);
    expect(decodeSummary(ID, before, '')).toEqual(summary());
  });

  it('round-trips empty texts and no hashtags', () => {
    const s = summary({ tags: [], preview: { kind: 'text', text: '' } });
    expect(decodeSummary(ID, encodeSummary(s), '')).toEqual(s);
  });

  it('strips the separator character from the preview', () => {
    const s = summary({ preview: { kind: 'text', text: 'c\n\u001e\nd' } });
    expect(decodeSummary(ID, encodeSummary(s), '')).toEqual({ ...s, preview: { kind: 'text', text: 'c\n\nd' } });
  });

  it('leaves an empty line where releases with an AI kept its summary, and skips that summary in what they wrote', () => {
    const header = `3 ${NOW - 1234} ${NOW} 0\n7c9e6679-7425-40de-944b-e07fc1f90ae7\ntext/plain\nnews mumbai\ntext\n`;
    expect(encodeSummary(summary())).toBe(`${header}\n\n\u001e\nFlooding closes roads.\n\nMore below.`);
    const withAi = `${header}\nRelated: flooding\nin Mumbai\n\u001e\nFlooding closes roads.\n\nMore below.`;
    expect(decodeSummary(ID, withAi, '')).toEqual(summary());
  });

  it('stores no text for a media preview and builds its URL when read', () => {
    const s = summary({ mimeType: 'image/png', preview: { kind: 'media', url: 'https://old.example/ignored' } });
    const text = encodeSummary(s);
    expect(text).not.toContain('ignored');
    expect(decodeSummary(ID, text, 'https://api.example.com').preview).toEqual({
      kind: 'media',
      url: `https://api.example.com/content/${ID}/raw?version=3`,
    });
  });

  it('round-trips the origin of federated content, whose media links point at the origin server', () => {
    const origin = { server: 'https://a.example/api', contentId: '5c06badf-f69d-4900-8cab-256a1b626b10', version: 7 };
    const s = summary({ origin });
    expect(decodeSummary(ID, encodeSummary(s), '')).toEqual(s);
    const media = summary({ mimeType: 'image/png', preview: { kind: 'media', url: 'https://old.example/ignored' }, origin });
    expect(decodeSummary(ID, encodeSummary(media), 'https://b.example').preview).toEqual({
      kind: 'media',
      url: `https://a.example/api/content/${origin.contentId}/raw?version=7`,
    });
  });

  it('rejects truncated text', () => {
    const text = encodeSummary(summary());
    expect(() => decodeSummary(ID, text.slice(0, 20), '')).toThrow(/truncated/);
    expect(() => decodeSummary(ID, text.slice(0, text.indexOf('\u001e')), '')).toThrow(/separator/);
  });
});

describe('day index entries', () => {
  it('packs each entry into 30 bytes, keeping whole seconds of the creation time', () => {
    const entries: IndexEntry[] = [
      { contentId: ID, version: 65535, createdAt: NOW + 999, likes: 4_000_000_000, size: 0xffffff, aiGenerated: true },
      { contentId: '00000000-0000-4000-8000-000000000001', version: 1, createdAt: NOW, likes: 0, size: 0, aiGenerated: false },
    ];
    const buf = packDay(entries);
    expect(buf.length).toBe(2 * DAY_ENTRY_BYTES);
    expect(unpackDay(buf)).toEqual([{ ...entries[0]!, createdAt: NOW }, entries[1]]);
  });

  it('reads entries packed with a 32-bit size, before flags existed, as not AI-generated', () => {
    const old = Buffer.alloc(DAY_ENTRY_BYTES);
    Buffer.from(ID.replace(/-/g, ''), 'hex').copy(old);
    old.writeUInt32BE(7, 16);
    old.writeUInt32BE(NOW / 1000, 20);
    old.writeUInt32BE(1234, 24);
    old.writeUInt16BE(2, 28);
    expect(unpackDay(old)).toEqual([{ contentId: ID, version: 2, createdAt: NOW, likes: 7, size: 1234, aiGenerated: false }]);
  });

  it('clamps likes to 32 bits and sizes to 24, and refuses ids that are not UUIDs', () => {
    const [e] = unpackDay(packDay([{ contentId: ID, version: 1, createdAt: NOW, likes: 2 ** 40, size: -5, aiGenerated: false }]));
    expect(e).toMatchObject({ likes: 0xffffffff, size: 0 });
    const [big] = unpackDay(packDay([{ contentId: ID, version: 1, createdAt: NOW, likes: 0, size: 2 ** 24, aiGenerated: true }]));
    expect(big).toMatchObject({ size: 0xffffff, aiGenerated: true });
    expect(() => packDay([{ contentId: 'c-1', version: 1, createdAt: NOW, likes: 0, size: 0, aiGenerated: false }])).toThrow(/UUID/);
  });
});

describe('tail lines', () => {
  it('round-trips records and tombstones, and ignores lines it cannot read', () => {
    const record = { contentId: ID, version: 2, createdAt: NOW - 5, updatedAt: NOW, likes: 0, size: 456, aiGenerated: false };
    expect(encodeTail(record)).toBe(`r ${ID} 2 ${NOW - 5} ${NOW} 456 0`);
    expect(decodeTail(encodeTail(record))).toEqual(record);
    const ai = { ...record, aiGenerated: true };
    expect(encodeTail(ai)).toBe(`r ${ID} 2 ${NOW - 5} ${NOW} 456 1`);
    expect(decodeTail(encodeTail(ai))).toEqual(ai);
    // Pushed before flags existed.
    expect(decodeTail(`r ${ID} 2 ${NOW - 5} ${NOW} 456`)).toEqual(record);
    for (const below of [3, null]) {
      const t = { tombstone: true as const, contentId: ID, below, createdAt: NOW };
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
});

describe('SummaryStore', () => {
  let dir: string;
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const create = async (now: () => number) => {
    dir = await mkdtemp(join(tmpdir(), 'theuniverse-summaries-'));
    const hot = new MemoryHotStore(now);
    const store = new SummaryStore(hot, { scheme: 'fs', options: { root: dir } }, { hotDays: 8, quality: 11, cacheSize: 0, publicBaseUrl: '' }, now);
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
