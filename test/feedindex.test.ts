import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { summaryKey, summaryObjectKey } from '../src/storage/summaryStore.js';
import type { SummaryRef } from '../src/storage/summaryStore.types.js';
import { authorIndex, DAY_ENTRY_BYTES, dayKey, headKey, manifestKey, unpackDay } from '../src/tagfeed/layout.js';
import type { DayRef, Head, Manifest } from '../src/tagfeed/layout.types.js';
import { TagFeedReader } from '../src/tagfeed/reader.js';
import { DAY, HOUR, utcDay } from '../src/time.js';
import { failing, once } from './harness.js';
import { createTestContext, queued, requests, TARGETS, type Feed, type TestContext, type User } from './helpers.js';

for (const target of TARGETS) {
  describe(`feed index (${target.name})`, () => {
    let ctx: TestContext;
    afterEach(async () => {
      vi.restoreAllMocks();
      await ctx.close();
    });

    const api = requests(() => ctx);
    const { post: store, feedItems: items } = api;
    /** Stores a post and returns what locates its summary. */
    const post = async (user: User, content: string): Promise<SummaryRef> => {
      const createdAt = ctx.clock.now;
      return { contentId: await store(user, content), createdAt };
    };
    const getFeed = async (query: string) => ctx.app.inject({ method: 'GET', url: `/feed?${query}` });
    const own = (user: User) => authorIndex(user.userId);
    const allIds = (f: Feed) => Object.values(f.tags).flatMap((l) => l.map((i) => i.contentId));
    const readJson = async <T>(key: string) => JSON.parse((await ctx.hot.get(key))!.toString()) as T;
    const readHead = (tag: string) => readJson<Head>(headKey(tag));
    const readManifest = async (tag: string) => readJson<Manifest>(manifestKey(tag, (await readHead(tag)).manifest!));
    const dayIndex = async (tag: string, d: DayRef) => unpackDay((await ctx.hot.get(dayKey(tag, d.gen)))!);
    const dayIds = async (tag: string, d: DayRef) => (await dayIndex(tag, d)).map((e) => e.contentId);
    const indexIds = async (tag: string) => {
      const days = (await readManifest(tag)).days;
      return (await Promise.all(days.map((d) => dayIds(tag, d)))).flat();
    };
    const like = async (user: User, contentId: string) => {
      const res = await api.like(user, contentId);
      expect(res.statusCode, res.body).toBe(201);
    };
    const update = (user: User, contentId: string, text: string) => api.storeText(user, text, { contentId });
    const contentRow = (contentId: string) => ctx.db.selectFrom('content').select('id').where('id', '=', contentId).executeTakeFirst();
    /** What a hashtag's feed shows: each post and its text. */
    const shown = async (tag: string) => (await items(tag)).map((i) => [i.contentId, i.preview.text]);
    /** The feed queue: "<contentId> <tag>" of every row. */
    const queue = () => queued(ctx);
    /** The rows a write of `contentId` under these hashtags queues: one each, and one for its publisher's own index. */
    const rowsOf = (user: User, contentId: string, ...tags: string[]) => [own(user), ...tags].map((tag) => `${contentId} ${tag}`);
    const del = async (user: User, contentId: string) => {
      const res = await ctx.app.inject({ method: 'DELETE', url: `/content/${contentId}`, payload: { ...user } });
      expect(res.statusCode, res.body).toBe(202);
    };
    /** Every page of the feed session that `first` began. */
    const restOf = async (query: string, first: Feed) => {
      const seen = allIds(first);
      let cursor = first.nextCursor;
      for (let page = 0; cursor && page < 40; page++) {
        const res = await getFeed(`${query}&cursor=${cursor}`);
        expect(res.statusCode, res.body).toBe(200);
        const f = res.json() as Feed;
        seen.push(...allIds(f));
        cursor = f.nextCursor;
      }
      return seen;
    };
    /** Runs the next transaction's statements, then fails it the way a failed COMMIT would. */
    const failNextCommit = (committed: boolean) => {
      const transaction = ctx.db.transaction.bind(ctx.db);
      vi.spyOn(ctx.db, 'transaction').mockImplementationOnce(
        () =>
          ({
            execute: async (fn: (trx: unknown) => Promise<unknown>) => {
              if (committed) await transaction().execute(fn);
              else await transaction().execute(async (trx) => {
                await fn(trx);
                throw new Error('rolled back');
              });
              throw new Error('commit failed');
            },
          }) as never,
      );
    };
    /**
     * Pauses the next write just before its commit, which is all of a request's write (see
     * contentWriter), until released: the request has read what it writes over by then.
     */
    const pauseCommit = () => {
      let reached!: () => void;
      let release!: () => void;
      const paused = new Promise<void>((r) => (reached = r));
      const released = new Promise<void>((r) => (release = r));
      const transaction = ctx.db.transaction.bind(ctx.db);
      vi.spyOn(ctx.db, 'transaction').mockImplementationOnce(
        () =>
          ({
            execute: async (fn: (trx: unknown) => Promise<unknown>) => {
              reached();
              await released;
              return transaction().execute(fn);
            },
          }) as never,
      );
      return { paused, release };
    };
    /** The writes that wait for the compactor: the number of each, in order. */
    const pending = async () => (await ctx.db.selectFrom('pending_writes').select('seq').orderBy('seq').execute()).map((r) => Number(r.seq));
    const storedFiles = async (contentId: string) => (await readdir(join(ctx.dir, 'content', 'content'))).filter((f) => f.startsWith(contentId)).sort();
    const summaryDir = (createdAt: number) => join(ctx.dir, 'summaries', 'summaries', String(utcDay(createdAt)).padStart(5, '0'));
    const storedSummaries = async (contentId: string, createdAt: number) => (await readdir(summaryDir(createdAt))).filter((f) => f.startsWith(contentId)).sort();
    /** Pauses the compactor's first write of index keys that has a matching key among them until released, before the write happens. */
    const pauseSet = (matches: (key: string) => boolean) => {
      let reached!: () => void;
      let release!: () => void;
      const paused = new Promise<void>((r) => (reached = r));
      const released = new Promise<void>((r) => (release = r));
      let done = false;
      ctx.compactor.watch('hot.setMany', {
        before: async ({ keys }) => {
          if (done || !keys.some(matches)) return;
          done = true;
          reached();
          await released;
        },
      });
      return { paused, release };
    };
    /** The index keys the compactor wrote, of those a watch on its `setMany` saw. */
    const keysSet = (watch: { calls: { keys: string[] }[] }) => watch.calls.flatMap(({ keys }) => keys);

    it('puts queued posts in feeds on the next run: a packed, sorted day index named by a manifest, and the head swapped to it', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(await store(alice, `item ${i} #news`));
        ctx.clock.now += 1000;
      }
      // Stored, and readable, but in no feed yet: each waits in the queue, for its hashtag's index and its publisher's.
      expect((await ctx.app.inject({ method: 'GET', url: `/content/${ids[0]}/raw` })).body).toBe('item 0 #news');
      expect(allIds((await getFeed('tags=news')).json())).toEqual([]);
      expect(await queue()).toEqual(ids.flatMap((id) => rowsOf(alice, id, 'news')).sort());

      // The next run takes them all, with nothing to wait for, and swaps each head once.
      const set = ctx.compactor.watch('hot.setMany');
      expect((await ctx.compactor.runOnce()).tags).toEqual([own(alice), 'news'].sort());
      expect(keysSet(set).filter((key) => key === headKey('news'))).toHaveLength(1);
      expect(await queue()).toEqual([]);
      expect(await readHead('news')).toMatchObject({ v: 5, manifest: expect.any(String) });
      const manifest = await readManifest('news');
      expect(manifest.days).toHaveLength(1);
      const [day] = manifest.days;
      expect(day).toMatchObject({ day: utcDay(ctx.clock.now), count: 5 });
      expect((await ctx.hot.get(dayKey('news', day!.gen)))!.length).toBe(5 * DAY_ENTRY_BYTES);
      const entries = await dayIndex('news', day!);
      expect(entries.map((e) => e.contentId)).toEqual([...ids].reverse());
      expect(allIds((await getFeed('tags=news')).json())).toEqual([...ids].reverse());

      // A run with nothing queued compacts nothing.
      expect((await ctx.compactor.runOnce()).tags).toEqual([]);
    });

    it('lets readers holding an old head keep reading while compaction swaps the head, then lets the superseded keys expire', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const a = await store(alice, 'a #news');
      await ctx.compact();
      const oldHead = await readHead('news');
      const oldManifest = await readManifest('news');
      // A node that read the head just before the run that replaces it, and has read nothing else of the index.
      const node = new TagFeedReader(ctx.hot, { headCacheMs: HOUR, indexCacheSize: 10 }, () => ctx.clock.now);
      expect(await node.head('news')).toEqual(oldHead);
      const b = await store(alice, 'b #news');
      await ctx.compact();
      const newHead = await readHead('news');
      expect(newHead.manifest).not.toBe(oldHead.manifest);
      const current = await readManifest('news');

      // It still reads a consistent view: the index as it was then.
      expect((await node.view('news')).candidates.map((c) => c.contentId)).toEqual([a]);

      const superseded = [manifestKey('news', oldHead.manifest!), ...oldManifest.days.map((d) => dayKey('news', d.gen))];
      const live = [manifestKey('news', newHead.manifest!), ...current.days.map((d) => dayKey('news', d.gen))];
      expect(await ctx.hot.exists(superseded)).toEqual([true, true]);
      // Kept a minute past the time a node caches a head (none, in tests), by Redis's own clock,
      // which is the one keys expire by: what a head names never expires.
      for (const left of await ctx.ttl(superseded)) {
        expect(left).toBeGreaterThan(50_000);
        expect(left).toBeLessThanOrEqual(60_000);
      }
      expect(await ctx.ttl(live)).toEqual([-1, -1]);
      expect(allIds((await getFeed('tags=news')).json()).sort()).toEqual([a, b].sort());
    });

    it('keeps a popular post for weeks while a flood of new posts arrives, trimming its day by likes', async () => {
      ctx = await createTestContext(target, { feed: { tagDayMaxPosts: 20, tagDayMinPosts: 3 } });
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');

      ctx.clock.now -= 20 * DAY;
      const popular = await store(alice, 'popular #news');
      for (let i = 0; i < 9; i++) {
        ctx.clock.now += 1000;
        await store(alice, `old ${i} #news`);
      }
      await like(bob, popular);
      await ctx.compact();
      const oldDay = utcDay(ctx.clock.now);

      ctx.clock.now += 20 * DAY;
      for (let i = 0; i < 40; i++) {
        await store(alice, `flood ${i} #news`);
        ctx.clock.now += 1000;
      }
      await ctx.compact();

      const manifest = await readManifest('news');
      const old = manifest.days.find((d) => d.day === oldDay)!;
      // Re-trimmed to the floor quota: the liked post first, then the newest of the rest.
      const oldIds = await dayIds('news', old);
      expect(oldIds.length).toBe(3);
      expect(oldIds[0]).toBe(popular);
      expect(manifest.days[0]!.count).toBe(20);
      // A feed of the past day has only the flood; one whose window reaches the old day puts the liked post first.
      expect(allIds((await getFeed('tags=news&hours=24')).json())).not.toContain(popular);
      const feed = (await getFeed('tags=news&hours=720')).json() as Feed;
      expect(allIds(feed)[0]).toBe(popular);
    });

    it('rewrites only the day index of liked content and re-admits liked content that was trimmed', async () => {
      ctx = await createTestContext(target, { feed: { tagDayMaxPosts: 3, tagDayMinPosts: 3 } });
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');

      ctx.clock.now -= 2 * DAY;
      const older: string[] = [];
      for (let i = 0; i < 6; i++) {
        older.push(await store(alice, `older ${i} #news`));
        ctx.clock.now += 1000;
      }
      ctx.clock.now += 2 * DAY;
      await store(alice, 'today #news');
      await ctx.compact();
      const before = await readManifest('news');
      const [today, past] = before.days;
      expect(await dayIds('news', past!)).toEqual(older.slice(3).reverse());

      // The oldest post was trimmed; a like brings it back, ranked first in its day.
      await like(bob, older[0]!);
      await ctx.compact();
      const after = await readManifest('news');
      expect(after.days[0]!.gen).toBe(today!.gen);
      expect(after.days[1]!.gen).not.toBe(past!.gen);
      const entries = await dayIndex('news', after.days[1]!);
      expect(entries.map((e) => e.contentId)).toEqual([older[0], older[5], older[4]]);
      expect(entries[0]!.likes).toBe(1);
    });

    it('drops days, and their summaries, older than the retention period', async () => {
      ctx = await createTestContext(target, { feed: { tagRetentionDays: 3 } });
      const alice = await ctx.register('alice');
      const old = await post(alice, 'old #news');
      await ctx.compact();
      ctx.clock.now += 4 * DAY;
      const fresh = await post(alice, 'fresh #news');
      await ctx.compact();
      const manifest = await readManifest('news');
      expect(manifest.days.map((d) => d.day)).toEqual([utcDay(ctx.clock.now)]);
      const ids = allIds((await getFeed('tags=news&hours=168')).json());
      expect(ids).toEqual([fresh.contentId]);
      expect(ids).not.toContain(old.contentId);
      expect(await readdir(join(ctx.dir, 'summaries', 'summaries'))).toEqual([String(utcDay(fresh.createdAt)).padStart(5, '0')]);
    });

    it('removes a record from tags that an update no longer carries', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const id = await store(alice, 'first #news #sports');
      await ctx.compact();
      expect(allIds((await getFeed('tags=sports')).json())).toEqual([id]);
      const upd = await update(alice, id, 'second #news');
      expect(upd.statusCode, upd.body).toBe(200);
      // Left out of #sports at once, by its summary, which no longer carries the hashtag; the index still holds its entry.
      expect(allIds((await getFeed('tags=sports')).json())).toEqual([]);
      expect(await indexIds('sports')).toEqual([id]);
      await ctx.compactor.runOnce();
      expect((await readManifest('sports')).days).toEqual([]);
      expect(allIds((await getFeed('tags=sports')).json())).toEqual([]);
      expect(allIds((await getFeed('tags=news')).json())).toEqual([id]);
    });

    it('keeps content set for deletion in feeds until the next run, which removes it from every index, the summaries and the database together', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const createdAt = ctx.clock.now;
      const id = await store(alice, 'v1 #news #tech');
      ctx.clock.now += 1000;
      const keep = await store(alice, 'keep #news');
      ctx.clock.now += 1000;
      expect((await update(alice, id, 'v2 #news #tech')).statusCode).toBe(200);
      await like(bob, id);
      await ctx.compact();
      expect(await shown('news')).toEqual([[id, 'v2 #news #tech'], [keep, 'keep #news']]);
      expect(await shown('tech')).toEqual([[id, 'v2 #news #tech']]);

      await del(alice, id);
      // Gone for anyone who asks for it, and for good: it can't be read, liked or updated.
      expect((await ctx.app.inject({ method: 'GET', url: `/content/${id}` })).statusCode).toBe(404);
      expect((await api.like(alice, id)).statusCode).toBe(404);
      expect((await update(alice, id, 'v3 #news')).statusCode).toBe(409);
      // Feeds still have it: the indexes, the summary, the row and the bytes are untouched until the compactor runs.
      expect(await shown('news')).toEqual([[id, 'v2 #news #tech'], [keep, 'keep #news']]);
      expect(await indexIds('tech')).toEqual([id]);
      expect(await contentRow(id)).toBeDefined();
      expect(await ctx.content.getMeta(id)).not.toBeNull();
      const ref = { contentId: id, createdAt };
      expect(await ctx.hot.exists([summaryKey(ref)])).toEqual([true]);

      // The next run, with nothing to wait for.
      expect((await ctx.compactor.runOnce()).deleted).toEqual([id]);
      expect(await shown('news')).toEqual([[keep, 'keep #news']]);
      expect(await shown('tech')).toEqual([]);
      expect(await indexIds('news')).toEqual([keep]);
      expect((await readManifest('tech')).days).toEqual([]);
      expect(await contentRow(id)).toBeUndefined();
      expect(await ctx.content.getMeta(id)).toBeNull();
      expect(await storedFiles(id)).toEqual([]);
      expect(await ctx.summaries.getMany([ref])).toEqual([null]);
      expect(await storedSummaries(id, createdAt)).toEqual([]);
      expect(await ctx.hot.exists([summaryKey(ref)])).toEqual([false]);
      expect(await ctx.db.selectFrom('likes').selectAll().execute()).toEqual([]);
      expect((await ctx.compact()).deleted).toEqual([]);
    });

    it('deletes content that was written a moment ago on the next run, before it was ever in a feed', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const id = await store(alice, 'fresh #news');
      await del(alice, id);
      expect(await queue()).toEqual(rowsOf(alice, id, 'news').sort());

      expect(await ctx.compactor.runOnce()).toMatchObject({ tags: [own(alice), 'news'].sort(), deleted: [id] });
      expect(await items('news')).toEqual([]);
      expect(await contentRow(id)).toBeUndefined();
      // Its rows in the queue went with it.
      expect(await queue()).toEqual([]);
    });

    it('skips a compactor run while another is going, so a slower run never republishes content a newer one deleted', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const id = await store(alice, 'doomed #news');
      await ctx.compact();

      // Run A starts before the DELETE, with a like to apply to #news, and is slow to publish it.
      await like(bob, id);
      const slow = pauseSet((key) => key === headKey('news'));
      ctx.clock.now += 1000;
      const runA = ctx.compactor.runOnce();
      await slow.paused;

      await del(alice, id);
      ctx.clock.now += 1000;
      expect(await ctx.compactor.runOnce()).toEqual({ tags: [], deleted: [], skipped: true });
      expect(await contentRow(id)).toBeDefined();

      slow.release();
      expect(await runA).toMatchObject({ tags: [authorIndex(alice.userId), 'news'], deleted: [] });
      expect((await items('news')).map((i) => [i.contentId, i.likes])).toEqual([[id, 1]]);
      expect((await ctx.compact()).deleted).toEqual([id]);
      expect((await readManifest('news')).days).toEqual([]);
      expect(await contentRow(id)).toBeUndefined();
    });

    it('stops a compactor run that lost its lease before it publishes or deletes anything more', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const id = await store(alice, 'doomed #news');
      await ctx.compact();

      // Run A stalls while writing its #news day index, until its lease has expired.
      await like(bob, id);
      const stalled = pauseSet((key) => key.startsWith('day:news:'));
      ctx.clock.now += 1000;
      const runA = ctx.compactor.runOnce();
      // Against a real database the run can find its lease gone, compacting alice's own index, before it is awaited below.
      runA.catch(() => {});
      await stalled.paused;

      await del(alice, id);
      // Once the lease has expired.
      expect((await ctx.compact(ctx.config.compact.leaseSeconds * 1000)).deleted).toEqual([id]);
      expect((await readManifest('news')).days).toEqual([]);
      const head = await readHead('news');

      stalled.release();
      await expect(runA).rejects.toThrow(/lease/);
      expect(await readHead('news')).toEqual(head);
      expect((await readManifest('news')).days).toEqual([]);
      expect(await items('news')).toEqual([]);
    });

    it('leaves deleted content out of later pages of a feed session, without skipping or repeating other records', async () => {
      ctx = await createTestContext(target, { feed: { pageSize: 5 } });
      const alice = await ctx.register('alice');
      const ids: string[] = [];
      for (let i = 0; i < 12; i++) {
        ids.push(await store(alice, `post ${i} #news`));
        ctx.clock.now += 1000;
      }
      await ctx.compact();

      const first = (await getFeed('tags=news')).json() as Feed;
      // One record the session has already returned, one it hasn't reached yet.
      const shown = allIds(first)[0]!;
      const unseen = ids.find((id) => !allIds(first).includes(id))!;
      for (const id of [shown, unseen]) await del(alice, id);
      // The run that deletes them takes them out of the index, which the session's later pages read as it is by then.
      expect((await ctx.compactor.runOnce()).deleted.sort()).toEqual([shown, unseen].sort());
      expect(await indexIds('news')).toHaveLength(10);

      const seen = await restOf('tags=news', first);
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.sort()).toEqual(ids.filter((id) => id !== unseen).sort());
    });

    it('leaves a post out of later pages of a feed session for a hashtag an update dropped, and shows it under one it still carries', async () => {
      ctx = await createTestContext(target, { feed: { pageSize: 2 } });
      const alice = await ctx.register('alice');
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) {
        ids.push(await store(alice, `post ${i} #news #sports`));
        ctx.clock.now += 1000;
      }
      await ctx.compact();

      const news = (await getFeed('tags=news')).json() as Feed;
      const sports = (await getFeed('tags=sports')).json() as Feed;
      const moved = ids.find((id) => !allIds(news).includes(id))!;
      expect((await update(alice, moved, 'moved #sports')).statusCode).toBe(200);
      // Before the run that rebuilds the index of #news, which still lists the post, and after it.
      const before = await restOf('tags=news', news);
      await ctx.compactor.runOnce();
      expect(await indexIds('news')).not.toContain(moved);

      for (const inNews of [before, await restOf('tags=news', news)]) {
        expect(new Set(inNews).size).toBe(inNews.length);
        expect(inNews.sort()).toEqual(ids.filter((id) => id !== moved).sort());
      }
      const inSports = await restOf('tags=sports', sports);
      expect(new Set(inSports).size).toBe(inSports.length);
      expect(inSports.sort()).toEqual([...ids].sort());
    });

    it('writes an update over the post: shown as it now is and left out of each hashtag it dropped at once, and under each it gave after the next run', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const { contentId: id, createdAt } = await post(alice, 'v1 #news #old');
      await ctx.compact();
      ctx.clock.now += 1000;
      expect((await update(alice, id, 'v2 #news')).statusCode).toBe(200);
      ctx.clock.now += 1000;
      expect((await update(alice, id, 'v3 #news #tech')).statusCode).toBe(200);

      expect(await shown('news')).toEqual([[id, 'v3 #news #tech']]);
      expect(await shown('old')).toEqual([]);
      // Not under the hashtag it gained until the compactor has run.
      expect(await shown('tech')).toEqual([]);
      // One post: one file, one meta file, one summary, however often it is updated.
      expect(await storedFiles(id)).toEqual([id, `${id}.meta.json`]);
      expect(await storedSummaries(id, createdAt)).toEqual([`${id}.br`]);
      expect(await ctx.db.selectFrom('content').select('id').execute()).toEqual([{ id }]);
      // Two updates, and one row for each index they changed its place in.
      expect(await queue()).toEqual(rowsOf(alice, id, 'news', 'old', 'tech').sort());

      await ctx.compactor.runOnce();
      expect((await readManifest('old')).days).toEqual([]);
      expect(await indexIds('tech')).toEqual([id]);
      expect(await shown('news')).toEqual([[id, 'v3 #news #tech']]);
      expect(await shown('old')).toEqual([]);
      expect(await shown('tech')).toEqual([[id, 'v3 #news #tech']]);
      expect(await queue()).toEqual([]);

      // A hashtag an update gives back shows the post again, once the compactor has run.
      ctx.clock.now += 1000;
      expect((await update(alice, id, 'v4 #news #old')).statusCode).toBe(200);
      expect(await shown('old')).toEqual([]);
      expect(await shown('tech')).toEqual([]);
      await ctx.compactor.runOnce();
      expect(await indexIds('old')).toEqual([id]);
      expect((await readManifest('tech')).days).toEqual([]);
      expect(await shown('old')).toEqual([[id, 'v4 #news #old']]);
    });

    it('queues a post once per index however often it is written between two runs, and builds its entry from what it is when the run reads it', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const id = await store(alice, 'v1 #news #sports');
      expect((await update(alice, id, 'v2 #news #sports')).statusCode).toBe(200);
      expect((await update(alice, id, 'v3 #news')).statusCode).toBe(200);
      expect(await queue()).toEqual(rowsOf(alice, id, 'news', 'sports').sort());

      expect((await ctx.compactor.runOnce()).tags).toEqual([own(alice), 'news', 'sports'].sort());
      expect(await shown('news')).toEqual([[id, 'v3 #news']]);
      // Never in #sports: the run found it without the hashtag.
      expect((await readManifest('sports')).days).toEqual([]);
      expect(await queue()).toEqual([]);
    });

    it('leaves for the next run a row that a write stamped again while the run was under way', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const id = await store(alice, 'v1 #news');

      // The run has read the queue and the post, and is about to publish #news.
      const publishing = pauseSet((key) => key === headKey('news'));
      const run = ctx.compactor.runOnce();
      await publishing.paused;
      expect((await update(alice, id, 'v2 #news #sports')).statusCode).toBe(200);
      publishing.release();
      expect((await run).tags).toEqual([own(alice), 'news'].sort());

      // The update's rows are its own, not the ones the run took: all of them wait, the hashtags it kept too.
      // So does the update itself, which the run didn't apply: feeds show the post as the run found it.
      expect(await queue()).toEqual(rowsOf(alice, id, 'news', 'sports').sort());
      expect(await pending()).toEqual([2]);
      expect(await shown('news')).toEqual([[id, 'v1 #news']]);
      expect(await shown('sports')).toEqual([]);
      await ctx.compactor.runOnce();
      expect(await shown('news')).toEqual([[id, 'v2 #news #sports']]);
      expect(await shown('sports')).toEqual([[id, 'v2 #news #sports']]);
      expect(await queue()).toEqual([]);
      expect(await pending()).toEqual([]);
    });

    it('publishes nothing for an update that leaves the index as it is', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const id = await store(alice, 'v1 #news');
      await ctx.compact();
      const head = await readHead('news');

      // Only the text changed: the entry is the same, so the day keeps its index and the hashtag its head.
      expect((await update(alice, id, 'v2 #news')).statusCode).toBe(200);
      const set = ctx.compactor.watch('hot.setMany');
      expect((await ctx.compactor.runOnce()).tags).toEqual([own(alice), 'news'].sort());
      expect(keysSet(set)).toEqual([]);
      expect(await readHead('news')).toEqual(head);
      expect(await shown('news')).toEqual([[id, 'v2 #news']]);
      expect(await queue()).toEqual([]);
    });

    it('writes nothing for an update whose commit failed: the post, its feeds and the queue are as they were, and sending it again makes it', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const { contentId: id, createdAt } = await post(alice, 'v1 #news #old');
      await ctx.compact();

      ctx.clock.now += 1000;
      failNextCommit(false);
      expect((await update(alice, id, 'v2 draft #news')).statusCode).toBe(500);
      // The commit is all there is to a write: one that failed left the post as it was, everywhere.
      expect((await ctx.app.inject({ method: 'GET', url: `/content/${id}/raw` })).body).toBe('v1 #news #old');
      expect(await ctx.content.getMeta(id)).toMatchObject({ text: 'v1 #news #old', tags: ['news', 'old'] });
      expect(await shown('news')).toEqual([[id, 'v1 #news #old']]);
      expect(await shown('old')).toEqual([[id, 'v1 #news #old']]);
      expect(await queue()).toEqual([]);
      expect(await pending()).toEqual([]);
      expect((await ctx.compactor.runOnce()).tags).toEqual([]);
      expect(await indexIds('old')).toEqual([id]);

      ctx.clock.now += 1000;
      const retry = await update(alice, id, 'v2 #news');
      expect(retry.statusCode, retry.body).toBe(200);
      expect(await queue()).toEqual(rowsOf(alice, id, 'news', 'old').sort());
      await ctx.compactor.runOnce();
      expect(await shown('news')).toEqual([[id, 'v2 #news']]);
      expect((await readManifest('old')).days).toEqual([]);
      expect(await storedFiles(id)).toEqual([id, `${id}.meta.json`]);
      expect(await storedSummaries(id, createdAt)).toEqual([`${id}.br`]);
      expect(await queue()).toEqual([]);
    });

    it('keeps an update the compactor could not write for its next run: read by its id the post is the update, and feeds show it as it was until then', async () => {
      ctx = await createTestContext(target, { settle: false });
      const alice = await ctx.register('alice');
      const id = await store(alice, 'v1 #news');
      await ctx.compact();

      ctx.clock.now += 1000;
      expect((await update(alice, id, 'v2 #news #tech')).statusCode).toBe(200);
      ctx.compactor.watch('content.putBytes', once(failing('store unavailable')));
      await ctx.compactor.runOnce();
      // The update committed: it is what the post is to whoever reads it by its id.
      expect((await ctx.app.inject({ method: 'GET', url: `/content/${id}` })).json()).toMatchObject({ preview: { kind: 'text', text: 'v2 #news #tech' }, tags: ['news', 'tech'] });
      // Nothing of it is in the stores yet, so feeds show what they showed, and its rows wait.
      expect(await ctx.content.getMeta(id)).toMatchObject({ text: 'v1 #news', tags: ['news'] });
      expect(await shown('news')).toEqual([[id, 'v1 #news']]);
      expect(await shown('tech')).toEqual([]);
      expect(await queue()).toEqual(rowsOf(alice, id, 'news', 'tech').sort());
      expect(await pending()).toEqual([2]);

      await ctx.compactor.runOnce();
      expect(await ctx.content.getMeta(id)).toMatchObject({ text: 'v2 #news #tech', tags: ['news', 'tech'] });
      expect(await shown('news')).toEqual([[id, 'v2 #news #tech']]);
      expect(await shown('tech')).toEqual([[id, 'v2 #news #tech']]);
      expect(await queue()).toEqual([]);
      expect(await pending()).toEqual([]);
    });

    it('keeps and queues a write whose commit went through even though it reported an error', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      failNextCommit(true);
      const res = await ctx.app.inject({ method: 'POST', url: '/store', payload: { ...alice, type: 'text', text: 'kept #news', tags: ['news'] } });
      expect(res.statusCode, res.body).toBe(201);
      const { contentId } = res.json();
      expect((await ctx.app.inject({ method: 'GET', url: `/content/${contentId}/raw` })).body).toBe('kept #news');
      expect(await queue()).toEqual(rowsOf(alice, contentId, 'news').sort());
      await ctx.compactor.runOnce();
      expect(await shown('news')).toEqual([[contentId, 'kept #news']]);
      expect(await queue()).toEqual([]);
    });

    it('applies the last of two overlapping updates to commit, and that one alone', async () => {
      ctx = await createTestContext(target, { settle: false });
      const alice = await ctx.register('alice');
      const { contentId: id, createdAt } = await post(alice, 'v1 #news');
      await ctx.compact();
      const raw = async () => (await ctx.app.inject({ method: 'GET', url: `/content/${id}/raw` })).body;

      // A client retries an update that timed out; the first attempt commits after the retry has.
      const first = pauseCommit();
      const firstRes = update(alice, id, 'first #news #sports');
      await first.paused;
      const retry = await update(alice, id, 'retry #news #tech');
      expect(retry.statusCode, retry.body).toBe(200);
      expect(await raw()).toBe('retry #news #tech');
      first.release();
      expect((await firstRes).statusCode).toBe(200);

      // The post is the update that committed last, to whoever reads it by its id.
      expect(await raw()).toBe('first #news #sports');
      expect((await ctx.app.inject({ method: 'GET', url: `/content/${id}` })).json()).toMatchObject({
        preview: { kind: 'text', text: 'first #news #sports' },
        tags: ['news', 'sports'],
      });
      // Both wait, in the order they committed, with the hashtags of both in the queue: the one the retry gave is to be looked at again.
      expect(await pending()).toEqual([2, 3]);
      expect(await queue()).toEqual(rowsOf(alice, id, 'news', 'sports', 'tech').sort());
      expect(await ctx.content.getMeta(id)).toMatchObject({ text: 'v1 #news' });

      // The compactor writes the last one, and nothing of the other.
      const putMeta = ctx.compactor.watch('content.putMeta');
      await ctx.compactor.runOnce();
      expect(putMeta.calls.map(({ meta }) => meta.text)).toEqual(['first #news #sports']);
      expect(await raw()).toBe('first #news #sports');
      expect(await shown('news')).toEqual([[id, 'first #news #sports']]);
      expect(await shown('sports')).toEqual([[id, 'first #news #sports']]);
      expect(await shown('tech')).toEqual([]);
      expect(await storedFiles(id)).toEqual([id, `${id}.meta.json`]);
      expect(await storedSummaries(id, createdAt)).toEqual([`${id}.br`]);
      expect(await queue()).toEqual([]);
      expect(await pending()).toEqual([]);
    });

    it('keeps a post whose summary could not be written for the next run, which puts it in feeds', async () => {
      ctx = await createTestContext(target, { settle: false });
      const alice = await ctx.register('alice');
      const { contentId, createdAt } = await post(alice, 'kept #news');
      const refused = ctx.compactor.watch('hot.set', {
        before: ({ key }) => {
          if (key.startsWith('sum:')) throw new Error('redis unavailable');
        },
      });
      await ctx.compactor.runOnce();
      // The post is there, and read by its id. It is in no feed, and its write and its rows wait.
      expect((await ctx.app.inject({ method: 'GET', url: `/content/${contentId}/raw` })).body).toBe('kept #news');
      expect(await ctx.content.getMeta(contentId)).toBeNull();
      expect(await shown('news')).toEqual([]);
      expect(await queue()).toEqual(rowsOf(alice, contentId, 'news').sort());
      expect(await pending()).toEqual([1]);

      refused.stop();
      await ctx.compactor.runOnce();
      expect(await shown('news')).toEqual([[contentId, 'kept #news']]);
      expect(await storedFiles(contentId)).toEqual([contentId, `${contentId}.meta.json`]);
      expect(await storedSummaries(contentId, createdAt)).toEqual([`${contentId}.br`]);
      expect(await queue()).toEqual([]);
      expect(await pending()).toEqual([]);
    });

    it('keeps the row of an index it could not compact, for the next run, and deletes the rest of the write', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      await store(alice, 'first #news');
      await ctx.compact();

      const second = await store(alice, 'second #news');
      // One of the post's two indexes can't be published: part of it was evicted before its head was swapped.
      ctx.compactor.watch('hot.persist', once({ before: ({ keys }) => keys.map((_, i) => i > 0) }));
      expect((await ctx.compactor.runOnce()).tags).toEqual([own(alice), 'news'].sort());
      const left = await queue();
      expect(left).toHaveLength(1);
      expect(rowsOf(alice, second, 'news')).toContain(left[0]);

      // The next run takes only that one.
      expect((await ctx.compactor.runOnce()).tags).toEqual([left[0]!.split(' ')[1]]);
      expect(await indexIds('news')).toContain(second);
      expect(await indexIds(own(alice))).toContain(second);
      expect(await queue()).toEqual([]);
      expect((await ctx.compactor.runOnce()).tags).toEqual([]);
    });

    it('compacts the indexes of a run together, in round trips to Redis that do not grow with the publishers who posted', async () => {
      ctx = await createTestContext(target);
      const users: User[] = [];
      for (let i = 0; i < 12; i++) users.push(await ctx.register(`user${i}`));
      const first: string[] = [];
      for (const user of users) first.push(await store(user, 'first #news'));
      await ctx.compact();

      // Each publisher's own index, #news, and three hashtags that are new.
      const second: string[] = [];
      for (const [i, user] of users.entries()) second.push(await store(user, `second #news #topic${i % 3}`));
      const mget = ctx.compactor.watch('hot.mget');
      const set = ctx.compactor.watch('hot.set');
      const setMany = ctx.compactor.watch('hot.setMany');
      const persist = ctx.compactor.watch('hot.persist');
      const expire = ctx.compactor.watch('hot.expire');
      const exists = ctx.compactor.watch('hot.exists');
      expect((await ctx.compactor.runOnce()).tags).toHaveLength(users.length + 4);

      // The heads, the manifests they name, and the day indexes to rebuild.
      expect(mget.calls.map(({ keys }) => keys.length)).toEqual([16, 13, 13]);
      // The new day indexes and manifests, made to last together, and then the heads.
      expect(setMany.calls.map(({ keys }) => keys.length)).toEqual([32, 16]);
      expect(keysSet(setMany).slice(32).sort()).toEqual([...users.map(own), 'news', 'topic0', 'topic1', 'topic2'].map(headKey).sort());
      expect(persist.calls.map(({ keys }) => keys.length)).toEqual([32]);
      // What the 13 indexes that were there no longer use: a day index and a manifest each.
      expect(expire.calls.map(({ keys }) => keys.length)).toEqual([26]);
      // The summaries of the posts rebuilt, asked about once each however many indexes a post is in.
      expect(exists.calls.map(({ keys }) => keys.length)).toEqual([12]);
      expect(set.calls.filter(({ key }) => /^(head|man|day):/.test(key))).toEqual([]);

      expect((await indexIds('news')).sort()).toEqual([...first, ...second].sort());
      for (const [i, user] of users.entries()) expect((await indexIds(own(user))).sort()).toEqual([first[i], second[i]].sort());
      expect((await indexIds('topic1')).sort()).toEqual(second.filter((_, i) => i % 3 === 1).sort());
      expect(await queue()).toEqual([]);
    });

    it('leaves a hashtag whose index is damaged as it is, and compacts the rest of its batch', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const first = await store(alice, 'first #news #sports');
      await ctx.compact();
      const head = await readHead('news');
      await ctx.hot.del([manifestKey('news', head.manifest!)]);

      const second = await store(alice, 'second #news #sports');
      expect((await ctx.compactor.runOnce()).tags).toEqual([own(alice), 'news', 'sports'].sort());
      expect(await readHead('news')).toEqual(head);
      expect((await indexIds('sports')).sort()).toEqual([first, second].sort());
      expect((await indexIds(own(alice))).sort()).toEqual([first, second].sort());
      // The post still waits for #news, and for nothing else.
      expect(await queue()).toEqual([`${second} news`]);

      // A rebuild takes the missing manifest for an empty one.
      await ctx.compactor.runOnce({ rebuild: true });
      expect((await indexIds('news')).sort()).toEqual([first, second].sort());
      expect(await queue()).toEqual([]);
    });

    it('reads summaries of posts younger than the hot window from Redis and older ones from the object store', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const t0 = ctx.clock.now;
      const at = async (ageDays: number, text: string) => {
        ctx.clock.now = t0 - ageDays * DAY;
        return post(alice, text);
      };
      const old = await at(9, 'nine days #news');
      const week = await at(7, 'seven days #news');
      const today = await at(0, 'today #news');
      await ctx.compact();

      // Redis keeps each summary for the 8 days after its post was created, by its own clock: the
      // posts were new when it took them, and the old one's time is up since.
      for (const left of await ctx.ttl([old, week, today].map(summaryKey))) {
        expect(left).toBeGreaterThan(8 * DAY - HOUR);
        expect(left).toBeLessThanOrEqual(8 * DAY);
      }
      await ctx.lapse(summaryKey(old));
      expect(await ctx.hot.exists([old, week, today].map(summaryKey))).toEqual([false, true, true]);
      // The recent posts need nothing from the object store; the old one is read from it.
      for (const r of [week, today]) await rm(join(ctx.dir, 'summaries', summaryObjectKey(r)));
      const mget = vi.spyOn(ctx.hot, 'mget');
      expect(allIds((await getFeed('tags=news&hours=336')).json())).toEqual([today, week, old].map((r) => r.contentId));
      const asked = mget.mock.calls.flatMap(([keys]) => keys);
      expect(asked).toEqual(expect.arrayContaining([summaryKey(week), summaryKey(today)]));
      expect(asked).not.toContain(summaryKey(old));
    });

    it('serves a summary Redis lost from the object store and restores its Redis copy until the post is 8 days old', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const lost = await post(alice, 'lost #news');
      await ctx.compact();
      ctx.clock.now += 12 * HOUR;
      await ctx.hot.del([summaryKey(lost)]);

      expect((await items('news')).map((i) => i.preview.text)).toEqual(['lost #news']);
      expect(await ctx.hot.exists([summaryKey(lost)])).toEqual([true]);
      // For what is left of the post's 8 days, half a day of which has passed.
      const [left] = await ctx.ttl([summaryKey(lost)]);
      expect(left).toBeGreaterThan(7.5 * DAY - HOUR);
      expect(left).toBeLessThanOrEqual(7.5 * DAY);

      // Gone from both tiers (erased after the feed was planned): the record is left out.
      await ctx.summaries.remove([lost]);
      const res = await getFeed('tags=news');
      expect(res.statusCode, res.body).toBe(200);
      expect(allIds(res.json())).toEqual([]);
    });

    it('stores one Brotli-compressed plain-text summary per post, shared by all its hashtags', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const r = await post(alice, 'Flooding closes roads in central Mumbai. #news #mumbai');
      expect(await readdir(summaryDir(r.createdAt))).toEqual([`${r.contentId}.br`]);
      const blob = await readFile(join(summaryDir(r.createdAt), `${r.contentId}.br`));
      expect(await ctx.hot.get(summaryKey(r))).toEqual(blob);

      const text = 'Flooding closes roads in central Mumbai. #news #mumbai';
      const plain = brotliDecompressSync(blob);
      expect(plain.toString('utf8')).toBe(
        [`${r.createdAt} ${r.createdAt} 0 0`, alice.userId, 'text/plain', 'news mumbai', 'text', text].join('\n'),
      );
      await ctx.compactor.runOnce();
      const [item] = await items('news');
      expect(blob.length).toBeLessThan(plain.length);
      expect(plain.length).toBeLessThan(Buffer.byteLength(JSON.stringify(item)));
    });

    it('rebuilds the feed index, summaries and publisher credits from the database with --rebuild', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      ctx.clock.now -= 10 * DAY;
      const old = await store(alice, 'old #news');
      ctx.clock.now += 10 * DAY;
      const recent = await store(alice, 'recent #news #sports');
      await like(bob, old);
      await ctx.compact();
      ctx.clock.now += 1000;
      const late = await store(bob, 'late #news');
      await ctx.compactor.runOnce();
      // Of the past 14 days, which holds all three; most liked first, then newest.
      const records = async (tag: string) => ((await getFeed(`tags=${tag}&hours=336`)).json() as Feed).tags;
      const news = await records('news');
      const sports = await records('sports');
      expect(news.news!.map((i) => i.contentId)).toEqual([old, late, recent]);

      // Redis loses everything, and the object store loses these summaries too.
      await ctx.hot.clear();
      await rm(join(ctx.dir, 'summaries'), { recursive: true, force: true });
      expect(allIds((await getFeed('tags=news')).json())).toEqual([]);

      ctx.clock.now += 1000;
      expect((await ctx.compactor.runOnce({ rebuild: true })).tags).toEqual([authorIndex(alice.userId), authorIndex(bob.userId), 'news', 'sports'].sort());
      expect(await records('news')).toEqual(news);
      expect(await records('sports')).toEqual(sports);
      expect(await storedSummaries(old, ctx.clock.now - 10 * DAY)).toEqual([`${old}.br`]);
    });

    it('trims each day index to its quota of best records', async () => {
      ctx = await createTestContext(target, { feed: { tagDayMaxPosts: 4, tagDayMinPosts: 1 } });
      const alice = await ctx.register('alice');
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        ids.push(await store(alice, `item ${i} #news`));
        ctx.clock.now += 1000;
      }
      await ctx.compact();
      expect(allIds((await getFeed('tags=news')).json())).toEqual([...ids].reverse().slice(0, 4));
    });

    it('pages multi-tag feeds across compactions, each page reading the indexes as they are by then', async () => {
      ctx = await createTestContext(target, { feed: { pageSize: 8 } });
      const alice = await ctx.register('alice');
      const ids: string[] = [];
      const tagSets = ['#news #sports', '#news', '#sports #tech', '#tech'];
      for (let i = 0; i < 24; i++) {
        ids.push(await store(alice, `post ${i} ${tagSets[i % 4]}`));
        ctx.clock.now += 1000;
      }
      await ctx.compact();
      for (let i = 24; i < 30; i++) {
        ids.push(await store(alice, `post ${i} ${tagSets[i % 4]}`));
        ctx.clock.now += 1000;
      }
      await ctx.compact();

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 40; page++) {
        const res = await getFeed(`tags=news,sports,tech${cursor ? `&cursor=${cursor}` : ''}`);
        expect(res.statusCode, res.body).toBe(200);
        const f = res.json() as Feed;
        seen.push(...allIds(f));
        if (page === 1 || page === 3) {
          // A post stored mid-session is newer than the session's window, and the index that holds it
          // replaces the one the pages before read: the pages after carry on where those stopped.
          const head = await readHead('news');
          ctx.clock.now += 1000;
          await store(alice, 'late arrival #news');
          await ctx.compact();
          expect((await readHead('news')).manifest).not.toBe(head.manifest);
        }
        cursor = f.nextCursor;
        if (!cursor) break;
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.sort()).toEqual([...ids].sort());
    });

    it('carries a feed session on however long ago it began, once the indexes its first page read are gone', async () => {
      ctx = await createTestContext(target, { feed: { pageSize: 2 } });
      const alice = await ctx.register('alice');
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(await store(alice, `post ${i} #news`));
        ctx.clock.now += 1000;
      }
      await ctx.compact();
      const first = (await getFeed('tags=news')).json() as Feed;
      expect(first.nextCursor).toBeTruthy();
      const read = [manifestKey('news', (await readHead('news')).manifest!), ...(await readManifest('news')).days.map((d) => dayKey('news', d.gen))];

      // Hours later, the index has been rebuilt since, and what the first page read of it has expired.
      ctx.clock.now += 5 * HOUR;
      const newer = await store(alice, 'newer #news');
      await ctx.compact();
      await ctx.compact(2 * 60_000);
      await ctx.lapse(read);
      expect(await ctx.hot.exists(read)).toEqual([false, false]);

      // The session's window is still the one its first page had.
      const seen = await restOf('tags=news', first);
      expect(seen).toEqual([...ids].reverse());
      expect(allIds((await getFeed('tags=news')).json())).toContain(newer);
    });

    it('answers 410 for a cursor of an earlier release, and 400 for one that is not a cursor', async () => {
      ctx = await createTestContext(target, { feed: { pageSize: 2 } });
      const alice = await ctx.register('alice');
      for (let i = 0; i < 3; i++) await store(alice, `post ${i} #news`);
      await ctx.compact();
      const first = (await getFeed('tags=news')).json() as Feed;
      const state = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8')) as { v: number; p: unknown[] };
      const cursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const status = async (value: unknown) => (await getFeed(`tags=news&cursor=${cursor(value)}`)).statusCode;

      expect(await status(state)).toBe(200);
      expect(await status({ ...state, v: state.v - 1 })).toBe(410);
      expect(await status({ ...state, v: state.v + 1 })).toBe(400);
      // One that names a place in no list, in a list the feed doesn't have, or nothing a place could be.
      expect(await status({ ...state, p: [] })).toBe(400);
      expect(await status({ ...state, p: [...state.p, null] })).toBe(400);
      expect(await status({ ...state, p: [[0, 'yesterday', 'x']] })).toBe(400);
      expect(await status({ ...state, f: [-1] })).toBe(400);
      expect((await getFeed('tags=news&cursor=nonsense')).statusCode).toBe(400);
    });

    it('leaves out of a feed session a post that reaches the index after the page it would have been on, and shows it to the next', async () => {
      ctx = await createTestContext(target, { feed: { pageSize: 3 } });
      const alice = await ctx.register('alice');
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        ids.push(await store(alice, `post ${i} #news`));
        ctx.clock.now += 1000;
      }
      await ctx.compact();
      // The post is stamped before its write commits, and the first page is read in between.
      const late = pauseCommit();
      const stored = store(alice, 'late #news');
      await late.paused;
      ctx.clock.now += 1000;
      const first = (await getFeed('tags=news')).json() as Feed;
      expect(first.nextCursor).toBeTruthy();
      late.release();
      const lateId = await stored;
      await ctx.compactor.runOnce();
      expect(await indexIds('news')).toContain(lateId);

      // It is the newest of the window, which is where the session began.
      const seen = await restOf('tags=news', first);
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.sort()).toEqual([...ids].sort());
      expect(allIds((await getFeed('tags=news')).json())[0]).toBe(lateId);
    });

    it('never repeats a post in a feed session as likes reorder the index between its pages, and misses one they take ahead of it', async () => {
      ctx = await createTestContext(target, { feed: { pageSize: 4, freshEvery: 0 } });
      const [alice, bob, carol] = [await ctx.register('alice'), await ctx.register('bob'), await ctx.register('carol')];
      const ids: string[] = [];
      for (let i = 0; i < 12; i++) {
        ids.push(await store(alice, `post ${i} #news`));
        ctx.clock.now += 1000;
      }
      // The newest six have a like each, so they come first.
      for (const id of ids.slice(6)) await like(bob, id);
      await ctx.compact();
      const first = (await getFeed('tags=news')).json() as Feed;
      expect(allIds(first)).toEqual([ids[11], ids[10], ids[9], ids[8]]);

      // Liked since: one the session has shown, one it would have shown next but one, and its last.
      for (const id of [ids[11]!, ids[6]!, ids[0]!]) await like(carol, id);
      await ctx.compact();
      expect(allIds((await getFeed('tags=news&limit=3')).json())).toEqual([ids[11], ids[6], ids[10]]);

      // The second is now ahead of where the session has got to. The last moved up among the posts to come.
      const seen = await restOf('tags=news', first);
      expect(seen).toEqual([ids[11], ids[10], ids[9], ids[8], ids[7], ids[0], ids[5], ids[4], ids[3], ids[2], ids[1]]);
    });

    it('injects new unliked content between liked content read from a day index', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const liked: string[] = [];
      for (let i = 0; i < 6; i++) {
        liked.push(await store(alice, `popular ${i} #news`));
        ctx.clock.now += 1000;
      }
      for (const contentId of liked) await like(bob, contentId);
      const fresh: string[] = [];
      for (let i = 0; i < 4; i++) {
        fresh.push(await store(alice, `new ${i} #news`));
        ctx.clock.now += 1000;
      }
      await ctx.compact();

      const full = (await getFeed('tags=news')).json() as Feed;
      expect(allIds(full).sort()).toEqual([...liked, ...fresh].sort());
      ctx.config.feed.pageSize = 4;

      // The page is assembled out of index order (liked, fresh, liked, ...) and must still be valid JSON.
      const res = await getFeed('tags=news');
      expect(res.statusCode, res.body).toBe(200);
      const page = (res.json() as Feed).tags.news!.map((r) => r.contentId);
      expect(page).toHaveLength(4);
      expect(liked).toContain(page[0]);
      expect(fresh).toContain(page[1]);

      ctx.config.feed.freshEvery = 0;
      const plain = (await getFeed('tags=news')).json() as Feed;
      expect(allIds(plain).every((id) => liked.includes(id))).toBe(true);
    });

    it('leaves nothing for good of a run killed before it swapped a head', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      await store(alice, 'first #news');
      await ctx.compact();
      const published = [dayKey('news', (await readManifest('news')).days[0]!.gen), manifestKey('news', (await readHead('news')).manifest!)];

      // The run dies as it is about to swap the head of #news: nothing after that point happens, not even tidying up.
      await store(alice, 'second #news');
      const written: string[] = [];
      ctx.compactor.watch('hot.setMany', {
        before: ({ keys }) => void written.push(...keys.filter((key) => key.startsWith('day:news:') || key.startsWith('man:news:'))),
      });
      ctx.compactor.watch('hot.persist', failing('killed'));
      ctx.compactor.watch('hot.del', failing('killed'));
      await ctx.compact();
      ctx.compactor.unwatch();
      expect(written).toHaveLength(2);
      expect(await ctx.hot.exists(written)).toEqual([true, true]);

      // The next run compacts the hashtag as if the killed one had never been.
      expect((await ctx.compact()).tags).toContain('news');
      expect(await indexIds('news')).toHaveLength(2);
      const current = [dayKey('news', (await readManifest('news')).days[0]!.gen), manifestKey('news', (await readHead('news')).manifest!)];

      // What the killed run wrote expires, like what the last run replaced; what a head names never does.
      for (const left of await ctx.ttl([...written, ...published])) expect(left).toBeGreaterThan(0);
      for (const left of await ctx.ttl(published)) expect(left).toBeLessThanOrEqual(60_000);
      expect(await ctx.ttl(current)).toEqual([-1, -1]);
      await ctx.lapse([...written, ...published]);
      expect(await ctx.hot.exists([...written, ...published, ...current])).toEqual([false, false, false, false, true, true]);
    });
  });
}
