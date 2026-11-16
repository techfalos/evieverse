import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { BUILD, CLI_HEADER } from '../src/cli/client.js';
import type { Io } from '../src/cli/commands.types.js';
import { run, UPDATED } from '../src/cli/main.js';
import { writeProfile } from '../src/cli/profiles.js';
import { bootstrapAdmin, ensureAdmin, type BootstrapAdmin } from '../src/moderation/bootstrap.js';
import { setAdmin } from '../src/moderation/policy.js';
import { RELEASE } from '../src/release.js';
import { loadCliRelease } from '../src/routes/cli.js';
import type { CliRelease } from '../src/routes/cli.types.js';
import { DAY } from '../src/time.js';
import { as, createTestContext, PNG, post, storeText, TARGETS, type TestContext, type User } from './helpers.js';

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NO_USER = '00000000-0000-4000-8000-000000000000';
const SERVER = 'https://evieverse.example.com';

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** A CLI for a server to ship, which is whatever `source` says it is. */
function release(source = 'console.log("the CLI the server ships");\n', build = 'feedfacefeedface'): CliRelease {
  const bundle = Buffer.from(source);
  return { version: '9.9.9', build, sha256: sha256(bundle), size: bundle.length, bundle };
}

/** An admin account and its key, made as the Terraform modules make them. */
function terraformAdmin(username = 'operator') {
  const apiKey = `tu_${randomBytes(6).toString('hex')}_${randomBytes(32).toString('base64url')}`;
  const admin: BootstrapAdmin = { userId: randomUUID(), username, keyHash: sha256(apiKey) };
  return { admin, user: { userId: admin.userId, apiKey } };
}

/** `fetch` that asks the app itself, for a CLI whose profile names SERVER. */
const fetchFrom =
  (app: FastifyInstance): typeof fetch =>
  async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(SERVER);
    const res = await app.inject({
      method: (init?.method ?? 'GET') as 'GET',
      url: `${url.pathname}${url.search}`,
      headers: init?.headers as Record<string, string>,
      ...(init?.body != null && { payload: init.body as string }),
    });
    return new Response(res.rawPayload, { status: res.statusCode, headers: { 'content-type': String(res.headers['content-type'] ?? '') } });
  };

for (const target of TARGETS) {
  describe(`admins (${target.name})`, () => {
    let ctx: TestContext;
    afterEach(() => ctx.close());

    const req = (u: User | null, method: 'GET' | 'PUT' | 'DELETE', url: string) => ctx.app.inject({ method, url, headers: u ? as(u) : {} });
    const ok = (res: LightMyRequestResponse, status = 200) => {
      expect(res.statusCode, res.body).toBe(status);
      return res.json();
    };
    const admin = async (name: string) => {
      const u = await ctx.register(name);
      await setAdmin(ctx.db, name, true);
      return u;
    };
    const admins = async () => (await ctx.db.selectFrom('users').select('username').where('admin', '=', 1).orderBy('username').execute()).map((r) => r.username);

    it('lets admins make and revoke admins, and nobody else', async () => {
      ctx = await createTestContext(target);
      const root = await admin('root');
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');

      for (const [method, url] of [['GET', '/admins'], ['PUT', `/admins/${alice.userId}`], ['DELETE', `/admins/${root.userId}`]] as const) {
        expect((await req(null, method, url)).statusCode).toBe(401);
        expect((await req(alice, method, url)).statusCode).toBe(403);
      }
      expect(await admins()).toEqual(['root']);

      expect(ok(await req(root, 'PUT', `/admins/${alice.userId}`), 201)).toEqual({ userId: alice.userId, username: 'alice', alreadyAdmin: false });
      expect(ok(await req(root, 'PUT', `/admins/${alice.userId}`))).toMatchObject({ alreadyAdmin: true });
      expect((await req(root, 'PUT', `/admins/${NO_USER}`)).statusCode).toBe(404);
      expect((await req(root, 'PUT', '/admins/alice')).statusCode).toBe(400);
      expect(ok(await req(alice, 'GET', '/admins'))).toEqual({
        admins: [
          { userId: alice.userId, username: 'alice' },
          { userId: root.userId, username: 'root' },
        ],
      });
      expect(ok(await req(null, 'GET', `/users/${alice.userId}`))).toMatchObject({ admin: true });

      // The new admin can revoke the one who made her; he then can't do anything an admin can.
      expect(ok(await req(alice, 'DELETE', `/admins/${root.userId}`))).toEqual({ userId: root.userId, wasAdmin: true });
      expect(ok(await req(alice, 'DELETE', `/admins/${root.userId}`))).toEqual({ userId: root.userId, wasAdmin: false });
      expect(ok(await req(alice, 'DELETE', `/admins/${NO_USER}`))).toEqual({ userId: NO_USER, wasAdmin: false });
      expect((await req(root, 'GET', '/admins')).statusCode).toBe(403);
      expect((await req(root, 'PUT', `/admins/${bob.userId}`)).statusCode).toBe(403);
      expect(await admins()).toEqual(['alice']);
    });

    it('never leaves the server without an admin', async () => {
      ctx = await createTestContext(target);
      const root = await admin('root');
      const alice = await ctx.register('alice');

      // The only admin can't step down...
      const refused = await req(root, 'DELETE', `/admins/${root.userId}`);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toBe('this is the only admin: make another user an admin first');
      expect(await admins()).toEqual(['root']);
      // ...until there's another.
      ok(await req(root, 'PUT', `/admins/${alice.userId}`), 201);
      expect(ok(await req(root, 'DELETE', `/admins/${root.userId}`))).toEqual({ userId: root.userId, wasAdmin: true });
      expect(await admins()).toEqual(['alice']);

      // Two admins revoking each other at once, or both stepping down at once: one of them stays.
      const atOnce = async (revocations: [by: User, whom: User][]) => {
        await setAdmin(ctx.db, 'root', true);
        expect(await admins()).toEqual(['alice', 'root']);
        const results = await Promise.all(revocations.map(([by, whom]) => req(by, 'DELETE', `/admins/${whom.userId}`)));
        expect(await admins()).toHaveLength(1);
        return results.map((r) => r.statusCode).sort();
      };
      expect(await atOnce([[alice, root], [root, alice]])).toEqual([200, 403]);
      expect(await atOnce([[alice, alice], [root, root]])).toEqual([200, 409]);
    });

    it('tells a key whose it is, and its roles', async () => {
      ctx = await createTestContext(target);
      const root = await admin('root');
      const carol = await ctx.register('carol');
      for (const tag of ['sports', 'news']) ok(await req(root, 'PUT', `/tags/${tag}/moderators/${carol.userId}`), 201);

      expect((await req(null, 'GET', '/whoami')).statusCode).toBe(401);
      expect((await req({ userId: carol.userId, apiKey: root.apiKey }, 'GET', '/whoami')).statusCode).toBe(401);
      expect(ok(await req(root, 'GET', '/whoami'))).toEqual({ userId: root.userId, username: 'root', language: 'en', admin: true, moderator: false, moderates: [], messages: true, showFollowing: false, showFollowers: false, banned: false });
      expect(ok(await req(carol, 'GET', '/whoami'))).toEqual({ userId: carol.userId, username: 'carol', language: 'en', admin: false, moderator: false, moderates: ['news', 'sports'], messages: true, showFollowing: false, showFollowers: false, banned: false });
      ok(await req(root, 'PUT', `/moderators/${carol.userId}`), 201);
      expect(ok(await req(carol, 'GET', '/whoami'))).toMatchObject({ admin: false, moderator: true, moderates: ['news', 'sports'] });
    });

    it('sets up the admin account of a deployment, once, and replaces its key when given another', async () => {
      ctx = await createTestContext(target);
      const whoami = (u: User) => req(u, 'GET', '/whoami');
      const first = terraformAdmin();
      /** The account's keys, by their hash, and when each was revoked. */
      const keys = async () =>
        Object.fromEntries((await ctx.db.selectFrom('api_keys').select(['key_hash', 'revoked_at']).where('user_id', '=', first.admin.userId).execute()).map((k) => [k.key_hash, k.revoked_at]));

      // Nothing to do without BOOTSTRAP_ADMIN, and nothing done with one that isn't an account.
      expect(await bootstrapAdmin(ctx.db, {})).toBeNull();
      await expect(bootstrapAdmin(ctx.db, { BOOTSTRAP_ADMIN: 'not json' })).rejects.toThrow('BOOTSTRAP_ADMIN is not JSON');
      await expect(bootstrapAdmin(ctx.db, { BOOTSTRAP_ADMIN: JSON.stringify({ ...first.admin, keyHash: first.user.apiKey }) })).rejects.toThrow(/BOOTSTRAP_ADMIN needs .*: keyHash$/);
      expect((await whoami(first.user)).statusCode).toBe(401);

      const env = { BOOTSTRAP_ADMIN: JSON.stringify(first.admin) };
      expect(await bootstrapAdmin(ctx.db, env)).toEqual({ userId: first.admin.userId, username: 'operator', created: true, keyChanged: true, keyReplaced: false });
      // An account the operator set up registered in no language, so it is answered in the server's default.
      expect(ok(await whoami(first.user))).toEqual({ userId: first.admin.userId, username: 'operator', language: 'en', admin: true, moderator: false, moderates: [], messages: true, showFollowing: false, showFollowers: false, banned: false });

      // Every later deploy runs it again, and changes nothing: not a profile renamed since, either.
      ok(await ctx.app.inject({ method: 'PATCH', url: `/users/${first.admin.userId}`, headers: as(first.user), payload: { username: 'root' } }));
      expect(await bootstrapAdmin(ctx.db, env)).toEqual({ userId: first.admin.userId, username: 'root', created: false, keyChanged: false, keyReplaced: false });
      expect(await keys()).toEqual({ [first.admin.keyHash]: null });

      // A new key for the same account replaces the old one, and makes it an admin again if it stopped being one.
      await setAdmin(ctx.db, first.admin.userId, false);
      ctx.clock.now += 1000;
      const second = terraformAdmin();
      const rotated = { ...second.admin, userId: first.admin.userId };
      expect(await ensureAdmin(ctx.db, rotated, ctx.clock.now)).toEqual({ userId: first.admin.userId, username: 'root', created: false, keyChanged: true, keyReplaced: false });
      expect(await keys()).toEqual({ [first.admin.keyHash]: ctx.clock.now, [rotated.keyHash]: null });
      expect((await whoami(first.user)).statusCode).toBe(401);
      expect(ok(await whoami({ userId: first.admin.userId, apiKey: second.user.apiKey }))).toMatchObject({ username: 'root', admin: true });

      // The key it had before is not brought back by a deploy that names it again.
      expect(await bootstrapAdmin(ctx.db, env)).toEqual({ userId: first.admin.userId, username: 'root', created: false, keyChanged: false, keyReplaced: true });
      expect(await keys()).toEqual({ [first.admin.keyHash]: ctx.clock.now, [rotated.keyHash]: null });

      // The account's name is someone else's: nothing is created.
      const alice = await ctx.register('alice');
      const taken = terraformAdmin('alice');
      await expect(ensureAdmin(ctx.db, taken.admin)).rejects.toThrow(`the username "alice" belongs to user ${alice.userId}`);
      expect((await whoami(taken.user)).statusCode).toBe(401);
      expect(await admins()).toEqual(['root']);
    });

    it("keeps a key that replaced the deployment's through the API, whichever deploys follow, until the deployment issues a new one", async () => {
      ctx = await createTestContext(target);
      const deployed = terraformAdmin();
      const whoami = (apiKey: string) => req({ userId: deployed.admin.userId, apiKey }, 'GET', '/whoami');
      const replace = (by: User): Promise<string> => ctx.app.inject({ method: 'POST', url: `/users/${deployed.admin.userId}/key`, headers: as(by) }).then((res) => ok(res, 201).apiKey);
      /** How many of the account's keys work, which is one, always. */
      const live = async () => (await ctx.db.selectFrom('api_keys').select('id').where('user_id', '=', deployed.admin.userId).where('revoked_at', 'is', null).execute()).length;
      const env = { BOOTSTRAP_ADMIN: JSON.stringify(deployed.admin) };
      const deploy = () => bootstrapAdmin(ctx.db, env);
      const kept = { userId: deployed.admin.userId, username: 'operator', created: false, keyChanged: false, keyReplaced: true };
      await deploy();

      // The account replaces its own key, as it would one that leaked: no deploy undoes that.
      const own = await replace(deployed.user);
      for (let i = 0; i < 2; i++) {
        expect(await deploy()).toEqual(kept);
        expect((await whoami(deployed.user.apiKey)).statusCode).toBe(401);
        expect(ok(await whoami(own))).toMatchObject({ username: 'operator', admin: true });
        expect(await live()).toBe(1);
      }

      // Nor one that another admin made for it, though the deploy makes the account an admin again.
      const other = await admin('other');
      const given = await replace(other);
      await setAdmin(ctx.db, deployed.admin.userId, false);
      expect(await deploy()).toEqual(kept);
      expect((await whoami(own)).statusCode).toBe(401);
      expect((await whoami(deployed.user.apiKey)).statusCode).toBe(401);
      expect(ok(await whoami(given))).toMatchObject({ admin: true });
      expect(await live()).toBe(1);

      // A new key from the deployment is the account's only one again, which is how the deployment takes the account back.
      const issued = terraformAdmin();
      const reissued = { BOOTSTRAP_ADMIN: JSON.stringify({ ...issued.admin, userId: deployed.admin.userId }) };
      expect(await bootstrapAdmin(ctx.db, reissued)).toEqual({ ...kept, keyChanged: true, keyReplaced: false });
      expect((await whoami(given)).statusCode).toBe(401);
      expect(ok(await whoami(issued.user.apiKey))).toMatchObject({ admin: true });
      expect(await bootstrapAdmin(ctx.db, reissued)).toEqual({ ...kept, keyReplaced: false });
      expect(await live()).toBe(1);
    });
  });
}

describe('the CLI a server ships', () => {
  let ctx: TestContext;
  afterEach(() => ctx.close());
  const get = (url: string, build?: string) => ctx.app.inject({ method: 'GET', url, headers: build === undefined ? {} : { [CLI_HEADER]: build } });

  it('serves its CLI, and scripts that install it, to anyone', async () => {
    const shipped = release();
    ctx = await createTestContext(TARGETS[0]!, { cli: shipped, publicBaseUrl: SERVER });

    const { bundle, ...manifest } = shipped;
    expect((await get('/cli')).json()).toEqual({
      ...manifest,
      url: `${SERVER}/cli/evieverse.mjs`,
      install: { sh: `curl -fsSL ${SERVER}/cli/install.sh | sh`, powershell: `irm ${SERVER}/cli/install.ps1 | iex` },
    });
    const file = await get('/cli/evieverse.mjs');
    expect(file.headers).toMatchObject({ 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
    expect(file.rawPayload.equals(bundle)).toBe(true);
    for (const script of ['install.sh', 'install.ps1']) {
      const res = await get(`/cli/${script}`);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(res.body).toContain(`'${SERVER}'`);
      expect(res.body).toContain(`'${shipped.sha256}'`);
      expect(res.body).toContain('/cli/evieverse.mjs');
    }
  });

  it('names itself by the address a request came to when it has no PUBLIC_BASE_URL, unless that could not be one', async () => {
    ctx = await createTestContext(TARGETS[0]!, { cli: release() });
    const at = (host: string) => ctx.app.inject({ method: 'GET', url: '/cli/install.sh', headers: { host } });
    expect((await at('localhost:3000')).body).toContain("server='http://localhost:3000'");
    expect((await at('[::1]:3000')).body).toContain("server='http://[::1]:3000'");
    for (const host of ["x'; rm -rf ~; '", 'a b', 'a/b', '$(id)']) expect((await at(host)).statusCode, host).toBe(400);
  });

  it('has nothing to serve, and holds no CLI to a build, when it was not built with one', async () => {
    ctx = await createTestContext(TARGETS[0]!);
    for (const url of ['/cli', '/cli/evieverse.mjs', '/cli/install.sh', '/cli/install.ps1']) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(404);
      expect(res.json().error).toContain('npm run build');
    }
    expect((await get('/health', 'any-build')).statusCode).toBe(200);
    expect(loadCliRelease(join(ctx.dir, 'no-such-dir'))).toBeNull();
  });

  it('answers a CLI of another build with 426 and its own, on every route group, and everyone else as ever', async () => {
    const shipped = release();
    ctx = await createTestContext(TARGETS[0]!, { cli: shipped });
    const alice = await ctx.register('alice');
    const { bundle: _, ...manifest } = shipped;

    for (const url of ['/whoami', '/health', '/feed?tags=news', '/admins', '/no-such-route']) {
      const res = await ctx.app.inject({ method: 'GET', url, headers: { ...as(alice), [CLI_HEADER]: 'an-older-build' } });
      expect(res.statusCode, url).toBe(426);
      expect(res.json()).toEqual({ error: 'this server works with version 9.9.9 (build feedfacefeedface) of the CLI: update it with `evieverse update`', cli: manifest });
    }
    // The server's own build, and clients that aren't the CLI.
    expect((await ctx.app.inject({ method: 'GET', url: '/whoami', headers: { ...as(alice), [CLI_HEADER]: shipped.build } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/whoami', headers: as(alice) })).statusCode).toBe(200);
    expect((await get('/feed?tags=news')).statusCode).toBe(200);
    // Whatever its build, a CLI can get the server's.
    for (const url of ['/cli', '/cli/evieverse.mjs', '/cli/install.sh']) expect((await get(url, 'an-older-build')).statusCode, url).toBe(200);
    expect((await get('/client', 'an-older-build')).statusCode).toBe(426);

    // A function that serves one route group holds the CLI to the build too.
    const feed = await buildApp(ctx, { logger: false, cli: shipped }, ['feed']);
    try {
      expect((await feed.inject({ method: 'GET', url: '/feed?tags=news', headers: { [CLI_HEADER]: 'an-older-build' } })).statusCode).toBe(426);
      expect((await feed.inject({ method: 'GET', url: '/feed?tags=news' })).statusCode).toBe(200);
    } finally {
      await feed.close();
    }
  });
});

describe('the CLI', () => {
  let ctx: TestContext;
  let home: string;
  afterEach(async () => {
    await ctx.close();
    await rm(home, { recursive: true, force: true });
  });

  /** A server, and a machine with no profiles on it. */
  async function setup(opts: Parameters<typeof createTestContext>[1] = {}) {
    ctx = await createTestContext(TARGETS[0]!, opts);
    home = await mkdtemp(join(tmpdir(), 'evieverse-cli-'));
  }

  /** Runs the CLI as `evieverse <args>` would, and returns what it printed and exited with. */
  async function cli(args: string[], io: Partial<Io> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const reruns: string[][] = [];
    const code = await run(args, {
      fetch: fetchFrom(ctx.app),
      env: {},
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      home,
      selfPath: null,
      readSecret: async () => '',
      rerun: async (argv) => {
        reruns.push(argv);
        return 0;
      },
      ...io,
    });
    return { code, out: out.join('\n'), err: err.join('\n'), reruns };
  }

  /** Saves a user's key as a profile, as `login` does. */
  const profile = (name: string, u: User) => writeProfile(home, name, { server: SERVER, ...u });
  /** A command that must succeed, and what it printed. */
  async function ran(...args: string[]) {
    const res = await cli(args);
    expect(res, res.err).toMatchObject({ code: 0, err: '' });
    return res.out;
  }
  const json = async (...args: string[]) => JSON.parse(await ran(...args, '--json'));

  it('signs in with a key the server knows, and keeps it in a profile only its owner can read', async () => {
    await setup();
    const alice = await ctx.register('alice');

    expect(await cli(['whoami'])).toMatchObject({ code: 1, err: 'evieverse: not signed in: run `evieverse login <server> <userId>`' });
    // A key the server doesn't know isn't saved, whether typed or in the environment.
    const wrong = `tu_${'0'.repeat(12)}_${'A'.repeat(43)}`;
    expect(await cli(['login', SERVER, alice.userId], { readSecret: async () => wrong })).toMatchObject({ code: 1, err: "evieverse: the server doesn't know this userId and API key" });
    expect(await cli(['login', SERVER, alice.userId])).toMatchObject({ code: 2, err: 'evieverse: no API key was given' });
    expect(await cli(['login', 'evieverse.example.com', alice.userId])).toMatchObject({ code: 2 });
    expect(await ran('profiles')).toBe('There are no profiles: sign in with `evieverse login <server> <userId>`.');

    const typed = await cli(['login', `${SERVER}/`, alice.userId], { readSecret: async (prompt) => (prompt === 'API key: ' ? `${alice.apiKey}\n` : '') });
    const file = join(home, 'profiles', 'default.json');
    expect(typed).toMatchObject({ code: 0, out: `Signed in to ${SERVER} as alice (no moderation role).\nSaved as profile "default" in ${file}` });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ server: SERVER, userId: alice.userId, apiKey: alice.apiKey, username: 'alice' });
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await ran('whoami')).toBe(`alice (${alice.userId}) on ${SERVER}: no moderation role`);

    // A second profile, named: from then on a command has to say which it means.
    const bob = await ctx.register('bob');
    expect((await cli(['login', SERVER, bob.userId, '--profile', 'work'], { env: { EVIEVERSE_API_KEY: bob.apiKey } })).code).toBe(0);
    expect(await ran('profiles')).toBe(`default  ${SERVER}  alice\nwork     ${SERVER}  bob`);
    expect(await cli(['whoami'])).toMatchObject({ code: 1, err: 'evieverse: there are several profiles (default, work): choose one with --profile <name> or EVIEVERSE_PROFILE' });
    expect(await json('--profile=work', 'whoami')).toEqual({ profile: 'work', server: SERVER, userId: bob.userId, username: 'bob', language: 'en', admin: false, moderator: false, moderates: [], messages: true, showFollowing: false, showFollowers: false, banned: false });
    expect((await cli(['whoami'], { env: { EVIEVERSE_PROFILE: 'default' } })).out).toContain('alice');
    expect(await cli(['whoami', '--profile', 'nobody'])).toMatchObject({ code: 1 });
    expect(await cli(['whoami', '--profile', '../default'])).toMatchObject({ code: 2 });

    expect(await ran('logout', '--profile', 'work')).toBe('Removed profile "work" from this machine. Its key still works on the server.');
    expect(await ran('whoami')).toContain('alice');
  });

  it("replaces a profile's key with a new one, and keeps that in the profile", async () => {
    await setup();
    const alice = await ctx.register('alice');
    const file = await profile('default', alice);
    const saved = async () => JSON.parse(await readFile(file, 'utf8')) as User;
    const whoami = (u: User) => ctx.app.inject({ method: 'GET', url: '/whoami', headers: as(u) });

    expect(await ran('key', 'rotate')).toBe(`Replaced the API key of profile "default": the old key no longer works.\nThe new one is saved in ${file}`);
    const first = await saved();
    expect(first).toEqual({ server: SERVER, userId: alice.userId, username: 'alice', apiKey: expect.stringMatching(/^tu_/) });
    expect(first.apiKey).not.toBe(alice.apiKey);
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect([(await whoami(alice)).statusCode, (await whoami(first)).statusCode]).toEqual([401, 200]);
    expect(await ran('whoami')).toBe(`alice (${alice.userId}) on ${SERVER}: no moderation role`);

    // --json says what was done, without the key: that is in the profile.
    expect(await json('key', 'rotate')).toEqual({ profile: 'default', file, userId: alice.userId, replaced: true });
    expect((await whoami(first)).statusCode).toBe(401);
    expect((await whoami(await saved())).statusCode).toBe(200);

    // A profile whose key the server no longer knows keeps it: nothing was replaced.
    await writeFile(file, JSON.stringify({ server: SERVER, ...alice }));
    expect(await cli(['key', 'rotate'])).toMatchObject({ code: 1, err: "evieverse: the server doesn't know this userId and API key" });
    expect(await saved()).toMatchObject({ apiKey: alice.apiKey });
    expect(await cli(['key'])).toMatchObject({ code: 2, err: 'evieverse: `key` is followed by one of: rotate' });
  });

  it("does what an admin's key may, through the endpoints", async () => {
    await setup();
    const root = await ctx.register('root');
    await setAdmin(ctx.db, 'root', true);
    const alice = await ctx.register('alice');
    const bob = await ctx.register('bob');
    await profile('root', root);

    expect(await ran('whoami')).toBe(`root (${root.userId}) on ${SERVER}: an admin`);
    expect(await ran('admins', 'list')).toBe(`${root.userId}  root`);
    expect(await ran('admins', 'grant', alice.userId)).toBe(`alice (${alice.userId}) is now an admin.`);
    expect(await ran('admins', 'grant', alice.userId)).toBe(`alice (${alice.userId}) was already an admin.`);
    expect(await json('admins', 'list')).toEqual({ admins: [{ userId: alice.userId, username: 'alice' }, { userId: root.userId, username: 'root' }] });
    expect(await ran('admins', 'revoke', alice.userId)).toBe(`${alice.userId} is no longer an admin.`);
    expect(await cli(['admins', 'revoke', root.userId])).toMatchObject({ code: 1, err: 'evieverse: this is the only admin: make another user an admin first' });

    expect(await ran('moderators', 'add', 'News', bob.userId)).toBe(`${bob.userId} now moderates #news.`);
    expect(await ran('moderators', 'list', 'news')).toMatch(new RegExp(`^${bob.userId}  bob  since 2026-`));
    expect(await ran('moderators', 'remove', 'news', bob.userId)).toBe(`${bob.userId} no longer moderates #news.`);
    expect(await ran('moderators', 'list', 'news')).toBe('#news has no moderators.');

    expect(await ran('words', 'list', '--server')).toBe('The server has no blocked words.');
    expect(await ran('words', 'add', '--server', 'Spam', 'buy  NOW')).toBe('buy now\nspam');
    expect(await json('words', 'add', '--tag', 'news', 'rumour')).toEqual({ tag: 'news', words: ['rumour'] });
    expect(await ran('words', 'remove', '--server', 'spam')).toBe('buy now');
    expect(await ran('words', 'remove', '--tag', 'news', 'rumour')).toBe('#news has no blocked words.');
    // A pattern is an entry like any other, kept as it was written.
    expect(await ran('words', 'add', '--server', '/垃圾|Scam\\w*/')).toBe('/垃圾|Scam\\w*/\nbuy now');
    expect(await ran('words', 'remove', '--server', '/垃圾|Scam\\w*/')).toBe('buy now');

    expect(await ran('mute', 'add', 'news', bob.userId)).toBe(`${bob.userId} is muted on #news.`);
    expect(await ran('mute', 'list', 'news', '--limit', '1')).toMatch(new RegExp(`^${bob.userId}  bob  muted 2026-`));
    expect(await ran('mute', 'remove', 'news', bob.userId)).toBe(`${bob.userId} is no longer muted on #news.`);
    expect(await ran('mute', 'list', 'news')).toBe('Nobody is muted on #news.');

    const contentId = await post(ctx, alice, 'both #news and #sports');
    expect(await ran('tag', 'remove', contentId, 'news', '--mute')).toBe(`Removed #news from ${contentId}: it's now under #sports.\nIts publisher is muted on #news.`);
    expect(await cli(['tag', 'remove', contentId, 'news'])).toMatchObject({ code: 1, err: "evieverse: the content isn't tagged #news" });
    expect(await ran('tag', 'remove', contentId, 'sports')).toBe(`Removed #sports from ${contentId}: it was its last hashtag, so the content is in no hashtag's feed any more.`);
    const other = await post(ctx, alice, 'another #sports');
    expect(await ran('content', 'delete', other)).toBe(`${other} is set for deletion.`);
    expect(await cli(['content', 'delete', NO_USER])).toMatchObject({ code: 1, err: 'evieverse: content not found' });
  });

  it("keeps the server's rules as an admin, and lists them, with its modification disclosure, as anyone", async () => {
    const SOURCE = 'https://git.example.com/our-evieverse';
    const SUPPORT = 'support@our-evieverse.example';
    await setup({ modified: true, sourceUrl: SOURCE, supportEmail: SUPPORT });
    const root = await ctx.register('root');
    await setAdmin(ctx.db, 'root', true);
    const alice = await ctx.register('alice');
    await profile('root', root);
    await profile('alice', alice);
    const by = (name: string, ...args: string[]) => ran(...args, '--profile', name);
    const refused = (name: string, ...args: string[]) => cli([...args, '--profile', name]);
    // What follows the rules: where to write for support, and the modification disclosure.
    const MODIFIED = `Support: ${SUPPORT}\n\nModification disclosure: this server runs a modified version of Evieverse, based on release ${RELEASE}.\nIts source code: ${SOURCE}`;
    const ruleId = (out: string) => out.split(': ')[1]!;

    expect(await by('alice', 'rules', 'list')).toBe(`The server has no rules.\n\n${MODIFIED}`);
    const kind = ruleId(await by('root', 'rules', 'add', 'Be kind.'));
    expect(kind).toMatch(/^[0-9a-f-]{36}$/);
    const spam = await by('root', 'rules', 'add', 'No spam.\nNot even a little.');
    expect(spam).toBe(`Added rule 2: ${ruleId(spam)}`);
    const first = ruleId(await by('root', 'rules', 'add', 'Read these first.', '--position', '1'));
    expect(await by('alice', 'rules', 'list')).toBe(
      `1  ${first}  Read these first.\n2  ${kind}  Be kind.\n3  ${ruleId(spam)}  No spam. Not even a little.\n\n${MODIFIED}`,
    );
    expect(await json('rules', 'list', '--profile', 'alice')).toMatchObject({
      modificationDisclosure: { modified: true, release: RELEASE, sourceUrl: SOURCE },
      supportEmail: SUPPORT,
      rules: [{ ruleId: first, position: 1 }, { ruleId: kind, position: 2, text: 'Be kind.' }, { ruleId: ruleId(spam), position: 3, text: 'No spam.\nNot even a little.' }],
    });

    expect(await by('root', 'rules', 'update', kind, '--text', 'Be kind to each other.')).toBe(`Updated rule ${kind}: it is rule 2.`);
    expect(await by('root', 'rules', 'update', kind, '--position', '1')).toBe(`Updated rule ${kind}: it is rule 1.`);
    expect(await json('rules', 'update', first, '--text', 'Read these.', '--position', '9', '--profile', 'root')).toMatchObject({ ruleId: first, position: 3, text: 'Read these.' });
    expect(await by('root', 'rules', 'remove', ruleId(spam))).toBe(`Removed rule ${ruleId(spam)}.`);
    expect(await by('root', 'rules', 'remove', ruleId(spam))).toBe(`${ruleId(spam)} isn't one of the server's rules.`);
    expect(await by('alice', 'rules', 'list')).toBe(`1  ${kind}  Be kind to each other.\n2  ${first}  Read these.\n\n${MODIFIED}`);

    // What the command can tell is wrong, it says before the server is asked; the rest is the server's to refuse.
    expect(await refused('root', 'rules', 'update', kind)).toMatchObject({ code: 2, err: 'evieverse: say what to change: --text <text>, --position <n>, or both' });
    expect(await refused('root', 'rules', 'add', 'Another.', '--position', '0')).toMatchObject({ code: 2, err: 'evieverse: --position is a place in the list of rules, counted from 1' });
    expect(await refused('root', 'rules', 'update', kind, '--position', 'first')).toMatchObject({ code: 2 });
    expect(await refused('root', 'rules', 'add')).toMatchObject({ code: 2, err: 'evieverse: usage: evieverse rules add <text> [--position <n>]' });
    expect(await refused('root', 'rules')).toMatchObject({ code: 2, err: 'evieverse: `rules` is followed by one of: list, add, update, remove' });
    expect(await refused('root', 'rules', 'update', NO_USER, '--text', 'Nothing.')).toMatchObject({ code: 1, err: 'evieverse: rule not found' });
    for (const args of [['rules', 'add', 'Anything goes.'], ['rules', 'update', kind, '--text', 'Anything goes.'], ['rules', 'remove', kind]]) {
      expect(await refused('alice', ...args)).toMatchObject({ code: 1, err: 'evieverse: only an admin can do this' });
    }

    const help = (await refused('alice', 'help')).out;
    expect(help).toMatch(/^  \+ rules list /m);
    expect(help).toMatch(/^  - rules add <text> \[--position <n>\] /m);
    expect(help).toMatch(/^  - rules update <ruleId> \[--text <text>\] \[--position <n>\] /m);
    expect(help).toMatch(/^  - rules remove <ruleId> /m);

    // A server whose operator says nothing of the kind runs a release, names no source, and gives the placeholder for a support address.
    await ctx.close();
    ctx = await createTestContext(TARGETS[0]!);
    await profile('alice', await ctx.register('alice'));
    expect(await by('alice', 'rules', 'list')).toBe(
      `The server has no rules.\n\nSupport: noreply@yoururl.com\n\nModification disclosure: this server runs Evieverse ${RELEASE}, unmodified.`,
    );
  });

  it('registers a user as an admin, without the challenge anyone else is asked to solve', async () => {
    await setup();
    const root = await ctx.register('root');
    await setAdmin(ctx.db, 'root', true);
    const alice = await ctx.register('alice');
    await profile('root', root);
    await profile('alice', alice);
    const by = (name: string, ...args: string[]) => ran(...args, '--profile', name);
    const refused = (name: string, ...args: string[]) => cli([...args, '--profile', name]);
    const whoami = (u: User) => ctx.app.inject({ method: 'GET', url: '/whoami', headers: as(u) });

    // The id and the key that come back are the new user's, and the key works at once.
    const registered = /^Registered bob \((\S{36})\)\.\nTheir API key, shown this once: (tu_\S+)$/.exec(await by('root', 'register', 'bob'));
    expect(registered).not.toBeNull();
    const [, userId, apiKey] = registered!;
    expect((await whoami({ userId: userId!, apiKey: apiKey! })).json()).toMatchObject({ userId, username: 'bob', language: 'en', admin: false });
    // --json is the server's answer, key and all, for a script to read.
    const carol = await json('register', 'Carol Jones', '--language', 'EN', '--profile', 'root');
    expect(carol).toEqual({ userId: expect.any(String), username: 'Carol Jones', language: 'en', apiKey: expect.stringMatching(/^tu_/), note: 'Store this apiKey now; it cannot be retrieved again.' });
    expect((await whoami(carol)).statusCode).toBe(200);

    expect(await refused('root', 'register', 'bob')).toMatchObject({ code: 1, err: 'evieverse: username is already taken' });
    expect(await refused('root', 'register', 'dave', '--language', 'xx')).toMatchObject({ code: 1, err: 'evieverse: "xx" is not one of this server\'s languages: en' });
    expect(await refused('root', 'register')).toMatchObject({ code: 2, err: 'evieverse: usage: evieverse register <username> [--language <code>]' });
    // Anyone else's key spares no challenge, and the CLI has no way to show one: nobody is registered.
    expect(await refused('alice', 'register', 'dave')).toMatchObject({
      code: 1,
      out: '',
      err: 'evieverse: only an admin registers a user with the CLI: the server asks anyone else to solve a challenge, which takes a client that shows its image',
    });
    expect(await ctx.db.selectFrom('users').select('username').orderBy('username').execute()).toEqual(['Carol Jones', 'alice', 'bob', 'root'].map((username) => ({ username })));
  });

  it("replaces another user's key as an admin, and prints the new one for them to pass on", async () => {
    await setup();
    const root = await ctx.register('root');
    await setAdmin(ctx.db, 'root', true);
    const second = await ctx.register('second');
    await setAdmin(ctx.db, 'second', true);
    const alice = await ctx.register('alice');
    const bob = await ctx.register('bob');
    const file = await profile('root', root);
    await profile('bob', bob);
    const by = (name: string, ...args: string[]) => ran(...args, '--profile', name);
    const refused = (name: string, ...args: string[]) => cli([...args, '--profile', name]);
    const whoami = async (u: User) => (await ctx.app.inject({ method: 'GET', url: '/whoami', headers: as(u) })).statusCode;
    const printed = (userId: string) => new RegExp(`^Replaced the API key of ${userId}: the keys they had no longer work\\.\\nTheir new API key, shown this once: (tu_\\S+)$`);

    // The key that comes back is the user's, and the only one of theirs that works.
    const [, apiKey] = printed(alice.userId).exec(await by('root', 'users', 'rotate-key', alice.userId))!;
    expect([await whoami(alice), await whoami({ userId: alice.userId, apiKey: apiKey! })]).toEqual([401, 200]);
    // --json is the server's answer, key and all, for a script to read.
    const again = await json('users', 'rotate-key', alice.userId, '--profile', 'root');
    expect(again).toEqual({
      userId: alice.userId,
      apiKey: expect.stringMatching(/^tu_/),
      note: 'Pass this apiKey on to the user now; it cannot be retrieved again. Every key they had no longer works.',
    });
    expect([await whoami({ userId: alice.userId, apiKey: apiKey! }), await whoami(again)]).toEqual([401, 200]);
    // Another admin's, too.
    const [, seconds] = printed(second.userId).exec(await by('root', 'users', 'rotate-key', second.userId))!;
    expect([await whoami(second), await whoami({ userId: second.userId, apiKey: seconds! })]).toEqual([401, 200]);

    // The admin's own key is `key rotate`'s to replace, which saves it: here it would be replaced and kept nowhere.
    for (const own of [root.userId, root.userId.toUpperCase()]) {
      expect(await refused('root', 'users', 'rotate-key', own)).toMatchObject({
        code: 2,
        out: '',
        err: 'evieverse: that is your own account: replace its key with `evieverse key rotate`, which saves the new one in the profile',
      });
    }
    // The profile is as it was through all of it, and its key works.
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ server: SERVER, ...root });
    expect(await whoami(root)).toBe(200);

    expect(await refused('bob', 'users', 'rotate-key', again.userId)).toMatchObject({ code: 1, out: '', err: "evieverse: you can only replace your own API key, unless you're an admin" });
    expect(await whoami(again)).toBe(200);
    expect(await refused('root', 'users', 'rotate-key', NO_USER)).toMatchObject({ code: 1, err: 'evieverse: user not found' });
    expect(await refused('root', 'users', 'rotate-key')).toMatchObject({ code: 2, err: 'evieverse: usage: evieverse users rotate-key <userId>' });
    expect(await refused('root', 'users')).toMatchObject({ code: 2, err: 'evieverse: `users` is followed by one of: delete, rotate-key' });
  });

  it("works through a hashtag's moderation queue, and the server's", async () => {
    await setup({ trust: { deleteBelow: 0 } });
    const root = await ctx.register('root');
    await setAdmin(ctx.db, 'root', true);
    const carol = await ctx.register('carol');
    const alice = await ctx.register('alice');
    const dave = await ctx.register('dave');
    await profile('root', root);
    await profile('carol', carol);
    await profile('dave', dave);
    const by = (name: string, ...args: string[]) => ran(...args, '--profile', name);
    const refused = (name: string, ...args: string[]) => cli([...args, '--profile', name]);
    await by('root', 'moderators', 'add', 'news', carol.userId);
    await by('root', 'words', 'add', '--server', 'spam');

    // A hashtag's queue: what is under it that none of its moderators has approved, or removed it from.
    expect(await by('carol', 'tag', 'queue', 'news')).toBe('Nothing under #news waits for a moderator.');
    // It is everything that waits under the hashtag, however old: not the last day's posts, which is what a feed is of unless it says.
    ctx.clock.now -= 30 * DAY;
    const old = await post(ctx, alice, 'Last month #news');
    ctx.clock.now += 30 * DAY;
    await ctx.compact();
    expect(await by('carol', 'tag', 'queue', 'news')).toMatch(new RegExp(`^${old}  alice  2026-\\S+  Last month #news$`));
    expect(await by('carol', 'tag', 'approve', old, 'news')).toBe(`Approved ${old} under #news.`);
    const first = await post(ctx, alice, 'Flooding closes roads #news #mumbai');
    ctx.clock.now += 1000;
    const second = await post(ctx, alice, 'Rumours of more rain #news #mumbai');
    // The compactor's next run puts the posts in the queue, and takes out the one that was approved.
    await ctx.compact();
    const waiting = (await by('carol', 'tag', 'queue', 'news')).split('\n');
    expect(waiting).toHaveLength(2);
    expect(waiting.find((line) => line.startsWith(first))).toMatch(new RegExp(`^${first}  alice  2026-\\S+  Flooding closes roads #news #mumbai$`));
    expect(await by('carol', 'tag', 'queue', 'news', '--limit', '1')).toMatch(/\nThere are more: --cursor \S+$/);
    expect(await by('carol', 'tag', 'approve', first, 'news')).toBe(`Approved ${first} under #news.`);
    expect(await by('carol', 'tag', 'approve', first, 'news')).toBe(`${first} was already approved under #news.`);
    expect(await refused('carol', 'tag', 'approve', first, 'mumbai')).toMatchObject({ code: 1, err: 'evieverse: only an admin or a moderator of #mumbai can do this' });
    expect(await by('carol', 'tag', 'remove', second, 'news')).toBe(`Removed #news from ${second}: it's now under #mumbai.`);
    await ctx.compact();
    expect(await by('carol', 'tag', 'queue', 'news')).toBe('Nothing under #news waits for a moderator.');

    // The server's queue: the posts a trust score held back, for admins and the server moderators they appoint.
    const NOT_A_MODERATOR = 'evieverse: only an admin or a server moderator can do this';
    expect(await by('root', 'server-moderators', 'list')).toBe('The server has no moderators.');
    expect(await refused('dave', 'queue', 'list')).toMatchObject({ code: 1, err: NOT_A_MODERATOR });
    expect(await refused('dave', 'server-moderators', 'add', dave.userId)).toMatchObject({ code: 1, err: 'evieverse: only an admin can do this' });
    expect(await by('root', 'server-moderators', 'add', dave.userId)).toBe(`dave (${dave.userId}) is now a server moderator.`);
    expect(await by('root', 'server-moderators', 'add', dave.userId)).toBe(`dave (${dave.userId}) was already a server moderator.`);
    expect(await by('root', 'server-moderators', 'list')).toBe(`${dave.userId}  dave`);
    expect(await json('server-moderators', 'list', '--profile', 'root')).toEqual({ moderators: [{ userId: dave.userId, username: 'dave' }] });
    expect(await by('dave', 'whoami')).toBe(`dave (${dave.userId}) on ${SERVER}: a server moderator`);
    expect(await refused('dave', 'server-moderators', 'list')).toMatchObject({ code: 1, err: 'evieverse: only an admin can do this' });
    expect(await by('root', 'queue', 'list')).toBe('The moderation queue is empty.');
    const held = (await storeText(ctx, alice, 'Free spam #news')).json().contentId;
    ctx.clock.now += 1000;
    const other = (await storeText(ctx, alice, 'More spam #mumbai')).json().contentId;
    expect(await by('root', 'queue', 'list', '--limit', '1')).toMatch(
      new RegExp(`^post  ${held}  alice  score 0  since 2026-\\S+  #news  Free spam #news\\nThere are more: --cursor \\S+$`),
    );
    expect((await json('queue', 'list', '--profile', 'root')).queue.map((p: { contentId: string }) => p.contentId)).toEqual([held, other]);
    expect((await json('queue', 'list', '--profile', 'dave')).queue.map((p: { contentId: string }) => p.contentId)).toEqual([held, other]);
    // A hashtag's moderator has no say in it.
    expect(await refused('carol', 'queue', 'list')).toMatchObject({ code: 1, err: NOT_A_MODERATOR });
    expect(await refused('carol', 'queue', 'accept', held)).toMatchObject({ code: 1, err: NOT_A_MODERATOR });
    expect(await by('dave', 'queue', 'accept', held)).toBe(`Accepted ${held}: it's published under #news.`);
    expect(await refused('root', 'queue', 'accept', held)).toMatchObject({ code: 1, err: 'evieverse: the content is not in the moderation queue' });
    expect(await by('root', 'queue', 'reject', other)).toBe(`Rejected ${other}: it is set for deletion.`);
    expect(await by('root', 'queue', 'list')).toBe('The moderation queue is empty.');
    // A server moderator rejects what waits in the queue. Deleting any post takes an admin: a hashtag's
    // moderator and a server moderator delete only their own.
    const fourth = (await storeText(ctx, alice, 'Spam again #news')).json().contentId;
    expect(await by('dave', 'queue', 'reject', fourth)).toBe(`Rejected ${fourth}: it is set for deletion.`);
    const third = (await storeText(ctx, alice, 'Even more spam #news')).json().contentId;
    for (const name of ['carol', 'dave']) {
      expect(await refused(name, 'content', 'delete', third)).toMatchObject({ code: 1, err: 'evieverse: only the original publisher or an admin can delete this content' });
    }
    expect(await by('root', 'content', 'delete', third)).toBe(`${third} is set for deletion.`);
    expect(await by('root', 'queue', 'list')).toBe('The moderation queue is empty.');
    // Once no longer a server moderator, the queue is closed to them.
    expect(await by('root', 'server-moderators', 'remove', dave.userId)).toBe(`${dave.userId} is no longer a server moderator.`);
    expect(await by('root', 'server-moderators', 'remove', dave.userId)).toBe(`${dave.userId} wasn't a server moderator.`);
    expect(await refused('dave', 'queue', 'list')).toMatchObject({ code: 1, err: NOT_A_MODERATOR });
    // What an admin accepted is published unmoderated, so it waits for the hashtag's moderators next.
    await ctx.compact();
    expect(await by('carol', 'tag', 'queue', 'news')).toMatch(new RegExp(`^${held}  alice  2026-\\S+  Free spam #news$`));
  });

  it('reports a post, and works through the report queue', async () => {
    await setup();
    const root = await ctx.register('root');
    await setAdmin(ctx.db, 'root', true);
    const alice = await ctx.register('alice');
    const bob = await ctx.register('bob');
    const carol = await ctx.register('carol');
    const dave = await ctx.register('dave');
    for (const [name, u] of [['root', root], ['bob', bob], ['carol', carol], ['dave', dave]] as const) await profile(name, u);
    const by = (name: string, ...args: string[]) => ran(...args, '--profile', name);
    const refused = (name: string, ...args: string[]) => cli([...args, '--profile', name]);
    const NOT_A_MODERATOR = 'evieverse: only an admin or a server moderator can do this';
    await by('root', 'server-moderators', 'add', dave.userId);

    // Anyone reports a post, once.
    const first = await post(ctx, alice, 'Buy my course #news');
    const second = await post(ctx, alice, 'Something unkind #news');
    expect(await by('dave', 'reports', 'list')).toBe('The report queue is empty.');
    expect(await by('bob', 'content', 'report', first, '--reason', 'Looks like\nspam')).toBe(`Reported ${first} to the server's moderators.`);
    expect(await by('bob', 'content', 'report', first)).toBe(`You had already reported ${first}.`);
    ctx.clock.now += 1000;
    expect(await by('carol', 'content', 'report', first)).toBe(`Reported ${first} to the server's moderators.`);
    expect(await refused('bob', 'content', 'report', NO_USER)).toMatchObject({ code: 1, err: 'evieverse: content not found' });
    expect(await refused('bob', 'content', 'report')).toMatchObject({ code: 2, err: 'evieverse: usage: evieverse content report <contentId> [--comment <commentId>] [--reason <text>]' });
    ctx.clock.now += 1000;
    await by('carol', 'content', 'report', second, '--reason', 'Unkind');

    // The queue is for server moderators and admins: they read it and each post's reports, and accept the post or delete it.
    for (const args of [['reports', 'list'], ['reports', 'show', first], ['reports', 'accept', first], ['reports', 'delete', first]]) {
      expect(await refused('bob', ...args)).toMatchObject({ code: 1, err: NOT_A_MODERATOR });
    }
    expect(await by('dave', 'reports', 'list', '--limit', '1')).toMatch(
      new RegExp(`^post  ${first}  alice  2 reports  since 2026-\\S+  #news  Buy my course #news\\nThere are more: --cursor \\S+$`),
    );
    expect((await json('reports', 'list', '--profile', 'root')).queue.map((p: { contentId: string; reports: number }) => [p.contentId, p.reports])).toEqual([[first, 2], [second, 1]]);
    expect((await by('dave', 'reports', 'show', first)).split('\n')).toEqual([
      expect.stringMatching(new RegExp(`^${carol.userId}  carol  2026-\\S+  \\(no reason given\\)$`)),
      expect.stringMatching(new RegExp(`^${bob.userId}  bob    2026-\\S+  Looks like spam$`)),
    ]);
    expect(await by('dave', 'reports', 'accept', first)).toBe(`Accepted ${first}: it stays, and 2 reports of it are settled.`);
    expect(await refused('root', 'reports', 'accept', first)).toMatchObject({ code: 1, err: 'evieverse: the content has no reports waiting for a decision' });
    expect(await by('dave', 'reports', 'show', first)).toBe(`${first} has no reports waiting for a decision.`);
    expect(await by('root', 'reports', 'delete', second)).toBe(`Deleted ${second}: it is set for deletion.`);
    expect(await by('root', 'reports', 'list')).toBe('The report queue is empty.');
    // A server moderator deletes what was reported, and nothing else that isn't theirs.
    expect(await refused('dave', 'content', 'delete', first)).toMatchObject({ code: 1, err: 'evieverse: only the original publisher or an admin can delete this content' });
    await by('bob', 'content', 'report', await post(ctx, alice, 'One more #news'));
    expect(await by('dave', 'reports', 'list')).toMatch(/  alice  1 report  since /);
  });

  it('comments on a post, and works through the comments in the moderation queue and the report queue', async () => {
    await setup({ trust: { deleteBelow: 0 } });
    const root = await ctx.register('root');
    await setAdmin(ctx.db, 'root', true);
    const alice = await ctx.register('alice');
    const bob = await ctx.register('bob');
    const carol = await ctx.register('carol');
    const dave = await ctx.register('dave');
    for (const [name, u] of [['root', root], ['alice', alice], ['bob', bob], ['carol', carol], ['dave', dave]] as const) await profile(name, u);
    const by = (name: string, ...args: string[]) => ran(...args, '--profile', name);
    const refused = (name: string, ...args: string[]) => cli([...args, '--profile', name]);
    const NOT_A_MODERATOR = 'evieverse: only an admin or a server moderator can do this';
    await by('root', 'server-moderators', 'add', dave.userId);
    await by('root', 'words', 'add', '--server', 'spam');

    // Anyone comments on a post that takes comments, and reads its comments.
    const closed = await post(ctx, alice, 'No comments here #news');
    const contentId = await post(ctx, alice, 'Say what you think #news', { comments: true });
    expect(await refused('bob', 'comments', 'add', closed, 'Hello')).toMatchObject({ code: 1, err: "evieverse: this post doesn't take comments" });
    expect(await refused('bob', 'comments', 'list', closed)).toMatchObject({ code: 1, err: "evieverse: this post doesn't take comments" });
    expect(await by('bob', 'comments', 'list', contentId)).toBe(`${contentId} has no comments.`);
    const added = await by('bob', 'comments', 'add', contentId, 'A first\nthought');
    expect(added).toMatch(new RegExp(`^Commented on ${contentId}: \\S{36}$`));
    const first = added.slice(-36);
    ctx.clock.now += 1000;
    const second = (await json('comments', 'add', contentId, 'A second thought', '--profile', 'carol')).commentId;
    expect((await by('bob', 'comments', 'list', contentId)).split('\n')).toEqual([
      expect.stringMatching(new RegExp(`^${first}  bob    2026-\\S+  0 likes  0 replies  A first thought$`)),
      expect.stringMatching(new RegExp(`^${second}  carol  2026-\\S+  0 likes  0 replies  A second thought$`)),
    ]);
    expect(await by('bob', 'comments', 'list', contentId, '--newest', '--limit', '1')).toMatch(
      new RegExp(`^${second}  carol  2026-\\S+  0 likes  0 replies  A second thought\\nThere are more: --cursor ${second}$`),
    );
    expect(await by('bob', 'comments', 'list', contentId, '--newest', '--limit', '1', '--cursor', second)).toMatch(new RegExp(`^${first}  bob  `));
    expect(await json('comments', 'list', contentId, '--profile', 'bob')).toMatchObject({ contentId, count: 2, nextCursor: null });
    expect(await refused('bob', 'comments', 'add', contentId)).toMatchObject({
      code: 2,
      err: 'evieverse: usage: evieverse comments add <contentId> <text> [--file <path>] [--reply-to <commentId>]',
    });

    // A comment is replied to, liked, and edited by its author. Its replies are a list of their own.
    expect(await by('carol', 'comments', 'list', contentId, '--replies-to', first)).toBe(`Comment ${first} has no replies.`);
    const replied = await by('carol', 'comments', 'add', contentId, 'Go on', '--reply-to', first);
    expect(replied).toMatch(new RegExp(`^Replied to comment ${first}: \\S{36}$`));
    const answer = replied.slice(-36);
    expect(await refused('carol', 'comments', 'add', contentId, 'Hello', '--reply-to', NO_USER)).toMatchObject({ code: 1, err: 'evieverse: comment not found' });
    expect(await by('carol', 'comments', 'like', contentId, first)).toBe(`Liked comment ${first}: it has 1 like.`);
    expect(await by('carol', 'comments', 'like', contentId, first)).toBe(`You had already liked comment ${first}: it has 1 like.`);
    expect(await by('alice', 'comments', 'like', contentId, first)).toBe(`Liked comment ${first}: it has 2 likes.`);
    expect(await refused('bob', 'comments', 'edit', contentId, answer, 'Go away')).toMatchObject({ code: 1, err: "evieverse: only the comment's author can edit this comment" });
    expect(await by('carol', 'comments', 'edit', contentId, answer, 'Do go on')).toBe(`Edited comment ${answer}.`);
    expect(await by('carol', 'comments', 'edit', contentId, answer, 'Do go on')).toBe(`Comment ${answer} already says that.`);
    expect((await by('bob', 'comments', 'list', contentId)).split('\n')).toEqual([
      expect.stringMatching(new RegExp(`^${first}  bob    2026-\\S+  2 likes  1 reply    A first thought$`)),
      expect.stringMatching(new RegExp(`^${second}  carol  2026-\\S+  0 likes  0 replies  A second thought$`)),
    ]);
    expect(await by('bob', 'comments', 'list', contentId, '--replies-to', first)).toMatch(new RegExp(`^${answer}  carol  2026-\\S+  0 likes  0 replies  Do go on \\(edited\\)$`));
    expect(await json('comments', 'list', contentId, '--replies-to', first, '--profile', 'bob')).toMatchObject({ contentId, commentId: first, count: 1, nextCursor: null });
    expect(await json('comments', 'list', contentId, '--profile', 'bob')).toMatchObject({ contentId, count: 3 });
    // Its author deletes the reply, and the comment has none again.
    expect(await by('carol', 'comments', 'delete', contentId, answer)).toBe(`Deleted comment ${answer}.`);
    expect(await by('bob', 'comments', 'list', contentId, '--replies-to', first)).toBe(`Comment ${first} has no replies.`);

    // A comment comes with an image or a video, with a text or without one, and a list says which do.
    const picture = join(home, 'pixel.png');
    await writeFile(picture, PNG);
    const pictured = await by('carol', 'comments', 'add', contentId, 'Look', '--file', picture, '--reply-to', first);
    expect(pictured).toMatch(new RegExp(`^Replied to comment ${first} with an image: \\S{36}$`));
    ctx.clock.now += 1000;
    const wordless = await json('comments', 'add', contentId, '', '--file', picture, '--reply-to', first, '--profile', 'carol');
    expect(wordless).toMatchObject({ text: '', media: { kind: 'image', mimeType: 'image/png', size: PNG.length } });
    expect((await by('bob', 'comments', 'list', contentId, '--replies-to', first)).split('\n')).toEqual([
      expect.stringMatching(new RegExp(`^${pictured.slice(-36)}  carol  2026-\\S+  0 likes  0 replies  \\[image\\] Look$`)),
      expect.stringMatching(new RegExp(`^${wordless.commentId}  carol  2026-\\S+  0 likes  0 replies  \\[image\\]$`)),
    ]);
    expect(await refused('carol', 'comments', 'add', contentId, 'Look', '--file', join(home, 'nothing.png'))).toMatchObject({
      code: 2,
      err: expect.stringMatching(/^evieverse: could not read .*nothing\.png: /),
    });
    const notes = join(home, 'notes.txt');
    await writeFile(notes, 'Some words');
    expect(await refused('carol', 'comments', 'add', contentId, 'Read', '--file', notes)).toMatchObject({ code: 1, err: 'evieverse: comments take image/* and video/* files, got text/plain' });
    expect(await refused('carol', 'comments', 'add', contentId, '')).toMatchObject({ code: 1, err: 'evieverse: a comment needs a text, an image or a video' });
    for (const id of [pictured.slice(-36), wordless.commentId]) await by('carol', 'comments', 'delete', contentId, id);

    // One the server holds back waits in the moderation queue, among the posts, for a server moderator or an admin.
    ctx.clock.now += 1000;
    const heldPost = (await storeText(ctx, alice, 'Free spam #news')).json().contentId;
    ctx.clock.now += 1000;
    const waits = await by('bob', 'comments', 'add', contentId, 'Buy spam');
    expect(waits).toMatch(new RegExp(`^Your comment on ${contentId} waits for the server's moderators: \\S{36}$`));
    const held = waits.slice(-36);
    ctx.clock.now += 1000;
    const rejected = (await json('comments', 'add', contentId, 'More spam', '--profile', 'carol')).commentId;
    expect((await by('dave', 'queue', 'list')).split('\n')).toEqual([
      expect.stringMatching(new RegExp(`^post     ${heldPost}  alice  score 0  since 2026-\\S+  #news {2,}Free spam #news$`)),
      expect.stringMatching(new RegExp(`^comment  ${held}  bob    score 0  since 2026-\\S+  on ${contentId}  Buy spam$`)),
      expect.stringMatching(new RegExp(`^comment  ${rejected}  carol  score 0  since 2026-\\S+  on ${contentId}  More spam$`)),
    ]);
    expect(await refused('alice', 'queue', 'accept', contentId, '--comment', held)).toMatchObject({ code: 1, err: NOT_A_MODERATOR });
    expect(await by('dave', 'queue', 'accept', contentId, '--comment', held)).toBe(`Accepted comment ${held}: it's published on ${contentId}.`);
    expect(await refused('root', 'queue', 'accept', contentId, '--comment', held)).toMatchObject({ code: 1, err: 'evieverse: the comment is not in the moderation queue' });
    expect(await by('root', 'queue', 'reject', contentId, '--comment', rejected)).toBe(`Rejected comment ${rejected}: it is deleted.`);
    expect((await json('comments', 'list', contentId, '--profile', 'bob')).comments.map((c: { commentId: string }) => c.commentId)).toEqual([first, second, held]);
    expect(await by('bob', 'inbox', 'list')).toMatch(
      /^\S{36}  2026-\S+  new  the server  Your comment was accepted from the moderation queue, and is published\. The comment: "Buy spam"$/,
    );

    // Anyone reports a comment, once, and it waits in the report queue.
    expect(await by('dave', 'reports', 'list')).toBe('The report queue is empty.');
    expect(await by('carol', 'content', 'report', contentId, '--comment', first, '--reason', 'Unkind')).toBe(`Reported comment ${first} to the server's moderators.`);
    expect(await by('carol', 'content', 'report', contentId, '--comment', first)).toBe(`You had already reported comment ${first}.`);
    expect(await refused('carol', 'content', 'report', contentId, '--comment', NO_USER)).toMatchObject({ code: 1, err: 'evieverse: comment not found' });
    ctx.clock.now += 1000;
    await by('bob', 'content', 'report', contentId, '--comment', second);
    expect((await by('dave', 'reports', 'list')).split('\n')).toEqual([
      expect.stringMatching(new RegExp(`^comment  ${first}  bob    1 report  since 2026-\\S+  on ${contentId}  A first thought$`)),
      expect.stringMatching(new RegExp(`^comment  ${second}  carol  1 report  since 2026-\\S+  on ${contentId}  A second thought$`)),
    ]);
    expect(await by('dave', 'reports', 'show', contentId, '--comment', first)).toMatch(new RegExp(`^${carol.userId}  carol  2026-\\S+  Unkind$`));
    expect(await by('dave', 'reports', 'show', contentId)).toBe(`${contentId} has no reports waiting for a decision.`);
    expect(await by('dave', 'reports', 'accept', contentId, '--comment', first)).toBe(`Accepted comment ${first}: it stays, and 1 report of it is settled.`);
    expect(await by('dave', 'reports', 'show', contentId, '--comment', first)).toBe(`Comment ${first} has no reports waiting for a decision.`);
    expect(await refused('root', 'reports', 'accept', contentId, '--comment', first)).toMatchObject({ code: 1, err: 'evieverse: the comment has no reports waiting for a decision' });
    expect(await by('root', 'reports', 'delete', contentId, '--comment', second)).toBe(`Deleted comment ${second}.`);
    expect(await by('root', 'reports', 'list')).toBe('The report queue is empty.');
    expect(await by('carol', 'inbox', 'list')).toMatch(/  the server  Your comment was deleted\. The comment: "A second thought"\n\S{36}  .*Your comment was rejected from the moderation queue, and deleted\. The comment: "More spam"$/);

    // A comment is deleted by its author, by the post's publisher, or by an admin.
    expect(await refused('carol', 'comments', 'delete', contentId, first)).toMatchObject({
      code: 1,
      err: "evieverse: only the comment's author, the post's publisher or an admin can delete this comment",
    });
    expect(await by('alice', 'comments', 'delete', contentId, held)).toBe(`Deleted comment ${held}.`);
    // The replies to it stay, listed under what is left of it, until they are deleted too.
    const staying = (await json('comments', 'add', contentId, 'Still here', '--reply-to', first, '--profile', 'carol')).commentId;
    expect(await by('bob', 'comments', 'delete', contentId, first)).toBe(`Deleted comment ${first}.`);
    expect(await refused('bob', 'comments', 'delete', contentId, first)).toMatchObject({ code: 1, err: 'evieverse: comment not found' });
    expect(await by('bob', 'comments', 'list', contentId)).toMatch(new RegExp(`^${first} {4}2026-\\S+  0 likes  1 reply  \\[deleted\\]$`));
    expect(await by('bob', 'comments', 'list', contentId, '--replies-to', first)).toMatch(new RegExp(`^${staying}  carol  2026-\\S+  0 likes  0 replies  Still here$`));
    expect(await by('carol', 'comments', 'delete', contentId, staying)).toBe(`Deleted comment ${staying}.`);
    expect(await by('bob', 'comments', 'list', contentId)).toBe(`${contentId} has no comments.`);
  });

  it('reads the inbox, sends messages, turns them off and blocks users', async () => {
    await setup();
    const root = await ctx.register('root');
    await setAdmin(ctx.db, 'root', true);
    const alice = await ctx.register('alice');
    const bob = await ctx.register('bob');
    for (const [name, u] of [['root', root], ['alice', alice], ['bob', bob]] as const) await profile(name, u);
    const by = (name: string, ...args: string[]) => ran(...args, '--profile', name);
    const refused = (name: string, ...args: string[]) => cli([...args, '--profile', name]);
    const NOT_TAKEN = "evieverse: this user doesn't take messages from you";

    expect(await by('bob', 'inbox', 'list')).toBe('Your inbox is empty.');
    expect(await by('alice', 'messages', 'send', bob.userId, 'Hello\nBob')).toBe(`Sent to bob (${bob.userId}).`);
    ctx.clock.now += 1000;
    await by('root', 'mute', 'add', 'news', bob.userId);
    ctx.clock.now += 1000;
    await by('root', 'content', 'delete', await post(ctx, bob, 'A post of\nmine #sports'));

    // Newest first, each on a line: a message with who sent it, a notice with the post it is about.
    const lines = (await by('bob', 'inbox', 'list')).split('\n');
    expect(lines).toEqual([
      expect.stringMatching(/^\S{36}  2026-\S+  new  the server {2,}An admin deleted your post\. The post: "A post of mine #sports"$/),
      expect.stringMatching(/^\S{36}  2026-\S+  new  the server {2,}A moderator muted you on #news: your new posts and updates don't get that hashtag\.$/),
      expect.stringMatching(new RegExp(`^\\S{36}  2026-\\S+  new  alice \\(${alice.userId}\\)  Hello Bob$`)),
    ]);
    const [deleted, , hello] = lines.map((line) => line.slice(0, 36));
    expect(await by('bob', 'inbox', 'list', '--limit', '1')).toMatch(/^\S{36}  2026-\S+  new  the server  An admin deleted your post\..*\nThere are more: --cursor \S+$/);
    expect((await json('inbox', 'list', '--profile', 'bob')).inbox[2]).toMatchObject({ messageId: hello, kind: 'message', text: 'Hello\nBob' });

    expect(await by('bob', 'inbox', 'read', '--message', hello!)).toBe('Marked 1 as read: 2 are left unread.');
    expect((await by('bob', 'inbox', 'list', '--unread')).split('\n')).toHaveLength(2);
    expect((await by('bob', 'inbox', 'list')).split('\n')[2]).toMatch(/  read  alice /);
    expect(await by('bob', 'inbox', 'delete', deleted!)).toBe(`Deleted ${deleted} from your inbox.`);
    expect(await by('bob', 'inbox', 'delete', deleted!)).toBe(`${deleted} isn't in your inbox.`);
    expect(await by('bob', 'inbox', 'read')).toBe('Marked 1 as read: 0 are left unread.');
    expect(await by('bob', 'inbox', 'list', '--unread')).toBe('Nothing in your inbox is unread.');
    expect(await refused('bob', 'inbox', 'delete')).toMatchObject({ code: 2, err: 'evieverse: usage: evieverse inbox delete <messageId>' });

    // Messages are a setting of the account's...
    expect(await by('bob', 'messages', 'off')).toBe('Messages are off: other users can send you none, and you send none.');
    expect(await json('whoami', '--profile', 'bob')).toMatchObject({ messages: false });
    expect(await refused('alice', 'messages', 'send', bob.userId, 'Still there?')).toMatchObject({ code: 1, err: NOT_TAKEN });
    expect(await refused('bob', 'messages', 'send', alice.userId, 'Hi')).toMatchObject({ code: 1, err: 'evieverse: you turned messages off: turn them on to send one' });
    expect(await by('bob', 'messages', 'on')).toBe('Messages are on: other users can send you messages, and you them.');
    expect(await by('bob', 'messages', 'send', alice.userId, 'Hi')).toBe(`Sent to alice (${alice.userId}).`);

    // ...and a block is between two users.
    expect(await by('bob', 'blocks', 'list')).toBe('You block nobody.');
    expect(await by('bob', 'blocks', 'add', alice.userId)).toBe(`You block ${alice.userId}: no message goes between the two of you.`);
    expect(await by('bob', 'blocks', 'add', alice.userId)).toBe(`You already blocked ${alice.userId}.`);
    expect(await by('bob', 'blocks', 'list')).toMatch(new RegExp(`^${alice.userId}  alice  blocked 2026-\\S+$`));
    expect(await refused('alice', 'messages', 'send', bob.userId, 'Hello?')).toMatchObject({ code: 1, err: NOT_TAKEN });
    expect(await refused('bob', 'messages', 'send', alice.userId, 'Hi')).toMatchObject({ code: 1, err: 'evieverse: you blocked this user: unblock them to send them a message' });
    expect(await refused('bob', 'blocks', 'add', NO_USER)).toMatchObject({ code: 1, err: 'evieverse: user not found' });
    expect(await by('bob', 'blocks', 'remove', alice.userId)).toBe(`You no longer block ${alice.userId}.`);
    expect(await by('bob', 'blocks', 'remove', alice.userId)).toBe(`You didn't block ${alice.userId}.`);
    expect(await by('alice', 'messages', 'send', bob.userId, 'Hello again')).toBe(`Sent to bob (${bob.userId}).`);
    expect(await refused('alice', 'messages', 'send', bob.userId)).toMatchObject({ code: 2, err: 'evieverse: usage: evieverse messages send <userId> <text>' });
  });

  it('bans users, and deletes accounts, for the roles that may', async () => {
    await setup();
    const root = await ctx.register('root');
    await setAdmin(ctx.db, 'root', true);
    const mod = await ctx.register('mod');
    const alice = await ctx.register('alice');
    const bob = await ctx.register('bob');
    const carol = await ctx.register('carol');
    for (const [name, u] of [['root', root], ['mod', mod], ['alice', alice], ['bob', bob], ['carol', carol]] as const) await profile(name, u);
    const by = (name: string, ...args: string[]) => ran(...args, '--profile', name);
    const refused = (name: string, ...args: string[]) => cli([...args, '--profile', name]);
    await by('root', 'server-moderators', 'add', mod.userId);
    const BANNED = "evieverse: your account is banned: you can't post, comment, like or send messages";
    const CONFIRM = "can't be undone: run the command again with --yes to go ahead";

    // Bans are for server moderators and admins.
    expect(await by('mod', 'bans', 'list')).toBe('Nobody is banned.');
    expect(await refused('alice', 'bans', 'list')).toMatchObject({ code: 1, err: 'evieverse: only an admin or a server moderator can do this' });
    expect(await refused('alice', 'bans', 'add', bob.userId)).toMatchObject({ code: 1, err: 'evieverse: only an admin or a server moderator can do this' });
    expect(await by('mod', 'bans', 'add', alice.userId, '--reason', 'Spam\nand more')).toBe(`alice (${alice.userId}) is banned: they can't post, comment, like or send messages.`);
    expect(await by('mod', 'bans', 'add', alice.userId)).toBe(`alice (${alice.userId}) was already banned.`);
    expect(await by('mod', 'bans', 'list')).toMatch(new RegExp(`^${alice.userId}\\s+alice\\s+since 2026-\\S+\\s+by mod\\s+Spam and more$`));
    expect(await json('bans', 'list', '--profile', 'root')).toMatchObject({ banned: [{ userId: alice.userId, reason: 'Spam\nand more', bannedBy: { username: 'mod' } }] });
    expect(await refused('mod', 'bans', 'add', root.userId)).toMatchObject({ code: 1, err: "evieverse: admins and server moderators can't be banned: end their role first" });

    // A banned user is told so by whoami, and is refused by the server what writes.
    expect(await by('alice', 'whoami')).toContain("banned, so you can't post, comment, like or send messages");
    expect(await json('whoami', '--profile', 'alice')).toMatchObject({ banned: true });
    expect(await refused('alice', 'messages', 'send', bob.userId, 'Hi')).toMatchObject({ code: 1, err: BANNED });
    expect(await by('mod', 'bans', 'remove', alice.userId)).toBe(`${alice.userId} is no longer banned.`);
    expect(await by('mod', 'bans', 'remove', alice.userId)).toBe(`${alice.userId} wasn't banned.`);
    expect(await by('mod', 'bans', 'list')).toBe('Nobody is banned.');
    expect(await by('alice', 'messages', 'send', bob.userId, 'Hi')).toBe(`Sent to bob (${bob.userId}).`);

    // Deleting an account can't be undone, so it takes --yes, which is checked before the server is asked.
    expect(await refused('alice', 'account', 'delete')).toMatchObject({ code: 2, err: `evieverse: deleting your account ${CONFIRM}` });
    expect(await refused('root', 'users', 'delete', bob.userId)).toMatchObject({ code: 2, err: `evieverse: deleting an account ${CONFIRM}` });
    expect(await by('bob', 'whoami')).toContain('bob');
    // Another user's account is an admin's to delete.
    expect(await refused('mod', 'users', 'delete', bob.userId, '--yes')).toMatchObject({ code: 1, err: "evieverse: you can only delete your own account, unless you're an admin" });
    expect(await by('root', 'users', 'delete', bob.userId, '--yes')).toBe(`Deleted account ${bob.userId}.`);
    expect(await refused('bob', 'whoami')).toMatchObject({ code: 1 });
    expect(await refused('root', 'users', 'delete', NO_USER, '--yes')).toMatchObject({ code: 1, err: 'evieverse: user not found' });
    expect(await refused('root', 'users', 'delete', root.userId, '--yes')).toMatchObject({ code: 1, err: 'evieverse: this is the only admin: make another user an admin first' });

    // One's own account: the profile goes with it, as it is of no use. With posts, the account waits for their removal.
    expect(await by('alice', 'account', 'delete', '--yes')).toBe(`Deleted account ${alice.userId}.\nRemoved profile "alice" from this machine.`);
    expect(await refused('alice', 'whoami')).toMatchObject({ code: 1 });
    expect(await by('root', 'profiles')).not.toContain('alice');
    await post(ctx, carol, 'Something to remove #news');
    expect(await json('account', 'delete', '--yes', '--profile', 'carol')).toEqual({ profile: 'carol', userId: carol.userId, status: 'pending_deletion', requestedAt: expect.any(String) });
    expect(await refused('carol', 'whoami')).toMatchObject({ code: 1 });
  });

  it('is refused by the server what its key may not do, and shows in its help what it may', async () => {
    await setup();
    const root = await ctx.register('root');
    await setAdmin(ctx.db, 'root', true);
    const carol = await ctx.register('carol');
    const dave = await ctx.register('dave');
    const erin = await ctx.register('erin');
    for (const [name, u] of [['root', root], ['carol', carol], ['dave', dave], ['erin', erin]] as const) await profile(name, u);
    await ran('--profile', 'root', 'moderators', 'add', 'news', carol.userId);
    await ran('--profile', 'root', 'server-moderators', 'add', erin.userId);
    const by = (name: string, ...args: string[]) => cli([...args, '--profile', name]);

    // A moderator of #news: that hashtag's commands, and no other's or an admin's.
    expect(await by('carol', 'mute', 'add', 'news', dave.userId)).toMatchObject({ code: 0 });
    expect(await by('carol', 'words', 'add', '--tag', 'news', 'rumour')).toMatchObject({ code: 0, out: 'rumour' });
    expect(await by('carol', 'mute', 'add', 'sports', dave.userId)).toMatchObject({ code: 1, err: 'evieverse: only an admin or a moderator of #sports can do this' });
    expect(await by('carol', 'words', 'list', '--server')).toMatchObject({ code: 1, err: 'evieverse: only an admin can do this' });
    expect(await by('carol', 'admins', 'grant', carol.userId)).toMatchObject({ code: 1, err: 'evieverse: only an admin can do this' });
    expect(await by('carol', 'queue', 'list')).toMatchObject({ code: 1, err: 'evieverse: only an admin or a server moderator can do this' });
    // A server moderator: the moderation queue, and no hashtag's commands or an admin's.
    expect(await by('erin', 'queue', 'list')).toMatchObject({ code: 0, out: 'The moderation queue is empty.' });
    expect(await by('erin', 'mute', 'add', 'news', dave.userId)).toMatchObject({ code: 1, err: 'evieverse: only an admin or a moderator of #news can do this' });
    expect(await by('erin', 'words', 'list', '--server')).toMatchObject({ code: 1, err: 'evieverse: only an admin can do this' });
    expect(await by('erin', 'server-moderators', 'add', dave.userId)).toMatchObject({ code: 1, err: 'evieverse: only an admin can do this' });
    expect(await by('erin', 'admins', 'grant', erin.userId)).toMatchObject({ code: 1, err: 'evieverse: only an admin can do this' });
    // Someone with no role: neither, and only their own content.
    expect(await by('dave', 'mute', 'list', 'news')).toMatchObject({ code: 1, err: 'evieverse: only an admin or a moderator of #news can do this' });
    expect(await by('dave', 'admins', 'list')).toMatchObject({ code: 1, err: 'evieverse: only an admin can do this' });
    const contentId = await post(ctx, carol, "carol's #sports");
    expect(await by('dave', 'content', 'delete', contentId)).toMatchObject({ code: 1, err: 'evieverse: only the original publisher or an admin can delete this content' });
    expect(await by('carol', 'content', 'delete', contentId)).toMatchObject({ code: 0 });

    const marks = async (name: string) => {
      const help = (await by(name, 'help')).out;
      const mark = (command: string) => new RegExp(`^  ([+-]) ${command}`, 'm').exec(help)?.[1];
      return { profile: help.split('\n').find((line) => line.startsWith('Profile')), marks: ['whoami', 'mute add', 'queue accept', 'server-moderators add', 'admins grant'].map(mark).join('') };
    };
    expect(await marks('root')).toEqual({ profile: `Profile "root": root on ${SERVER}, an admin`, marks: '+++++' });
    expect(await marks('carol')).toEqual({ profile: `Profile "carol": carol on ${SERVER}, moderator of #news`, marks: '++---' });
    expect(await marks('erin')).toEqual({ profile: `Profile "erin": erin on ${SERVER}, a server moderator`, marks: '+-+--' });
    expect(await marks('dave')).toEqual({ profile: `Profile "dave": dave on ${SERVER}, no moderation role`, marks: '+----' });
    // The two kinds of moderator are apart, and one user can be both.
    await ran('--profile', 'root', 'moderators', 'add', 'sports', erin.userId);
    expect(await marks('erin')).toEqual({ profile: `Profile "erin": erin on ${SERVER}, a server moderator, and moderator of #sports`, marks: '+++--' });
    const help = (await by('erin', 'help')).out;
    expect(help.indexOf('For server moderators, and admins')).toBeGreaterThan(help.indexOf("For a hashtag's moderators (you moderate #sports), and admins on every hashtag"));
    expect(help.indexOf('For admins')).toBeGreaterThan(help.indexOf('For server moderators, and admins'));

    // With no profile to ask about, the commands are listed unmarked; and a command that isn't one says how it's used.
    const unmarked = (await cli(['--help'])).out;
    expect(unmarked).toContain('\n  admins grant <userId> ');
    expect(unmarked).not.toMatch(/^Profile|^  [+-] /m);
    expect(await by('root', 'admins')).toMatchObject({ code: 2, err: 'evieverse: `admins` is followed by one of: list, grant, revoke' });
    expect(await by('root', 'frobnicate')).toMatchObject({ code: 2, err: 'evieverse: there is no command `frobnicate`: `evieverse help` lists them' });
    expect(await by('root', 'admins', 'grant')).toMatchObject({ code: 2, err: 'evieverse: usage: evieverse admins grant <userId>' });
    expect(await by('root', 'words', 'add', '--tag', 'news')).toMatchObject({ code: 2, err: 'evieverse: usage: evieverse words add (--tag <tag> | --server) <word>...' });
    expect(await by('root', 'words', 'list')).toMatchObject({ code: 2, err: 'evieverse: name one list: --tag <tag> for a hashtag, or --server for the whole server' });
    expect(await by('root', 'mute', 'list', 'news', '--force')).toMatchObject({ code: 2, err: 'evieverse: usage: evieverse mute list <tag> [--limit <n>] [--cursor <cursor>]' });
    expect((await cli(['--version'])).out).toBe(`evieverse dev (build ${BUILD})`);
  });

  it('reposts a post by its id, and a post on another server by its address, which it reads from that server', async () => {
    const OTHER = 'https://other.example';
    await setup();
    const other = await createTestContext(TARGETS[0]!, { publicBaseUrl: OTHER });
    try {
      const [alice, bob, carol] = await Promise.all(['alice', 'bob', 'carol'].map((name) => ctx.register(name)));
      const [dana, erin] = await Promise.all(['dana', 'erin'].map((name) => other.register(name)));
      for (const [name, u] of [['alice', alice], ['bob', bob], ['carol', carol]] as const) await profile(name, u!);
      await writeProfile(home, 'erin', { server: OTHER, ...erin! });
      // Two servers: each is asked what is addressed to it.
      const asked: [method: string, path: string, headers: string[]][] = [];
      const fetch: Io['fetch'] = async (input, init) => {
        const url = new URL(String(input));
        if (url.origin === SERVER) return fetchFrom(ctx.app)(input, init);
        expect(url.origin).toBe(OTHER);
        const headers = (init?.headers ?? {}) as Record<string, string>;
        asked.push([init?.method ?? 'GET', url.pathname, Object.keys(headers).sort()]);
        const res = await other.app.inject({ method: (init?.method ?? 'GET') as 'GET', url: `${url.pathname}${url.search}`, headers, ...(init?.body != null && { payload: init.body as string }) });
        return new Response(res.rawPayload, { status: res.statusCode, headers: { 'content-type': String(res.headers['content-type'] ?? '') } });
      };
      const by = (name: string, ...args: string[]) => cli([...args, '--profile', name], { fetch });
      const done = async (name: string, ...args: string[]) => {
        const res = await by(name, ...args);
        expect(res, res.err).toMatchObject({ code: 0, err: '' });
        return res.out;
      };
      const read = async (server: TestContext, contentId: string) => (await server.app.inject({ method: 'GET', url: `/content/${contentId}` })).json();

      // A post on the profile's own server, by its id or by its address.
      const contentId = await post(ctx, alice!, 'Flooding downtown #news');
      expect(await done('bob', 'repost', contentId, '--tags', 'Weather, #news')).toBe(`Reposted ${contentId} under #weather.\nNot #news: the post has it already.`);
      ctx.clock.now += 1000;
      expect(await done('carol', 'repost', `${SERVER}/content/${contentId.toUpperCase()}`, '--tags', 'rain')).toBe(`Reposted ${contentId} under #rain.`);
      expect(asked).toEqual([]);
      await ctx.compact();
      expect((await read(ctx, contentId)).tags).toEqual(['news', 'weather', 'rain']);
      expect(await by('alice', 'repost', contentId, '--tags', 'storms')).toMatchObject({ code: 1, err: "evieverse: you can't repost your own post: update it to give it other hashtags" });
      expect(await by('bob', 'repost', contentId, '--tags', 'storms')).toMatchObject({ code: 1, err: 'evieverse: you already reposted this post' });
      expect(await by('bob', 'repost', NO_USER, '--tags', 'storms')).toMatchObject({ code: 1, err: 'evieverse: content not found' });

      // A post on another server: the CLI reads it there, with no key, and sends what it read to its own server.
      const original = await post(other, dana!, 'Sunset over the bay #pics');
      const address = `${OTHER}/content/${original}`;
      const made = /^Reposted (\S+) under #pics: it is (\S+) here\.$/.exec(await done('bob', 'repost', address, '--tags', 'pics'));
      expect(made?.[1]).toBe(address);
      const entry = made![2]!;
      expect(asked).toEqual([['GET', `/content/${original}`, ['accept']]]);
      expect(await read(ctx, entry)).toMatchObject({
        publisher: { userId: bob!.userId, username: 'bob' },
        mimeType: 'text/plain',
        preview: { kind: 'text', text: 'Sunset over the bay #pics' },
        tags: ['pics'],
        origin: { url: address, publisher: { userId: dana!.userId, username: 'dana' } },
      });
      // The server has one entry for it, which the next repost of the address gives hashtags.
      expect(await done('carol', 'repost', address, '--tags', 'art, pics')).toBe(`Reposted ${entry} under #art.\nNot #pics: the post has it already.`);
      expect(await by('bob', 'repost', address, '--tags', 'art')).toMatchObject({ code: 1, err: 'evieverse: you already reposted this post' });
      const data = JSON.parse(await done('alice', 'repost', address, '--tags', 'sunsets', '--json'));
      expect(data).toMatchObject({ contentId: entry, tags: ['sunsets'] });

      // The entry's own address names the original, so that is what a repost of it from elsewhere is of: here, a post on erin's own server.
      asked.length = 0;
      expect(await done('erin', 'repost', `${SERVER}/content/${entry}`, '--tags', 'art')).toBe(`Reposted ${original} under #art.`);
      expect(asked.map(([method, path]) => `${method} ${path}`)).toContain('POST /repost');
      await other.compact();
      expect((await read(other, original)).tags).toEqual(['pics', 'art']);

      // What isn't a post's address, or has no post at it, is said before the server is asked for anything.
      const NOT_AN_ADDRESS = (address: string) => `evieverse: "${address}" is not the address of a post, such as https://other.example/content/<id>`;
      for (const bad of [`${OTHER}/posts/${original}`, `${address}/raw`, `${address}?a=b`, `${OTHER}/content/1`]) {
        expect(await by('bob', 'repost', bad, '--tags', 'pics')).toMatchObject({ code: 2, err: NOT_AN_ADDRESS(bad) });
      }
      expect(await by('bob', 'repost', `${OTHER}/content/${NO_USER}`, '--tags', 'pics')).toMatchObject({ code: 1, err: `evieverse: there is no post at ${OTHER}/content/${NO_USER}` });
      expect(await by('bob', 'repost', `${OTHER}/users/../content/${NO_USER}`, '--tags', 'pics')).toMatchObject({ code: 1 });
      expect(await by('bob', 'repost', contentId)).toMatchObject({ code: 2, err: 'evieverse: name the hashtags the repost gives the post: --tags "news, mumbai"' });
      expect(await by('bob', 'repost', '--tags', 'pics')).toMatchObject({ code: 2, err: 'evieverse: usage: evieverse repost <post> --tags <tags>' });
      expect((await cli(['--help'])).out).toContain('\n  repost <post> --tags <tags> ');
    } finally {
      await other.close();
    }
  });

  it("says that a repost was challenged, which it can't show", async () => {
    await setup({ challenge: { postWindowSeconds: 60 } });
    const [alice, bob] = await Promise.all(['alice', 'bob'].map((name) => ctx.register(name)));
    await profile('bob', bob!);
    const contentId = await post(ctx, alice!, 'Flooding downtown #news');
    await post(ctx, bob!, 'Bob was here #local');
    expect(await cli(['repost', contentId, '--tags', 'weather', '--profile', 'bob'])).toMatchObject({
      code: 1,
      err: "evieverse: you posted or were challenged less than 60 seconds ago; solve the challenge to post. The CLI can't show a challenge: repost again later, or with a client that shows its image",
    });
    ctx.clock.now += 61_000;
    expect(await ran('repost', contentId, '--tags', 'weather', '--profile', 'bob')).toBe(`Reposted ${contentId} under #weather.`);
  });

  it('replaces itself with the build the server ships when the server asks, and runs the command again', async () => {
    const shipped = release();
    await setup({ cli: shipped });
    const alice = await ctx.register('alice');
    await profile('alice', alice);
    const selfPath = join(home, 'evieverse.mjs');
    const installed = () => readFile(selfPath, 'utf8');
    await writeFile(selfPath, 'the build before', { mode: 0o755 });

    // Any command the server refuses for the build: the file is replaced, and the same arguments run again.
    const updated = await cli(['whoami', '--json'], { selfPath });
    expect(updated).toMatchObject({ code: 0, out: '', reruns: [['whoami', '--json']] });
    expect(updated.err).toBe(`evieverse: ${SERVER} needs version 9.9.9 (build feedfacefeedface) of the CLI; updating...`);
    expect(await installed()).toBe(shipped.bundle.toString());
    if (process.platform !== 'win32') expect((await stat(selfPath)).mode & 0o777).toBe(0o755);
    // The exit code is the second run's.
    expect((await cli(['whoami'], { selfPath, rerun: async () => 7 })).code).toBe(7);

    // Asked again right after an update, it stops instead of going round.
    await writeFile(selfPath, 'the build before');
    const again = await cli(['whoami'], { selfPath, env: { [UPDATED]: '1' } });
    expect(again).toMatchObject({ code: 1, reruns: [] });
    expect(again.err).toContain('asked for another build of the CLI (feedfacefeedface) right after an update');
    expect(await installed()).toBe('the build before');

    // A download that isn't the build the server named is left where it was.
    const other = fetchFrom(ctx.app);
    const cut: typeof fetch = async (input, init) => (String(input).endsWith('.mjs') ? new Response(shipped.bundle.subarray(0, 10)) : other(input, init));
    const refused = await cli(['whoami'], { selfPath, fetch: cut });
    expect(refused).toMatchObject({ code: 1, reruns: [] });
    expect(refused.err).toContain("isn't build feedfacefeedface");
    expect(await installed()).toBe('the build before');

    // Run from source there's no file to replace; `update` says the same, and `version` and `help` need no server.
    const source = await cli(['whoami']);
    expect(source).toMatchObject({ code: 1, reruns: [] });
    expect(source.err).toContain("a copy run from source can't update itself");
    expect((await cli(['update'])).err).toContain("a copy run from source can't update itself");
    expect(await cli(['version'])).toMatchObject({ code: 0 });
    expect((await cli(['help'])).out).toContain('For admins');

    // `update` does the same without being asked.
    expect(await cli(['update'], { selfPath })).toMatchObject({ code: 0, out: 'Updated to 9.9.9 (build feedfacefeedface).', reruns: [] });
    expect(await installed()).toBe(shipped.bundle.toString());
  });

  it.skipIf(process.platform === 'win32')('installs from the server with one command, and keeps itself the build the server ships', async () => {
    // The CLI as a build makes it, served by a server that listens, to a machine that has only node.
    home = await mkdtemp(join(tmpdir(), 'evieverse-cli-'));
    const built = join(home, 'built');
    await exec(process.execPath, [join(ROOT, 'scripts', 'build-cli.mjs'), built]);
    const shipped = loadCliRelease(built)!;
    expect(shipped.build).toMatch(/^[0-9a-f]{16}$/);
    ctx = await createTestContext(TARGETS[0]!, { cli: shipped });
    const server = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const alice = await ctx.register('alice');
    await writeProfile(home, 'alice', { server, ...alice });
    const env = { ...process.env, EVIEVERSE_HOME: home, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}` };
    const evieverse = join(home, 'bin', 'evieverse');
    const whoami = { profile: 'alice', server, userId: alice.userId, username: 'alice', language: 'en', admin: false, moderator: false, moderates: [], messages: true, showFollowing: false, showFollowers: false, banned: false };

    const install = await exec('sh', ['-c', `curl -fsSL ${server}/cli/install.sh | sh`], { env });
    expect(install.stdout).toContain(`Installed evieverse ${shipped.version} in ${join(home, 'bin')}`);
    const file = join(home, 'bin', 'evieverse.mjs');
    expect((await readFile(file)).equals(shipped.bundle)).toBe(true);
    expect((await exec(evieverse, ['version'], { env })).stdout).toBe(`evieverse ${shipped.version} (build ${shipped.build})\n`);
    expect(JSON.parse((await exec(evieverse, ['whoami', '--json'], { env })).stdout)).toEqual(whoami);

    // The same file from an earlier build: its next command updates it, and then runs.
    await writeFile(file, shipped.bundle.toString().replaceAll(shipped.build, '0'.repeat(16)));
    expect((await exec(evieverse, ['version'], { env })).stdout).toContain('build 0000000000000000');
    const updated = await exec(evieverse, ['whoami', '--json'], { env });
    expect(updated.stderr).toContain(`needs version ${shipped.version} (build ${shipped.build}) of the CLI; updating...`);
    expect(JSON.parse(updated.stdout)).toEqual(whoami);
    expect((await readFile(file)).equals(shipped.bundle)).toBe(true);
  });
});
