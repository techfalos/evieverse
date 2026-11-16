import { lookup } from 'node:dns/promises';
import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { article, pick, PUBLISHERS, rng, shuffle } from '../testbed/seed/corpus.js';
import { newPost, type User } from './dataset.js';
import { list, LoadGenerator, type Request, type RequestSource, type Workload } from './load.js';
import { render, type Host, type Measured } from './report.js';
import type { ServerInfo, Usage } from './serve.js';
import { given, setting } from './settings.js';

/**
 * The benchmark: it measures the API under load and writes BENCHMARKS.md, which says how to run
 * it and what a run does. `npm run bench` runs it (run.mjs), in Docker: this is the load
 * generator's container, and the server it measures is in another (docker-compose.yml), with
 * CPUs and memory of its own. `npm test` doesn't run it (vitest.bench.config.ts).
 */

/** In the container, where run.mjs takes it from, to the root of the repository. */
const OUT = fileURLToPath(new URL('../BENCHMARKS.md', import.meta.url));

/** Where the server answers about itself (serve.ts). */
const SERVER = given('BENCH_SERVER');
/** The machine the containers are on, which only run.mjs, outside them, can say. */
const HOST = JSON.parse(given('BENCH_HOST')) as Host;
/** The CPUs this container has: a thread of connections for each. */
const THREADS = setting('BENCH_LOAD_CPUS');
const DURATION_SECONDS = setting('BENCH_DURATION_SECONDS');
const CONNECTIONS = setting('BENCH_CONNECTIONS');
const WARMUP_SECONDS = 2;
/** How long the server has to store its posts, before the run gives up on it. */
const READY_MINUTES = 30;
/** The connections the mix of requests is also sent over, beside CONNECTIONS. */
const RAMP = [1, 10, 100, 500];

interface Scenario {
  name: string;
  what: string;
  workload: Workload;
  /** The statuses its responses have, if all is well. */
  expect: number[];
}

const get = (path: string, as?: User): Request => ({ method: 'GET', path, ...(as && { headers: { authorization: `Bearer ${as.apiKey}`, 'x-user-id': as.userId } }) });
const post = (path: string, payload: object): Request => ({ method: 'POST', path, body: JSON.stringify(payload) });

/**
 * What the server answers about itself. Asked a second time if the first fails: the server closes
 * a connection it hasn't heard from in 5 seconds, and making the requests of the loads can keep
 * this process busy for longer, which then finds out only as it sends on the one it had kept.
 */
const ask = async <T>(path: string): Promise<T> => {
  const res = await fetch(`${SERVER}${path}`).catch(() => fetch(`${SERVER}${path}`));
  if (!res.ok) throw new Error(`${SERVER}${path} -> ${res.status}`);
  return (await res.json()) as T;
};

/** The server, once it has its posts: it answers nothing about itself before. */
async function ready(): Promise<ServerInfo> {
  const giveUpAt = Date.now() + READY_MINUTES * 60_000;
  for (;;) {
    try {
      return await ask<ServerInfo>('/info');
    } catch (err) {
      if (Date.now() > giveUpAt) throw new Error(`the server at ${SERVER} wasn't ready within ${READY_MINUTES} minutes`, { cause: err });
      await sleep(1000);
    }
  }
}

it('measures the API under load, and writes BENCHMARKS.md', async () => {
  const startedAt = new Date();
  const log = (message: string) => console.log(`bench ${String(Math.round((Date.now() - startedAt.getTime()) / 1000)).padStart(4)}s: ${message}`);
  const server = await ready();
  const { address } = await lookup(new URL(SERVER).hostname);
  const load = new LoadGenerator(address, server.port, get('/health'), THREADS);
  try {
    const { publishers, readers, fans, posts, commented, commentsEach, likes: seededLikes, days } = server.dataset;
    const r = rng(20261116);
    const hashtags = [...new Set(posts.flatMap((p) => p.tags))];
    const pictures = posts.filter((p) => p.type === 'image');
    const follower = readers[0]!;

    // Each a like of its own: a fan's first of that post. A like given twice is answered without a write.
    const likes: RequestSource = {
      kind: 'pairs',
      method: 'POST',
      path: '/like',
      first: fans.map((fan) => `{"userId":"${fan.userId}","apiKey":"${fan.apiKey}","contentId":"`),
      second: posts.map((p) => `${p.contentId}"}`),
      base: 0,
    };
    const newPosts = list(
      Array.from({ length: 400 }, (_, i) => {
        const { publisher, ...body } = newPost(r, posts.length + i + 1);
        return post('/store', { ...publishers[publisher]!, ...body });
      }),
    );
    const newComments = list(
      shuffle(r, posts)
        .slice(0, 200)
        .flatMap((p) => [0, 1].map(() => post(`/content/${p.contentId}/comments`, { ...pick(r, readers), text: article(r, pick(r, pick(r, PUBLISHERS).beats), []).paragraphs[1]! }))),
    );
    const anyPost = list(posts.map((p) => get(`/content/${p.contentId}`)));
    const comments = list(commented.map((id) => get(`/content/${id}/comments`)));
    const profiles = list([...publishers, ...readers].map((u) => get(`/users/${u.userId}`)));
    const anyFeed = list(
      hashtags.flatMap((tag, i) => [
        get(`/feed?tags=${tag}`),
        get(`/feed?tags=${tag},${hashtags[(i + 1) % hashtags.length]},${hashtags[(i + 7) % hashtags.length]}&hours=72`),
        get(`/feed?tags=${tag}&hours=168&algorithm=chronological`),
        get(`/feed?tags=${tag}&addRelated=true`),
      ]),
    );

    const reads: Scenario[] = [
      { name: 'GET /health', what: 'Reads nothing: what answering a request costs by itself.', workload: list([get('/health')]), expect: [200] },
      { name: 'GET /feed?tags=news', what: "One hashtag's most liked posts of the past 24 hours, a page of up to 50.", workload: list([get('/feed?tags=news')]), expect: [200] },
      {
        name: 'GET /feed?tags=news,tech,sports&hours=168&algorithm=chronological',
        what: "Three hashtags' posts of the past week, newest first, a page of up to 50.",
        workload: list([get('/feed?tags=news,tech,sports&hours=168&algorithm=chronological')]),
        expect: [200],
      },
      {
        name: 'GET /feed?tags=<hashtag>&hours=720&limit=100',
        what: `A hashtag's most liked posts of the past 30 days, a page of up to 100, of each of the ${hashtags.length} hashtags in turn.`,
        workload: list(hashtags.map((tag) => get(`/feed?tags=${tag}&hours=720&limit=100`))),
        expect: [200],
      },
      {
        name: 'GET /feed/following?userId=<userId>',
        what: `The newest posts of the ${publishers.length} users one user follows, a page of up to 50, read with that user's key.`,
        workload: list([get(`/feed/following?userId=${follower.userId}`, follower)]),
        expect: [200],
      },
      { name: 'GET /content/<contentId>', what: `A post, of each of the ${posts.length.toLocaleString('en-US')} in turn.`, workload: anyPost, expect: [200] },
      {
        name: 'GET /content/<contentId>/raw',
        what: `A picture's file, of each of the ${pictures.length} pictures in turn.`,
        workload: list(pictures.map((p) => get(`/content/${p.contentId}/raw`))),
        expect: [200],
      },
      { name: 'GET /content/<contentId>/comments', what: `The ${commentsEach} comments on a post, of each of the ${commented.length} posts that have comments in turn.`, workload: comments, expect: [200] },
      { name: 'GET /tags', what: 'The hashtags posts have used, most recently active first.', workload: list([get('/tags')]), expect: [200] },
      { name: 'GET /users/<userId>', what: "A user's profile, of each of those who post or read in turn.", workload: profiles, expect: [200] },
    ];
    const writes: Scenario[] = [
      { name: 'POST /store', what: 'A new post: a text of 90 to 200 words mostly, sometimes a link or a picture, under two or three hashtags.', workload: newPosts, expect: [201] },
      { name: 'POST /like', what: "A user's first like of a post.", workload: likes, expect: [201] },
      { name: 'POST /content/<contentId>/comments', what: 'A new comment of a few sentences on a post, on one of 200 posts.', workload: newComments, expect: [201] },
    ];
    const mix = [
      { percent: 60, what: 'feeds (of each hashtag in turn: its past 24 hours, that with two other hashtags over three days, its past week newest first, and its past 24 hours with related hashtags added)', source: anyFeed },
      { percent: 20, what: 'posts read', source: anyPost },
      { percent: 5, what: "posts' comments read", source: comments },
      { percent: 3, what: 'profiles read', source: profiles },
      { percent: 2, what: 'lists of hashtags', source: list([get('/tags')]) },
      { percent: 7, what: 'likes', source: likes },
      { percent: 2, what: 'new comments', source: newComments },
      { percent: 1, what: 'new posts', source: newPosts },
    ];
    const mixed: Scenario = { name: 'A mix of requests', what: '', workload: mix, expect: [200, 201] };

    async function measure({ name, what, workload, expect: expected }: Scenario, connections = CONNECTIONS): Promise<Measured> {
      // What the server's process used, from before the load's connections open to after its last response.
      const before = await ask<Usage>('/usage');
      const result = await load.run(workload, { connections, warmupSeconds: WARMUP_SECONDS, durationSeconds: DURATION_SECONDS });
      const after = await ask<Usage>('/usage');
      const used = { cpus: (after.cpuSeconds - before.cpuSeconds) / ((after.at - before.at) / 1000), memoryBytes: after.memoryBytes };
      log(
        `${name}, ${connections} connections: ${Math.round(result.requestsPerSecond)} requests/s, p50 ${result.p50.toFixed(1)} ms, p99 ${result.p99.toFixed(1)} ms, ` +
          `${used.cpus.toFixed(2)} CPUs, ${Math.round(used.memoryBytes / 1024 / 1024)} MB`,
      );
      // Stops the run at the first load that went wrong, so that no file is written of it.
      const unexpected = Object.fromEntries(Object.entries(result.statuses).filter(([status]) => !expected.includes(Number(status))));
      expect({ ...unexpected, ...result.failures }, `${name}, ${connections} connections: responses with a status other than ${expected.join(' or ')}, by status (0: the request failed), and how requests failed`).toEqual({});
      expect(result.requests, `${name}: no request was answered`).toBeGreaterThan(0);
      return { name, what, result, used };
    }

    const report = {
      reads: [] as Measured[],
      writes: [] as Measured[],
      ramp: [] as Measured[],
    };
    for (const scenario of reads) report.reads.push(await measure(scenario));
    for (const scenario of writes) report.writes.push(await measure(scenario));
    const measuredMix = await measure(mixed);
    // From the fewest connections to the most, with the run above in its place among them.
    for (const connections of [...new Set([...RAMP, CONNECTIONS])].sort((a, b) => a - b)) {
      report.ramp.push(connections === CONNECTIONS ? measuredMix : await measure(mixed, connections));
    }
    // Past this, likes would have been given twice, and counted as the writes they weren't.
    expect(likes.base, 'the run needed more likes than there are users and posts to give them: shorten it, or give it more posts').toBeLessThanOrEqual(fans.length * posts.length);

    await writeFile(
      OUT,
      render({
        startedAt,
        host: HOST,
        server: {
          cpus: server.cpus,
          memoryBytes: server.memoryBytes,
          peakMemoryBytes: (await ask<Usage>('/usage')).peakMemoryBytes,
          flushMs: server.flushMs,
          node: server.node,
          kernel: server.kernel,
        },
        settings: { connections: CONNECTIONS, durationSeconds: DURATION_SECONDS, warmupSeconds: WARMUP_SECONDS, threads: THREADS },
        data: {
          users: publishers.length + readers.length + fans.length,
          posts: posts.length,
          hashtags: hashtags.length,
          likes: seededLikes,
          comments: commented.length * commentsEach,
          days,
        },
        ...report,
        mix: mix.map(({ percent, what }) => ({ percent, what })),
        mixed: measuredMix,
      }),
    );
    log(`wrote ${OUT}`);
  } finally {
    await load.close();
  }
});
