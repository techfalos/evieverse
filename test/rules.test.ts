import { readFileSync } from 'node:fs';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { setAdmin } from '../src/moderation/policy.js';
import { RELEASE } from '../src/release.js';
import { MAX_RULE_CHARS, MAX_RULES } from '../src/routes/rules.js';
import { as, createTestContext, readAudit, TARGETS, type TestContext, type User } from './helpers.js';

const NO_RULE = '00000000-0000-4000-8000-000000000000';
const ADMIN_ONLY = 'only an admin can do this';
const SOURCE = 'https://git.example.com/our-evieverse';
/** What a server that runs a release says of itself, as every server does unless it is told otherwise. */
const AS_RELEASED = { modified: false, release: RELEASE, sourceUrl: null };

type Rule = { ruleId: string; position: number; text: string; createdAt: string; updatedAt: string };
type Rules = { modificationDisclosure: { modified: boolean; release: string; sourceUrl: string | null }; rules: Rule[] };

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
      expect(await published()).toEqual({ modificationDisclosure: AS_RELEASED, rules: [] });

      const at = now();
      const first = await add(root, '  Be kind.  ');
      expect(first).toEqual({ ruleId: expect.stringMatching(/^[0-9a-f-]{36}$/), position: 1, text: 'Be kind.', createdAt: at, updatedAt: at });
      const second = await add(root, 'No spam.\nNot even a little.');
      expect(second).toMatchObject({ position: 2, text: 'No spam.\nNot even a little.' });

      const expected = { modificationDisclosure: AS_RELEASED, rules: [first, second] };
      expect(await published()).toEqual(expected);
      expect(ok(await req(alice, 'GET', '/rules'))).toEqual(expected);
      // The body's credentials are as good as the headers', as on every route.
      expect(ok(await ctx.app.inject({ method: 'POST', url: '/rules', payload: { ...root, text: 'Third.' } }), 201)).toMatchObject({ position: 3 });
    });

    it('says it runs a modified version, the release that is based on and where its source is, on a server whose operator says so', async () => {
      const { root } = await setup({ modified: true, sourceUrl: SOURCE });
      const modificationDisclosure = { modified: true, release: RELEASE, sourceUrl: SOURCE };
      expect(await published()).toEqual({ modificationDisclosure, rules: [] });
      const rule = await add(root, 'Be kind.');
      expect(await published()).toEqual({ modificationDisclosure, rules: [rule] });
      // No request changes it: not an admin's, and not one that names it.
      ok(await req(root, 'PATCH', `/rules/${rule.ruleId}`, { text: 'Be kinder.', modified: false, modificationDisclosure: AS_RELEASED }));
      expect((await published()).modificationDisclosure).toEqual(modificationDisclosure);
    });

    it('says where its source is on a server that runs a release, if its operator says', async () => {
      await setup({ sourceUrl: SOURCE });
      expect(await published()).toEqual({ modificationDisclosure: { ...AS_RELEASED, sourceUrl: SOURCE }, rules: [] });
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
      expect(await published()).toEqual({ modificationDisclosure: AS_RELEASED, rules: [] });
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

describe('the modification disclosure', () => {
  const disclosure = (env: Record<string, string>, overrides = {}) => {
    const { modified, sourceUrl } = loadConfig(overrides, { EVIEVERSE_CONFIG: '/nonexistent.json', ...env });
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
