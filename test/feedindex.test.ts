import { readFileSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { summaryKey, summaryObjectKey, type SummaryRef } from '../src/storage/summaryStore.js';
import {
  authorIndex,
  DAY_ENTRY_BYTES,
  dayKey,
  headKey,
  isTombstone,
  manifestKey,
  tailIndexKey,
  tailKey,
  unpackDay,
  type DayRef,
  type Head,
  type Manifest,
  type TailRecord,
} from '../src/tagfeed/layout.js';
import { DAY, HOUR, utcDay } from '../src/time.js';
import { createTestContext, requests, tailLines, TARGETS, type Feed, type TestContext, type User } from './helpers.js';

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
    const allIds = (f: Feed) => f.days.flatMap((d) => Object.values(d.tags).flatMap((l) => l.map((i) => i.contentId)));
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
    const pendingAppends = async () =>
      (await ctx.db.selectFrom('pending_appends').select(['content_id', 'tag']).execute()).map((r) => `${r.content_id} ${r.tag}`).sort();
    const tailRecords = async (tag: string) => (await tailLines(ctx.hot, tag)).filter((l): l is TailRecord => !isTombstone(l));
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
     * Pauses the /store request for `text` in the content store until released: just before it writes
     * its bytes, or just after it writes its meta file (right before its commit).
     */
    const pauseStore = (at: 'putFile' | 'putMeta', text: string) => {
      let reached!: () => void;
      let release!: () => void;
      const paused = new Promise<void>((r) => (reached = r));
      const released = new Promise<void>((r) => (release = r));
      if (at === 'putFile') {
        const putFile = ctx.content.putFile.bind(ctx.content);
        vi.spyOn(ctx.content, 'putFile').mockImplementation(async (...args) => {
          if (readFileSync(args[1], 'utf8') === text) {
            reached();
            await released;
          }
          return putFile(...args);
        });
      } else {
        const putMeta = ctx.content.putMeta.bind(ctx.content);
        vi.spyOn(ctx.content, 'putMeta').mockImplementation(async (meta) => {
          await putMeta(meta);
          if (meta.preview.kind === 'text' && meta.preview.text === text) {
            reached();
            await released;
          }
        });
      }
      return { paused, release };
    };
    const storedFiles = async (contentId: string) => (await readdir(join(ctx.dir, 'content', 'content'))).filter((f) => f.startsWith(contentId)).sort();
    const summaryDir = (createdAt: number) => join(ctx.dir, 'summaries', 'summaries', String(utcDay(createdAt)).padStart(5, '0'));
    const storedSummaries = async (contentId: string, createdAt: number) => (await readdir(summaryDir(createdAt))).filter((f) => f.startsWith(contentId)).sort();
    /** Pauses the first Redis write to a matching key until released, before the write happens. */
    const pauseSet = (matches: (key: string) => boolean) => {
      let reached!: () => void;
      let release!: () => void;
      const paused = new Promise<void>((r) => (reached = r));
      const released = new Promise<void>((r) => (release = r));
      const set = ctx.hot.set.bind(ctx.hot);
      let done = false;
      vi.spyOn(ctx.hot, 'set').mockImplementation(async (...args) => {
        if (!done && matches(args[0])) {
          done = true;
          reached();
          await released;
        }
        return set(...args);
      });
      return { paused, release };
    };

    it('compacts tails into a packed, sorted day index named by the manifest, swaps the head, and keeps the feed identical', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(await store(alice, `item ${i} #news`));
        ctx.clock.now += 1000;
      }
      const before = (await getFeed('tags=news')).json();
      expect(allIds(before)).toEqual([...ids].reverse());

      await ctx.compact();
      expect(await readHead('news')).toMatchObject({ v: 4, manifest: expect.any(String) });
      const manifest = await readManifest('news');
      expect(manifest.days).toHaveLength(1);
      const [day] = manifest.days;
      expect(day).toMatchObject({ day: utcDay(ctx.clock.now), count: 5 });
      expect((await ctx.hot.get(dayKey('news', day!.gen)))!.length).toBe(5 * DAY_ENTRY_BYTES);
      const entries = await dayIndex('news', day!);
      expect(entries.map((e) => e.contentId)).toEqual([...ids].reverse());

      const after = (await getFeed('tags=news')).json();
      expect(allIds(after)).toEqual(allIds(before));
      expect(after.days[0].tags.news[0]).toEqual(before.days[0].tags.news[0]);
    });

    it('lets readers holding an old head keep reading while compaction swaps the head, then lets the superseded keys expire', async () => {
      ctx = await createTestContext(target, { feed: { genRetentionMinutes: 10 } });
      const alice = await ctx.register('alice');
      const a = await store(alice, 'a #news');
      await ctx.compact();
      const oldHead = await readHead('news');
      const oldManifest = await readManifest('news');
      const b = await store(alice, 'b #news');
      await ctx.compact();
      const newHead = await readHead('news');
      expect(newHead.manifest).not.toBe(oldHead.manifest);
      const current = await readManifest('news');

      // A reader that loaded the old head still sees a consistent view (old indexes + tails since).
      const view = await ctx.feedReader.view('news', ctx.clock.now, oldHead);
      expect(view.candidates.map((c) => c.contentId).sort()).toEqual([a, b].sort());

      const superseded = [manifestKey('news', oldHead.manifest!), ...oldManifest.days.map((d) => dayKey('news', d.gen))];
      const live = [manifestKey('news', newHead.manifest!), ...current.days.map((d) => dayKey('news', d.gen))];
      const windows = await ctx.hot.scores(tailIndexKey('news'), 0, Infinity);
      expect(windows).toHaveLength(2);
      expect(await ctx.hot.exists([...superseded, ...windows.map((w) => tailKey('news', w))])).toEqual([true, true, true, true]);
      // Redis expires keys by its own clock, so only the in-process store can be moved past the retention period.
      if (target.hot === 'memory') {
        await ctx.compact(11 * 60_000);
        expect(await ctx.hot.exists([...superseded, ...windows.map((w) => tailKey('news', w))])).toEqual([false, false, false, false]);
        expect(await ctx.hot.exists(live)).toEqual([true, true]);
        expect(await ctx.hot.scores(tailIndexKey('news'), 0, Infinity)).toEqual([]);
      }
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
      const feed = (await getFeed('tags=news&hours=24')).json() as Feed;
      expect(allIds(feed)).toContain(popular);
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
      await ctx.compact();
      expect((await readManifest('sports')).days).toEqual([]);
      expect(allIds((await getFeed('tags=sports')).json())).toEqual([]);
      expect(allIds((await getFeed('tags=news')).json())).toEqual([id]);
    });

    it('hides content set for deletion at once, then removes it from every index, the summaries and the database in one compaction', async () => {
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

      const del = await ctx.app.inject({ method: 'DELETE', url: `/content/${id}`, payload: { ...alice } });
      expect(del.statusCode, del.body).toBe(202);
      expect(await shown('news')).toEqual([[keep, 'keep #news']]);
      expect(await shown('tech')).toEqual([]);
      expect((await ctx.app.inject({ method: 'GET', url: `/content/${id}` })).statusCode).toBe(404);
      // Only hidden so far: the indexes, the summary, the row and the bytes are untouched until the compactor runs.
      expect(await indexIds('tech')).toEqual([id]);
      expect(await contentRow(id)).toBeDefined();
      expect(await ctx.content.getMeta(id)).not.toBeNull();
      const ref = { contentId: id, createdAt };
      expect(await ctx.hot.exists([summaryKey(ref)])).toEqual([true]);

      expect((await ctx.compact()).deleted).toEqual([id]);
      expect(await shown('news')).toEqual([[keep, 'keep #news']]);
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

    it('hides content set for deletion while the database keeps it until its open tail window is merged', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const id = await store(alice, 'fresh #news');
      expect((await ctx.app.inject({ method: 'DELETE', url: `/content/${id}`, payload: { ...alice } })).statusCode).toBe(202);
      expect(await items('news')).toEqual([]);

      // A minute later the tail window holding the entry is still open, so the compactor can't drop it yet.
      ctx.clock.now += 60_000;
      expect((await ctx.compactor.runOnce()).deleted).toEqual([]);
      expect(await items('news')).toEqual([]);
      expect(await contentRow(id)).toBeDefined();

      expect((await ctx.compact()).deleted).toEqual([id]);
      expect(await items('news')).toEqual([]);
      expect(await contentRow(id)).toBeUndefined();
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

      // The tombstone append fails, so only the compactor can take the post out of #news.
      vi.spyOn(ctx.appender, 'tombstone').mockResolvedValue(['news']);
      expect((await ctx.app.inject({ method: 'DELETE', url: `/content/${id}`, payload: { ...alice } })).statusCode).toBe(202);
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

      vi.spyOn(ctx.appender, 'tombstone').mockResolvedValue(['news']);
      expect((await ctx.app.inject({ method: 'DELETE', url: `/content/${id}`, payload: { ...alice } })).statusCode).toBe(202);
      // Once the lease has expired, and the tail window of the deletion has closed.
      expect((await ctx.compact(ctx.config.compact.leaseSeconds * 1000)).deleted).toEqual([id]);
      expect((await readManifest('news')).days).toEqual([]);
      const head = await readHead('news');

      stalled.release();
      await expect(runA).rejects.toThrow(/lease/);
      expect(await readHead('news')).toEqual(head);
      expect((await readManifest('news')).days).toEqual([]);
      expect(await items('news')).toEqual([]);
    });

    it('hides deleted content from later pages of a feed session without skipping or repeating other records', async () => {
      ctx = await createTestContext(target, { feed: { pageSize: 5 } });
      const alice = await ctx.register('alice');
      const ids: string[] = [];
      for (let i = 0; i < 12; i++) {
        ids.push(await store(alice, `post ${i} #news`));
        ctx.clock.now += 1000;
      }
      await ctx.compact();

      const first = (await getFeed('tags=news')).json() as Feed;
      const seen = allIds(first);
      // One record the session has already returned, one it hasn't reached yet.
      const shown = seen[0]!;
      const unseen = ids.find((id) => !seen.includes(id))!;
      for (const id of [shown, unseen]) {
        expect((await ctx.app.inject({ method: 'DELETE', url: `/content/${id}`, payload: { ...alice } })).statusCode).toBe(202);
      }
      let cursor = first.nextCursor;
      for (let page = 0; cursor && page < 40; page++) {
        const res = await getFeed(`tags=news&cursor=${cursor}`);
        expect(res.statusCode, res.body).toBe(200);
        const f = res.json() as Feed;
        seen.push(...allIds(f));
        cursor = f.nextCursor;
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.sort()).toEqual(ids.filter((id) => id !== unseen).sort());
    });

    it('writes an update over the post, hiding it at once from each hashtag the update dropped and showing it under each it gave', async () => {
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
      expect(await shown('tech')).toEqual([[id, 'v3 #news #tech']]);
      // One post: one file, one meta file, one summary, however often it is updated.
      expect(await storedFiles(id)).toEqual([id, `${id}.meta.json`]);
      expect(await storedSummaries(id, createdAt)).toEqual([`${id}.br`]);
      expect(await ctx.db.selectFrom('content').select('id').execute()).toEqual([{ id }]);

      await ctx.compact();
      expect((await readManifest('old')).days).toEqual([]);
      expect(await indexIds('tech')).toEqual([id]);
      expect(await shown('news')).toEqual([[id, 'v3 #news #tech']]);
      expect(await shown('old')).toEqual([]);
      expect(await pendingAppends()).toEqual([]);

      // A hashtag an update gives back shows the post again, before the compactor merges the tombstone and after.
      ctx.clock.now += 1000;
      expect((await update(alice, id, 'v4 #news #old')).statusCode).toBe(200);
      expect(await shown('old')).toEqual([[id, 'v4 #news #old']]);
      expect(await shown('tech')).toEqual([]);
      await ctx.compact();
      expect(await indexIds('old')).toEqual([id]);
      expect((await readManifest('tech')).days).toEqual([]);
      expect(await shown('old')).toEqual([[id, 'v4 #news #old']]);
    });

    it('takes a post out of a hashtag an update dropped on the next compaction, when the tombstone append failed', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const id = await store(alice, 'v1 #news #old');
      await ctx.compact();

      const append = ctx.appender.append.bind(ctx.appender);
      const failing = vi
        .spyOn(ctx.appender, 'append')
        .mockImplementation((tag, entry) => (tag === 'old' ? Promise.reject(new Error('redis unavailable')) : append(tag, entry)));
      ctx.clock.now += 1000;
      expect((await update(alice, id, 'v2 #news')).statusCode).toBe(200);
      failing.mockRestore();
      // Nothing hides it from #old yet, where it shows as it now is.
      expect(await shown('old')).toEqual([[id, 'v2 #news']]);
      expect(await pendingAppends()).toEqual([`${id} old`]);

      await ctx.compact();
      expect(await shown('old')).toEqual([]);
      expect((await readManifest('old')).days).toEqual([]);
      expect(await shown('news')).toEqual([[id, 'v2 #news']]);
      expect(await pendingAppends()).toEqual([]);
    });

    it('appends only after the database commits; an update whose commit failed is reported as failed and completed by sending it again', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const { contentId: id, createdAt } = await post(alice, 'v1 #news #old');
      await ctx.compact();

      ctx.clock.now += 1000;
      failNextCommit(false);
      expect((await update(alice, id, 'v2 draft #news')).statusCode).toBe(500);
      // Nothing was pushed for it, but it wrote over the post, which has one version: that can't be taken back.
      expect((await tailLines(ctx.hot, 'news')).map((l) => [isTombstone(l), l.contentId])).toEqual([[false, id]]);
      expect((await tailRecords('news')).map((r) => r.updatedAt)).toEqual([createdAt]);
      expect((await ctx.app.inject({ method: 'GET', url: `/content/${id}/raw` })).body).toBe('v2 draft #news');
      expect(await shown('news')).toEqual([[id, 'v2 draft #news']]);
      // The compactor is told which indexes to look at again, and takes the post out of the hashtag it lost.
      expect(await pendingAppends()).toEqual([`${id} ${own(alice)}`, `${id} news`, `${id} old`].sort());
      await ctx.compact();
      expect(await shown('news')).toEqual([[id, 'v2 draft #news']]);
      expect(await shown('old')).toEqual([]);
      expect(await pendingAppends()).toEqual([]);

      ctx.clock.now += 1000;
      const retry = await update(alice, id, 'v2 #news');
      expect(retry.statusCode, retry.body).toBe(200);
      expect((await tailRecords('news')).map((r) => r.updatedAt)).toEqual([createdAt, ctx.clock.now]);
      expect(await shown('news')).toEqual([[id, 'v2 #news']]);
      await ctx.compact();
      expect(await shown('news')).toEqual([[id, 'v2 #news']]);
      expect(await storedFiles(id)).toEqual([id, `${id}.meta.json`]);
      expect(await storedSummaries(id, createdAt)).toEqual([`${id}.br`]);
      expect(await pendingAppends()).toEqual([]);
    });

    it('leaves an update that could not be written as it was in feeds, and in the database', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const id = await store(alice, 'v1 #news');
      await ctx.compact();

      ctx.clock.now += 1000;
      vi.spyOn(ctx.content, 'putMeta').mockRejectedValueOnce(new Error('store unavailable'));
      expect((await update(alice, id, 'v2 #news #tech')).statusCode).toBe(500);
      // The meta file says what the post is, and feeds show what it says.
      expect((await ctx.app.inject({ method: 'GET', url: `/content/${id}` })).json()).toMatchObject({ preview: { kind: 'text', text: 'v1 #news' }, tags: ['news'] });
      expect(await shown('news')).toEqual([[id, 'v1 #news']]);
      expect(await shown('tech')).toEqual([]);
      await ctx.compact();
      expect(await shown('news')).toEqual([[id, 'v1 #news']]);
      expect(await shown('tech')).toEqual([]);
      expect(await pendingAppends()).toEqual([]);
    });

    it('keeps and appends a write whose commit went through even though it reported an error', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      failNextCommit(true);
      const res = await ctx.app.inject({ method: 'POST', url: '/store', payload: { ...alice, type: 'text', text: 'kept #news', tags: ['news'] } });
      expect(res.statusCode, res.body).toBe(201);
      const { contentId } = res.json();
      expect((await ctx.app.inject({ method: 'GET', url: `/content/${contentId}/raw` })).body).toBe('kept #news');
      expect(await shown('news')).toEqual([[contentId, 'kept #news']]);
      expect(await ctx.db.selectFrom('pending_appends').selectAll().execute()).toEqual([]);
    });

    it('keeps the last of two overlapping updates to be written', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const { contentId: id, createdAt } = await post(alice, 'v1 #news');
      await ctx.compact();

      // A client retries an update that timed out; the first attempt writes its bytes after the retry is done.
      const first = pauseStore('putFile', 'first #news #sports');
      const firstRes = update(alice, id, 'first #news #sports');
      await first.paused;
      const retry = await update(alice, id, 'retry #news');
      expect(retry.statusCode, retry.body).toBe(200);
      expect(await shown('news')).toEqual([[id, 'retry #news']]);
      first.release();
      expect((await firstRes).statusCode).toBe(200);

      const check = async () => {
        expect((await ctx.app.inject({ method: 'GET', url: `/content/${id}/raw` })).body).toBe('first #news #sports');
        expect((await ctx.app.inject({ method: 'GET', url: `/content/${id}` })).json()).toMatchObject({
          preview: { kind: 'text', text: 'first #news #sports' },
          tags: ['news', 'sports'],
        });
        expect(await shown('news')).toEqual([[id, 'first #news #sports']]);
        expect(await shown('sports')).toEqual([[id, 'first #news #sports']]);
      };
      await check();
      expect(await storedFiles(id)).toEqual([id, `${id}.meta.json`]);
      expect(await storedSummaries(id, createdAt)).toEqual([`${id}.br`]);
      await ctx.compact();
      await check();
    });

    it('stores nothing when the summary cannot be written', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const set = ctx.hot.set.bind(ctx.hot);
      vi.spyOn(ctx.hot, 'set').mockImplementation((key, ...rest) => (key.startsWith('sum:') ? Promise.reject(new Error('redis unavailable')) : set(key, ...rest)));
      const res = await ctx.app.inject({ method: 'POST', url: '/store', payload: { ...alice, type: 'text', text: 'lost #news', tags: ['news'] } });
      expect(res.statusCode, res.body).toBe(500);
      expect(await ctx.db.selectFrom('content').selectAll().execute()).toEqual([]);
      expect(await tailLines(ctx.hot, 'news')).toEqual([]);
      const files = (dir: string) => readdir(dir).catch(() => []);
      expect(await files(join(ctx.dir, 'content', 'content'))).toEqual([]);
      expect(await files(summaryDir(ctx.clock.now))).toEqual([]);
    });

    it('adds entries whose tail append failed after the commit on the next compaction', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const id = await store(alice, 'v1 #news #sports');
      await ctx.compact();

      const append = ctx.appender.append.bind(ctx.appender);
      const failing = vi
        .spyOn(ctx.appender, 'append')
        .mockImplementation((tag, entry) => (tag === 'news' ? Promise.reject(new Error('redis unavailable')) : append(tag, entry)));
      ctx.clock.now += 1000;
      // The database accepted both writes, so both requests succeed.
      expect((await update(alice, id, 'v2 #news #sports')).statusCode).toBe(200);
      const fresh = await store(alice, 'fresh #news');
      failing.mockRestore();

      expect(await pendingAppends()).toEqual([`${fresh} news`, `${id} news`].sort());
      expect(await shown('sports')).toEqual([[id, 'v2 #news #sports']]);
      // The new post isn't in #news yet; the updated one is there by its entry from before, and shows as it now is.
      expect(await shown('news')).toEqual([[id, 'v2 #news #sports']]);

      await ctx.compact();
      expect(await shown('news')).toEqual([[fresh, 'fresh #news'], [id, 'v2 #news #sports']]);
      expect(await shown('sports')).toEqual([[id, 'v2 #news #sports']]);
      expect(await pendingAppends()).toEqual([]);
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

      // Redis dropped the old summary 8 days after its post was created.
      if (target.hot === 'memory') expect(await ctx.hot.exists([old, week, today].map(summaryKey))).toEqual([false, true, true]);
      // The recent posts need nothing from the object store; the old one is read from it.
      for (const r of [week, today]) await rm(join(ctx.dir, 'summaries', summaryObjectKey(r)));
      const mget = vi.spyOn(ctx.hot, 'mget');
      expect(allIds((await getFeed('tags=news')).json())).toEqual([today, week, old].map((r) => r.contentId));
      const asked = mget.mock.calls.flatMap(([keys]) => keys);
      expect(asked).toEqual(expect.arrayContaining([summaryKey(week), summaryKey(today)]));
      expect(asked).not.toContain(summaryKey(old));
    });

    it('serves a summary Redis lost from the object store and restores its Redis copy until the post is 8 days old', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const lost = await post(alice, 'lost #news');
      ctx.clock.now += DAY;
      await ctx.hot.del([summaryKey(lost)]);

      expect((await items('news')).map((i) => i.preview.text)).toEqual(['lost #news']);
      expect(await ctx.hot.exists([summaryKey(lost)])).toEqual([true]);
      if (target.hot === 'memory') {
        ctx.clock.now = lost.createdAt + 8 * DAY;
        expect(await ctx.hot.exists([summaryKey(lost)])).toEqual([false]);
      }

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
      const records = async (tag: string) => ((await getFeed(`tags=${tag}`)).json() as Feed).days.map((d) => d.tags);
      const news = await records('news');
      const sports = await records('sports');
      expect(news.flatMap((t) => t.news!.map((i) => i.contentId))).toEqual([late, recent, old]);

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

    it('pages multi-tag feeds with a cursor pinned to the indexes of the first page, across a compaction', async () => {
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

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 40; page++) {
        const res = await getFeed(`tags=news,sports,tech${cursor ? `&cursor=${cursor}` : ''}`);
        expect(res.statusCode, res.body).toBe(200);
        const f = res.json() as Feed;
        seen.push(...allIds(f));
        if (page === 1) {
          // Records stored and compacted mid-pagination don't disturb the pinned pages.
          await store(alice, 'late arrival #news');
          await ctx.compact();
        }
        cursor = f.nextCursor;
        if (!cursor) break;
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.sort()).toEqual([...ids].sort());
    });

    it('leaves out of a feed session a post stamped before its first page but pushed after it', async () => {
      ctx = await createTestContext(target, { feed: { pageSize: 3 } });
      const alice = await ctx.register('alice');
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        ids.push(await store(alice, `post ${i} #news`));
        ctx.clock.now += 1000;
      }
      // The post is stamped before its bytes are uploaded, and the first page is read during the upload.
      const late = pauseStore('putFile', 'late #news');
      const stored = store(alice, 'late #news');
      await late.paused;
      ctx.clock.now += 1000;
      const first = (await getFeed('tags=news')).json() as Feed;
      expect(first.nextCursor).toBeTruthy();
      late.release();
      await stored;

      const seen = allIds(first);
      let cursor = first.nextCursor;
      for (let page = 0; cursor && page < 40; page++) {
        const res = await getFeed(`tags=news&cursor=${cursor}`);
        expect(res.statusCode, res.body).toBe(200);
        const f = res.json() as Feed;
        seen.push(...allIds(f));
        cursor = f.nextCursor;
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.sort()).toEqual([...ids].sort());

      // A tail the first page read that Redis has since lost ends the session, rather than skipping its posts.
      await ctx.hot.del((await ctx.hot.scores(tailIndexKey('news'), 0, Infinity)).map((w) => tailKey('news', w)));
      expect((await getFeed(`tags=news&cursor=${first.nextCursor}`)).statusCode).toBe(410);
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
      const page = (res.json() as Feed).days[0]!.tags.news!.map((r) => r.contentId);
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
      const set = ctx.hot.set.bind(ctx.hot);
      const written: string[] = [];
      vi.spyOn(ctx.hot, 'set').mockImplementation(async (...args) => {
        if (args[0].startsWith('day:news:') || args[0].startsWith('man:news:')) written.push(args[0]);
        return set(...args);
      });
      vi.spyOn(ctx.hot, 'persist').mockRejectedValue(new Error('killed'));
      vi.spyOn(ctx.hot, 'del').mockRejectedValue(new Error('killed'));
      await ctx.compact();
      vi.restoreAllMocks();
      expect(written).toHaveLength(2);
      expect(await ctx.hot.exists(written)).toEqual([true, true]);

      // The next run compacts the hashtag as if the killed one had never been.
      expect((await ctx.compact()).tags).toContain('news');
      expect(await indexIds('news')).toHaveLength(2);
      const current = [dayKey('news', (await readManifest('news')).days[0]!.gen), manifestKey('news', (await readHead('news')).manifest!)];

      // What the killed run wrote expires, like what the last run replaced; what a head names never does.
      // (Only the in-process store keeps the test's time.)
      if (target.hot === 'memory') ctx.clock.now += 2 * HOUR + ctx.config.feed.genRetentionMinutes * 60_000;
      const gone = target.hot !== 'memory';
      expect(await ctx.hot.exists([...written, ...published, ...current])).toEqual([gone, gone, gone, gone, true, true]);
    });

    it('looks for tails to merge once a tail window has closed, not at every run, and again after a hashtag failed', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      await store(alice, 'first #news');
      expect((await ctx.compact()).tags).toEqual([own(alice), 'news'].sort());

      // Until the next window closes there are no tails to merge, so runs don't go looking for any: a
      // post made meanwhile shows from its tail, and is merged by the run after its window has closed.
      const second = await store(alice, 'second #sports');
      expect((await ctx.compactor.runOnce()).tags).toEqual([]);
      expect(await shown('sports')).toEqual([[second, 'second #sports']]);
      expect((await ctx.compact()).tags).toEqual([own(alice), 'sports'].sort());
      expect(await indexIds('sports')).toEqual([second]);

      // A run that couldn't compact a hashtag is followed by one that looks again, without waiting for a window.
      const third = await store(alice, 'third #news');
      vi.spyOn(ctx.hot, 'persist').mockRejectedValueOnce(new Error('redis is unavailable'));
      await ctx.compact();
      expect((await ctx.compactor.runOnce()).tags).toHaveLength(1);
      expect(await indexIds('news')).toContain(third);
      expect(await indexIds(own(alice))).toContain(third);
      expect((await ctx.compactor.runOnce()).tags).toEqual([]);
    });

    it('rejects cursors older than the retention period', async () => {
      ctx = await createTestContext(target, { feed: { pageSize: 2, genRetentionMinutes: 5 } });
      const alice = await ctx.register('alice');
      for (let i = 0; i < 5; i++) await store(alice, `post ${i} #news`);
      const first = (await getFeed('tags=news')).json() as Feed;
      expect(first.nextCursor).toBeTruthy();
      ctx.clock.now += 6 * 60_000;
      expect((await getFeed(`tags=news&cursor=${first.nextCursor}`)).statusCode).toBe(410);
    });
  });
}
