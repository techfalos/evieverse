import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';
import type { InjectOptions } from 'fastify';
import { Redis } from 'ioredis';
import { sql } from 'kysely';
import { expect } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AuditRecord } from '../src/audit.types.js';
import { challengeKey, leadingZeroBits } from '../src/challenge/challenges.js';
import type { Challenge } from '../src/challenge/challenges.types.js';
import { loadConfig, type Config } from '../src/config.js';
import { createDb, type Db } from '../src/db/index.js';
import { bootstrap } from '../src/deps.js';
import type { Languages } from '../src/language.js';
import type { KeyFetcher } from '../src/originKeys.js';
import { createHotStore, type HotStore } from '../src/storage/index.js';
import { openTrust } from '../src/moderation/trust.js';
import type { TestPlugin } from '../src/moderation/trust.types.js';
import type { CliRelease } from '../src/routes/cli.types.js';
import { startHarness, type Fetchers } from './harness.js';

/**
 * The Redis or Valkey every test runs against, as every server does: TEST_REDIS_URL, or the one
 * `docker compose up -d redis` starts. Tests share it, each under a key prefix of its own.
 */
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379';

/**
 * The environment of a test that reads the settings as a server would (`loadConfig({}, BASE_ENV)`):
 * no config file, and nothing of this machine's but where Redis is, which no server starts without.
 */
export const BASE_ENV = { EVIEVERSE_CONFIG: '/nonexistent.json', REDIS_URL: TEST_REDIS_URL };

export interface TestTarget {
  name: string;
  dialect: 'sqlite' | 'postgres' | 'mysql';
  /**
   * The database's URL. For SQLite it is `:memory:`, which is for a test that opens the database
   * itself: a test context has a file of its own instead (see createTestContext), so that a
   * second process can open it.
   */
  url: string;
}

/**
 * SQLite always runs. Set TEST_POSTGRES_URL / TEST_MYSQL_URL for those databases. Each runs
 * against the Redis at TEST_REDIS_URL.
 */
export const TARGETS: TestTarget[] = [
  { name: 'sqlite', dialect: 'sqlite', url: ':memory:' },
  ...(process.env.TEST_POSTGRES_URL ? [{ name: 'postgres', dialect: 'postgres' as const, url: process.env.TEST_POSTGRES_URL }] : []),
  ...(process.env.TEST_MYSQL_URL ? [{ name: 'mysql', dialect: 'mysql' as const, url: process.env.TEST_MYSQL_URL }] : []),
];

/**
 * Redis as a test itself reads it, past what the hot store tells: which keys there are under
 * `keyPrefix`, and how long they have left. Over a connection of its own, which `close` ends.
 */
export function redisView(keyPrefix: string) {
  const redis = new Redis(TEST_REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
  return {
    /** The keys that match `pattern` (a glob, such as `limit:*`), without the prefix, sorted. */
    async keys(pattern: string): Promise<string[]> {
      const found: string[] = [];
      for await (const page of redis.scanStream({ match: `${keyPrefix}${pattern}`, count: 500 }) as AsyncIterable<string[]>) found.push(...page);
      return [...new Set(found)].map((key) => key.slice(keyPrefix.length)).sort();
    },
    /**
     * How long each key has left, in ms, by Redis's own clock, which is the one keys expire by:
     * a test's clock moves nothing there. -1: the key never expires. -2: there is no such key.
     */
    async ttl(names: string[]): Promise<number[]> {
      if (!names.length) return [];
      const p = redis.pipeline();
      for (const name of names) p.pttl(`${keyPrefix}${name}`);
      return ((await p.exec()) ?? []).map(([err, left]) => {
        if (err) throw err;
        return left as number;
      });
    },
    close() {
      redis.disconnect();
    },
  };
}

/**
 * A hot store of a test's own, for one that needs no test context: the tests' Redis, under a key
 * prefix nothing else has, with `ttl` to read how long its keys have left (see redisView).
 * `close` deletes what the test left there.
 */
export function testHotStore() {
  const keyPrefix = `test:${randomUUID()}:`;
  const hot = createHotStore({ url: TEST_REDIS_URL, keyPrefix });
  const view = redisView(keyPrefix);
  return {
    hot,
    ttl: view.ttl,
    async close() {
      await hot.clear();
      await hot.close();
      view.close();
    },
  };
}

export const TABLES = [
  'pinned_posts',
  'search_terms',
  'monetization',
  'inbox',
  'server_rules',
  'user_blocks',
  'comment_reports',
  'comment_queue',
  'reports',
  'tag_moderation_log',
  'tag_moderation',
  'moderation_queue',
  'blocked_words',
  'tag_rules',
  'tag_claims',
  'tag_mutes',
  'tag_moderators',
  'follows',
  'likes',
  'dislikes',
  'repost_removals',
  'reposts',
  'staged_removals',
  'quarantine_access',
  'quarantine',
  'media_jobs',
  'pending_writes',
  // What 0004_unnumbered_writes leaves behind if it stops halfway, where a database commits each statement of a migration.
  'pending_writes_keyed',
  'feed_queue',
  'compactor_lease',
  'tag_pairs',
  'tags',
  'content',
  'api_keys',
  'users',
  'kysely_migration',
  'kysely_migration_lock',
];

/** Drops every table of the schema, and what the migrations keep of themselves. */
export async function resetDatabase(db: Db, dialect: TestTarget['dialect']) {
  if (dialect === 'mysql') await sql`SET FOREIGN_KEY_CHECKS = 0`.execute(db);
  for (const t of TABLES) await db.schema.dropTable(t).ifExists().execute();
  if (dialect === 'mysql') await sql`SET FOREIGN_KEY_CHECKS = 1`.execute(db);
}

/** A nonce that makes the SHA-256 of `prefix + nonce` start with `bits` zero bits, as a client finds it. */
export function proofOfWork({ prefix, bits }: Challenge['proofOfWork']): string {
  for (let n = 0; ; n++) {
    if (leadingZeroBits(createHash('sha256').update(`${prefix}${n}`).digest()) >= bits) return String(n);
  }
}

/**
 * What a person and their client send back for a challenge: its characters, read here from `hot`,
 * where the server keeps them, and the proof of work.
 */
export async function solution(hot: Pick<HotStore, 'get'>, challenge: Challenge) {
  const issued = await hot.get(challengeKey(challenge.id));
  return {
    challengeId: challenge.id,
    challengeAnswer: (JSON.parse(issued!.toString('utf8')) as { answer: string }).answer,
    challengeNonce: proofOfWork(challenge.proofOfWork),
  };
}

/** The #hashtags written in a post's text, which tests send as its tags. */
export const hashtags = (text: string) => [...text.matchAll(/#(\w+)/g)].map((m) => m[1]!);

/** The feed queue: "<contentId> <tag>" of every row, sorted. What the compactor's next run takes. */
export const queued = async (ctx: { db: Db }) =>
  (await ctx.db.selectFrom('feed_queue').select(['content_id', 'tag']).execute()).map((r) => `${r.content_id} ${r.tag}`).sort();

/**
 * Registering takes a challenge, as on any server, which `register` and `registration` solve. Its
 * proof of work is quick enough for tests, and an answer is accepted at once, so solving one leaves
 * the clock where it was, unless `challenge` says otherwise. The limits on posts and on comments a
 * minute are off, unless `postRateLimitPerMinute` and `comments` set them. So is the limit on
 * registrations from one address, which every test's are, unless `registerRateLimitPerHour` sets
 * one, and so are the limits on feeds, by address and at a time, unless `feed` sets them
 * (`rateLimitPerMinute`, `maxConcurrent`).
 *
 * A request commits what it writes of posts and comments to the database, and the compactor
 * writes the stores (`pending_writes`). Here those writes are applied as soon as the request that
 * made them is answered (see `apply`), as if a compactor ran just then, so a test reads what it
 * wrote without running one: feeds still wait for `compact`. `settle: false` leaves them to the
 * compactor, or to the test's own `apply`, which is how the time in between is tested.
 */
export async function createTestContext(
  target: TestTarget,
  opts: {
    /** Whether the writes a request committed are applied once it is answered. They are, unless this is false. */
    settle?: boolean;
    feed?: Record<string, number>;
    /** Writes the audit log, to `audit/` in the test's directory (see readAudit). Off unless asked for. */
    audit?: boolean;
    publicBaseUrl?: string;
    challenge?: Partial<Config['challenge']>;
    /** How posts are tagged, and the settings of claims. Requests to a hashtag's log from one address have no limit, unless `logRateLimitPerMinute` sets one. */
    tagging?: Partial<Config['tagging']>;
    /** The types of post the server takes: all of them, but for the ones turned off here. */
    postTypes?: Partial<Config['postTypes']>;
    /** The trust scores that have a post refused, queued or published; the server's defaults unless given. */
    trust?: Partial<Config['trust']>;
    /** What the urlhaus trust plugin downloads its list with. No Auth-Key, so the plugin is off, unless given. */
    urlhaus?: Partial<Config['urlhaus']>;
    /** Where the pdq trust plugin reads its list of hashes, and how it matches. No list, so the plugin is off, unless given. */
    pdq?: Partial<Config['pdq']>;
    /** Keeps the files that match the pdq plugin's list, in `quarantine/` in the test's directory: with true, or with how long a reported file is kept. Off unless asked for. */
    quarantine?: boolean | Pick<Config['quarantine'], 'retentionDays'>;
    /** Requests to /register from one address in an hour, of which a registration takes two. More than any test makes, unless given. */
    registerRateLimitPerHour?: number;
    postRateLimitPerMinute?: number;
    maxFollowing?: number;
    /** The posts a user can report in an hour; the server's default unless given. */
    reportsPerHour?: number;
    /** The limit on messages a minute and how long inboxes keep them; the server's defaults unless given. */
    inbox?: Partial<Config['inbox']>;
    /** The pages of their export a user can read in a minute; the server's default unless given. */
    export?: Partial<Config['export']>;
    /** The limit on comments a minute, which tests have none of unless they say, and how long Redis keeps comments. */
    comments?: Partial<Config['comments']>;
    /** Where the server shows its ads: in hashtag feeds, at the end of posts. Nowhere unless given. */
    monetization?: Partial<Config['monetization']>;
    /** The modification disclosure GET /rules gives: that the server runs a modified version, which needs `sourceUrl`. A release, unless given. */
    modified?: boolean;
    /** Where the server says its source code can be obtained. Nowhere, unless given. */
    sourceUrl?: string;
    /** The address GET /rules gives to write to for support. The server's default, unless given. */
    supportEmail?: string;
    /** The minimum age GET /rules gives, in years. None, unless given. */
    minimumAge?: number;
    /** What GET /rules says of content made with generative AI. The server's default, unless given. */
    genAi?: Config['genAi'];
    corsOrigins?: string | string[];
    compact?: Partial<Config['compact']>;
    /**
     * Whether the server processes the videos it is sent, and how (compactor/src/video). It doesn't,
     * unless asked: the "videos" tests post are a few bytes, which no ffmpeg reads. A test that
     * asks runs the worker itself (see `processVideo`).
     */
    video?: Partial<Config['video']>;
    /** The connections the server keeps to its database, for a test of requests that are under way together. 4, unless given. */
    poolSize?: number;
    /** Replaces the content store, which is otherwise a directory of the test's own. */
    content?: { scheme: string; options: Record<string, string> };
    maxUploadBytes?: number;
    uploadLinksPerMinute?: number;
    trustProxy?: number | boolean | string;
    /** The CLI the server ships. Tests ship none unless they say, whatever was last built. */
    cli?: CliRelease;
    /** Trust plugins the test describes, in place of the server's own (compactor/crates/trust/src/testing.rs). */
    trustPlugins?: TestPlugin[];
    /** Trust plugins the test describes, which run after the server's own. */
    moreTrustPlugins?: TestPlugin[];
    /** The languages the server answers in, in place of its own (the languages folder). */
    languages?: Languages;
    /** Whether the server takes reposts, and the keys it signs its posts' attestations with: none, unless given. */
    reposts?: Partial<Config['reposts']>;
    /** What answers for the other servers this one asks for their keys. Nothing does unless given: a test reaches no other server. */
    keyFetcher?: KeyFetcher;
    /** What answers for the other servers this one asks for the attestations of their posts (see `sweep`). Nothing does unless given. */
    attestationFetcher?: Fetchers['attestation'];
    /** Whether posts can be disliked, and say how many dislike them (`dislikes` in the configuration). They can't, unless given. */
    dislikes?: boolean;
    /** Requests to GET /content/:id from one address in a minute. No limit, unless given. */
    contentRateLimitPerMinute?: number;
    /** Requests to GET /users/:userId/posts from one address in a minute. No limit, unless given. */
    profilePostsRateLimitPerMinute?: number;
    /** Requests to GET /users/:userId/avatar from one address in a minute. No limit, unless given. */
    avatarRateLimitPerMinute?: number;
    /** Searches from one address in a minute, which tests have no limit on unless they say, and the most words a post is found by. */
    search?: Partial<Config['search']>;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'evieverse-test-'));
  const keyPrefix = `test:${dir.split('/').pop()}:`;
  // What the test's settings are, beside the defaults: the server's here, and the compactor's, which reads them from a file.
  const overrides = {
    logLevel: 'silent',
    publicBaseUrl: opts.publicBaseUrl ?? '',
    // Each test gets its own key prefix, so tests can share one Redis.
    redis: { url: TEST_REDIS_URL, keyPrefix },
    // And its own SQLite file, which a second process can open, as the compactor's does.
    db: { dialect: target.dialect, url: target.dialect === 'sqlite' ? join(dir, 'db.sqlite') : target.url, poolSize: opts.poolSize ?? 4 },
    storage: {
      content: opts.content ?? { scheme: 'fs', options: { root: join(dir, 'content') } },
      summaries: { scheme: 'fs', options: { root: join(dir, 'summaries') } },
      tmpPath: join(dir, 'tmp'),
      ...(opts.maxUploadBytes && { maxUploadBytes: opts.maxUploadBytes }),
      ...(opts.uploadLinksPerMinute !== undefined && { uploadLinksPerMinute: opts.uploadLinksPerMinute }),
    },
    ...(opts.audit && { audit: { scheme: 'fs', options: { root: join(dir, 'audit') } } }),
    feed: { headCacheMs: 0, rateLimitPerMinute: 0, followingRateLimitPerMinute: 0, maxConcurrent: 0, ...opts.feed },
    contentRateLimitPerMinute: opts.contentRateLimitPerMinute ?? 0,
    profilePostsRateLimitPerMinute: opts.profilePostsRateLimitPerMinute ?? 0,
    avatarRateLimitPerMinute: opts.avatarRateLimitPerMinute ?? 0,
    search: { rateLimitPerMinute: 0, ...opts.search },
    challenge: { powBits: 8, minSolveMs: 0, ...opts.challenge },
    tagging: { logRateLimitPerMinute: 0, ...opts.tagging },
    ...(opts.postTypes && { postTypes: opts.postTypes }),
    reposts: { attestationRateLimitPerMinute: 0, ...opts.reposts },
    ...(opts.dislikes !== undefined && { dislikes: opts.dislikes }),
    ...(opts.trust && { trust: opts.trust }),
    ...(opts.urlhaus && { urlhaus: opts.urlhaus }),
    ...(opts.pdq && { pdq: opts.pdq }),
    ...(opts.quarantine && { quarantine: { scheme: 'fs', options: { root: join(dir, 'quarantine') }, ...(opts.quarantine !== true && opts.quarantine) } }),
    registerRateLimitPerHour: opts.registerRateLimitPerHour ?? 1_000_000,
    postRateLimitPerMinute: opts.postRateLimitPerMinute ?? 0,
    ...(opts.maxFollowing && { maxFollowing: opts.maxFollowing }),
    ...(opts.reportsPerHour !== undefined && { reportsPerHour: opts.reportsPerHour }),
    ...(opts.inbox && { inbox: opts.inbox }),
    ...(opts.export && { export: opts.export }),
    comments: { perMinute: 0, listRateLimitPerMinute: 0, ...opts.comments },
    ...(opts.monetization && { monetization: opts.monetization }),
    ...(opts.modified !== undefined && { modified: opts.modified }),
    ...(opts.sourceUrl !== undefined && { sourceUrl: opts.sourceUrl }),
    ...(opts.supportEmail !== undefined && { supportEmail: opts.supportEmail }),
    ...(opts.minimumAge !== undefined && { minimumAge: opts.minimumAge }),
    ...(opts.genAi !== undefined && { genAi: opts.genAi }),
    ...(opts.corsOrigins && { corsOrigins: opts.corsOrigins }),
    ...(opts.compact && { compact: opts.compact }),
    video: { processing: false, ...opts.video },
    ...(opts.trustProxy !== undefined && { trustProxy: opts.trustProxy }),
  };
  const config = loadConfig(overrides, {});
  if (target.dialect !== 'sqlite') {
    const db = await createDb(config.db);
    await resetDatabase(db, target.dialect);
    await db.destroy();
  }

  const clock = { now: Date.UTC(2026, 10, 6, 12) };
  const { close, ...deps } = await bootstrap(config, () => clock.now);
  const unreached = async (address: string) => Promise.reject(new Error(`a test asked ${address}, and no test reaches another server`));
  const keyFetcher = opts.keyFetcher ?? unreached;
  // The trust plugins the app scores with, and the compactor's process too: the server's own, or the ones the test describes.
  const plugins = { testPlugins: opts.trustPlugins ?? opts.moreTrustPlugins, onlyTestPlugins: opts.trustPlugins !== undefined };
  const trust = openTrust(config, undefined, plugins);
  const app = await buildApp(deps, {
    logger: false,
    cli: opts.cli ?? null,
    trust,
    languages: opts.languages,
    keyFetcher,
  });

  // The compactor: the Rust binary, as a process of this test's own, which takes what the test asks of it and tells
  // the time by the test's clock (see test/harness.ts). The schema is there by now: `bootstrap` brought it up to date.
  // What it would ask other servers (their keys, the attestations of their posts), it asks the test.
  const compactor = await startHarness(dir, overrides, clock, { fetchers: { keys: keyFetcher, attestation: opts.attestationFetcher }, plugins });
  const graceMs = config.compact.graceSeconds * 1000;

  // One at a time, in the order they were asked for, as a compactor's runs are.
  let applying: Promise<unknown> = Promise.resolve();
  /**
   * Applies the writes that requests committed, as a compactor run starts by doing, and nothing
   * else of a run: no index is built, and the clock stays where it is. Under the compactor's
   * lease, as a run is. False, with nothing applied, if a run holds it.
   */
  const apply = (): Promise<boolean> => {
    const run = applying.then(() => compactor.apply());
    applying = run.catch(() => {});
    return run;
  };
  if (opts.settle !== false) {
    const inject = app.inject.bind(app) as (o: InjectOptions) => ReturnType<typeof app.inject>;
    (app as { inject: unknown }).inject = async (o: InjectOptions) => {
      const res = await inject(o);
      if ((o.method ?? 'GET').toUpperCase() !== 'GET') await apply();
      return res;
    };
  }

  /**
   * What a person and their client send back: the characters (read from Redis here), and the proof of
   * work. The clock moves on by `thinkMs` first, the shortest time an answer is accepted after by default.
   */
  async function solve(challenge: Challenge, thinkMs = config.challenge.minSolveMs) {
    const solved = await solution(deps.hot, challenge);
    clock.now += thinkMs;
    return solved;
  }

  // Redis as the test itself reads it: which of its keys there are, and how long they have left.
  const view = redisView(keyPrefix);
  const { keys, ttl } = view;
  /**
   * Has keys expire now, as they do when their time is up, and returns how long each had left,
   * by its name: how a test gets past a window that Redis keeps the time of, and learns what the
   * window was. The keys are the ones named, or the ones that match a pattern (see `keys`). Each
   * must be there and be a key that expires: one that doesn't is ended by no amount of time, and
   * the test is told so.
   */
  async function lapse(which: string | string[]): Promise<Record<string, number>> {
    const names = typeof which === 'string' ? await keys(which) : which;
    const left = await ttl(names);
    const lasting = names.filter((_, i) => left[i]! < 0);
    if (lasting.length) throw new Error(`these keys are missing or never expire, so no time would end them: ${lasting.join(', ')}`);
    await deps.hot.expire(names, 1);
    while ((await deps.hot.exists(names)).some(Boolean)) await sleep(2);
    return Object.fromEntries(names.map((name, i) => [name, left[i]!]));
  }

  /**
   * POST /register as a person sends it: again with the challenge solved, when the request is
   * answered with one. Returns the last response, whatever it is.
   */
  async function registration(payload: Record<string, unknown>, headers: Record<string, string> = {}) {
    const asked = await app.inject({ method: 'POST', url: '/register', payload, headers });
    if (asked.statusCode !== 428) return asked;
    return app.inject({ method: 'POST', url: '/register', payload: { ...payload, ...(await solve(asked.json().challenge)) }, headers });
  }

  return {
    app,
    clock,
    dir,
    ...deps,
    /** The server's trust plugins: `trust.seen()` is what the ones that record were shown. */
    trust,
    /**
     * The compactor, which is a process of its own: `runOnce` makes a pass, `start` has it make pass after pass, and
     * `watch` shows the test the calls it makes to its stores, which the test's own `hot`, `content` and `comments`
     * (the server's) are not.
     */
    compactor,
    apply,
    /**
     * One look of the server's own asking after reposts' originals (compactor/src/sweep.rs):
     * asks `attestationFetcher` about every entry that is due, and applies what that
     * committed. Returns how many entries were due.
     */
    async sweep() {
      const due = await compactor.sweep();
      if (opts.settle !== false) await apply();
      return due;
    },
    /**
     * Has the video worker take the oldest video that waits and process it
     * (compactor/src/video/worker.rs), and applies what that committed. False if no video waited.
     */
    async processVideo() {
      const took = await compactor.video();
      if (took && opts.settle !== false) await apply();
      return took;
    },
    /**
     * Runs one compaction pass, which is what puts writes in feeds, with the clock moved past the
     * grace period first: the run then takes everything there is to take, the hashtag counts too.
     * A write needs no such wait: `compactor.runOnce()` takes it as it is.
     */
    async compact(extraMs = 0) {
      clock.now += graceMs + 1000 + extraMs;
      return compactor.runOnce();
    },
    solve,
    keys,
    ttl,
    lapse,
    registration,
    /** Registers a user, solving the challenge the server asks for. */
    async register(username: string) {
      const res = await registration({ username });
      expect(res.statusCode, res.body).toBe(201);
      return res.json() as { userId: string; apiKey: string };
    },
    async close() {
      await app.close();
      await trust.close();
      await compactor.close();
      await deps.hot.clear();
      view.close();
      await close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export type TestContext = Awaited<ReturnType<typeof createTestContext>>;

/** Every record of the audit log (see `audit` of createTestContext), oldest first, with the file it is in. */
export async function readAudit(ctx: Pick<TestContext, 'dir'>): Promise<(AuditRecord & { key: string })[]> {
  const root = join(ctx.dir, 'audit');
  const keys = (await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json.gz'))
    .map((entry) => join(entry.parentPath, entry.name));
  const records = await Promise.all(keys.map(async (key) => ({ ...(JSON.parse(gunzipSync(await readFile(key)).toString('utf8')) as AuditRecord), key })));
  return records.sort((a, b) => a.time.localeCompare(b.time) || a.key.localeCompare(b.key));
}

/** A file part of a multipart body: named "content", unless `field` names it otherwise. */
export type FilePart = { name: string; type: string; data: Buffer; field?: string };

/** Builds a multipart/form-data body for app.inject: the fields, then the file, or the files in their order. */
export function multipart(fields: Record<string, string>, file?: FilePart | FilePart[]) {
  const boundary = `----evieverse${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  for (const part of file === undefined ? [] : Array.isArray(file) ? file : [file]) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.field ?? 'content'}"; filename="${part.name}"\r\nContent-Type: ${part.type}\r\n\r\n`),
      part.data,
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

// 1x1 transparent PNG
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

// 8x8 grey JPEG, with nothing in it but a JFIF header and the image
export const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDACgcHiMeGSgjISMtKygwPGRBPDc3PHtYXUlkkYCZlo+AjIqgtObDoKrarYqMyP/L2u71////m8H////6/+b9//j/wAALCAAIAAgBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AP//Z',
  'base64',
);

/** The hash a post's meta file keeps of its file: of the bytes as stored, in hex. */
export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** A registered user's credentials, as the fields of a request. */
export type User = { userId: string; apiKey: string };

/** A feed record, as far as tests read it. */
export type FeedItem = {
  contentId: string;
  publisher: { userId: string; username: string };
  aiGenerated: boolean;
  /** Whether the post takes comments. */
  comments: boolean;
  preview: { kind: string; text?: string; url?: string; imageCount?: number; alt?: string[]; video?: { id: string; width: number; height: number; duration: number; poster: string; hls: string } };
  tags: string[];
  likes: number;
  /** How many times the post was viewed by a user account. */
  views: number;
  /** How many users dislike the post, on a server that has dislikes on; null on one that has them off. */
  dislikes: number | null;
  /** On a hashtag's feed: whether one of its moderators approved the record there. */
  moderated?: boolean;
  createdAt: string;
  updatedAt: string;
  /** On a record a repost put where it was read: when, and in a following feed, who reposted it. */
  repost?: { at: string; by?: { userId: string; username: string } };
  /** On a repost of a post on another server: the original. */
  origin?: { url: string; publisher: { userId: string; username: string } };
  /** On a hashtag's feed: the hashtag the record is listed under, of those the feed reads. */
  listedUnder?: string;
};

export type Feed = {
  /** The span of time the feed is of. */
  window: { from: string; to: string };
  count: number;
  truncated: boolean;
  nextCursor: string | null;
  /** With addRelated: the related hashtags the feed added to the ones asked for. */
  related?: string[];
  /** Where the server shows ads in feeds: the page's ads, each with the record of the page it goes before, counted from 1. */
  ads?: FeedAdItem[];
  /** The page's records as one list, in the feed's order, each naming the hashtag it is listed under. */
  records: FeedItem[];
};

/** The records of a feed's page that are listed under `tag`, in the page's order. */
export const listedUnder = (f: Feed, tag: string) => f.records.filter((r) => r.listedUnder === tag);

/** An ad of a feed's page, as far as tests read it. */
export type FeedAdItem = { adId: string; label: string; kind: 'text' | 'image'; imageUrl?: string; text?: string; url?: string; position: number };

type App = Pick<TestContext, 'app'>;

/** The user's credentials as headers. */
export const as = (u: User) => ({ authorization: `Bearer ${u.apiKey}`, 'x-user-id': u.userId });

/** POST /store as `user`. */
export const store = (ctx: App, user: User, payload: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: '/store', payload: { ...user, ...payload } });

/** Stores a text post with the #hashtags written in it. */
export const storeText = (ctx: App, user: User, text: string, extra: Record<string, unknown> = {}) =>
  store(ctx, user, { type: 'text', text, tags: hashtags(text), ...extra });

/** Stores a text post, which must be new content, and returns its id. */
export async function post(ctx: App, user: User, text: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await storeText(ctx, user, text, extra);
  expect(res.statusCode, res.body).toBe(201);
  return res.json().contentId;
}

export const like = (ctx: App, user: User, contentId: string) => ctx.app.inject({ method: 'POST', url: '/like', payload: { ...user, contentId } });

/** DELETE /like as `user`: takes their like of a post back. */
export const unlike = (ctx: App, user: User, contentId: string) => ctx.app.inject({ method: 'DELETE', url: '/like', payload: { ...user, contentId } });

/** POST /dislike as `user`. */
export const dislike = (ctx: App, user: User, contentId: string) => ctx.app.inject({ method: 'POST', url: '/dislike', payload: { ...user, contentId } });

/** DELETE /dislike as `user`: takes their dislike of a post back. */
export const undislike = (ctx: App, user: User, contentId: string) => ctx.app.inject({ method: 'DELETE', url: '/dislike', payload: { ...user, contentId } });

/** GET /content/:contentId, as `user` where one is given, which is what counts a view of the post, and with no credentials otherwise. */
export const read = (ctx: App, contentId: string, user?: User) => ctx.app.inject({ method: 'GET', url: `/content/${contentId}`, headers: user ? as(user) : {} });

/** GET /feed?<query>, which must succeed. */
export async function feed(ctx: App, query: string): Promise<Feed> {
  const res = await ctx.app.inject({ method: 'GET', url: `/feed?${query}` });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

/** The records of a hashtag's feed. */
export const feedItems = async (ctx: App, tag: string) => (await feed(ctx, `tags=${tag}`)).records;

/** The requests above on whichever context a test is running with, so its calls needn't pass it. */
export const requests = (ctx: () => App) => ({
  store: (user: User, payload: Record<string, unknown>) => store(ctx(), user, payload),
  storeText: (user: User, text: string, extra?: Record<string, unknown>) => storeText(ctx(), user, text, extra),
  post: (user: User, text: string, extra?: Record<string, unknown>) => post(ctx(), user, text, extra),
  like: (user: User, contentId: string) => like(ctx(), user, contentId),
  unlike: (user: User, contentId: string) => unlike(ctx(), user, contentId),
  dislike: (user: User, contentId: string) => dislike(ctx(), user, contentId),
  undislike: (user: User, contentId: string) => undislike(ctx(), user, contentId),
  read: (contentId: string, user?: User) => read(ctx(), contentId, user),
  feed: (query: string) => feed(ctx(), query),
  feedItems: (tag: string) => feedItems(ctx(), tag),
});
