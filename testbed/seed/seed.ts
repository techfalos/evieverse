import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import pino from 'pino';
import { buildApp } from '../../src/app.js';
import { createCompactor } from '../../src/compact/compactor.js';
import { loadConfig } from '../../src/config.js';
import { bootstrap, createStores } from '../../src/deps.js';
import { DAY, HOUR, iso } from '../../src/time.js';
import { mapLimit } from '../../src/util.js';
import {
  article,
  articleText,
  between,
  gauss,
  interests,
  pick,
  picture,
  PUBLISHERS,
  readerNames,
  rng,
  shuffle,
  topicOf,
  updateNote,
  type PublisherSpec,
} from './corpus.js';

/**
 * Seeds the testbed through the app's own routes (register, store, like), so every write takes the real
 * path: object store, summaries, database and the feed queue. Each request runs on its own clock, set back
 * in time, which spreads the posts over the last SEED_DAYS days while requests run concurrently. Summaries
 * use the real clock, so only posts younger than SUMMARY_HOT_DAYS are also kept in Redis. A final
 * `--rebuild` compaction on the real clock builds the day indexes, as after Redis lost its data.
 */

const OUT = process.env.SEED_OUT ?? '/out';
const USERS_FILE = join(OUT, 'users.json');
const POSTS = Number(process.env.SEED_POSTS ?? 2400);
const READERS = Number(process.env.SEED_READERS ?? 220);
const DAYS = Number(process.env.SEED_DAYS ?? 45);
const UPDATES = Math.round(POSTS / 100);
/** Share of posts their publisher declares created with AI. */
const AI_SHARE = Number(process.env.SEED_AI_SHARE ?? 0.2);

const log = (msg: string) => console.log(`${iso(Date.now())} seed: ${msg}`);

// It registers and posts on clocks set back in time, so no person is there to solve a challenge. Every
// post carries its planned hashtags, whatever TAGGING_MODE the app runs with.
const config = loadConfig({
  logLevel: 'warn',
  registerRateLimitPerHour: 1_000_000,
  postRateLimitPerMinute: 0,
  challenge: { register: false, postWindowSeconds: 0 },
  tagging: { mode: 'user' },
});
const clock = new AsyncLocalStorage<number>();
const { close, ...deps } = await bootstrap(config, () => clock.getStore() ?? Date.now());
const { db } = deps;

const { n: existingUsers } = await db.selectFrom('users').select(db.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
if (Number(existingUsers) > 0) {
  await close();
  if (existsSync(USERS_FILE)) {
    log(`already seeded (${existingUsers} users); run \`docker compose -f testbed/docker-compose.yml down -v\` to start over`);
    process.exit(0);
  }
  log('a previous seed did not finish; run `docker compose -f testbed/docker-compose.yml down -v` and start again');
  process.exit(1);
}

// Summaries are written on the real clock, whatever the request's.
const { summaries } = createStores(config, Date.now, deps.hot);
const app = await buildApp({ ...deps, summaries }, { logger: { level: 'error' } });
await app.ready();

async function call<T>(time: number, opts: InjectOptions): Promise<T> {
  // With a callback, inject dispatches at once, inside the clock; without one it waits for `then`, outside it.
  const res = await new Promise<LightMyRequestResponse>((resolve, reject) =>
    clock.run(time, () => app.inject(opts, (err, response) => (err ? reject(err) : resolve(response!)))),
  );
  if (res.statusCode >= 300) {
    throw new Error(`${opts.method} ${opts.url} at ${iso(time)} -> ${res.statusCode} ${res.body}`);
  }
  return res.json() as T;
}

// Everything random is drawn up front, so the data is the same on every run.
const r = rng(20261109);
// Streams of their own, so the AI flags and captions leave every other draw as it was.
const rAi = rng(20261110);
const rCaption = rng(20261111);
const start = Date.now();
const registeredAt = start - (DAYS + 1) * DAY;

interface UserPlan {
  username: string;
  role: 'publisher' | 'reader';
  interests: string[];
  spec?: PublisherSpec;
}
const userPlans: UserPlan[] = [
  ...PUBLISHERS.map((spec) => ({
    username: spec.username,
    role: 'publisher' as const,
    interests: [...new Set([...spec.beats.map(topicOf), ...spec.beats])],
    spec,
  })),
  ...readerNames(r, READERS).map((name) => ({
    username: name,
    role: 'reader' as const,
    interests: interests(r),
  })),
];
const readerIdx = userPlans.flatMap((u, i) => (u.role === 'reader' ? [i] : []));

/** Newest first in weight: a third in the last two days, a third in the rest of the week, a third before. */
function postedAt(): number {
  const x = r();
  const age = x < 0.35 ? r() * 2 * DAY : x < 0.65 ? (2 + r() * 5) * DAY : (7 + r() * (DAYS - 7)) * DAY;
  return start - Math.round(Math.max(age, 60_000));
}

const totalPull = PUBLISHERS.reduce((s, p) => s + p.pull, 0);
function publisher(): number {
  let x = r() * totalPull;
  return Math.max(0, PUBLISHERS.findIndex((p) => (x -= p.pull) < 0));
}

/** What /store is sent for a post, but its hashtags and AI flag. */
type PostBody =
  | { type: 'image'; content: string; contentEncoding: 'base64'; contentType: 'image/png'; filename: string; text?: string }
  | { type: 'text'; text: string }
  | { type: 'link'; url: string };

interface PostPlan {
  n: number;
  author: number;
  time: number;
  body: PostBody;
  tags: string[];
  aiGenerated: boolean;
  likers: { user: number; time: number }[];
  stored?: Promise<string>;
  contentId?: string;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const posts: PostPlan[] = [];
for (let n = 1; n <= POSTS; n++) {
  const author = publisher();
  const spec = PUBLISHERS[author]!;
  const beat = pick(r, spec.beats);
  const tags = [topicOf(beat), beat];
  if (spec.beats.length > 1 && r() < 0.35) tags.push(pick(r, spec.beats.filter((b) => b !== beat)));
  const time = postedAt();
  const id = String(n).padStart(4, '0');

  let body: PostBody;
  if (r() < (spec.images ?? 0.04)) {
    if (!tags.includes('photography') && r() < 0.5) tags.push('photography');
    const png = picture(r, topicOf(beat));
    const caption = rCaption() < 0.6 ? article(rCaption, beat, tags).title : undefined;
    body = { type: 'image', content: png.toString('base64'), contentEncoding: 'base64', contentType: 'image/png', filename: `seed-${id}.png`, ...(caption && { text: caption }) };
  } else {
    const a = article(r, beat, tags);
    // Some publishers' posts link to the article on their own site.
    body = r() < 0.08 ? { type: 'link', url: `https://${spec.host}.example.com/${beat}/${slug(a.title)}-${id}` } : { type: 'text', text: articleText(a) };
  }
  const plan = { n, author, time, tags, body };

  // Heavy-tailed likes; four in ten posts get none, and posts under 12 hours old have had less time.
  const age = start - time;
  const likes = r() < 0.4 ? 0 : Math.floor(Math.exp(1.5 + 1.1 * gauss(r)) * spec.pull * Math.min(1, age / (12 * HOUR)));
  const fans = new Set(readerIdx.filter((i) => userPlans[i]!.interests.some((t) => tags.includes(t))));
  const others = readerIdx.filter((i) => !fans.has(i));
  const likers = [...shuffle(r, [...fans]), ...shuffle(r, others)].slice(0, likes).map((user) => ({
    user,
    time: time + Math.round(r() * Math.min(age - 30_000, 2 * DAY)),
  }));
  posts.push({ ...plan, aiGenerated: rAi() < AI_SHARE, likers });
}
posts.sort((a, b) => a.time - b.time);

// A few text posts older than a day are edited some hours later.
const updates = shuffle(
  r,
  posts.filter((p) => p.body.type === 'text' && p.time < start - DAY),
)
  .slice(0, UPDATES)
  .map((p) => {
    const tags = p.tags.length > 2 && r() < 0.3 ? p.tags.slice(0, 2) : p.tags;
    const { text } = p.body as Extract<PostBody, { type: 'text' }>;
    const body: PostBody = { type: 'text', text: `${updateNote(r)}\n\n${text}` };
    return { post: p, body, tags, time: Math.min(p.time + between(r, 1, 20) * HOUR, start - 10 * 60_000) };
  });

log(`registering ${userPlans.length} users`);
const users: (UserPlan & { userId: string; apiKey: string })[] = new Array(userPlans.length);
await mapLimit(
  userPlans.map((u, i) => ({ u, i })),
  16,
  async ({ u, i }) => {
    const res = await call<{ userId: string; apiKey: string }>(registeredAt, {
      method: 'POST',
      url: '/register',
      payload: { username: u.username },
    });
    users[i] = { ...u, userId: res.userId, apiKey: res.apiKey };
  },
);
const creds = (i: number) => ({ userId: users[i]!.userId, apiKey: users[i]!.apiKey });

// Edits go in time order with the posts: each store stamps its hashtags' last activity (what /tags sorts by)
// with its own time, so a backdated edit run after every post would make those hashtags look days old.
const writes = [
  ...posts.map((post) => ({ time: post.time, post, update: undefined })),
  ...updates.map((update) => ({ time: update.time, post: update.post, update })),
].sort((a, b) => a.time - b.time);

log(`storing ${posts.length} posts and ${updates.length} edits from ${iso(writes[0]!.time)} to ${iso(writes.at(-1)!.time)}`);
let stored = 0;
await mapLimit(writes, 8, async ({ post: p, update: u }) => {
  if (u) {
    // mapLimit starts items in order, so the post's own store has already begun.
    const contentId = await p.stored!;
    // No aiGenerated: an edit that doesn't say keeps the post's.
    await call(u.time, { method: 'POST', url: '/store', payload: { ...creds(p.author), contentId, ...u.body, tags: u.tags } });
    return;
  }
  p.stored = call<{ contentId: string }>(p.time, {
    method: 'POST',
    url: '/store',
    payload: { ...creds(p.author), ...p.body, tags: p.tags, aiGenerated: p.aiGenerated },
  }).then((res) => res.contentId);
  p.contentId = await p.stored;
  if (++stored % 250 === 0) log(`stored ${stored}/${posts.length}`);
});

const likes = posts.flatMap((p) => p.likers.map((l) => ({ ...l, contentId: p.contentId! }))).sort((a, b) => a.time - b.time);
log(`liking: ${likes.length} likes`);
let liked = 0;
await mapLimit(likes, 16, async (l) => {
  await call(l.time, { method: 'POST', url: '/like', payload: { ...creds(l.user), contentId: l.contentId } });
  if (++liked % 2000 === 0) log(`liked ${liked}/${likes.length}`);
});

const span = await db
  .selectFrom('content')
    .select((eb) => [eb.fn.min('created_at').as('first'), eb.fn.max('created_at').as('last')])
  .executeTakeFirstOrThrow();
if (Number(span.first) > start - (DAYS - 7) * DAY) {
  throw new Error(`posts were not backdated: the oldest is from ${iso(Number(span.first))}`);
}

log('rebuilding the feed index');
const compactor = createCompactor({ ...deps, summaries }, pino({ level: 'warn' }));
const { tags } = await compactor.runOnce({ rebuild: true });
log(`indexed ${tags.length} hashtags`);

const checks = [
  '/feed?tags=news&hours=24',
  '/feed?tags=ai,space,football&hours=72&algorithm=chronological',
  '/feed?tags=news&hours=24&aiGenerated=true',
  '/feed?tags=ai&hours=168&addRelated=true',
];
for (const url of checks) {
  const res = await app.inject({ method: 'GET', url });
  const feed = res.json() as { count: number; truncated: boolean; related?: string[] };
  log(`${url}: ${res.statusCode}, ${feed.count} records, truncated=${feed.truncated}${feed.related ? `, related=${feed.related.join(',') || 'none'}` : ''}`);
}

await mkdir(OUT, { recursive: true });
await writeFile(
  USERS_FILE,
  JSON.stringify({
    seededAt: iso(start),
    posts: posts.length,
    aiGenerated: posts.filter((p) => p.aiGenerated).length,
    updates: updates.length,
    likes: likes.length,
    users: users.map((u) => ({
      userId: u.userId,
      apiKey: u.apiKey,
      username: u.username,
      role: u.role,
      interests: u.interests,
    })),
  }),
);
log(`done: ${users.length} users, ${posts.length} posts (${posts.filter((p) => p.aiGenerated).length} created with AI), ${updates.length} updates, ${likes.length} likes`);

await app.close();
await close();
