import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_MENTIONS, resolveMentions } from '../src/mentions.js';
import { setAdmin } from '../src/moderation/policy.js';
import { as, createTestContext, requests, TARGETS, type TestContext, type User } from './helpers.js';

type Mention = { userId: string; username: string };
type Item = {
  messageId: string;
  kind: string;
  from?: Mention | null;
  text: string;
  contentId?: string;
  commentId?: string;
  excerpt?: string;
  sentAt: string;
  readAt: string | null;
};

for (const target of TARGETS) {
  describe(`mentions (${target.name})`, () => {
    let ctx: TestContext;
    afterEach(() => ctx.close());

    const { storeText: store, feedItems } = requests(() => ctx);
    const req = (u: User | null, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
      ctx.app.inject({ method, url, headers: u ? as(u) : {}, ...(payload && { payload }) });
    const ok = (res: LightMyRequestResponse, status = 200) => {
      expect(res.statusCode, res.body).toBe(status);
      return res.json();
    };
    const now = () => new Date(ctx.clock.now).toISOString();
    const admin = async (name = 'root') => {
      const u = await ctx.register(name);
      await setAdmin(ctx.db, name, true);
      return u;
    };
    /** Registers a user, and returns them with how a text that mentions them names them. */
    const named = async (username: string): Promise<User & { mention: Mention }> => {
      const u = await ctx.register(username);
      return { ...u, mention: { userId: u.userId, username } };
    };
    /** A user's notices, oldest first, without their ids and times. */
    const notices = async (u: User) =>
      (ok(await req(u, 'GET', `/users/${u.userId}/inbox`)).inbox as Item[])
        .filter((m) => m.kind !== 'message')
        .map(({ messageId: _id, sentAt: _sent, readAt: _read, ...notice }) => notice)
        .reverse();
    const comment = (u: User, contentId: string, text: string) => req(u, 'POST', `/content/${contentId}/comments`, { text });
    const edit = (u: User, contentId: string, commentId: string, text: string) => req(u, 'PATCH', `/content/${contentId}/comments/${commentId}`, { text });
    const block = (u: User, other: User) => req(u, 'PUT', `/users/${u.userId}/blocked/${other.userId}`);
    /** A second later, so what is left in an inbox is in the order it was left. */
    const tick = () => {
      ctx.clock.now += 1000;
    };

    it('finds whom a text mentions by their names, to the letter, and no more of them than a text can mention', async () => {
      ctx = await createTestContext(target);
      const ann = await named('ann');
      const annLee = await named('Ann Lee');
      const snake = await named('snake_case');
      await named('bob');
      const mentions = (text: string | undefined) => resolveMentions(ctx.db, text);

      expect(await mentions(undefined)).toEqual([]);
      expect(await mentions('Nobody here, and no-one@ann either')).toEqual([]);
      // The longest name that is someone's, wherever it ends; a name in other capitals is nobody's.
      expect(await mentions('@Ann Lee and @ann, again @ann. Then @Ann and @ANN LEE and @annie')).toEqual([annLee.mention, ann.mention]);
      // A name is found as the text says it, with what it escapes, and isn't looked for in code or in a link's label.
      expect(await mentions('@snake\\_case, `@bob` and [@bob](https://example.com/bob), \\@ann')).toEqual([snake.mention]);
      expect(await mentions('(@ann) "@Ann Lee", @snake_case!')).toEqual([ann.mention, annLee.mention, snake.mention]);

      const many = [];
      for (let i = 0; i <= MAX_MENTIONS; i++) many.push(await named(`user${i}x`));
      const all = await mentions(many.map((u) => `@${u.mention.username}`).join(' '));
      expect(all).toEqual(many.slice(0, MAX_MENTIONS).map((u) => u.mention));

      // An account that is closed is mentioned no more.
      ok(await req(ann, 'DELETE', `/users/${ann.userId}`));
      expect(await mentions('@ann and @Ann Lee')).toEqual([annLee.mention]);
    });

    it('tells the users a post mentions, and gives them with its text, to link each to their profile', async () => {
      ctx = await createTestContext(target, { feed: { previewWords: 6 } });
      const alice = await named('alice');
      const bob = await named('bob');
      const annLee = await named('Ann Lee');
      const carol = await named('carol');

      const text = 'Hello @bob and @Ann Lee, not @nobody. And then, much later, @carol and @alice and @bob again #news';
      const stored = ok(await store(alice, text), 201);
      const at = now();
      const { contentId } = stored;
      const mentions = [bob.mention, annLee.mention, carol.mention, alice.mention];
      // The preview is the start of the text, and the response has everyone the whole of it mentions.
      expect(stored.preview.text).toBe('Hello @bob and @Ann Lee, not …');
      expect(stored.mentions).toEqual(mentions);
      expect(ok(await req(null, 'GET', `/content/${contentId}`))).toMatchObject({ text, mentions });
      // A feed has the preview, and whom the preview mentions.
      await ctx.compact();
      expect((await feedItems('news'))[0]).toMatchObject({ contentId, preview: { text: 'Hello @bob and @Ann Lee, not …' }, mentions: [bob.mention, annLee.mention] });
      // Their profiles are where the ids lead.
      for (const u of [bob, annLee]) expect(ok(await req(null, 'GET', `/users/${u.userId}`))).toMatchObject(u.mention);

      const notice = { kind: 'post_mention', from: alice.mention, contentId, excerpt: 'Hello @bob and @Ann Lee, not …', text: 'alice mentioned you in a post.' };
      // Each is told once, and its publisher not at all.
      for (const u of [bob, annLee, carol]) expect(await notices(u)).toEqual([notice]);
      expect(await notices(alice)).toEqual([]);
      expect(ok(await req(bob, 'GET', `/users/${bob.userId}/inbox`))).toMatchObject({ unread: 1, inbox: [{ messageId: expect.any(String), sentAt: at, readAt: null }] });

      // A post that mentions nobody says nothing of mentions.
      const plain = ok(await store(alice, 'Nobody at all, email@bob.example #news'), 201);
      expect(plain).not.toHaveProperty('mentions');
      expect(ok(await req(null, 'GET', `/content/${plain.contentId}`))).not.toHaveProperty('mentions');
      expect(await notices(bob)).toHaveLength(1);

      // Once its publisher's account is closed, the notice names nobody.
      ok(await req(alice, 'DELETE', `/users/${alice.userId}`), 202);
      expect(await notices(carol)).toEqual([{ ...notice, from: null, text: 'You were mentioned in a post.' }]);
    });

    it('tells whom an update of a post newly mentions, and goes on mentioning a user who was renamed while one could be', async () => {
      ctx = await createTestContext(target);
      const alice = await named('alice');
      const bob = await named('bob');
      const carol = await named('carol');
      const { contentId } = ok(await store(alice, 'Thanks @bob #news'), 201);
      expect(await notices(bob)).toHaveLength(1);

      // No request renames a user, so nobody takes a name from one who has an account. A database
      // that is older than that may hold one who was renamed, and whose name someone else took
      // since, which is written here as it was then: the post still mentions the user it did.
      expect((await req(bob, 'PATCH', `/users/${bob.userId}`, { username: 'robert' })).statusCode).toBe(400);
      await ctx.db.updateTable('users').set({ username: 'robert', username_folded: 'robert' }).where('id', '=', bob.userId).execute();
      const other = await named('bob');
      tick();
      const updated = ok(await store(alice, 'Thanks @bob and @carol #news', { contentId }), 200);
      expect(updated.mentions).toEqual([bob.mention, carol.mention]);
      expect(ok(await req(null, 'GET', `/content/${contentId}`)).mentions).toEqual([bob.mention, carol.mention]);
      expect(await notices(carol)).toEqual([{ kind: 'post_mention', from: alice.mention, contentId, excerpt: 'Thanks @bob and @carol #news', text: 'alice mentioned you in a post.' }]);
      expect(await notices(bob)).toHaveLength(1);
      expect(await notices(other)).toEqual([]);

      // A user who is mentioned no more, and then again, while the first notice is in their inbox, isn't told twice.
      tick();
      expect(ok(await store(alice, 'Thanks @carol #news', { contentId }), 200).mentions).toEqual([carol.mention]);
      tick();
      // By now the name is the other user's.
      expect(ok(await store(alice, 'Thanks @carol and @bob and @robert #news', { contentId }), 200).mentions).toEqual([carol.mention, other.mention, { userId: bob.userId, username: 'robert' }]);
      expect(await notices(carol)).toHaveLength(1);
      expect(await notices(bob)).toHaveLength(1);
      expect(await notices(other)).toHaveLength(1);
    });

    it('tells the users a comment mentions, and whom an edit of it newly does', async () => {
      ctx = await createTestContext(target);
      const alice = await named('alice');
      const bob = await named('bob');
      const carol = await named('carol');
      const contentId = ok(await store(alice, 'Talk to me #news', { comments: true }), 201).contentId as string;

      const sent = ok(await comment(bob, contentId, 'What do **@alice** and @carol think, @bob?'), 201);
      const { commentId } = sent;
      expect(sent.mentions).toEqual([alice.mention, carol.mention, bob.mention]);
      const notice = { kind: 'comment_mention', from: bob.mention, contentId, commentId, excerpt: 'What do @alice and @carol think, @bob?', text: 'bob mentioned you in a comment.' };
      expect(await notices(alice)).toEqual([notice]);
      expect(await notices(carol)).toEqual([notice]);
      expect(await notices(bob)).toEqual([]);

      // It is read with them, by its id and in the post's comments.
      expect(ok(await req(null, 'GET', `/content/${contentId}/comments/${commentId}`)).mentions).toEqual(sent.mentions);
      expect(ok(await req(null, 'GET', `/content/${contentId}/comments`)).comments).toMatchObject([{ commentId, mentions: sent.mentions }]);
      // A reader who blocks its author is listed nothing of it.
      ok(await block(carol, bob), 201);
      const [blocked] = ok(await req(carol, 'GET', `/content/${contentId}/comments`)).comments;
      expect(blocked).toMatchObject({ commentId, status: 'blocked', text: '' });
      expect(blocked).not.toHaveProperty('mentions');

      // An edit says anew whom the comment mentions, and tells those it didn't before.
      const dave = await named('dave');
      tick();
      const edited = ok(await edit(bob, contentId, commentId, 'What does @dave think, @alice?'));
      expect(edited.mentions).toEqual([dave.mention, alice.mention]);
      expect(await notices(dave)).toEqual([{ ...notice, excerpt: 'What does @dave think, @alice?' }]);
      expect(await notices(alice)).toEqual([notice]);
      tick();
      const plain = ok(await edit(bob, contentId, commentId, 'Never mind'));
      expect(plain).not.toHaveProperty('mentions');
      expect(ok(await req(null, 'GET', `/content/${contentId}/comments/${commentId}`))).not.toHaveProperty('mentions');

      // Another comment on the same post is another mention.
      tick();
      const second = ok(await comment(bob, contentId, 'Or you, @alice?'), 201);
      expect(await notices(alice)).toEqual([notice, { ...notice, commentId: second.commentId, excerpt: 'Or you, @alice?' }]);
    });

    it('tells nobody of a mention while what makes it is held for review, and tells them once it is accepted', async () => {
      ctx = await createTestContext(target, { trust: { deleteBelow: 0 } });
      const root = await admin();
      const alice = await named('alice');
      const bob = await named('bob');
      const carol = await named('carol');
      ok(await req(root, 'POST', '/moderation/blocked-words', { words: ['spam'] }));

      const held = ok(await store(alice, 'Free spam for @bob #news', { comments: true }), 202);
      expect(held).toMatchObject({ status: 'pending_review', mentions: [bob.mention] });
      const open = ok(await store(alice, 'Talk to me #news', { comments: true }), 201).contentId as string;
      const heldComment = ok(await comment(carol, open, 'Spam for @bob too'), 202);
      expect(heldComment).toMatchObject({ status: 'pending_review', mentions: [bob.mention] });
      expect(await notices(bob)).toEqual([]);
      // Whoever decides on them reads them with whom they mention.
      const queue = ok(await req(root, 'GET', '/moderation/queue')).queue as { contentId: string; commentId?: string; mentions?: Mention[] }[];
      expect(queue.map((item) => item.mentions)).toEqual([[bob.mention], [bob.mention]]);

      tick();
      ok(await req(root, 'POST', `/moderation/queue/${held.contentId}/accept`));
      tick();
      ok(await req(root, 'POST', `/moderation/queue/${open}/comments/${heldComment.commentId}/accept`));
      expect(await notices(bob)).toEqual([
        { kind: 'post_mention', from: alice.mention, contentId: held.contentId, excerpt: 'Free spam for @bob #news', text: 'alice mentioned you in a post.' },
        { kind: 'comment_mention', from: carol.mention, contentId: open, commentId: heldComment.commentId, excerpt: 'Spam for @bob too', text: 'carol mentioned you in a comment.' },
      ]);

      // One that is rejected tells nobody, and neither does an edit that is held.
      tick();
      const dave = await named('dave');
      const rejected = ok(await store(alice, 'More spam for @dave #news'), 202);
      ok(await req(root, 'POST', `/moderation/queue/${rejected.contentId}/reject`), 202);
      const kept = ok(await comment(alice, open, 'An honest comment'), 201);
      tick();
      ok(await edit(alice, open, kept.commentId, 'Honest spam, @dave'), 202);
      expect(await notices(dave)).toEqual([]);
      tick();
      ok(await req(root, 'POST', `/moderation/queue/${open}/comments/${kept.commentId}/accept`));
      expect(await notices(dave)).toMatchObject([{ kind: 'comment_mention', from: alice.mention, commentId: kept.commentId, excerpt: 'Honest spam, @dave' }]);
    });

    it('tells neither of two users that the other mentioned them while one blocks the other', async () => {
      ctx = await createTestContext(target);
      const alice = await named('alice');
      const bob = await named('bob');
      const carol = await named('carol');
      ok(await block(bob, alice), 201);

      // The text mentions them all the same: it is its author's to write.
      const first = ok(await store(alice, 'Hello @bob and @carol #news', { comments: true }), 201);
      expect(first.mentions).toEqual([bob.mention, carol.mention]);
      tick();
      const second = ok(await store(bob, 'Hello @alice and @carol #news'), 201);
      expect(second.mentions).toEqual([alice.mention, carol.mention]);
      const sent = ok(await comment(alice, first.contentId, 'And again, @bob'), 201);
      expect(sent.mentions).toEqual([bob.mention]);
      expect(await notices(bob)).toEqual([]);
      expect(await notices(alice)).toEqual([]);
      expect((await notices(carol)).map((n) => [n.kind, n.from?.username])).toEqual([
        ['post_mention', 'alice'],
        ['post_mention', 'bob'],
      ]);

      // Turning off messages between users turns off no notice.
      ok(await req(carol, 'PATCH', `/users/${carol.userId}`, { messages: false }));
      tick();
      ok(await store(alice, 'Once more, @carol #news'), 201);
      expect(await notices(carol)).toHaveLength(3);
    });
  });
}
