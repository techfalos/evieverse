import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { setAdmin } from '../src/moderation/policy.js';
import { loadTrustPlugins, trustOf, type TrustChange, type TrustContext, type TrustPlugin, type TrustPost } from '../src/moderation/trust.js';
import { as, createTestContext, requests, TARGETS, type TestContext } from './helpers.js';

const REFUSED = "the post contains a word or phrase this server doesn't allow, so it wasn't published";
const NOT_TRUSTED = "this server doesn't trust the post enough to keep it, so it wasn't published";

/** A plugin that always answers the same. */
const always = (name: string, change: TrustChange | null): TrustPlugin => ({ name, assess: () => change });

describe('trust plugins', () => {
  const POST: TrustPost = { userId: 'u', tags: ['news'], texts: ['hello'] };
  const CTX = { now: () => 0 } as unknown as Omit<TrustContext, 'score'>;
  const score = async (...changes: (TrustChange | null)[]) => (await trustOf(changes.map((change, i) => always(`p${i}`, change)), POST, CTX)).score;

  it('start a post at full trust, and set or reduce its score', async () => {
    expect(await trustOf([], POST, CTX)).toEqual({ score: 100 });
    expect(await score(null)).toBe(100);
    expect(await score({ set: 40 })).toBe(40);
    expect(await score({ reduce: 30 })).toBe(70);
    expect(await score({ reduce: 30 }, { reduce: 30 })).toBe(40);
    expect(await score({ reduce: 0 })).toBe(100);
  });

  it('never raise a score: where plugins disagree, the lower score wins', async () => {
    expect(await score({ set: 40 }, { set: 90 })).toBe(40);
    expect(await score({ set: 90 }, { set: 40 })).toBe(40);
    expect(await score({ set: 0 }, { set: 100 })).toBe(0);
    expect(await score({ set: 250 })).toBe(100);
    // A set that is higher changes nothing; a reduction always counts.
    expect(await score({ reduce: 20 }, { set: 90 })).toBe(80);
    expect(await score({ set: 50 }, { reduce: 20 })).toBe(30);
    expect(await score({ reduce: 20 }, { set: 50 })).toBe(50);
    // Never under 0, and a whole number.
    expect(await score({ reduce: 70 }, { reduce: 70 })).toBe(0);
    expect(await score({ set: -5 })).toBe(0);
    expect(await score({ set: 49.9 })).toBe(49);
    expect(await score({ reduce: 0.5 })).toBe(99);
  });

  it('refuse an answer that is neither a set nor a reduction, or would raise the score', async () => {
    const bad = [{ reduce: -10 }, { set: Number.NaN }, { reduce: Infinity }, { set: '10' }, { set: 10, reduce: 10 }, {}, { reason: 'no' }] as unknown as TrustChange[];
    for (const change of bad) await expect(score(change), JSON.stringify(change)).rejects.toThrow(/the trust plugin p0 must answer/);
  });

  it('run every plugin in order, each told the post and the score so far, and keep the reason of the change that left the score', async () => {
    const seen: [string, number][] = [];
    const plugin = (name: string, change: TrustChange | null): TrustPlugin => ({
      name,
      async assess(post, ctx) {
        expect(post).toBe(POST);
        seen.push([name, ctx.score]);
        return change;
      },
    });
    const plugins = [
      plugin('a', { reduce: 10, reason: 'a' }),
      plugin('b', { set: 0, reason: 'b' }),
      // The score is 0 already: neither of these changes it, and neither's reason is the one.
      plugin('c', { set: 100, reason: 'c' }),
      plugin('d', { reduce: 50, reason: 'd' }),
      plugin('e', null),
    ];
    expect(await trustOf(plugins, POST, CTX)).toEqual({ score: 0, reason: 'b' });
    expect(seen).toEqual([['a', 100], ['b', 90], ['c', 0], ['d', 0], ['e', 0]]);
    // A change that gives no reason leaves none.
    expect(await trustOf([plugin('a', { reduce: 10, reason: 'a' }), plugin('b', { reduce: 10 })], POST, CTX)).toEqual({ score: 80 });
    await expect(trustOf([{ name: 'broken', assess: () => Promise.reject(new Error('boom')) }], POST, CTX)).rejects.toThrow('boom');
  });

  describe('as folders', () => {
    // Under the project (in a folder git ignores), as vitest only loads modules from there.
    const DATA = join(dirname(fileURLToPath(import.meta.url)), 'data');
    const dirs: string[] = [];
    afterEach(async () => {
      for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
    });

    const folders = async (plugins: Record<string, string | null>) => {
      await mkdir(DATA, { recursive: true });
      const dir = await mkdtemp(join(DATA, 'plugins-'));
      dirs.push(dir);
      await writeFile(join(dir, 'README.md'), 'Not a folder, so not a plugin.');
      for (const [name, source] of Object.entries(plugins)) {
        await mkdir(join(dir, name));
        if (source !== null) await writeFile(join(dir, name, 'index.js'), source);
      }
      return dir;
    };

    it('are the folders of src/plugins/trust, of which blocked_words is one', async () => {
      expect((await loadTrustPlugins()).map((plugin) => plugin.name)).toEqual(['blocked_words']);
    });

    it('are loaded from each folder, in the order of their names', async () => {
      const plugins = await loadTrustPlugins(
        await folders({
          b_links: 'export default { assess: (post, ctx) => ({ set: ctx.score - 1, reason: post.texts[0] }) };',
          a_length: 'export default { assess: async () => ({ reduce: 30 }) };',
          c_nothing: 'export default { assess() {} };',
        }),
      );
      expect(plugins.map((plugin) => plugin.name)).toEqual(['a_length', 'b_links', 'c_nothing']);
      expect(await trustOf(plugins, POST, CTX)).toEqual({ score: 69, reason: 'hello' });
    });

    it('stop the server that has a folder without a plugin in it', async () => {
      await expect(loadTrustPlugins(await folders({ empty: null }))).rejects.toThrow(/the trust plugin empty has no index file/);
      await expect(loadTrustPlugins(await folders({ wrong: 'export const assess = () => null;' }))).rejects.toThrow(/the trust plugin wrong must export an object with an assess function/);
      await expect(loadTrustPlugins(await folders({ broken: 'throw new Error("cannot start");' }))).rejects.toThrow('cannot start');
    });
  });
});

for (const target of TARGETS) {
  describe(`trust plugins on posts (${target.name})`, () => {
    let ctx: TestContext;
    afterEach(() => ctx.close());

    const { storeText: store, feedItems } = requests(() => ctx);
    /** The server's own plugins, and then `more`. */
    const setup = async (...more: TrustPlugin[]) => {
      ctx = await createTestContext(target, { trustPlugins: [...(await loadTrustPlugins()), ...more] });
      const root = await ctx.register('root');
      await setAdmin(ctx.db, 'root', true);
      const blocked = await ctx.app.inject({ method: 'POST', url: '/moderation/blocked-words', headers: as(root), payload: { words: ['spam'] } });
      expect(blocked.statusCode, blocked.body).toBe(200);
      return { root, alice: await ctx.register('alice') };
    };
    const queued = () => ctx.db.selectFrom('moderation_queue').select(['content_id', 'trust_score']).execute();
    /** Takes off 30 for each of the words it knows. */
    const shouting: TrustPlugin = {
      name: 'shouting',
      assess: ({ texts }) => {
        const found = ['FREE', 'NOW', 'WIN'].filter((word) => texts.some((text) => text.includes(word))).length;
        return found ? { reduce: 30 * found, reason: 'the post shouts too much, so it was not published' } : null;
      },
    };

    it('sends every post and update through each plugin, and the post where the score they leave says', async () => {
      const seen: TrustPost[] = [];
      const watching: TrustPlugin = { name: 'watching', assess: (post) => void seen.push(post) };
      const { alice } = await setup(shouting, watching);

      // No plugin has anything against it: full trust, and it is published.
      const fine = await store(alice, 'A quiet post #news');
      expect(fine.statusCode, fine.body).toBe(201);
      const { contentId } = fine.json();
      expect(seen).toEqual([{ userId: alice.userId, contentId: undefined, tags: ['news'], texts: ['A quiet post #news'] }]);

      // One reduction leaves 70, under the 75 a post is published from: it waits for an admin.
      const held = await store(alice, 'FREE things #news');
      expect(held.statusCode, held.body).toBe(202);
      expect(held.json()).toMatchObject({ status: 'pending_review' });
      expect(await queued()).toEqual([{ content_id: held.json().contentId, trust_score: 70 }]);

      // Two leave 40, and still it waits; a blocked word of the server leaves nothing, whatever came after.
      const lower = await store(alice, 'FREE things NOW #news');
      expect(lower.statusCode, lower.body).toBe(202);
      expect(await queued()).toContainEqual({ content_id: lower.json().contentId, trust_score: 40 });
      const refused = await store(alice, 'FREE spam #news');
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toEqual({ error: REFUSED });

      // An update goes through them as a new post does, and is told what it updates.
      seen.length = 0;
      const update = await store(alice, 'A quiet post, FREE now #news', { contentId });
      expect(update.statusCode, update.body).toBe(202);
      expect(seen).toEqual([{ userId: alice.userId, contentId, tags: ['news'], texts: ['A quiet post, FREE now #news'] }]);
      expect(await queued()).toContainEqual({ content_id: contentId, trust_score: 70 });
      expect(await feedItems('news')).toEqual([]);
    });

    it('refuses a post with the reason of the plugin that brought its score under the threshold, if it gave one', async () => {
      const { alice } = await setup(shouting, { name: 'strict', assess: ({ texts }) => (texts[0]!.includes('bad') ? { set: 10 } : null) });
      // Three reductions leave 10, under the 25 a post is kept from.
      const loud = await store(alice, 'WIN things FREE, NOW #news');
      expect(loud.statusCode).toBe(422);
      expect(loud.json()).toEqual({ error: 'the post shouts too much, so it was not published' });
      const bad = await store(alice, 'a bad post #news');
      expect(bad.statusCode).toBe(422);
      expect(bad.json()).toEqual({ error: NOT_TRUSTED });
      expect(await ctx.db.selectFrom('content').select('id').execute()).toEqual([]);
    });

    it('sends a comment through each plugin as it sends a post, told which post it is on, and where the score they leave says', async () => {
      const seen: TrustPost[] = [];
      const watching: TrustPlugin = { name: 'watching', assess: (post) => void seen.push(post) };
      const strict: TrustPlugin = { name: 'strict', assess: ({ commentOn, texts }) => (commentOn !== undefined && texts[0]!.includes('bad') ? { set: 10 } : null) };
      const { alice } = await setup(shouting, strict, watching);
      const bob = await ctx.register('bob');
      const comment = (text: string) => ctx.app.inject({ method: 'POST', url: `/content/${contentId}/comments`, headers: as(bob), payload: { text } });
      const held = () => ctx.db.selectFrom('comment_queue').select(['comment_id', 'trust_score']).execute();
      // What a plugin has against comments, it doesn't have against posts.
      const posted = await store(alice, 'Not a bad post #news', { comments: true });
      expect(posted.statusCode, posted.body).toBe(201);
      const { contentId } = posted.json();
      seen.length = 0;

      // No plugin has anything against it: full trust, and it is published.
      const fine = await comment('A quiet comment');
      expect(fine.statusCode, fine.body).toBe(201);
      expect(seen).toEqual([{ userId: bob.userId, commentOn: contentId, tags: [], texts: ['A quiet comment'] }]);
      expect(await held()).toEqual([]);

      // One reduction leaves 70, and two 40: it waits for a server moderator, with its score.
      const waits = await comment('FREE things');
      expect(waits.statusCode, waits.body).toBe(202);
      expect(waits.json()).toMatchObject({ status: 'pending_review' });
      const lower = await comment('FREE things NOW');
      expect(lower.statusCode, lower.body).toBe(202);
      expect((await held()).sort((a, b) => b.trust_score - a.trust_score)).toEqual([
        { comment_id: waits.json().commentId, trust_score: 70 },
        { comment_id: lower.json().commentId, trust_score: 40 },
      ]);

      // Under the 25 a comment is kept from, it is refused: with the plugin's reason if it gave one, and the server's if not.
      const loud = await comment('WIN things FREE, NOW');
      expect([loud.statusCode, loud.json()]).toEqual([422, { error: 'the post shouts too much, so it was not published' }]);
      const bad = await comment('a bad comment');
      expect([bad.statusCode, bad.json()]).toEqual([422, { error: "this server doesn't trust the comment enough to keep it, so it wasn't published" }]);
      const blocked = await comment('Some spam');
      expect([blocked.statusCode, blocked.json()]).toEqual([422, { error: "the comment contains a word or phrase this server doesn't allow, so it wasn't published" }]);
      expect(await held()).toHaveLength(2);
      const listed = (await ctx.app.inject({ method: 'GET', url: `/content/${contentId}/comments` })).json();
      expect(listed.comments.map((c: { text: string }) => c.text)).toEqual(['A quiet comment']);
    });

    it("doesn't let a plugin raise the score another left, and stores nothing of a post a plugin fails on", async () => {
      const { alice } = await setup({ name: 'generous', assess: () => ({ set: 100 }) }, { name: 'broken', assess: ({ texts }) => (texts[0]!.includes('boom') ? Promise.reject(new Error('boom')) : null) });
      const refused = await store(alice, 'Some spam #news');
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toEqual({ error: REFUSED });

      expect((await store(alice, 'boom #news')).statusCode).toBe(500);
      expect(await ctx.db.selectFrom('content').select('id').execute()).toEqual([]);
      expect((await store(alice, 'An honest post #news')).statusCode).toBe(201);
    });
  });
}
