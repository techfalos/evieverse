import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { sql } from 'kysely';
import { expect } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AuditRecord } from '../src/audit.js';
import { challengeKey, leadingZeroBits, type Challenge } from '../src/challenge/challenges.js';
import { createCompactor } from '../src/compact/compactor.js';
import { loadConfig, type Config } from '../src/config.js';
import { createDb, type Db } from '../src/db/index.js';
import { bootstrap } from '../src/deps.js';
import type { Languages } from '../src/language.js';
import type { HotStore } from '../src/storage/index.js';
import type { TrustPlugin } from '../src/moderation/trust.js';
import type { CliRelease } from '../src/routes/cli.js';

export interface TestTarget {
  name: string;
  dialect: 'sqlite' | 'postgres' | 'mysql';
  url: string;
  /** The RAM tier: the in-process store, or a real Redis-protocol server. */
  hot: 'memory' | 'redis';
}

/**
 * SQLite with the in-process store always runs. Set TEST_POSTGRES_URL / TEST_MYSQL_URL for those
 * databases, and TEST_REDIS_URL (e.g. redis://127.0.0.1:6379) to run against a real Redis or Valkey.
 */
export const TARGETS: TestTarget[] = [
  { name: 'sqlite + memory', dialect: 'sqlite', url: ':memory:', hot: 'memory' },
  ...(process.env.TEST_REDIS_URL ? [{ name: 'sqlite + redis', dialect: 'sqlite' as const, url: ':memory:', hot: 'redis' as const }] : []),
  ...(process.env.TEST_POSTGRES_URL ? [{ name: 'postgres', dialect: 'postgres' as const, url: process.env.TEST_POSTGRES_URL, hot: 'memory' as const }] : []),
  ...(process.env.TEST_MYSQL_URL ? [{ name: 'mysql', dialect: 'mysql' as const, url: process.env.TEST_MYSQL_URL, hot: 'memory' as const }] : []),
];

export const TABLES = [
  'monetization',
  'inbox',
  'server_rules',
  'user_blocks',
  'comment_reports',
  'comment_queue',
  'reports',
  'tag_moderation',
  'moderation_queue',
  'blocked_words',
  'tag_mutes',
  'tag_moderators',
  'follows',
  'likes',
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

async function resetDatabase(db: Db, dialect: TestTarget['dialect']) {
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

/** The feed queue: "<contentId> <tag>" of every row, sorted. What the compactor's next run takes, once committed. */
export const queued = async (ctx: { db: Db }) =>
  (await ctx.db.selectFrom('feed_queue').select(['content_id', 'tag']).execute()).map((r) => `${r.content_id} ${r.tag}`).sort();

/**
 * Registering takes a challenge, as on any server, which `register` and `registration` solve. Its
 * proof of work is quick enough for tests, and an answer is accepted at once, so solving one leaves
 * the clock where it was, unless `challenge` says otherwise. The post window is off unless `challenge`
 * turns it on, and so are the limits on posts and on comments a minute.
 */
export async function createTestContext(
  target: TestTarget,
  opts: {
    feed?: Record<string, number>;
    /** Writes the audit log, to `audit/` in the test's directory (see readAudit). Off unless asked for. */
    audit?: boolean;
    publicBaseUrl?: string;
    challenge?: Partial<Config['challenge']>;
    tagging?: Partial<Config['tagging']>;
    /** The trust scores that have a post refused, queued or published; the server's defaults unless given. */
    trust?: Partial<Config['trust']>;
    postRateLimitPerMinute?: number;
    maxFollowing?: number;
    /** The posts a user can report in an hour; the server's default unless given. */
    reportsPerHour?: number;
    /** The limit on messages a minute and how long inboxes keep them; the server's defaults unless given. */
    inbox?: Partial<Config['inbox']>;
    /** The limit on comments a minute, which tests have none of unless they say, and how long Redis keeps comments. */
    comments?: Partial<Config['comments']>;
    /** Where the server shows its ads: in hashtag feeds, at the end of posts. Nowhere unless given. */
    monetization?: Partial<Config['monetization']>;
    /** The modification disclosure GET /rules gives: that the server runs a modified version, which needs `sourceUrl`. A release, unless given. */
    modified?: boolean;
    /** Where the server says its source code can be obtained. Nowhere, unless given. */
    sourceUrl?: string;
    corsOrigins?: string | string[];
    compact?: Partial<Config['compact']>;
    /** Replaces the content store, which is otherwise a directory of the test's own. */
    content?: { scheme: string; options: Record<string, string> };
    maxUploadBytes?: number;
    uploadLinksPerMinute?: number;
    trustProxy?: number | boolean | string;
    /** The CLI the server ships. Tests ship none unless they say, whatever was last built. */
    cli?: CliRelease;
    /** The trust plugins, in place of the server's own (src/plugins/trust). */
    trustPlugins?: TrustPlugin[];
    /** The languages the server answers in, in place of its own (src/languages). */
    languages?: Languages;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'evieverse-test-'));
  const config = loadConfig(
    {
      logLevel: 'silent',
      publicBaseUrl: opts.publicBaseUrl ?? '',
      // Each test gets its own key prefix, so tests can share one Redis.
      redis: target.hot === 'redis' ? { url: process.env.TEST_REDIS_URL!, keyPrefix: `test:${dir.split('/').pop()}:` } : {},
      db: { dialect: target.dialect, url: target.url, poolSize: 4 },
      storage: {
        content: opts.content ?? { scheme: 'fs', options: { root: join(dir, 'content') } },
        summaries: { scheme: 'fs', options: { root: join(dir, 'summaries') } },
        tmpPath: join(dir, 'tmp'),
        ...(opts.maxUploadBytes && { maxUploadBytes: opts.maxUploadBytes }),
        ...(opts.uploadLinksPerMinute !== undefined && { uploadLinksPerMinute: opts.uploadLinksPerMinute }),
      },
      ...(opts.audit && { audit: { scheme: 'fs', options: { root: join(dir, 'audit') } } }),
      feed: { headCacheMs: 0, ...opts.feed },
      challenge: { postWindowSeconds: 0, powBits: 8, minSolveMs: 0, ...opts.challenge },
      ...(opts.tagging && { tagging: opts.tagging }),
      ...(opts.trust && { trust: opts.trust }),
      postRateLimitPerMinute: opts.postRateLimitPerMinute ?? 0,
      ...(opts.maxFollowing && { maxFollowing: opts.maxFollowing }),
      ...(opts.reportsPerHour !== undefined && { reportsPerHour: opts.reportsPerHour }),
      ...(opts.inbox && { inbox: opts.inbox }),
      comments: { perMinute: 0, ...opts.comments },
      ...(opts.monetization && { monetization: opts.monetization }),
      ...(opts.modified !== undefined && { modified: opts.modified }),
      ...(opts.sourceUrl !== undefined && { sourceUrl: opts.sourceUrl }),
      ...(opts.corsOrigins && { corsOrigins: opts.corsOrigins }),
      ...(opts.compact && { compact: opts.compact }),
      ...(opts.trustProxy !== undefined && { trustProxy: opts.trustProxy }),
    },
    {},
  );
  if (target.dialect !== 'sqlite') {
    const db = await createDb(config.db);
    await resetDatabase(db, target.dialect);
    await db.destroy();
  }

  const clock = { now: Date.UTC(2026, 10, 6, 12) };
  const { close, ...deps } = await bootstrap(config, () => clock.now);
  const app = await buildApp(deps, { logger: false, cli: opts.cli ?? null, trustPlugins: opts.trustPlugins, languages: opts.languages });

  const compactor = createCompactor(deps);
  const graceMs = config.compact.graceSeconds * 1000;

  /**
   * What a person and their client send back: the characters (read from Redis here), and the proof of
   * work. The clock moves on by `thinkMs` first, the shortest time an answer is accepted after by default.
   */
  async function solve(challenge: Challenge, thinkMs = config.challenge.minSolveMs) {
    const solved = await solution(deps.hot, challenge);
    clock.now += thinkMs;
    return solved;
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
    compactor,
    /**
     * Runs one compaction pass, which is what puts writes in feeds, with the clock moved past the
     * grace period first: the run then takes everything there is to take, the hashtag counts and the
     * updates that stopped half way too. A committed write needs no such wait: `compactor.runOnce()`
     * takes it as it is.
     */
    async compact(extraMs = 0) {
      clock.now += graceMs + 1000 + extraMs;
      return compactor.runOnce();
    },
    solve,
    registration,
    /** Registers a user, solving the challenge the server asks for. */
    async register(username: string) {
      const res = await registration({ username });
      expect(res.statusCode, res.body).toBe(201);
      return res.json() as { userId: string; apiKey: string };
    },
    async close() {
      await app.close();
      await deps.hot.clear();
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

/** Builds a multipart/form-data body for app.inject. */
export function multipart(fields: Record<string, string>, file?: { name: string; type: string; data: Buffer }) {
  const boundary = `----evieverse${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="content"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`),
      file.data,
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

/** A registered user's credentials, as the fields of a request. */
export type User = { userId: string; apiKey: string };

/** A feed record, as far as tests read it. */
export type FeedItem = {
  contentId: string;
  publisher: { userId: string; username: string };
  aiGenerated: boolean;
  /** Whether the post takes comments. */
  comments: boolean;
  preview: { kind: string; text?: string; url?: string };
  tags: string[];
  likes: number;
  /** On a hashtag's feed: whether one of its moderators approved the record there. */
  moderated?: boolean;
  createdAt: string;
  updatedAt: string;
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
  /** Each hashtag's records, in the feed's order; a hashtag with none is left out. */
  tags: Record<string, FeedItem[]>;
};

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

/** GET /feed?<query>, which must succeed. */
export async function feed(ctx: App, query: string): Promise<Feed> {
  const res = await ctx.app.inject({ method: 'GET', url: `/feed?${query}` });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

/** The records of a hashtag's feed. */
export const feedItems = async (ctx: App, tag: string) => (await feed(ctx, `tags=${tag}`)).tags[tag] ?? [];

/** The requests above on whichever context a test is running with, so its calls needn't pass it. */
export const requests = (ctx: () => App) => ({
  store: (user: User, payload: Record<string, unknown>) => store(ctx(), user, payload),
  storeText: (user: User, text: string, extra?: Record<string, unknown>) => storeText(ctx(), user, text, extra),
  post: (user: User, text: string, extra?: Record<string, unknown>) => post(ctx(), user, text, extra),
  like: (user: User, contentId: string) => like(ctx(), user, contentId),
  feed: (query: string) => feed(ctx(), query),
  feedItems: (tag: string) => feedItems(ctx(), tag),
});
