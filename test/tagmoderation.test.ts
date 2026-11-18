import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { setAdmin } from '../src/moderation/policy.js';
import { MAX_REASON_CHARS } from '../src/moderation/tagDecisions.js';
import { MAX_RULE_CHARS, MAX_RULES } from '../src/routes/rules.js';
import { as, createTestContext, readAudit, requests, TARGETS, type TestContext, type User } from './helpers.js';

const HOUR = 60 * 60 * 1000;
const NO_RULE = '00000000-0000-4000-8000-000000000000';

type Claim = { tag: string; userId: string; username: string; claimedAt: string; reviewUntil: string };
type Rule = { tag: string; ruleId: string; position: number; text: string; createdAt: string; updatedAt: string };
type Action = { action: string; tag: string; by: string; reason?: string; at: string; text: string };

for (const target of TARGETS) {
  describe(`tag moderation (${target.name})`, () => {
    let ctx: TestContext;
    afterEach(() => ctx.close());

    const { post } = requests(() => ctx);
    const req = (u: User | null, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
      ctx.app.inject({ method, url, headers: u ? as(u) : {}, ...(payload && { payload }) });
    const ok = (res: LightMyRequestResponse, status = 200) => {
      expect(res.statusCode, res.body).toBe(status);
      return res.json();
    };
    /** What a refused request was told. */
    const refused = async (res: Promise<LightMyRequestResponse>) => {
      const r = await res;
      return [r.statusCode, r.json().error];
    };
    const iso = (ms: number) => new Date(ms).toISOString();
    const now = () => iso(ctx.clock.now);
    /** A server with an admin, a server moderator, and three users who hold no role. */
    const setup = async (opts: Parameters<typeof createTestContext>[1] = {}) => {
      ctx = await createTestContext(target, opts);
      const root = await ctx.register('root');
      await setAdmin(ctx.db, 'root', true);
      const mod = await ctx.register('mod');
      ok(await req(root, 'PUT', `/moderators/${mod.userId}`), 201);
      return { root, mod, alice: await ctx.register('alice'), bob: await ctx.register('bob'), carol: await ctx.register('carol') };
    };
    const claim = (u: User | null, tag: string) => req(u, 'POST', `/tags/${tag}/claim`);
    const moderatorsOf = async (tag: string) => ok(await req(null, 'GET', `/tags/${tag}/moderators`)) as { tag: string; moderators: { userId: string; username: string; since: string }[]; claim?: Claim };
    /** A user's notices of one hashtag's claims, oldest first: the kind of each, what it says, and the facts it holds. */
    const notices = async (u: User, tag: string) =>
      (ok(await req(u, 'GET', `/users/${u.userId}/inbox`)).inbox as { kind: string; tag?: string; text: string; details?: Record<string, string> }[])
        .filter((m) => m.kind.startsWith('tag_claim') && m.tag === tag)
        .map((m) => [m.kind, m.text, ...(m.details ? [m.details] : [])])
        .reverse();
    /** Whether `u` can do what a moderator of `tag` does: read who is muted on it. */
    const moderates = async (u: User, tag: string) => (await req(u, 'GET', `/tags/${tag}/muted`)).statusCode === 200;

    describe('claims', () => {
      it('has a user claim a hashtag nobody moderates, tells the admins and server moderators, and makes the user its moderator once the time to refuse it is over', async () => {
        const { root, mod, alice, bob } = await setup();
        const claimedAt = now();
        const reviewUntil = iso(ctx.clock.now + 24 * HOUR);
        const made: Claim = { tag: 'cars', userId: alice.userId, username: 'alice', claimedAt, reviewUntil };

        // The hashtag as it is written, or as the server keeps it. Nobody has posted under it yet.
        expect(ok(await claim(alice, 'Cars'), 201)).toEqual({ ...made, alreadyClaimed: false });
        expect(await moderatorsOf('cars')).toEqual({ tag: 'cars', moderators: [], claim: made });
        expect(await moderates(alice, 'cars')).toBe(false);

        // Every admin and server moderator is told, and nobody else is.
        const told = [
          'tag_claimed',
          `alice claimed #cars, to moderate it. They become its moderator at ${reviewUntil}, unless an admin or a server moderator refuses the claim before then (DELETE /tags/cars/claim).`,
          { userId: alice.userId, username: 'alice', reviewUntil },
        ];
        expect(await notices(root, 'cars')).toEqual([told]);
        expect(await notices(mod, 'cars')).toEqual([told]);
        expect(await notices(alice, 'cars')).toEqual([]);
        expect(await notices(bob, 'cars')).toEqual([]);

        // Claiming it again changes nothing and tells nobody; another user's claim has to wait for this one to end.
        ctx.clock.now += HOUR;
        expect(ok(await claim(alice, 'cars'))).toEqual({ ...made, alreadyClaimed: true });
        expect(await notices(root, 'cars')).toHaveLength(1);
        expect(await refused(claim(bob, 'cars'))).toEqual([409, "another user's claim to #cars is waiting"]);

        // The claims that wait are the server moderators' and the admins' to read.
        expect(ok(await req(mod, 'GET', '/moderation/tag-claims'))).toEqual({ claims: [made], nextCursor: null });
        expect(ok(await req(root, 'GET', '/moderation/tag-claims'))).toEqual({ claims: [made], nextCursor: null });
        expect((await req(alice, 'GET', '/moderation/tag-claims')).statusCode).toBe(403);
        expect((await req(null, 'GET', '/moderation/tag-claims')).statusCode).toBe(401);

        // It waits out its time: a run of the compactor before then leaves it.
        await ctx.compact();
        expect(await moderatorsOf('cars')).toEqual({ tag: 'cars', moderators: [], claim: made });
        expect(await moderates(alice, 'cars')).toBe(false);

        ctx.clock.now += 23 * HOUR;
        await ctx.compact();
        const { moderators, claim: left } = await moderatorsOf('cars');
        expect(left).toBeUndefined();
        expect(moderators).toMatchObject([{ userId: alice.userId, username: 'alice' }]);
        expect(Date.parse(moderators[0]!.since)).toBeGreaterThanOrEqual(Date.parse(reviewUntil));
        expect(await moderates(alice, 'cars')).toBe(true);
        expect(await moderates(alice, 'trucks')).toBe(false);
        expect(await notices(alice, 'cars')).toEqual([['tag_claim_granted', 'Your claim to #cars went through: you are now a moderator of the hashtag.']]);
        expect(ok(await req(mod, 'GET', '/moderation/tag-claims'))).toEqual({ claims: [], nextCursor: null });
        expect(await ctx.db.selectFrom('tag_claims').selectAll().execute()).toEqual([]);

        // A hashtag that has a moderator can't be claimed: its other moderators are appointed.
        expect(await refused(claim(bob, 'cars'))).toEqual([409, "#cars has a moderator already, so it can't be claimed: its moderators, or an admin, appoint the others"]);
        // And what a claim gave, an admin can take back.
        expect(ok(await req(root, 'DELETE', `/tags/cars/moderators/${alice.userId}`))).toMatchObject({ wasModerator: true });
        expect(await moderates(alice, 'cars')).toBe(false);
      });

      it('lists the claims that wait, longest waiting first, a page at a time', async () => {
        const { mod, alice, bob, carol } = await setup();
        ok(await claim(alice, 'cars'), 201);
        ctx.clock.now += 1000;
        ok(await claim(bob, 'bikes'), 201);
        ok(await claim(carol, 'boats'), 201);
        const tags = (page: { claims: Claim[] }) => page.claims.map((c) => [c.tag, c.username]);

        const first = ok(await req(mod, 'GET', '/moderation/tag-claims?limit=2'));
        expect(tags(first)).toEqual([['cars', 'alice'], ['bikes', 'bob']]);
        expect(first.nextCursor).toEqual(expect.any(String));
        const second = ok(await req(mod, 'GET', `/moderation/tag-claims?limit=2&cursor=${first.nextCursor}`));
        expect(tags(second)).toEqual([['boats', 'carol']]);
        expect(second.nextCursor).toBeNull();
      });

      it('has an admin or a server moderator refuse a claim, which its user is told, and its user withdraw it', async () => {
        const { root, mod, alice, bob, carol } = await setup();
        ok(await claim(alice, 'cars'), 201);

        expect(ok(await req(mod, 'DELETE', '/tags/cars/claim'))).toEqual({ tag: 'cars', wasClaimed: true, userId: alice.userId, refused: true });
        expect(await notices(alice, 'cars')).toEqual([['tag_claim_refused', 'Your claim to moderate #cars was refused.']]);
        expect(await moderatorsOf('cars')).toEqual({ tag: 'cars', moderators: [] });
        // There is nothing left to refuse, or to grant.
        expect(ok(await req(root, 'DELETE', '/tags/cars/claim'))).toEqual({ tag: 'cars', wasClaimed: false, refused: false });
        ctx.clock.now += 25 * HOUR;
        await ctx.compact();
        expect(await moderatorsOf('cars')).toEqual({ tag: 'cars', moderators: [] });
        expect(await moderates(alice, 'cars')).toBe(false);
        expect(await notices(alice, 'cars')).toHaveLength(1);

        // The hashtag is there to claim again. Only the claim's own user withdraws it, and they are told nothing.
        ok(await claim(bob, 'cars'), 201);
        expect(await refused(req(carol, 'DELETE', '/tags/cars/claim'))).toEqual([403, 'only whoever made the claim can withdraw it, and only an admin or a server moderator can refuse it']);
        expect((await req(null, 'DELETE', '/tags/cars/claim')).statusCode).toBe(401);
        expect(ok(await req(bob, 'DELETE', '/tags/cars/claim'))).toEqual({ tag: 'cars', wasClaimed: true, userId: bob.userId, refused: false });
        expect(await notices(bob, 'cars')).toEqual([]);
        expect(ok(await req(bob, 'DELETE', '/tags/cars/claim'))).toEqual({ tag: 'cars', wasClaimed: false, refused: false });

        // An admin refuses one as a server moderator does.
        ok(await claim(carol, 'cars'), 201);
        expect(ok(await req(root, 'DELETE', '/tags/cars/claim'))).toMatchObject({ wasClaimed: true, userId: carol.userId, refused: true });
        expect((await notices(carol, 'cars')).map(([kind]) => kind)).toEqual(['tag_claim_refused']);
      });

      it('takes no claim from those who moderate every hashtag, from a banned user, or without a key', async () => {
        const { root, mod, alice } = await setup();
        const staff = 'you moderate every hashtag already, as an admin or a server moderator';
        expect(await refused(claim(root, 'cars'))).toEqual([409, staff]);
        expect(await refused(claim(mod, 'cars'))).toEqual([409, staff]);
        expect((await claim(null, 'cars')).statusCode).toBe(401);
        expect((await claim(alice, 'not-a-tag')).statusCode).toBe(400);

        ok(await req(root, 'PUT', `/banned/${alice.userId}`), 201);
        expect((await claim(alice, 'cars')).statusCode).toBe(403);
        expect(await ctx.db.selectFrom('tag_claims').selectAll().execute()).toEqual([]);
      });

      it('takes no claim where the server chooses the hashtags', async () => {
        const { alice } = await setup({ tagging: { mode: 'server', serverTags: ['news', 'cars'] } });
        expect(await refused(claim(alice, 'cars'))).toEqual([400, "this server chooses its hashtags itself, so they can't be claimed: an admin appoints their moderators"]);
        expect(await moderatorsOf('cars')).toEqual({ tag: 'cars', moderators: [] });
      });

      it('grants a claim in the next run of the compactor where there is no time to refuse it', async () => {
        const { root, alice } = await setup({ tagging: { claimReviewHours: 0 } });
        expect(ok(await claim(alice, 'cars'), 201)).toMatchObject({ claimedAt: now(), reviewUntil: now() });
        // The admins are told all the same.
        expect((await notices(root, 'cars')).map(([kind]) => kind)).toEqual(['tag_claimed']);
        expect(await moderates(alice, 'cars')).toBe(false);
        await ctx.compact();
        expect(await moderates(alice, 'cars')).toBe(true);
      });

      it('lets a user make only so many claims a day', async () => {
        const { alice, bob } = await setup({ tagging: { claimsPerDay: 2 } });
        ok(await claim(alice, 'cars'), 201);
        ok(await claim(alice, 'bikes'), 201);
        // A claim that was made already costs nothing, and neither does one that is refused for another reason.
        ok(await claim(alice, 'cars'));
        ok(await claim(bob, 'boats'), 201);
        expect((await claim(alice, 'boats')).statusCode).toBe(409);

        const over = await claim(alice, 'trains');
        expect(over.statusCode).toBe(429);
        expect(over.json().error).toMatch(/^too many claims; try again in \d+ hours?$/);
        expect(over.json().retryAfterSeconds).toBeGreaterThan(0);
        expect(over.headers['retry-after']).toBe(String(over.json().retryAfterSeconds));
        expect((await moderatorsOf('trains')).claim).toBeUndefined();
        // The limit is each user's own.
        ok(await claim(bob, 'trains'), 201);
      });

      it('grants nothing to a user who was banned while their claim waited, and ends the claim of an account that is closed', async () => {
        const { root, alice, bob } = await setup();
        ok(await claim(alice, 'cars'), 201);
        ok(await claim(bob, 'bikes'), 201);
        ok(await req(root, 'PUT', `/banned/${alice.userId}`), 201);
        ok(await req(bob, 'DELETE', `/users/${bob.userId}`));
        expect((await moderatorsOf('bikes')).claim).toBeUndefined();

        ctx.clock.now += 25 * HOUR;
        await ctx.compact();
        expect(await moderatorsOf('cars')).toEqual({ tag: 'cars', moderators: [] });
        expect(await moderatorsOf('bikes')).toEqual({ tag: 'bikes', moderators: [] });
        expect(await notices(alice, 'cars')).toEqual([['tag_claim_refused', 'Your claim to moderate #cars was refused.']]);
        expect(await ctx.db.selectFrom('tag_claims').selectAll().execute()).toEqual([]);
      });

      it('ends the claim of a user an admin appoints to the hashtag, who moderates it from then on', async () => {
        const { root, alice } = await setup();
        ok(await claim(alice, 'cars'), 201);
        ok(await req(root, 'PUT', `/tags/cars/moderators/${alice.userId}`), 201);
        expect(await moderatorsOf('cars')).toEqual({ tag: 'cars', moderators: [{ userId: alice.userId, username: 'alice', since: now() }] });
        expect(await moderates(alice, 'cars')).toBe(true);
        ctx.clock.now += 25 * HOUR;
        await ctx.compact();
        expect((await moderatorsOf('cars')).moderators).toHaveLength(1);
        expect(await notices(alice, 'cars')).toEqual([]);
      });

      it('ends the claim to a hashtag that is given another moderator meanwhile, which its user is told', async () => {
        const { root, alice, bob } = await setup();
        ok(await claim(alice, 'cars'), 201);
        ok(await req(root, 'PUT', `/tags/cars/moderators/${bob.userId}`), 201);
        const bobs = { tag: 'cars', moderators: [{ userId: bob.userId, username: 'bob', since: now() }] };
        expect(await moderatorsOf('cars')).toEqual(bobs);
        expect(await notices(alice, 'cars')).toEqual([['tag_claim_refused', 'Your claim to moderate #cars was refused.']]);

        // The hashtag has a moderator: it is claimed no more, and nothing is granted when the claim's time would have been over.
        expect((await claim(alice, 'cars')).statusCode).toBe(409);
        ctx.clock.now += 25 * HOUR;
        await ctx.compact();
        expect(await moderatorsOf('cars')).toEqual(bobs);
        expect(await moderates(alice, 'cars')).toBe(false);
      });

      it('writes down who claimed which hashtag, and who refused it', async () => {
        const { mod, alice } = await setup({ audit: true });
        ok(await claim(alice, 'cars'), 201);
        ok(await req(mod, 'DELETE', '/tags/cars/claim'));
        const records = (await readAudit(ctx)).filter((r) => r.route === '/tags/:tag/claim');
        expect(records.map((r) => [r.method, r.status, r.userId, r.params]).sort()).toEqual([
          ['DELETE', 200, mod.userId, { tag: 'cars' }],
          ['POST', 201, alice.userId, { tag: 'cars' }],
        ]);
      });
    });

    describe("a hashtag's moderators", () => {
      const NOT_THEIRS = 'only an admin or a moderator of #cars can do this';
      const JOINED_BEFORE = 'you can remove only the moderators of #cars who became one after you, and yourself';
      const appoint = (by: User | null, tag: string, u: User) => req(by, 'PUT', `/tags/${tag}/moderators/${u.userId}`);
      const remove = (by: User | null, tag: string, u: User) => req(by, 'DELETE', `/tags/${tag}/moderators/${u.userId}`);
      const names = async (tag: string) => (await moderatorsOf(tag)).moderators.map((m) => m.username);

      it("has a hashtag's moderators appoint others to it, as an admin does, and nobody else", async () => {
        const { root, mod, alice, bob, carol } = await setup();
        ok(await appoint(root, 'cars', alice), 201);
        ctx.clock.now += 1000;

        // Not a user with no role, not a server moderator, and not a moderator of another hashtag.
        ok(await appoint(root, 'trucks', carol), 201);
        expect(await refused(appoint(bob, 'cars', bob))).toEqual([403, NOT_THEIRS]);
        expect(await refused(appoint(mod, 'cars', bob))).toEqual([403, NOT_THEIRS]);
        expect(await refused(appoint(carol, 'cars', bob))).toEqual([403, NOT_THEIRS]);
        expect((await appoint(null, 'cars', bob)).statusCode).toBe(401);

        // One of its own: whoever they appoint moderates it as they do, and appoints in turn.
        const since = now();
        expect(ok(await appoint(alice, 'Cars', bob), 201)).toEqual({ tag: 'cars', userId: bob.userId, since, alreadyModerator: false });
        ctx.clock.now += 1000;
        expect(ok(await appoint(alice, 'cars', bob))).toEqual({ tag: 'cars', userId: bob.userId, since, alreadyModerator: true });
        expect(await moderates(bob, 'cars')).toBe(true);
        expect(await moderates(bob, 'trucks')).toBe(false);
        ok(await appoint(bob, 'cars', carol), 201);
        expect(await names('cars')).toEqual(['alice', 'bob', 'carol']);
        // Only to the hashtag they moderate, and only users there are.
        expect((await appoint(alice, 'trucks', bob)).statusCode).toBe(403);
        expect((await appoint(alice, 'cars', { ...bob, userId: NO_RULE })).statusCode).toBe(404);
      });

      it("has a hashtag's moderator remove those who became one after them, and themselves, and an admin anyone", async () => {
        const { root, mod, alice, bob, carol } = await setup();
        ok(await appoint(root, 'cars', alice), 201);
        ctx.clock.now += 1000;
        ok(await appoint(alice, 'cars', bob), 201);
        ctx.clock.now += 1000;
        ok(await appoint(bob, 'cars', carol), 201);

        // Nobody who was there before them: whoever a moderator brought in can't turn them out.
        expect(await refused(remove(bob, 'cars', alice))).toEqual([403, JOINED_BEFORE]);
        expect(await refused(remove(carol, 'cars', bob))).toEqual([403, JOINED_BEFORE]);
        expect(await refused(remove(mod, 'cars', carol))).toEqual([403, NOT_THEIRS]);
        expect(await names('cars')).toEqual(['alice', 'bob', 'carol']);

        // Those who came after them, whoever appointed them.
        expect(ok(await remove(alice, 'cars', carol))).toEqual({ tag: 'cars', userId: carol.userId, wasModerator: true });
        expect(ok(await remove(alice, 'cars', carol))).toEqual({ tag: 'cars', userId: carol.userId, wasModerator: false });
        expect(await moderates(carol, 'cars')).toBe(false);
        // Who is one no more removes nobody.
        expect(await refused(remove(carol, 'cars', bob))).toEqual([403, NOT_THEIRS]);

        // One who is appointed again is there since then: after those who stayed.
        ctx.clock.now += 1000;
        ok(await appoint(bob, 'cars', carol), 201);
        expect(ok(await remove(bob, 'cars', carol))).toMatchObject({ wasModerator: true });

        // Themselves, and an admin anyone. A hashtag left with no moderator can be claimed again.
        expect(ok(await remove(bob, 'cars', bob))).toMatchObject({ wasModerator: true });
        expect(await names('cars')).toEqual(['alice']);
        expect(ok(await remove(root, 'cars', alice))).toMatchObject({ wasModerator: true });
        expect(await names('cars')).toEqual([]);
        ok(await claim(bob, 'cars'), 201);
      });

      it('tells a user that they were made a moderator of a hashtag, and that they are one no more, unless they did it themselves', async () => {
        const { root, alice, bob } = await setup();
        /** A user's notices of moderating a hashtag, oldest first: the kind of each, its hashtag, and what it says. */
        const told = async (u: User) =>
          (ok(await req(u, 'GET', `/users/${u.userId}/inbox`)).inbox as { kind: string; tag?: string; text: string }[])
            .filter((m) => m.kind.startsWith('tag_moderator_'))
            .map((m) => [m.kind, m.tag, m.text])
            .reverse();
        const added = ['tag_moderator_added', 'cars', 'You were made a moderator of #cars.'];
        const removed = ['tag_moderator_removed', 'cars', 'You are no longer a moderator of #cars.'];

        // Appointed by an admin, or by one of the hashtag's moderators: once, and whoever appointed them is told nothing.
        ok(await appoint(root, 'cars', alice), 201);
        ok(await appoint(root, 'cars', alice));
        expect(await told(alice)).toEqual([added]);
        ctx.clock.now += 1000;
        ok(await appoint(alice, 'cars', bob), 201);
        expect(await told(bob)).toEqual([added]);
        expect(await told(alice)).toEqual([added]);
        expect(await told(root)).toEqual([]);

        // Removed: once.
        ctx.clock.now += 1000;
        ok(await remove(alice, 'cars', bob));
        ok(await remove(alice, 'cars', bob));
        expect(await told(bob)).toEqual([added, removed]);

        // Nobody is told of what they did themselves: one who leaves, and an admin who appoints themselves.
        ok(await remove(alice, 'cars', alice));
        expect(await told(alice)).toEqual([added]);
        ok(await appoint(root, 'cars', root), 201);
        expect(await told(root)).toEqual([]);
        // An admin's removal is told as a moderator's is.
        ctx.clock.now += 1000;
        ok(await appoint(root, 'cars', alice), 201);
        ctx.clock.now += 1000;
        ok(await remove(root, 'cars', alice));
        expect(await told(alice)).toEqual([added, added, removed]);
      });

      it('tells a user whose claim waits, and who is appointed to the hashtag, that they were made its moderator', async () => {
        const { root, alice } = await setup();
        ok(await claim(alice, 'cars'), 201);
        ok(await appoint(root, 'cars', alice), 201);
        const kinds = (ok(await req(alice, 'GET', `/users/${alice.userId}/inbox`)).inbox as { kind: string }[]).map((m) => m.kind);
        expect(kinds).toEqual(['tag_moderator_added']);
      });

      it('lets neither of two moderators appointed at the same moment remove the other', async () => {
        const { root, alice, bob } = await setup();
        ok(await appoint(root, 'cars', alice), 201);
        ok(await appoint(root, 'cars', bob), 201);
        expect(await refused(remove(alice, 'cars', bob))).toEqual([403, JOINED_BEFORE]);
        expect(await refused(remove(bob, 'cars', alice))).toEqual([403, JOINED_BEFORE]);
      });
    });

    describe("a hashtag's rules", () => {
      const rulesOf = async (tag: string, u: User | null = null) => ok(await req(u, 'GET', `/tags/${tag}/rules`)) as { tag: string; rules: Omit<Rule, 'tag'>[] };
      const texts = async (tag: string) => (await rulesOf(tag)).rules.map((r) => r.text);
      const add = async (by: User, tag: string, text: string, position?: number) =>
        ok(await req(by, 'POST', `/tags/${tag}/rules`, { text, ...(position !== undefined && { position }) }), 201) as Rule;
      /** A server where alice moderates #news. */
      const moderated = async () => {
        const users = await setup();
        ok(await req(users.root, 'PUT', `/tags/news/moderators/${users.alice.userId}`), 201);
        return users;
      };

      it("has a hashtag's moderators set its rules, which anyone reads", async () => {
        const { root, mod, alice, bob } = await moderated();
        expect(await rulesOf('news')).toEqual({ tag: 'news', rules: [] });

        const at = now();
        const first = await add(alice, 'News', '  Link to your source.  ');
        expect(first).toEqual({ tag: 'news', ruleId: expect.stringMatching(/^[0-9a-f-]{36}$/), position: 1, text: 'Link to your source.', createdAt: at, updatedAt: at });
        // Server moderators and admins moderate every hashtag, and so keep its rules too.
        const second = await add(mod, 'news', 'No rumours.');
        const third = await add(root, 'news', 'English only.');
        expect([second.position, third.position]).toEqual([2, 3]);

        const expected = { tag: 'news', rules: [first, second, third].map(({ tag: _tag, ...rule }) => rule) };
        // To anyone, with a key or without, and however the hashtag is written.
        expect(await rulesOf('news')).toEqual(expected);
        expect(await rulesOf('%23News', bob)).toEqual(expected);

        // They are the hashtag's own: not another hashtag's, and not the server's.
        expect(await rulesOf('sports')).toEqual({ tag: 'sports', rules: [] });
        expect(ok(await req(null, 'GET', '/rules')).rules).toEqual([]);
        ok(await req(root, 'POST', '/rules', { text: 'Be kind.' }), 201);
        expect(await texts('news')).toEqual(['Link to your source.', 'No rumours.', 'English only.']);
      });

      it("has only a hashtag's moderators, server moderators and admins change its rules", async () => {
        const { alice, bob } = await moderated();
        const rule = await add(alice, 'news', 'Link to your source.');
        const only = 'only an admin, a server moderator or a moderator of #news can do this';

        expect(await refused(req(bob, 'POST', '/tags/news/rules', { text: 'Anything goes.' }))).toEqual([403, only]);
        expect(await refused(req(bob, 'PATCH', `/tags/news/rules/${rule.ruleId}`, { text: 'Anything goes.' }))).toEqual([403, only]);
        expect(await refused(req(bob, 'DELETE', `/tags/news/rules/${rule.ruleId}`))).toEqual([403, only]);
        expect((await req(null, 'POST', '/tags/news/rules', { text: 'Anything goes.' })).statusCode).toBe(401);
        expect((await req(null, 'PATCH', `/tags/news/rules/${rule.ruleId}`, { text: 'Anything goes.' })).statusCode).toBe(401);
        expect((await req(null, 'DELETE', `/tags/news/rules/${rule.ruleId}`)).statusCode).toBe(401);
        // A moderator of one hashtag has no say over another's rules.
        expect(await refused(req(alice, 'POST', '/tags/sports/rules', { text: 'Anything goes.' }))).toEqual([403, 'only an admin, a server moderator or a moderator of #sports can do this']);
        expect(await texts('news')).toEqual(['Link to your source.']);
        expect(await texts('sports')).toEqual([]);
      });

      it('has a user whose claim to a hashtag went through set its rules', async () => {
        const { alice } = await setup();
        ok(await req(alice, 'POST', '/tags/cars/claim'), 201);
        expect((await req(alice, 'POST', '/tags/cars/rules', { text: 'Cars only.' })).statusCode).toBe(403);
        ctx.clock.now += 25 * HOUR;
        await ctx.compact();
        expect(await add(alice, 'cars', 'Cars only.')).toMatchObject({ tag: 'cars', position: 1, text: 'Cars only.' });
        expect(await texts('cars')).toEqual(['Cars only.']);
      });

      it("adds a rule at the end or at a place, changes its text or its place, and removes it, as the server's rules are kept", async () => {
        const { root, alice } = await moderated();
        ok(await req(root, 'PUT', `/tags/sports/moderators/${alice.userId}`), 201);
        const created = now();
        const b = await add(alice, 'news', 'B');
        const d = await add(alice, 'news', 'D');
        const a = await add(alice, 'news', 'A', 1);
        expect(await add(alice, 'news', 'C', 3)).toMatchObject({ position: 3 });
        expect(await add(alice, 'news', 'E', 99)).toMatchObject({ position: 5 });
        expect(await texts('news')).toEqual(['A', 'B', 'C', 'D', 'E']);
        for (const payload of [{}, { text: '' }, { text: '   ' }, { text: 'x'.repeat(MAX_RULE_CHARS + 1) }, { text: 'F', position: 0 }, { text: 'F', position: 'first' }]) {
          expect((await req(alice, 'POST', '/tags/news/rules', payload)).statusCode, JSON.stringify(payload).slice(0, 60)).toBe(400);
        }

        const patch = (rule: Rule, payload: Record<string, unknown>, tag = 'news') => req(alice, 'PATCH', `/tags/${tag}/rules/${rule.ruleId}`, payload);
        ctx.clock.now += 60_000;
        expect(ok(await patch(b, { text: ' B, reworded ' }))).toEqual({ ...b, position: 2, text: 'B, reworded', updatedAt: now() });
        expect(ok(await patch(a, { position: 4 }))).toEqual({ ...a, position: 4, updatedAt: now() });
        expect(await texts('news')).toEqual(['B, reworded', 'C', 'D', 'A', 'E']);
        expect(ok(await patch(d, { position: 50, text: 'D, last' }))).toMatchObject({ position: 5, text: 'D, last' });
        expect(await texts('news')).toEqual(['B, reworded', 'C', 'A', 'E', 'D, last']);
        // A rule that only moved because another did hasn't changed, and neither has one told to be what it is.
        const c = (await rulesOf('news')).rules[1]!;
        expect(c).toMatchObject({ text: 'C', position: 2, updatedAt: created });
        expect(ok(await req(alice, 'PATCH', `/tags/news/rules/${c.ruleId}`, { text: 'C', position: 2 }))).toMatchObject({ updatedAt: created });
        expect(await refused(patch(b, {}))).toEqual([400, 'nothing to update: provide text or position']);
        expect(await refused(req(alice, 'PATCH', `/tags/news/rules/${NO_RULE}`, { text: 'Nothing.' }))).toEqual([404, 'rule not found']);

        // A rule is its hashtag's: under another hashtag's address it isn't there, to its moderator either.
        const other = await add(alice, 'sports', 'Scores in the title.');
        expect(await refused(patch(b, { text: 'Moved in' }, 'sports'))).toEqual([404, 'rule not found']);
        expect(ok(await req(alice, 'DELETE', `/tags/sports/rules/${b.ruleId}`))).toEqual({ tag: 'sports', ruleId: b.ruleId, wasThere: false });
        expect(await texts('sports')).toEqual(['Scores in the title.']);
        expect(await texts('news')).toHaveLength(5);

        expect(ok(await req(alice, 'DELETE', `/tags/news/rules/${b.ruleId}`))).toEqual({ tag: 'news', ruleId: b.ruleId, wasThere: true });
        expect(ok(await req(alice, 'DELETE', `/tags/news/rules/${b.ruleId}`))).toEqual({ tag: 'news', ruleId: b.ruleId, wasThere: false });
        expect((await rulesOf('news')).rules.map((r) => [r.position, r.text])).toEqual([[1, 'C'], [2, 'A'], [3, 'E'], [4, 'D, last']]);
        // The other hashtag's rules were left as they were all along.
        expect((await rulesOf('sports')).rules).toMatchObject([{ ruleId: other.ruleId, position: 1 }]);
      });

      it(`has at most ${MAX_RULES} rules for a hashtag, whatever the others have`, async () => {
        const { root, alice } = await moderated();
        for (let n = 1; n <= MAX_RULES; n++) await add(alice, 'news', `Rule ${n}`);
        expect(await refused(req(alice, 'POST', '/tags/news/rules', { text: 'One too many.' }))).toEqual([409, `a hashtag can have at most ${MAX_RULES} rules: remove one first`]);
        expect(await add(root, 'sports', 'Room here.')).toMatchObject({ position: 1 });
        const { rules } = await rulesOf('news');
        ok(await req(alice, 'DELETE', `/tags/news/rules/${rules[0]!.ruleId}`));
        expect(await add(alice, 'news', 'Room for one.')).toMatchObject({ position: MAX_RULES });
      });
    });

    describe("a post's record of what moderators did to it", () => {
      const read = async (contentId: string, u: User | null = null) => ok(await req(u, 'GET', `/content/${contentId}`)) as { tags: string[]; moderation?: Action[] };
      const rows = (contentId: string) =>
        ctx.db.selectFrom('tag_moderation_log').select(['tag', 'decision', 'moderator_id', 'moderator_role', 'reason']).where('content_id', '=', contentId).orderBy('created_at').execute();

      it('says on the post which hashtag a moderator approved it under or removed from it, as what, when and why', async () => {
        const { root, mod, alice, bob } = await setup();
        ok(await req(root, 'PUT', `/tags/cars/moderators/${bob.userId}`), 201);
        const contentId = await post(alice, 'A boat, mostly #cars #news #boats');
        expect(await read(contentId)).not.toHaveProperty('moderation');

        ctx.clock.now += 1000;
        const approvedAt = now();
        ok(await req(bob, 'PUT', `/content/${contentId}/tags/cars`), 201);
        const approved: Action = { action: 'tag_approved', tag: 'cars', by: 'tag_moderator', at: approvedAt, text: 'This post was approved under #cars by a moderator of the hashtag.' };
        expect((await read(contentId)).moderation).toEqual([approved]);
        // An approval that was there already isn't one more thing that happened.
        ctx.clock.now += 1000;
        expect(ok(await req(bob, 'PUT', `/content/${contentId}/tags/cars`))).toMatchObject({ alreadyApproved: true });
        expect((await read(contentId)).moderation).toEqual([approved]);

        // The same moderator thinks again, and says why. The response is what it always was.
        ctx.clock.now += 1000;
        const removedAt = now();
        expect(ok(await req(bob, 'DELETE', `/content/${contentId}/tags/cars`, { reason: '  it has no cars in it  ' }))).toEqual({ contentId, tag: 'cars', tags: ['news', 'boats'], muted: false });
        const removed: Action = {
          action: 'tag_removed',
          tag: 'cars',
          by: 'tag_moderator',
          reason: 'it has no cars in it',
          at: removedAt,
          text: '#cars was removed from this post by a moderator of the hashtag: it has no cars in it',
        };
        expect((await read(contentId)).moderation).toEqual([approved, removed]);

        // A server moderator and an admin are named as what they are, and a removal needs no reason.
        ctx.clock.now += 1000;
        const byMod: Action = { action: 'tag_removed', tag: 'news', by: 'server_moderator', at: now(), text: '#news was removed from this post by a server moderator.' };
        ok(await req(mod, 'DELETE', `/content/${contentId}/tags/news`));
        ctx.clock.now += 1000;
        const byAdmin: Action = { action: 'tag_removed', tag: 'boats', by: 'admin', reason: 'Not a boat either.', at: now(), text: '#boats was removed from this post by an admin: Not a boat either.' };
        ok(await req(root, 'DELETE', `/content/${contentId}/tags/boats`, { reason: 'Not a boat either.', mute: true }));
        const all = [approved, removed, byMod, byAdmin];

        // To anyone who reads the post: its publisher, another user, and someone with no key. Nobody is told who.
        expect((await read(contentId)).moderation).toEqual(all);
        expect((await read(contentId, alice)).moderation).toEqual(all);
        expect((await read(contentId, bob)).moderation).toEqual(all);
        expect(JSON.stringify((await read(contentId)).moderation)).not.toContain(bob.userId);
        // The row says who, for the server's own record.
        expect(await rows(contentId)).toEqual([
          { tag: 'cars', decision: 'approved', moderator_id: bob.userId, moderator_role: 'tag_moderator', reason: null },
          { tag: 'cars', decision: 'removed', moderator_id: bob.userId, moderator_role: 'tag_moderator', reason: 'it has no cars in it' },
          { tag: 'news', decision: 'removed', moderator_id: mod.userId, moderator_role: 'server_moderator', reason: null },
          { tag: 'boats', decision: 'removed', moderator_id: root.userId, moderator_role: 'admin', reason: 'Not a boat either.' },
        ]);

        // It stays as it is once the compactor has taken the hashtags off the post.
        await ctx.compact();
        const after = await read(contentId);
        expect(after.tags).toEqual([]);
        expect(after.moderation).toEqual(all);
      });

      it('takes a reason of a few words, and none that is empty or too long', async () => {
        const { root, alice } = await setup();
        const contentId = await post(alice, 'Something #news');
        for (const reason of ['', '   ', 'x'.repeat(MAX_REASON_CHARS + 1), 7]) {
          expect((await req(root, 'DELETE', `/content/${contentId}/tags/news`, { reason })).statusCode, String(reason).slice(0, 20)).toBe(400);
        }
        expect(await read(contentId)).not.toHaveProperty('moderation');
        ok(await req(root, 'DELETE', `/content/${contentId}/tags/news`, { reason: 'x'.repeat(MAX_REASON_CHARS) }));
        expect((await read(contentId)).moderation).toMatchObject([{ action: 'tag_removed', reason: 'x'.repeat(MAX_REASON_CHARS) }]);
      });

      it('writes nothing down for a decision that was refused', async () => {
        const { root, alice, bob } = await setup();
        const contentId = await post(alice, 'Something #news');
        expect((await req(bob, 'DELETE', `/content/${contentId}/tags/news`, { reason: 'I say so.' })).statusCode).toBe(403);
        expect((await req(bob, 'PUT', `/content/${contentId}/tags/news`)).statusCode).toBe(403);
        expect((await req(root, 'DELETE', `/content/${contentId}/tags/sports`, { reason: 'Not sports.' })).statusCode).toBe(404);
        expect((await req(root, 'PUT', `/content/${contentId}/tags/sports`)).statusCode).toBe(404);
        expect(await read(contentId)).not.toHaveProperty('moderation');
        expect(await rows(contentId)).toEqual([]);
      });

      it('keeps the record when the moderator is gone, and deletes it with the post', async () => {
        const { root, alice, bob } = await setup();
        ok(await req(root, 'PUT', `/tags/news/moderators/${bob.userId}`), 201);
        const contentId = await post(alice, 'Something #news #sports');
        const other = await post(alice, 'Something else #news');
        ok(await req(bob, 'DELETE', `/content/${contentId}/tags/news`, { reason: 'Old news.' }));
        ok(await req(bob, 'PUT', `/content/${other}/tags/news`), 201);

        ok(await req(bob, 'DELETE', `/users/${bob.userId}`));
        await ctx.compact();
        expect(await ctx.db.selectFrom('users').select('id').where('id', '=', bob.userId).execute()).toEqual([]);
        expect((await read(contentId)).moderation).toMatchObject([{ action: 'tag_removed', tag: 'news', by: 'tag_moderator', reason: 'Old news.' }]);
        expect(await rows(contentId)).toMatchObject([{ moderator_id: null, moderator_role: 'tag_moderator' }]);

        ok(await req(alice, 'DELETE', `/content/${contentId}`), 202);
        for (let i = 0; i < 3; i++) await ctx.compact();
        expect((await req(null, 'GET', `/content/${contentId}`)).statusCode).toBe(404);
        expect(await rows(contentId)).toEqual([]);
        expect(await rows(other)).toHaveLength(1);
      });
    });
  });
}

describe('the settings of claims', () => {
  const tagging = (env: Record<string, string>, overrides = {}) => loadConfig(overrides, { EVIEVERSE_CONFIG: '/nonexistent.json', ...env }).tagging;

  it('gives a claim a day to be refused, and a user five claims a day, unless told otherwise', () => {
    expect(tagging({})).toMatchObject({ mode: 'user', claimReviewHours: 24, claimsPerDay: 5 });
    expect(tagging({ TAG_CLAIM_REVIEW_HOURS: '72', TAG_CLAIMS_PER_DAY: '1' })).toMatchObject({ claimReviewHours: 72, claimsPerDay: 1 });
    expect(tagging({ TAG_CLAIM_REVIEW_HOURS: '0', TAG_CLAIMS_PER_DAY: '0' })).toMatchObject({ claimReviewHours: 0, claimsPerDay: 0 });
    expect(tagging({}, { tagging: { claimReviewHours: 1 } })).toMatchObject({ claimReviewHours: 1, claimsPerDay: 5 });
    for (const bad of ['-1', '1.5', 'soon']) {
      expect(() => tagging({ TAG_CLAIM_REVIEW_HOURS: bad }), bad).toThrow();
      expect(() => tagging({ TAG_CLAIMS_PER_DAY: bad }), bad).toThrow();
    }
  });
});
