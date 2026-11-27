import { readFileSync } from 'node:fs';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_GEN_AI, DEFAULT_POST_TITLES, DEFAULT_SUPPORT_EMAIL, GEN_AI_SETTINGS, loadConfig, MAX_MINIMUM_AGE, POST_TITLES_SETTINGS } from '../src/config.js';
import { loadLanguages } from '../src/language.js';
import { setAdmin } from '../src/moderation/policy.js';
import { POST_TYPES } from '../src/posts.js';
import { RELEASE } from '../src/release.js';
import { MAX_RULE_CHARS, MAX_RULES } from '../src/routes/rules.js';
import { as, BASE_ENV, createTestContext, readAudit, TARGETS, type TestContext, type User } from './helpers.js';

const NO_RULE = '00000000-0000-4000-8000-000000000000';
const ADMIN_ONLY = 'only an admin can do this';
const SOURCE = 'https://git.example.com/our-evieverse';
const SUPPORT = 'support@our-evieverse.example';
/** What a server that runs a release says of itself, as every server does unless it is told otherwise. */
const AS_RELEASED = { modified: false, release: RELEASE, sourceUrl: null };
/** What a server says its minimum age is where its operator set none, as every server does unless it is told otherwise. */
const ALL_AGES = 'All Legal Ages Allowed';
/** What the tests' server does with post titles unless a test says otherwise (see createTestContext): not the server's default. */
const TEST_TITLES = 'on_optional';
/** The types of post a server says it takes where its operator turned none off, as every server does unless it is told otherwise: all five, in the order of POST_TYPES. */
const ALL_TYPES = ['image', 'video', 'audio', 'text', 'link'];

type Rule = { ruleId: string; position: number; text: string; createdAt: string; updatedAt: string };
type Rules = {
  modificationDisclosure: { modified: boolean; release: string; sourceUrl: string | null };
  supportEmail: string;
  minimumAge: number | string;
  genAi: string;
  postTitles: string;
  postTypes: string[];
  postCount: number;
  rules: Rule[];
};

for (const target of TARGETS) {
  describe(`rules (${target.name})`, () => {
    let ctx: TestContext;
    afterEach(() => ctx.close());

    const req = (u: User | null, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
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
    const now = () => new Date(ctx.clock.now).toISOString();
    /** A server with an admin, and someone who isn't one. */
    const setup = async (opts: Parameters<typeof createTestContext>[1] = {}) => {
      ctx = await createTestContext(target, opts);
      const root = await ctx.register('root');
      await setAdmin(ctx.db, 'root', true);
      return { root, alice: await ctx.register('alice') };
    };
    /** What anyone is given, without a key. */
    const published = async () => ok(await req(null, 'GET', '/rules')) as Rules;
    /** The rules' texts, in their order. */
    const texts = async () => (await published()).rules.map((r) => r.text);
    const add = async (by: User, text: string, position?: number) => ok(await req(by, 'POST', '/rules', { text, ...(position !== undefined && { position }) }), 201) as Rule;

    it('gives the rules and the modification disclosure to anyone, with a key or without', async () => {
      const { root, alice } = await setup();
      expect(await published()).toEqual({ modificationDisclosure: AS_RELEASED, supportEmail: DEFAULT_SUPPORT_EMAIL, minimumAge: ALL_AGES, genAi: DEFAULT_GEN_AI, postTitles: TEST_TITLES, postTypes: ALL_TYPES, postCount: 0, rules: [] });

      const at = now();
      const first = await add(root, '  Be kind.  ');
      expect(first).toEqual({ ruleId: expect.stringMatching(/^[0-9a-f-]{36}$/), position: 1, text: 'Be kind.', createdAt: at, updatedAt: at });
      const second = await add(root, 'No spam.\nNot even a little.');
      expect(second).toMatchObject({ position: 2, text: 'No spam.\nNot even a little.' });

      const expected = { modificationDisclosure: AS_RELEASED, supportEmail: DEFAULT_SUPPORT_EMAIL, minimumAge: ALL_AGES, genAi: DEFAULT_GEN_AI, postTitles: TEST_TITLES, postTypes: ALL_TYPES, postCount: 0, rules: [first, second] };
      expect(await published()).toEqual(expected);
      expect(ok(await req(alice, 'GET', '/rules'))).toEqual(expected);
      // The body's credentials are as good as the headers', as on every route.
      expect(ok(await ctx.app.inject({ method: 'POST', url: '/rules', payload: { ...root, text: 'Third.' } }), 201)).toMatchObject({ position: 3 });
    });

    it('says it runs a modified version, the release that is based on and where its source is, on a server whose operator says so', async () => {
      const { root } = await setup({ modified: true, sourceUrl: SOURCE });
      const modificationDisclosure = { modified: true, release: RELEASE, sourceUrl: SOURCE };
      expect(await published()).toEqual({ modificationDisclosure, supportEmail: DEFAULT_SUPPORT_EMAIL, minimumAge: ALL_AGES, genAi: DEFAULT_GEN_AI, postTitles: TEST_TITLES, postTypes: ALL_TYPES, postCount: 0, rules: [] });
      const rule = await add(root, 'Be kind.');
      expect(await published()).toEqual({ modificationDisclosure, supportEmail: DEFAULT_SUPPORT_EMAIL, minimumAge: ALL_AGES, genAi: DEFAULT_GEN_AI, postTitles: TEST_TITLES, postTypes: ALL_TYPES, postCount: 0, rules: [rule] });
      // No request changes it: not an admin's, and not one that names it.
      ok(await req(root, 'PATCH', `/rules/${rule.ruleId}`, { text: 'Be kinder.', modified: false, modificationDisclosure: AS_RELEASED }));
      expect((await published()).modificationDisclosure).toEqual(modificationDisclosure);
    });

    it('says where its source is on a server that runs a release, if its operator says', async () => {
      await setup({ sourceUrl: SOURCE });
      expect(await published()).toEqual({ modificationDisclosure: { ...AS_RELEASED, sourceUrl: SOURCE }, supportEmail: DEFAULT_SUPPORT_EMAIL, minimumAge: ALL_AGES, genAi: DEFAULT_GEN_AI, postTitles: TEST_TITLES, postTypes: ALL_TYPES, postCount: 0, rules: [] });
    });

    it('gives the address to write to for support: the one its operator set, and a placeholder until they do', async () => {
      await setup();
      expect((await published()).supportEmail).toBe('noreply@yoururl.com');
      await ctx.close();

      const { root, alice } = await setup({ supportEmail: SUPPORT });
      expect((await published()).supportEmail).toBe(SUPPORT);
      expect(ok(await req(alice, 'GET', '/rules')).supportEmail).toBe(SUPPORT);
      // No request changes it: not an admin's, and not one that names it.
      const rule = await add(root, 'Be kind.');
      ok(await req(root, 'PATCH', `/rules/${rule.ruleId}`, { text: 'Be kinder.', supportEmail: 'someone@else.example' }));
      expect((await published()).supportEmail).toBe(SUPPORT);
    });

    it('gives the minimum age its operator set, as a number of years, and says that all legal ages are allowed until they set one', async () => {
      await setup();
      expect((await published()).minimumAge).toBe('All Legal Ages Allowed');
      await ctx.close();

      const { root, alice } = await setup({ minimumAge: 13 });
      expect((await published()).minimumAge).toBe(13);
      expect(ok(await req(alice, 'GET', '/rules')).minimumAge).toBe(13);
      // It comes with the rest, and beside the rules, not among them.
      const rule = await add(root, 'Be kind.');
      expect(await published()).toEqual({ modificationDisclosure: AS_RELEASED, supportEmail: DEFAULT_SUPPORT_EMAIL, minimumAge: 13, genAi: DEFAULT_GEN_AI, postTitles: TEST_TITLES, postTypes: ALL_TYPES, postCount: 0, rules: [rule] });
      // No request changes it: not an admin's, and not one that names it.
      ok(await req(root, 'PATCH', `/rules/${rule.ruleId}`, { text: 'Be kinder.', minimumAge: 21 }));
      ok(await req(root, 'POST', '/rules', { text: 'Be older.', minimumAge: 21 }), 201);
      expect((await published()).minimumAge).toBe(13);
    });

    it('says that all legal ages are allowed in the language the request asks for, and a minimum age as the same number in any', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'evieverse-languages-'));
      try {
        await copyFile(fileURLToPath(new URL('../languages/en.json', import.meta.url)), join(dir, 'en.json'));
        await writeFile(join(dir, 'es.json'), JSON.stringify({ name: 'Español', messages: { 'rule.all_ages': 'Se permiten todas las edades legales' } }));
        const inSpanish = async () => (await ctx.app.inject({ method: 'GET', url: '/rules', headers: { 'accept-language': 'es-MX, en;q=0.5' } })).json() as Rules;

        await setup({ languages: loadLanguages('en', dir) });
        expect((await inSpanish()).minimumAge).toBe('Se permiten todas las edades legales');
        expect((await published()).minimumAge).toBe(ALL_AGES);
        // A language the server doesn't speak is answered in its default one.
        expect(ok(await ctx.app.inject({ method: 'GET', url: '/rules', headers: { 'accept-language': 'fr' } })).minimumAge).toBe(ALL_AGES);
        await ctx.close();

        await setup({ languages: loadLanguages('en', dir), minimumAge: 16 });
        expect((await inSpanish()).minimumAge).toBe(16);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('says what its operator set of generative AI, and that it is allowed with no word needed of it until they set something', async () => {
      await setup();
      expect((await published()).genAi).toBe('disclosure_optional');

      for (const genAi of GEN_AI_SETTINGS) {
        await ctx.close();
        const { root, alice } = await setup({ genAi });
        expect((await published()).genAi).toBe(genAi);
        expect(ok(await req(alice, 'GET', '/rules')).genAi).toBe(genAi);
        // The setting as it is written, whatever language the request asks for.
        expect(ok(await ctx.app.inject({ method: 'GET', url: '/rules', headers: { 'accept-language': 'es-MX' } })).genAi).toBe(genAi);
        // It comes with the rest, and beside the rules, not among them.
        const rule = await add(root, 'Be kind.');
        expect(await published()).toEqual({ modificationDisclosure: AS_RELEASED, supportEmail: DEFAULT_SUPPORT_EMAIL, minimumAge: ALL_AGES, genAi, postTitles: TEST_TITLES, postTypes: ALL_TYPES, postCount: 0, rules: [rule] });
        // No request changes it: not an admin's, and not one that names it.
        ok(await req(root, 'PATCH', `/rules/${rule.ruleId}`, { text: 'Be kinder.', genAi: 'not_allowed' }));
        ok(await req(root, 'POST', '/rules', { text: 'Be human.', genAi: 'disclosure_optional' }), 201);
        expect((await published()).genAi).toBe(genAi);
      }
    });

    it('says what its operator set of post titles: whether a post has one, and whether it has to', async () => {
      for (const postTitles of POST_TITLES_SETTINGS) {
        const { root, alice } = await setup({ postTitles });
        expect((await published()).postTitles).toBe(postTitles);
        expect(ok(await req(alice, 'GET', '/rules')).postTitles).toBe(postTitles);
        // The setting as it is written, whatever language the request asks for.
        expect(ok(await ctx.app.inject({ method: 'GET', url: '/rules', headers: { 'accept-language': 'es-MX' } })).postTitles).toBe(postTitles);
        // It comes with the rest, and beside the rules, not among them.
        const rule = await add(root, 'Be kind.');
        expect(await published()).toEqual({ modificationDisclosure: AS_RELEASED, supportEmail: DEFAULT_SUPPORT_EMAIL, minimumAge: ALL_AGES, genAi: DEFAULT_GEN_AI, postTitles, postTypes: ALL_TYPES, postCount: 0, rules: [rule] });
        // No request changes it: not an admin's, and not one that names it.
        ok(await req(root, 'PATCH', `/rules/${rule.ruleId}`, { text: 'Be kinder.', postTitles: 'off' }));
        ok(await req(root, 'POST', '/rules', { text: 'Be brief.', postTitles: 'on_required' }), 201);
        expect((await published()).postTitles).toBe(postTitles);
        await ctx.close();
      }
      // The last one stays open for the test's end to close.
      await setup();
    });

    it('says which types of post it takes: all five, or the ones its operator left on', async () => {
      await setup();
      expect((await published()).postTypes).toEqual(['image', 'video', 'audio', 'text', 'link']);
      expect((await published()).postTypes).toEqual([...POST_TYPES]);
      await ctx.close();

      // A server of pictures and links.
      const taken = ['image', 'link'];
      const { root, alice } = await setup({ postTypes: { text: false, video: false, audio: false } });
      expect((await published()).postTypes).toEqual(taken);
      expect(ok(await req(alice, 'GET', '/rules')).postTypes).toEqual(taken);
      // The types as a post names its own, whatever language the request asks for.
      expect(ok(await ctx.app.inject({ method: 'GET', url: '/rules', headers: { 'accept-language': 'es-MX' } })).postTypes).toEqual(taken);
      // It comes with the rest, and beside the rules, not among them.
      const rule = await add(root, 'Be kind.');
      expect(await published()).toEqual({ modificationDisclosure: AS_RELEASED, supportEmail: DEFAULT_SUPPORT_EMAIL, minimumAge: ALL_AGES, genAi: DEFAULT_GEN_AI, postTitles: TEST_TITLES, postTypes: taken, postCount: 0, rules: [rule] });
      // No request changes it: not an admin's, and not one that names it.
      ok(await req(root, 'PATCH', `/rules/${rule.ruleId}`, { text: 'Be kinder.', postTypes: ['text'] }));
      ok(await req(root, 'POST', '/rules', { text: 'Be seen.', postTypes: { video: true } }), 201);
      expect((await published()).postTypes).toEqual(taken);

      // They are the types POST /store goes by: a post of one that is left out is refused for its type, in words that list
      // the same ones, and a post of one that is listed isn't. These have neither a file nor the fields of their type, so
      // the ones that get past the type are refused for something else.
      for (const type of POST_TYPES) {
        const res = await req(alice, 'POST', '/store', { type, tags: ['news'] });
        const typeOff = `this server doesn't take ${type} posts: the types it takes are ${taken.join(', ')}`;
        if (taken.includes(type)) expect(res.json().error, type).not.toBe(typeOff);
        else expect([res.statusCode, res.json().error], type).toEqual([400, typeOff]);
      }
    });

    it('has only an admin add, change and remove rules', async () => {
      const { root, alice } = await setup();
      const rule = await add(root, 'Be kind.');

      expect(await refused(req(alice, 'POST', '/rules', { text: 'Anything goes.' }))).toEqual([403, ADMIN_ONLY]);
      expect(await refused(req(alice, 'PATCH', `/rules/${rule.ruleId}`, { text: 'Anything goes.' }))).toEqual([403, ADMIN_ONLY]);
      expect(await refused(req(alice, 'DELETE', `/rules/${rule.ruleId}`))).toEqual([403, ADMIN_ONLY]);
      expect((await req(null, 'POST', '/rules', { text: 'Anything goes.' })).statusCode).toBe(401);
      expect((await req(null, 'PATCH', `/rules/${rule.ruleId}`, { text: 'Anything goes.' })).statusCode).toBe(401);
      expect((await req(null, 'DELETE', `/rules/${rule.ruleId}`)).statusCode).toBe(401);
      // A server moderator isn't an admin.
      ok(await ctx.app.inject({ method: 'PUT', url: `/moderators/${alice.userId}`, headers: as(root) }), 201);
      expect(await refused(req(alice, 'POST', '/rules', { text: 'Anything goes.' }))).toEqual([403, ADMIN_ONLY]);

      expect((await published()).rules).toEqual([rule]);
    });

    it('adds a rule at the end, or at the place it is given', async () => {
      const { root } = await setup();
      await add(root, 'B');
      await add(root, 'D');
      expect(await add(root, 'A', 1)).toMatchObject({ position: 1 });
      expect(await add(root, 'C', 3)).toMatchObject({ position: 3 });
      // One past the last, and anything beyond it, is the end.
      expect(await add(root, 'E', 5)).toMatchObject({ position: 5 });
      expect(await add(root, 'F', 99)).toMatchObject({ position: 6 });
      expect(await add(root, 'G', '7' as unknown as number)).toMatchObject({ position: 7 });
      expect((await published()).rules.map((r) => [r.position, r.text])).toEqual([[1, 'A'], [2, 'B'], [3, 'C'], [4, 'D'], [5, 'E'], [6, 'F'], [7, 'G']]);

      for (const payload of [{}, { text: '' }, { text: '   ' }, { text: 'x'.repeat(MAX_RULE_CHARS + 1) }, { text: 'H', position: 0 }, { text: 'H', position: 1.5 }, { text: 'H', position: 'first' }]) {
        expect((await req(root, 'POST', '/rules', payload)).statusCode, JSON.stringify(payload).slice(0, 60)).toBe(400);
      }
      expect(await add(root, 'x'.repeat(MAX_RULE_CHARS))).toMatchObject({ position: 8 });
      expect(await texts()).toHaveLength(8);
    });

    it("changes a rule's text, its place, or both, and says when it last changed", async () => {
      const { root } = await setup();
      const created = now();
      const [a, b, c, d] = [await add(root, 'A'), await add(root, 'B'), await add(root, 'C'), await add(root, 'D')];
      const patch = (rule: Rule, payload: Record<string, unknown>) => req(root, 'PATCH', `/rules/${rule.ruleId}`, payload);

      ctx.clock.now += 60_000;
      const edited = now();
      expect(ok(await patch(b, { text: ' B, reworded ' }))).toEqual({ ...b, text: 'B, reworded', updatedAt: edited });
      expect(await texts()).toEqual(['A', 'B, reworded', 'C', 'D']);

      // Down the list, up it, and to the end from anywhere past it. The rules between move by one.
      ctx.clock.now += 60_000;
      expect(ok(await patch(a, { position: 3 }))).toEqual({ ...a, position: 3, updatedAt: now() });
      expect(await texts()).toEqual(['B, reworded', 'C', 'A', 'D']);
      expect(ok(await patch(d, { position: 1 }))).toMatchObject({ position: 1, text: 'D' });
      expect(await texts()).toEqual(['D', 'B, reworded', 'C', 'A']);
      expect(ok(await patch(d, { position: 50, text: 'D, last' }))).toMatchObject({ position: 4, text: 'D, last' });
      expect(await texts()).toEqual(['B, reworded', 'C', 'A', 'D, last']);
      expect((await published()).rules.map((r) => r.position)).toEqual([1, 2, 3, 4]);

      // A rule that only moved because another did hasn't changed, and neither has one told to be what it is.
      ctx.clock.now += 60_000;
      expect((await published()).rules.find((r) => r.ruleId === c.ruleId)).toEqual({ ...c, position: 2, updatedAt: created });
      expect(ok(await patch(c, { text: 'C', position: 2 }))).toEqual({ ...c, position: 2, updatedAt: created });
      expect(ok(await patch(b, { position: 1 }))).toMatchObject({ position: 1, updatedAt: edited });

      expect(await refused(patch(c, {}))).toEqual([400, 'nothing to update: provide text or position']);
      for (const payload of [{ text: '' }, { text: 'x'.repeat(MAX_RULE_CHARS + 1) }, { position: 0 }, { position: -1 }, { position: 'last' }]) {
        expect((await patch(c, payload)).statusCode, JSON.stringify(payload).slice(0, 60)).toBe(400);
      }
      expect(await refused(req(root, 'PATCH', `/rules/${NO_RULE}`, { text: 'Nothing.' }))).toEqual([404, 'rule not found']);
      expect((await req(root, 'PATCH', '/rules/not-a-rule', { text: 'Nothing.' })).statusCode).toBe(400);
      expect(await texts()).toEqual(['B, reworded', 'C', 'A', 'D, last']);
    });

    it('removes a rule, and the ones after it move up', async () => {
      const { root } = await setup();
      const [a, b, c] = [await add(root, 'A'), await add(root, 'B'), await add(root, 'C')];

      expect(ok(await req(root, 'DELETE', `/rules/${b.ruleId}`))).toEqual({ ruleId: b.ruleId, wasThere: true });
      expect((await published()).rules).toEqual([a, { ...c, position: 2 }]);
      expect(ok(await req(root, 'DELETE', `/rules/${b.ruleId}`))).toEqual({ ruleId: b.ruleId, wasThere: false });
      expect(ok(await req(root, 'DELETE', `/rules/${NO_RULE}`))).toEqual({ ruleId: NO_RULE, wasThere: false });
      expect((await req(root, 'DELETE', '/rules/not-a-rule')).statusCode).toBe(400);
      expect(await refused(req(root, 'PATCH', `/rules/${b.ruleId}`, { text: 'B again' }))).toEqual([404, 'rule not found']);

      // The place a removed rule left is the next one's to take.
      expect(await add(root, 'D')).toMatchObject({ position: 3 });
      expect(await add(root, 'E', 2)).toMatchObject({ position: 2 });
      expect(await texts()).toEqual(['A', 'E', 'C', 'D']);
      for (const rule of (await published()).rules) ok(await req(root, 'DELETE', `/rules/${rule.ruleId}`));
      expect(await published()).toEqual({ modificationDisclosure: AS_RELEASED, supportEmail: DEFAULT_SUPPORT_EMAIL, minimumAge: ALL_AGES, genAi: DEFAULT_GEN_AI, postTitles: TEST_TITLES, postTypes: ALL_TYPES, postCount: 0, rules: [] });
    });

    it(`has at most ${MAX_RULES} rules`, async () => {
      const { root } = await setup();
      for (let n = 1; n <= MAX_RULES; n++) await add(root, `Rule ${n}`);
      expect(await refused(req(root, 'POST', '/rules', { text: 'One too many.' }))).toEqual([409, `the server can have at most ${MAX_RULES} rules: remove one first`]);
      expect(await refused(req(root, 'POST', '/rules', { text: 'One too many.', position: 1 }))).toEqual([409, `the server can have at most ${MAX_RULES} rules: remove one first`]);

      const { rules } = await published();
      expect(rules).toHaveLength(MAX_RULES);
      expect(rules.map((r) => r.position)).toEqual(rules.map((_, i) => i + 1));
      // A full list can still be reordered, and has room again once a rule is removed.
      ok(await req(root, 'PATCH', `/rules/${rules[MAX_RULES - 1]!.ruleId}`, { position: 1 }));
      expect((await texts()).slice(0, 2)).toEqual([`Rule ${MAX_RULES}`, 'Rule 1']);
      ok(await req(root, 'DELETE', `/rules/${rules[0]!.ruleId}`));
      expect(await add(root, 'Room for one.')).toMatchObject({ position: MAX_RULES });
    });

    it('writes down who changed the rules, and which', async () => {
      const { root, alice } = await setup({ audit: true });
      const rule = await add(root, 'Be kind.');
      ok(await req(root, 'PATCH', `/rules/${rule.ruleId}`, { text: 'Be kinder.' }));
      await req(alice, 'POST', '/rules', { text: 'Anything goes.' });
      await published();
      ok(await req(root, 'DELETE', `/rules/${rule.ruleId}`));

      // The changes that went through, and neither the one that was refused nor the read. The log's order is not theirs.
      const records = (await readAudit(ctx)).filter((r) => r.route?.startsWith('/rules'));
      expect(records.map((r) => [r.method, r.route, r.status, r.userId, r.result]).sort()).toEqual([
        ['DELETE', '/rules/:ruleId', 200, root.userId, { ruleId: rule.ruleId }],
        ['PATCH', '/rules/:ruleId', 200, root.userId, { ruleId: rule.ruleId }],
        ['POST', '/rules', 201, root.userId, { ruleId: rule.ruleId }],
      ]);
      expect(records.find((r) => r.method === 'PATCH')).toMatchObject({ params: { ruleId: rule.ruleId }, body: { text: 'Be kinder.' } });
    });
  });
}

describe('the support address', () => {
  const supportEmail = (env: Record<string, string>, overrides = {}) => loadConfig(overrides, { ...BASE_ENV, ...env }).supportEmail;

  it('is noreply@yoururl.com unless SUPPORT_EMAIL says otherwise', () => {
    expect(DEFAULT_SUPPORT_EMAIL).toBe('noreply@yoururl.com');
    expect(supportEmail({})).toBe(DEFAULT_SUPPORT_EMAIL);
    // An empty value counts as unset, as it does for every setting.
    for (const unset of ['', '   ']) expect(supportEmail({ SUPPORT_EMAIL: unset }), `"${unset}"`).toBe(DEFAULT_SUPPORT_EMAIL);
    expect(supportEmail({}, { supportEmail: '' })).toBe(DEFAULT_SUPPORT_EMAIL);
    expect(supportEmail({ SUPPORT_EMAIL: ` ${SUPPORT} ` })).toBe(SUPPORT);
    expect(supportEmail({}, { supportEmail: SUPPORT })).toBe(SUPPORT);
    // The environment is over the config file, and what a caller passes is over both.
    expect(supportEmail({ SUPPORT_EMAIL: SUPPORT }, { supportEmail: 'help@elsewhere.example' })).toBe('help@elsewhere.example');
  });

  it('does not start a server whose support address is no email address', () => {
    for (const address of ['support', 'support@', '@example.com', 'support at example.com', 'https://example.com/support', 'a@example.com, b@example.com']) {
      expect(() => supportEmail({ SUPPORT_EMAIL: address }), address).toThrow(/SUPPORT_EMAIL is the address people write to for support/);
    }
  });
});

describe('the minimum age', () => {
  const minimumAge = (env: Record<string, string>, overrides = {}) => loadConfig(overrides, { ...BASE_ENV, ...env }).minimumAge;

  it('is none unless MINIMUM_AGE says otherwise', () => {
    expect(minimumAge({})).toBeNull();
    // An empty value counts as unset, as it does for every setting, and a minimum of no years is none.
    for (const unset of ['', '   ', '0', '00']) expect(minimumAge({ MINIMUM_AGE: unset }), `"${unset}"`).toBeNull();
    for (const unset of ['', 0, null]) expect(minimumAge({}, { minimumAge: unset }), JSON.stringify(unset)).toBeNull();
    expect(minimumAge({ MINIMUM_AGE: '13' })).toBe(13);
    expect(minimumAge({ MINIMUM_AGE: ' 18 ' })).toBe(18);
    expect(minimumAge({ MINIMUM_AGE: '1' })).toBe(1);
    expect(minimumAge({ MINIMUM_AGE: String(MAX_MINIMUM_AGE) })).toBe(MAX_MINIMUM_AGE);
    // As a config file has it: a number, or the same in a string.
    expect(minimumAge({}, { minimumAge: 16 })).toBe(16);
    expect(minimumAge({}, { minimumAge: '16' })).toBe(16);
    // The environment is over the config file, and what a caller passes is over both.
    expect(minimumAge({ MINIMUM_AGE: '13' }, { minimumAge: 21 })).toBe(21);
    // Settings that were read can be read again, as a function's are from the server's.
    for (const read of [minimumAge({}), minimumAge({ MINIMUM_AGE: '13' })]) expect(minimumAge({}, { minimumAge: read })).toBe(read);
  });

  it('does not start a server whose minimum age is no age in whole years', () => {
    for (const age of ['thirteen', '13+', '13.5', '-13', '1e1', '0x12', '13 years', '13,18', String(MAX_MINIMUM_AGE + 1), '180']) {
      expect(() => minimumAge({ MINIMUM_AGE: age }), age).toThrow(/MINIMUM_AGE is the youngest a person may be to use the server/);
    }
    for (const age of [13.5, -1, MAX_MINIMUM_AGE + 1]) {
      expect(() => minimumAge({}, { minimumAge: age }), String(age)).toThrow(/MINIMUM_AGE is the youngest a person may be to use the server/);
    }
    // What isn't a number or the text of one is refused too, whatever it holds.
    for (const age of [Infinity, NaN, true, [13], { years: 13 }]) expect(() => minimumAge({}, { minimumAge: age }), String(age)).toThrow();
  });
});

describe('what the server says of generative AI', () => {
  const genAi = (env: Record<string, string>, overrides = {}) => loadConfig(overrides, { ...BASE_ENV, ...env }).genAi;

  it('is that it is allowed, with no word needed of it, unless GEN_AI says otherwise', () => {
    expect(GEN_AI_SETTINGS).toEqual(['disclosure_optional', 'disclosure_required', 'not_allowed']);
    expect(DEFAULT_GEN_AI).toBe('disclosure_optional');
    expect(genAi({})).toBe(DEFAULT_GEN_AI);
    // An empty value counts as unset, as it does for every setting.
    for (const unset of ['', '   ']) expect(genAi({ GEN_AI: unset }), `"${unset}"`).toBe(DEFAULT_GEN_AI);
    expect(genAi({}, { genAi: '' })).toBe(DEFAULT_GEN_AI);
    for (const setting of GEN_AI_SETTINGS) {
      expect(genAi({ GEN_AI: setting })).toBe(setting);
      // In any case, and with space around it.
      expect(genAi({ GEN_AI: ` ${setting.toUpperCase()} ` })).toBe(setting);
      // As a config file has it.
      expect(genAi({}, { genAi: setting })).toBe(setting);
      // Settings that were read can be read again, as a function's are from the server's.
      expect(genAi({}, { genAi: genAi({ GEN_AI: setting }) })).toBe(setting);
    }
    // The environment is over the config file, and what a caller passes is over both.
    expect(genAi({ GEN_AI: 'not_allowed' }, { genAi: 'disclosure_required' })).toBe('disclosure_required');
  });

  it('does not start a server whose GEN_AI is none of the three', () => {
    for (const setting of ['allowed', 'disclosure', 'optional', 'required', 'not allowed', 'not-allowed', 'no', 'false', 'true', '0', 'disclosure_optional,not_allowed']) {
      expect(() => genAi({ GEN_AI: setting }), setting).toThrow(/GEN_AI is what the server says of content made with generative AI/);
    }
    // What isn't text is refused too, whatever it holds.
    for (const setting of [true, 1, null, ['not_allowed'], { allowed: false }]) expect(() => genAi({}, { genAi: setting }), String(setting)).toThrow();
  });
});

describe('what the server does with post titles', () => {
  const postTitles = (env: Record<string, string>, overrides = {}) => loadConfig(overrides, { ...BASE_ENV, ...env }).postTitles;

  it('is that every post has one, unless POST_TITLES says otherwise', () => {
    expect(POST_TITLES_SETTINGS).toEqual(['on_required', 'on_optional', 'off']);
    expect(DEFAULT_POST_TITLES).toBe('on_required');
    expect(postTitles({})).toBe('on_required');
    // An empty value counts as unset, as it does for every setting.
    for (const unset of ['', '   ']) expect(postTitles({ POST_TITLES: unset }), `"${unset}"`).toBe(DEFAULT_POST_TITLES);
    expect(postTitles({}, { postTitles: '' })).toBe(DEFAULT_POST_TITLES);
    for (const setting of POST_TITLES_SETTINGS) {
      expect(postTitles({ POST_TITLES: setting })).toBe(setting);
      // In any case, and with space around it.
      expect(postTitles({ POST_TITLES: ` ${setting.toUpperCase()} ` })).toBe(setting);
      // As a config file has it.
      expect(postTitles({}, { postTitles: setting })).toBe(setting);
      // Settings that were read can be read again, as a function's are from the server's.
      expect(postTitles({}, { postTitles: postTitles({ POST_TITLES: setting }) })).toBe(setting);
    }
    // With a hyphen or a space where the setting has an underscore: the three as they are said.
    expect(postTitles({ POST_TITLES: 'On-Required' })).toBe('on_required');
    expect(postTitles({ POST_TITLES: 'On-Optional' })).toBe('on_optional');
    expect(postTitles({ POST_TITLES: 'Off' })).toBe('off');
    expect(postTitles({ POST_TITLES: 'on required' })).toBe('on_required');
    expect(postTitles({ POST_TITLES: 'ON_OPTIONAL' })).toBe('on_optional');
    // The environment is over the config file, and what a caller passes is over both.
    expect(postTitles({ POST_TITLES: 'off' }, { postTitles: 'on_optional' })).toBe('on_optional');
  });

  it('does not start a server whose POST_TITLES is none of the three', () => {
    for (const setting of ['on', 'required', 'optional', 'onrequired', 'true', 'false', '0', 'yes', 'no', 'on_required,off', 'off!']) {
      expect(() => postTitles({ POST_TITLES: setting }), setting).toThrow(/POST_TITLES is whether a post has a title, and whether it has to/);
    }
    // What isn't text is refused too, whatever it holds.
    for (const setting of [true, false, 1, null, ['off'], { required: true }]) expect(() => postTitles({}, { postTitles: setting }), String(setting)).toThrow();
  });
});

describe('the modification disclosure', () => {
  const disclosure = (env: Record<string, string>, overrides = {}) => {
    const { modified, sourceUrl } = loadConfig(overrides, { ...BASE_ENV, ...env });
    return { modified, sourceUrl };
  };

  it('is of a release unless EVIEVERSE_MODIFIED says otherwise', () => {
    expect(disclosure({})).toEqual({ modified: false, sourceUrl: null });
    for (const yes of ['yes', 'true', '1', 'YES', 'True']) {
      expect(disclosure({ EVIEVERSE_MODIFIED: yes, EVIEVERSE_SOURCE_URL: SOURCE }), yes).toEqual({ modified: true, sourceUrl: SOURCE });
    }
    for (const no of ['no', 'false', '0', '']) expect(disclosure({ EVIEVERSE_MODIFIED: no }), no).toEqual({ modified: false, sourceUrl: null });
    expect(disclosure({}, { modified: true, sourceUrl: SOURCE })).toEqual({ modified: true, sourceUrl: SOURCE });
    // A server that runs a release can say where its source is too.
    expect(disclosure({ EVIEVERSE_SOURCE_URL: ` ${SOURCE} ` })).toEqual({ modified: false, sourceUrl: SOURCE });
    // Settings that were read can be read again, as a function's are from the server's.
    for (const read of [disclosure({}), disclosure({ EVIEVERSE_MODIFIED: 'true', EVIEVERSE_SOURCE_URL: SOURCE })]) expect(disclosure({}, read)).toEqual(read);
  });

  it('does not start a server as a modified version that does not say where its source is', () => {
    expect(() => disclosure({ EVIEVERSE_MODIFIED: 'true' })).toThrow(/EVIEVERSE_MODIFIED needs EVIEVERSE_SOURCE_URL/);
    expect(() => disclosure({ EVIEVERSE_MODIFIED: 'true', EVIEVERSE_SOURCE_URL: '  ' })).toThrow(/EVIEVERSE_MODIFIED needs EVIEVERSE_SOURCE_URL/);
    for (const address of ['our-evieverse', 'git.example.com/our-evieverse', 'ftp://example.com/src.tar', 'javascript:alert(1)']) {
      expect(() => disclosure({ EVIEVERSE_SOURCE_URL: address }), address).toThrow(/EVIEVERSE_SOURCE_URL is an http or https URL/);
    }
  });

  it('names the release in package.json', () => {
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(RELEASE).toBe(version);
    expect(RELEASE).toMatch(/^\d+\.\d+\.\d+/);
  });
});
