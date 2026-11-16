import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { relatedTo } from '../src/feed/related.js';
import { setAdmin } from '../src/moderation/policy.js';
import { as, createTestContext, requests, TARGETS, type Feed, type TestContext, type User } from './helpers.js';

describe('relatedTo', () => {
  it('gives every requested hashtag its most related one before any gets its second', () => {
    expect(relatedTo(['dogs', 'cars'], [['pets', 'puppies'], ['racing', 'engines']], 20)).toEqual(['pets', 'racing', 'puppies', 'engines']);
    expect(relatedTo(['dogs', 'cars'], [[], ['racing']], 20)).toEqual(['racing']);
    expect(relatedTo(['dogs'], [[]], 20)).toEqual([]);
  });

  it('passes over hashtags that were asked for, or that another hashtag added', () => {
    expect(relatedTo(['dogs', 'pets'], [['pets', 'puppies'], ['dogs', 'cats']], 20)).toEqual(['puppies', 'cats']);
    expect(relatedTo(['dogs', 'cats'], [['pets', 'puppies'], ['pets', 'kittens']], 20)).toEqual(['pets', 'puppies', 'kittens']);
  });

  it('adds none past the most hashtags a feed reads', () => {
    expect(relatedTo(['dogs', 'cars'], [['pets', 'puppies'], ['racing', 'engines']], 5)).toEqual(['pets', 'racing', 'puppies']);
    expect(relatedTo(['dogs', 'cars'], [['pets'], ['racing']], 2)).toEqual([]);
  });
});

for (const target of TARGETS) {
  describe(`related hashtags (${target.name})`, () => {
    let ctx: TestContext;
    let alice: User;
    beforeEach(async () => {
      // Related from two posts in common, if they are a fifth of the hashtag's posts; two related hashtags at most.
      ctx = await createTestContext(target, { feed: { relatedMinPosts: 2, relatedMinPercent: 20, relatedTags: 2 }, trust: { deleteBelow: 0 } });
      alice = await ctx.register('alice');
    });
    afterEach(async () => {
      await ctx.close();
    });

    const { storeText, post, feed } = requests(() => ctx);
    /** Stores `count` posts with these hashtags, a second apart, and returns their ids, oldest first. */
    const posts = async (text: string, count: number) => {
      const ids: string[] = [];
      for (let i = 0; i < count; i++) {
        ids.push(await post(alice, `${text} (${ctx.clock.now})`));
        ctx.clock.now += 1000;
      }
      return ids;
    };
    const counts = async () =>
      Object.fromEntries(
        (await ctx.db.selectFrom('tag_pairs').select(['tag_a', 'tag_b', 'posts']).orderBy('tag_a').orderBy('tag_b').execute()).map((r) => [
          `${r.tag_a} ${r.tag_b}`,
          Number(r.posts),
        ]),
      );
    const tagsOf = (f: Feed, tag: string) => (f.tags[tag] ?? []).map((i) => i.contentId);

    it('counts the posts of each hashtag, and of each pair of hashtags on one post, as they are stored', async () => {
      const [both] = await posts('a dog #dogs #pets', 1);
      expect(await counts()).toEqual({ 'dogs dogs': 1, 'dogs pets': 1, 'pets pets': 1 });
      await posts('another #Pets #dogs', 1);
      await posts('a dog alone #dogs', 1);
      expect(await counts()).toEqual({ 'dogs dogs': 3, 'dogs pets': 2, 'pets pets': 2 });

      // An update counts the hashtags it adds, with the ones the post keeps, and takes nothing back.
      const update = (text: string) => storeText(alice, text, { contentId: both });
      expect((await update('a cute dog #dogs #pets #cute')).statusCode).toBe(200);
      const added = { 'cute cute': 1, 'cute dogs': 1, 'cute pets': 1, 'dogs dogs': 3, 'dogs pets': 2, 'pets pets': 2 };
      expect(await counts()).toEqual(added);
      expect((await update('a cute dog #dogs #pets #cute')).json()).toMatchObject({ unchanged: true });
      expect((await update('a cute dog, reworded #dogs #pets #cute')).statusCode).toBe(200);
      expect((await update('a cute animal #pets #cute')).statusCode).toBe(200);
      expect(await counts()).toEqual(added);
    });

    it('relates a hashtag to those on a good share of its posts, once the compactor has worked them out', async () => {
      await posts('#dogs #pets', 3);
      await posts('#dogs #puppies', 2);
      await posts('#dogs #walks', 2);
      await posts('#dogs #cats', 1);
      await posts('#pets', 13);
      // Feeds read what the compactor wrote, not the counts.
      expect(await ctx.relatedTags.get('dogs')).toEqual([]);
      expect((await feed('tags=dogs&addRelated=true')).related).toEqual([]);

      await ctx.compact();
      // #cats is on one post of #dogs, which is too few. Of two as related, the first by name; and no more than two.
      expect(await ctx.relatedTags.get('dogs')).toEqual(['pets', 'puppies']);
      expect(await ctx.relatedTags.get('puppies')).toEqual(['dogs']);
      // One-sided: 3 of #pets' 16 posts are under #dogs, which is under a fifth.
      expect(await ctx.relatedTags.get('pets')).toEqual([]);
      expect(await ctx.relatedTags.get('cats')).toEqual([]);

      // Counts made since are applied by the next run, to the hashtags they are of.
      await posts('#dogs #walks', 2);
      await posts('#cats #kittens', 2);
      await ctx.compact();
      expect(await ctx.relatedTags.get('dogs')).toEqual(['walks', 'pets']);
      expect(await ctx.relatedTags.get('cats')).toEqual(['kittens']);
      expect(await ctx.relatedTags.get('puppies')).toEqual(['dogs']);

      // A hashtag that stops being related is taken out: #pets is now on 3 of the 16 posts of #dogs.
      await posts('#dogs #walks', 6);
      await ctx.compact();
      expect(await ctx.relatedTags.get('dogs')).toEqual(['walks']);

      // Redis lost everything: they are worked out again from the database.
      await ctx.hot.clear();
      expect(await ctx.relatedTags.get('dogs')).toEqual([]);
      await ctx.compactor.runOnce({ rebuild: true });
      expect(await ctx.relatedTags.get('dogs')).toEqual(['walks']);
      expect(await ctx.relatedTags.get('cats')).toEqual(['kittens']);
      expect(await ctx.relatedTags.get('pets')).toEqual([]);
    });

    it('adds the posts of related hashtags to a feed asked to, without touching the database', async () => {
      const both = await posts('#dogs #pets', 3);
      const [dog] = await posts('#dogs', 1);
      const [pet] = await posts('#pets', 1);
      const [fish] = await posts('#fish', 1);
      await ctx.compact();
      const [latest] = await posts('the latest #pets', 1);
      await ctx.compactor.runOnce();

      const plain = await feed('tags=dogs');
      expect(plain).not.toHaveProperty('related');
      expect(tagsOf(plain, 'dogs').sort()).toEqual([...both, dog].sort());
      expect(plain.count).toBe(4);
      for (const off of ['false', '0']) expect(await feed(`tags=dogs&addRelated=${off}`)).not.toHaveProperty('related');

      // #pets is on 3 of the 4 posts of #dogs. A post under both hashtags is returned once.
      const related = await feed('tags=dogs&addRelated=true');
      expect(related.related).toEqual(['pets']);
      expect(Object.keys(related.tags)).toEqual(['dogs', 'pets']);
      const all = [...tagsOf(related, 'dogs'), ...tagsOf(related, 'pets')];
      expect([...all].sort()).toEqual([...both, dog, pet, latest].sort());
      expect(tagsOf(related, 'pets')).toEqual(expect.arrayContaining([pet, latest]));
      expect(related.count).toBe(6);
      expect(all).not.toContain(fish);

      // In whichever order the feed is asked for, and with its other filters.
      const newest = await feed('tags=dogs&addRelated=1&algorithm=chronological&limit=2');
      expect(newest.related).toEqual(['pets']);
      expect(tagsOf(newest, 'pets')).toEqual([latest, pet]);
      expect((await feed('tags=dogs&addRelated=true&aiGenerated=true')).count).toBe(0);

      // A hashtag asked for is not added again, and one with none related adds none.
      expect((await feed('tags=dogs,pets&addRelated=true')).related).toEqual([]);
      expect((await feed('tags=fish&addRelated=true')).related).toEqual([]);
      expect((await ctx.app.inject({ method: 'GET', url: '/feed?tags=dogs&addRelated=maybe' })).statusCode).toBe(400);

      // The feed routes alone, as a function serves them, given no database to use.
      const { db: _, app: __, ...stores } = ctx;
      const app = await buildApp({ ...stores, now: () => ctx.clock.now }, { logger: false }, ['feed']);
      try {
        const res = await app.inject({ method: 'GET', url: '/feed?tags=dogs&addRelated=true' });
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json()).toMatchObject({ related: ['pets'], count: 6 });
      } finally {
        await app.close();
      }
    });

    it('keeps the related hashtags of the first page on every page of a cursor', async () => {
      const both = await posts('#dogs #pets', 2);
      const pets = await posts('#pets', 2);
      const cats = await posts('#cats', 2);
      await ctx.compact();
      const everything = [...both, ...pets].sort();

      ctx.config.feed.pageSize = 1;
      const query = 'tags=dogs&addRelated=true&algorithm=chronological';
      const first = await feed(query);
      expect(first.related).toEqual(['pets']);
      expect(first.nextCursor).toBeTruthy();

      // What is related changes under the cursor: a first page reads the new hashtags, a later page the ones it began with.
      await ctx.relatedTags.put('dogs', ['cats']);
      expect((await feed(query)).related).toEqual(['cats']);
      const seen = [...tagsOf(first, 'dogs'), ...tagsOf(first, 'pets')];
      let cursor = first.nextCursor;
      for (let page = 0; page < 10 && cursor; page++) {
        const f = await feed(`${query}&cursor=${cursor}`);
        expect(f.related).toEqual(['pets']);
        seen.push(...tagsOf(f, 'dogs'), ...tagsOf(f, 'pets'));
        expect(tagsOf(f, 'cats')).toEqual([]);
        cursor = f.nextCursor;
      }
      expect(cursor).toBeNull();
      expect(seen).toHaveLength(4);
      expect([...seen].sort()).toEqual(everything);
      expect(seen).not.toEqual(expect.arrayContaining(cats));

      // A cursor carries on the feed it was given for: one with related hashtags, or one without.
      const mismatch = 'cursor does not match the requested tags/hours/algorithm/addRelated/aiGenerated/moderated';
      const without = await ctx.app.inject({ method: 'GET', url: `/feed?tags=dogs&algorithm=chronological&cursor=${first.nextCursor}` });
      expect([without.statusCode, without.json().error]).toEqual([400, mismatch]);
      const plain = await feed('tags=pets&algorithm=chronological');
      expect(plain.nextCursor).toBeTruthy();
      const withRelated = await ctx.app.inject({ method: 'GET', url: `/feed?tags=pets&algorithm=chronological&addRelated=true&cursor=${plain.nextCursor}` });
      expect([withRelated.statusCode, withRelated.json().error]).toEqual([400, mismatch]);
    });

    it('counts a post held for moderation as it is stored, and not again when it is accepted', async () => {
      const root = await ctx.register('root');
      await setAdmin(ctx.db, 'root', true);
      const words = await ctx.app.inject({ method: 'POST', url: '/moderation/blocked-words', headers: as(root), payload: { words: ['spam'] } });
      expect(words.statusCode, words.body).toBe(200);
      const held = await storeText(alice, 'spam #dogs #pets');
      expect(held.statusCode, held.body).toBe(202);
      const counted = { 'dogs dogs': 1, 'dogs pets': 1, 'pets pets': 1 };
      expect(await counts()).toEqual(counted);
      const accepted = await ctx.app.inject({ method: 'POST', url: `/moderation/queue/${held.json().contentId}/accept`, headers: as(root) });
      expect(accepted.statusCode, accepted.body).toBeLessThan(300);
      expect(await counts()).toEqual(counted);
    });

    it('relates no hashtags when set to add none', async () => {
      await posts('#dogs #pets', 3);
      ctx.config.feed.relatedTags = 0;
      await ctx.compact();
      expect(await ctx.relatedTags.get('dogs')).toEqual([]);
      expect((await feed('tags=dogs&addRelated=true')).related).toEqual([]);
    });
  });
}
