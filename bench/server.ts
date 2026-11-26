import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { devNull } from 'node:os';
import { join } from 'node:path';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import pino from 'pino';
import { buildApp } from '../src/app.js';
import { issueApiKey } from '../src/auth/apiKey.js';
import { loadConfig } from '../src/config.js';
import { bootstrap, createSummaryStore } from '../src/deps.js';
import { compactorPath } from '../src/native.js';
import { DAY, HOUR } from '../src/time.js';
import { mapLimit } from '../src/util.js';
import { article, gauss, pick, PUBLISHERS, readerNames, rng, shuffle } from '../testbed/seed/corpus.js';
import { newPost, type Dataset, type User } from './dataset.js';

export interface BenchServer {
  dataset: Dataset;
  /** Milliseconds the disk takes to flush a small file, where the server keeps its files: what every file a write stores waits for. */
  flushMs: number;
  /** The process of the compactor that runs beside the server, whose work is the server's too. */
  compactorPid: number;
}

/** The median time to write a small file to `dir` and flush it. */
function flushTime(dir: string): number {
  const times = Array.from({ length: 21 }, (_, i) => {
    const file = join(dir, `flush-${i}`);
    const startedAt = performance.now();
    const fd = openSync(file, 'w');
    writeSync(fd, Buffer.alloc(1024, 'x'));
    fsyncSync(fd);
    closeSync(fd);
    const took = performance.now() - startedAt;
    unlinkSync(file);
    return took;
  });
  return times.sort((a, b) => a - b)[10]!;
}

const READERS = 200;
const FANS = 400;
const DAYS = 30;
const COMMENTED = 25;
const COMMENTS_EACH = 20;

/**
 * Starts a server as `npm run dev` runs one, listening on `host` and `port`: SQLite in a file,
 * content and summaries in a directory (both in `dir`), the feed index in the Redis that
 * REDIS_URL names, and the compactor running beside it, as a process of its own that this one
 * starts, all with the settings a server has by default. It logs each request as
 * a server does, to nowhere. Two things differ, without which there would be no load to measure:
 * a user may post and comment as often as they like, and feeds are read as often as they are
 * asked for, however many at once: the load is one address.
 *
 * It starts with `posts` posts, written through the app's own routes so that everything a write
 * leaves is there, and spread over the last 30 days as the testbed's are (testbed/seed/seed.ts):
 * each request runs on a clock of its own, set back in time.
 *
 * Nothing stops it: it runs until its process does, and its files go with the volume they are on.
 */
export async function startServer({
  posts: postCount,
  dir,
  host,
  port,
  log,
}: {
  posts: number;
  dir: string;
  host: string;
  port: number;
  log: (message: string) => void;
}): Promise<BenchServer> {
  const flushMs = flushTime(dir);
  const settings = {
    db: { dialect: 'sqlite', url: join(dir, 'evieverse.sqlite') },
    storage: { content: { scheme: 'fs', options: { root: join(dir, 'content') } }, tmpPath: join(dir, 'tmp') },
    // The users are registered from one address, by an admin, whose requests count like anyone's.
    registerRateLimitPerHour: 1_000_000,
    postRateLimitPerMinute: 0,
    // The load is one address, and at its largest more connections than a server answers feeds for at a time.
    // So are the limits by address on the other reads it measures: the following feed, a post, and a post's comments.
    feed: { rateLimitPerMinute: 0, followingRateLimitPerMinute: 0, maxConcurrent: 0 },
    contentRateLimitPerMinute: 0,
    comments: { perMinute: 0, listRateLimitPerMinute: 0 },
  };
  // Neither the environment nor a config file changes what is measured: all the environment says is where Redis is.
  const config = loadConfig(settings, { EVIEVERSE_CONFIG: join(dir, 'no-config.json'), REDIS_URL: process.env.REDIS_URL });
  // The compactor reads its settings itself, from a file and the environment: the same ones, and nothing else of this process's.
  const settingsFile = join(dir, 'bench-config.json');
  writeFileSync(settingsFile, JSON.stringify(settings));
  const compactorEnv = { PATH: process.env.PATH, EVIEVERSE_CONFIG: settingsFile, REDIS_URL: process.env.REDIS_URL };

  const clock = new AsyncLocalStorage<number>();
  const { close: _close, ...stores } = await bootstrap(config, () => clock.getStore() ?? Date.now());
  // Summaries are written on the real clock, whatever the request's: it decides which of them Redis keeps.
  const deps = { ...stores, summaries: createSummaryStore(config, stores.hot) };
  const { db } = deps;
  const app = await buildApp(deps, { logger: { level: config.logLevel, stream: pino.destination({ dest: devNull, sync: true }) }, cli: null });
  await app.ready();

  async function call<T>(time: number, opts: InjectOptions): Promise<T> {
    // With a callback, inject dispatches at once, inside the clock; without one it waits for `then`, outside it.
    const res = await new Promise<LightMyRequestResponse>((resolve, reject) =>
      clock.run(time, () => app.inject(opts, (err, response) => (err ? reject(err) : resolve(response!)))),
    );
    if (res.statusCode >= 300) throw new Error(`${opts.method} ${opts.url} -> ${res.statusCode} ${res.body}`);
    return res.json() as T;
  }

  // Everything random is drawn up front, from a seed, so every run measures the same data.
  const r = rng(20261115);
  const start = Date.now();
  const registeredAt = start - (DAYS + 1) * DAY;

  // Registering takes a challenge, which only an admin's request is spared: the users are registered by
  // one, an account put straight in the database as an operator's first admin is.
  const adminId = randomUUID();
  await db.insertInto('users').values({ id: adminId, username: 'bench-admin', username_folded: 'bench-admin', created_at: registeredAt, updated_at: registeredAt, admin: 1 }).execute();
  const asAdmin = { authorization: `Bearer ${await issueApiKey(db, adminId, registeredAt)}`, 'x-user-id': adminId };
  const usernames = [...PUBLISHERS.map((p) => p.username), ...readerNames(r, READERS), ...Array.from({ length: FANS }, (_, i) => `fan_${i + 1}`)];
  log(`registering ${usernames.length} users`);
  const users: User[] = new Array(usernames.length);
  await mapLimit([...usernames.entries()], 16, async ([i, username]) => {
    const { userId, apiKey } = await call<User>(registeredAt, { method: 'POST', url: '/register', headers: asAdmin, payload: { username } });
    users[i] = { userId, apiKey };
  });
  const publishers = users.slice(0, PUBLISHERS.length);
  const readers = users.slice(PUBLISHERS.length, PUBLISHERS.length + READERS);
  const fans = users.slice(PUBLISHERS.length + READERS);

  // Newest first in weight: a third in the last two days, a third in the rest of the week, a third before.
  const plans = Array.from({ length: postCount }, (_, i) => {
    const x = r();
    const age = Math.max(60_000, Math.round((x < 0.35 ? r() * 2 : x < 0.65 ? 2 + r() * 5 : 7 + r() * (DAYS - 7)) * DAY));
    const body = newPost(r, i + 1);
    // Heavy-tailed likes; four in ten posts get none, and posts under 12 hours old have had less time.
    const likes = r() < 0.4 ? 0 : Math.floor(Math.exp(1.5 + 1.1 * gauss(r)) * PUBLISHERS[body.publisher]!.pull * Math.min(1, age / (12 * HOUR)));
    const likers = shuffle(r, readers)
      .slice(0, likes)
      .map((user) => ({ user, time: start - age + Math.round(r() * Math.min(age - 30_000, 2 * DAY)) }));
    return { time: start - age, body, likers, contentId: '' };
  }).sort((a, b) => a.time - b.time);

  // Many at once: most of the time a post takes is spent waiting for the disk to flush its files.
  log(`storing ${plans.length} posts`);
  await mapLimit(plans, 32, async (plan) => {
    const { publisher, ...body } = plan.body;
    const payload = { ...publishers[publisher]!, ...body, comments: true };
    plan.contentId = (await call<{ contentId: string }>(plan.time, { method: 'POST', url: '/store', payload })).contentId;
  });

  const likes = plans.flatMap((p) => p.likers.map((l) => ({ ...l, contentId: p.contentId }))).sort((a, b) => a.time - b.time);
  log(`liking them ${likes.length} times`);
  await mapLimit(likes, 16, async ({ user, time, contentId }) => {
    await call(time, { method: 'POST', url: '/like', payload: { ...user, contentId } });
  });

  const commented = shuffle(r, plans).slice(0, Math.min(COMMENTED, plans.length));
  log(`commenting on ${commented.length} of them`);
  await mapLimit(commented, 32, async (plan) => {
    // One after another: a post's comments are in the order they were sent.
    for (let i = 0; i < COMMENTS_EACH; i++) {
      const text = article(r, pick(r, PUBLISHERS[plan.body.publisher]!.beats), []).paragraphs[1]!;
      await call(Math.min(start, plan.time + (i + 1) * 60_000), { method: 'POST', url: `/content/${plan.contentId}/comments`, payload: { ...pick(r, readers), text } });
    }
  });

  const follower = readers[0]!;
  const asFollower = { authorization: `Bearer ${follower.apiKey}`, 'x-user-id': follower.userId };
  for (const { userId } of publishers) await call(start, { method: 'PUT', url: `/users/${follower.userId}/following/${userId}`, headers: asFollower });

  // On the real clock, as after Redis lost its data: every day's index is built from the database, by one pass of
  // the compactor. It logs as the server does, to nowhere, and says what stops it.
  log('building the feed index');
  const run = { env: compactorEnv, stdio: ['ignore', 'ignore', 'inherit'] as ['ignore', 'ignore', 'inherit'] };
  execFileSync(compactorPath(), ['--rebuild', '--once'], run);
  // Then pass after pass, beside the server, for as long as it is up: in its container, so what the compactor uses
  // is counted with what the server does. A server whose compactor is gone measures nothing a server does.
  const compactor = spawn(compactorPath(), [], run);
  compactor.once('exit', (code, signal) => {
    log(`the compactor ended (${signal ?? code}), and the server with it`);
    process.exit(1);
  });
  process.once('exit', () => compactor.kill());
  if (compactor.pid === undefined) throw new Error('the compactor did not start');

  await app.listen({ host, port });
  return {
    flushMs,
    compactorPid: compactor.pid,
    dataset: {
      publishers,
      readers,
      fans,
      posts: plans.map((p) => ({ contentId: p.contentId, type: p.body.type, tags: p.body.tags })),
      commented: commented.map((p) => p.contentId),
      commentsEach: COMMENTS_EACH,
      likes: likes.length,
      days: DAYS,
    },
  };
}
