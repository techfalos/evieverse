import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { buildApp } from '../src/app.js';
import { challengeKey, leadingZeroBits, type Challenge } from '../src/challenge/challenges.js';
import { Compactor } from '../src/compact/compactor.js';
import { loadConfig, type Config } from '../src/config.js';
import { createDb, type Db } from '../src/db/index.js';
import { migrateToLatest } from '../src/db/migrator.js';
import { createStores } from '../src/deps.js';
import type { HotStore } from '../src/storage/index.js';
import { decodeTail, tailIndexKey, tailKey, type TailRecord, type Tombstone } from '../src/tagfeed/layout.js';

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
  'likes',
  'pending_appends',
  'superseded_versions',
  'compactor_lease',
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

/** The #hashtags written in a post's text, which tests send as its tags. */
export const hashtags = (text: string) => [...text.matchAll(/#(\w+)/g)].map((m) => m[1]!);

/** Every line of a tag's tail lists, oldest window first. */
export async function tailLines(hot: HotStore, tag: string): Promise<(TailRecord | Tombstone)[]> {
  const windows = await hot.scores(tailIndexKey(tag), 0, Infinity);
  const lists = await hot.lists(windows.map((w) => tailKey(tag, w)));
  return lists.flat().map((line) => decodeTail(line.toString('utf8'))!);
}

/**
 * Challenges are off unless `challenge` turns them on, with a proof of work quick enough for tests, and
 * so is the limit on posts a minute.
 */
export async function createTestContext(
  target: TestTarget,
  opts: {
    feed?: Record<string, number>;
    publicBaseUrl?: string;
    challenge?: Partial<Config['challenge']>;
    tagging?: Partial<Config['tagging']>;
    registerRateLimitPerHour?: number;
    postRateLimitPerMinute?: number;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'theuniverse-test-'));
  const config = loadConfig(
    {
      logLevel: 'silent',
      publicBaseUrl: opts.publicBaseUrl ?? '',
      // Each test gets its own key prefix, so tests can share one Redis.
      redis: target.hot === 'redis' ? { url: process.env.TEST_REDIS_URL!, keyPrefix: `test:${dir.split('/').pop()}:` } : {},
      db: { dialect: target.dialect, url: target.url, poolSize: 4 },
      storage: {
        content: { scheme: 'fs', options: { root: join(dir, 'content') } },
        summaries: { scheme: 'fs', options: { root: join(dir, 'summaries') } },
        tmpPath: join(dir, 'tmp'),
      },
      feed: { maxTokens: 100000, headCacheMs: 0, ...opts.feed },
      challenge: { register: false, postWindowSeconds: 0, powBits: 8, ...opts.challenge },
      ...(opts.tagging && { tagging: opts.tagging }),
      ...(opts.registerRateLimitPerHour && { registerRateLimitPerHour: opts.registerRateLimitPerHour }),
      postRateLimitPerMinute: opts.postRateLimitPerMinute ?? 0,
    },
    {},
  );
  const db = await createDb(config.db);
  if (target.dialect !== 'sqlite') await resetDatabase(db, target.dialect);
  await migrateToLatest(db);

  const clock = { now: Date.UTC(2026, 10, 6, 12) };
  const now = () => clock.now;
  const stores = createStores(config, now);
  const app = await buildApp({ config, db, ...stores, now }, { logger: false });

  const compactor = new Compactor({ config, db, hot: stores.hot, summaries: stores.summaries, content: stores.content, now });
  const windowMs = config.feed.tailWindowSeconds * 1000;
  const graceMs = config.compact.graceSeconds * 1000;

  /**
   * What a person and their client send back: the characters (read from Redis here), and the proof of
   * work. The clock moves on by `thinkMs` first, the shortest time an answer is accepted after by default.
   */
  async function solve(challenge: Challenge, thinkMs = config.challenge.minSolveMs) {
    const issued = await stores.hot.get(challengeKey(challenge.id));
    clock.now += thinkMs;
    return {
      challengeId: challenge.id,
      challengeAnswer: (JSON.parse(issued!.toString('utf8')) as { answer: string }).answer,
      challengeNonce: proofOfWork(challenge.proofOfWork),
    };
  }

  return {
    app,
    db,
    config,
    clock,
    dir,
    ...stores,
    compactor,
    /** Moves the clock past the current tail window (plus grace) and runs one compaction pass. */
    async compact(extraMs = 0) {
      clock.now += windowMs + graceMs + extraMs;
      return compactor.runOnce();
    },
    solve,
    /** Registers a user, solving the challenge if there is one. */
    async register(username: string, publisherUrl: string | null = `https://${username}.example.com`) {
      const payload = { username, ...(publisherUrl ? { publisherUrl } : {}) };
      let res = await app.inject({ method: 'POST', url: '/register', payload });
      if (res.statusCode === 428) {
        res = await app.inject({ method: 'POST', url: '/register', payload: { ...payload, ...(await solve(res.json().challenge)) } });
      }
      return res.json() as { userId: string; apiKey: string };
    },
    async close() {
      await app.close();
      await stores.hot.clear();
      await stores.hot.close();
      await db.destroy();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export type TestContext = Awaited<ReturnType<typeof createTestContext>>;

/** Builds a multipart/form-data body for app.inject. */
export function multipart(fields: Record<string, string>, file?: { name: string; type: string; data: Buffer }) {
  const boundary = `----theuniverse${Math.random().toString(16).slice(2)}`;
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
