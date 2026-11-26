import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { setAdmin } from '../src/moderation/policy.js';
import { openTrust } from '../src/moderation/trust.js';
import type { TestPlugin } from '../src/moderation/trust.types.js';
import { as, BASE_ENV, createTestContext, requests, TARGETS, type TestContext } from './helpers.js';

const REFUSED = "the post contains a word or phrase this server doesn't allow, so it wasn't published";
const NOT_TRUSTED = "this server doesn't trust the post enough to keep it, so it wasn't published";

/**
 * The plugins are the server's own (compactor/crates/trust), whose tests cover how a score is
 * made of their answers and which of them a server runs. Here they are joined by test plugins,
 * which do what their rules say (see TestPlugin), to show what a server does with a score.
 */
describe('trust plugins', () => {
  let ctx: TestContext | undefined;
  afterEach(async () => {
    await ctx?.close();
    ctx = undefined;
  });

  it('are the folders of compactor/crates/trust/src/plugins: blocked_words, and the optional ones a server turns on', async () => {
    ctx = await createTestContext(TARGETS[0]!);
    expect(ctx.trust.plugins).toEqual(['blocked_words']);
    await ctx.close();
    ctx = await createTestContext(TARGETS[0]!, { trust: { optionalPlugins: ['urlhaus'] }, urlhaus: { authKey: 'KEY' } });
    expect(ctx.trust.plugins).toEqual(['blocked_words', 'urlhaus']);
    await ctx.close();
    // After the server's own, in the order they are given, or in their place.
    ctx = await createTestContext(TARGETS[0]!, { moreTrustPlugins: [{ name: 'b' }, { name: 'a' }] });
    expect(ctx.trust.plugins).toEqual(['blocked_words', 'b', 'a']);
    await ctx.close();
    ctx = await createTestContext(TARGETS[0]!, { trustPlugins: [{ name: 'only' }] });
    expect(ctx.trust.plugins).toEqual(['only']);
  });

  it("stop the server that names an optional plugin it doesn't have", () => {
    const config = loadConfig({ trust: { optionalPlugins: ['urlhouse'] } }, BASE_ENV);
    expect(() => openTrust(config)).toThrow(/TRUST_OPTIONAL_PLUGINS names urlhouse, which isn't one of the trust plugins this server was built with: it has blocked_words, pdq, urlhaus/);
  });
});

for (const target of TARGETS) {
  describe(`trust plugins on posts (${target.name})`, () => {
    let ctx: TestContext;
    afterEach(() => ctx.close());

    const { storeText: store, feedItems } = requests(() => ctx);
    /** The server's own plugins, and then `more`. */
    const setup = async (...more: TestPlugin[]) => {
      ctx = await createTestContext(target, { moreTrustPlugins: more });
      const root = await ctx.register('root');
      await setAdmin(ctx.db, 'root', true);
      const blocked = await ctx.app.inject({ method: 'POST', url: '/moderation/blocked-words', headers: as(root), payload: { words: ['spam'] } });
      expect(blocked.statusCode, blocked.body).toBe(200);
      return { root, alice: await ctx.register('alice') };
    };
    const queued = () => ctx.db.selectFrom('moderation_queue').select(['content_id', 'trust_score']).execute();
    /** Takes off 30 for each of the words it knows. */
    const shouting: TestPlugin = {
      name: 'shouting',
      rules: ['FREE', 'NOW', 'WIN'].map((includes) => ({ includes, reduce: 30, reason: 'the post shouts too much, so it was not published' })),
    };
    /** Keeps the posts it is shown, for `seen` to read. */
    const watching: TestPlugin = { name: 'watching', record: true };
    /** The posts `watching` was shown since the last time this was asked. */
    const seen = async () => (await ctx.trust.seen()).map(({ post }) => post);

    it('sends every post and update through each plugin, and the post where the score they leave says', async () => {
      const { alice } = await setup(shouting, watching);

      // No plugin has anything against it: full trust, and it is published.
      const fine = await store(alice, 'A quiet post #news');
      expect(fine.statusCode, fine.body).toBe(201);
      const { contentId } = fine.json();
      expect(await seen()).toEqual([{ userId: alice.userId, tags: ['news'], texts: ['A quiet post #news'] }]);

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
      await seen();
      const update = await store(alice, 'A quiet post, FREE now #news', { contentId });
      expect(update.statusCode, update.body).toBe(202);
      expect(await seen()).toEqual([{ userId: alice.userId, contentId, tags: ['news'], texts: ['A quiet post, FREE now #news'] }]);
      expect(await queued()).toContainEqual({ content_id: contentId, trust_score: 70 });
      expect(await feedItems('news')).toEqual([]);
    });

    it('refuses a post with the reason of the plugin that brought its score under the threshold, if it gave one', async () => {
      const { alice } = await setup(shouting, { name: 'strict', rules: [{ includes: 'bad', set: 10 }] });
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
      const strict: TestPlugin = { name: 'strict', rules: [{ includes: 'bad', comments: true, set: 10 }] };
      const { alice } = await setup(shouting, strict, watching);
      const bob = await ctx.register('bob');
      const comment = (text: string) => ctx.app.inject({ method: 'POST', url: `/content/${contentId}/comments`, headers: as(bob), payload: { text } });
      const held = () => ctx.db.selectFrom('comment_queue').select(['comment_id', 'trust_score']).execute();
      // What a plugin has against comments, it doesn't have against posts.
      const posted = await store(alice, 'Not a bad post #news', { comments: true });
      expect(posted.statusCode, posted.body).toBe(201);
      const { contentId } = posted.json();
      await seen();

      // No plugin has anything against it: full trust, and it is published.
      const fine = await comment('A quiet comment');
      expect(fine.statusCode, fine.body).toBe(201);
      expect(await seen()).toEqual([{ userId: bob.userId, commentOn: contentId, tags: [], texts: ['A quiet comment'] }]);
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
      const { alice } = await setup({ name: 'generous', rules: [{ set: 100 }] }, { name: 'broken', rules: [{ includes: 'boom', fails: 'boom' }] });
      const refused = await store(alice, 'Some spam #news');
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toEqual({ error: REFUSED });

      expect((await store(alice, 'boom #news')).statusCode).toBe(500);
      expect(await ctx.db.selectFrom('content').select('id').execute()).toEqual([]);
      expect((await store(alice, 'An honest post #news')).statusCode).toBe(201);
    });
  });
}
