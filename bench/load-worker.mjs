// One thread of the load generator (see load.ts, which starts these and says what the messages are).
// Plain JavaScript, so a worker thread runs it as it is, with nothing to compile it first.
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { parentPort } from 'node:worker_threads';

/** Milliseconds between one connection being opened and the next, over all the threads. */
const OPEN_EVERY_MS = 2;

/**
 * What every request says it takes, as a browser's does: a server that compresses its responses
 * for the clients that ask has that work to do here too. Responses are counted as they arrive,
 * and aren't unpacked.
 */
const ACCEPT_ENCODING = 'gzip, deflate, br';

/** This thread's connections, by their number: each an agent that keeps one socket open. */
const agents = new Map();

/**
 * Sends one request and reads all of its response. A request that fails, before its response or
 * part of the way through it, is status 0, with what went wrong in `failure`.
 */
function send(agent, { host, port }, { method, path, headers, body }) {
  return new Promise((resolve) => {
    // The path without what differs from one request to the next, so that failures of a kind count together.
    const route = path.split('?')[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>');
    const failed = (when, bytes) => (err) => resolve({ status: 0, bytes, failure: `${method} ${route}: ${err.code ?? err.message} ${when}` });
    const req = http.request({ host, port, agent, method, path, headers: { 'accept-encoding': ACCEPT_ENCODING, ...headers } }, (res) => {
      let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
      });
      res.on('end', () => (res.complete ? resolve({ status: res.statusCode ?? 0, bytes }) : failed('part of the way through the response', bytes)(new Error('the connection closed'))));
      res.on('error', failed('part of the way through the response', bytes));
    });
    req.on('error', failed('before a response', 0));
    req.end(body);
  });
}

/**
 * Opens this thread's connections, one after another, each with a request of its own.
 *
 * Before any load, because a server that is busy answering requests takes new connections slowly
 * (a Node server with 1 ms of work a request and 160 connections sending took about six more a
 * second, one a turn of its event loop): opened while the load runs, connections wait seconds to
 * be accepted, and the ones the listen queue has no room for time out.
 */
async function open({ host, port, connections, request }) {
  const failures = {};
  await Promise.all(
    connections.map(async (connection) => {
      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
      agents.set(connection, agent);
      await sleep(connection * OPEN_EVERY_MS);
      const res = await send(agent, { host, port }, request);
      if (res.failure) failures[`opening a connection: ${res.failure}`] = (failures[`opening a connection: ${res.failure}`] ?? 0) + 1;
    }),
  );
  return { failures };
}

/** The request a connection sends as its `k`th of a source (see RequestSource in load.ts). */
function requestOf(source, connection, total, k) {
  if (source.kind === 'list') {
    const { requests } = source;
    // Connections start at points spread over the list, so they don't all ask for the same thing at once.
    return requests[(Math.floor((connection * requests.length) / total) + k) % requests.length];
  }
  // No two connections, and no two runs, get the same number: each is a pair of its own until the pairs run out.
  const n = source.base + connection + k * total;
  const body = source.first[n % source.first.length] + source.second[Math.floor(n / source.first.length) % source.second.length];
  return { method: source.method, path: source.path, headers: source.headers, body };
}

/** Sends the load over the connections `open` opened, and closes them. */
async function run({ host, port, total, warmupMs, durationMs, sources, schedule }) {
  let latencies = new Float64Array(1 << 16);
  let count = 0;
  let bytes = 0;
  const statuses = {};
  /** How many requests failed in each way, in the warm-up as well: a connection that fails then is one the load goes without. */
  const failures = {};
  /** The most requests any of this thread's connections took from each source. */
  const used = sources.map(() => 0);

  const measureFrom = performance.now() + warmupMs;
  const stopAt = measureFrom + durationMs;

  await Promise.all(
    [...agents].map(async ([connection, agent]) => {
      const taken = sources.map(() => 0);
      for (let i = 0; ; i++) {
        const s = schedule[(connection + i) % schedule.length];
        const request = requestOf(sources[s], connection, total, taken[s]++);
        const headers = request.body === undefined ? request.headers : { 'content-type': 'application/json', ...request.headers, 'content-length': Buffer.byteLength(request.body) };
        const startedAt = performance.now();
        if (startedAt >= stopAt) break;
        const res = await send(agent, { host, port }, { ...request, headers });
        if (res.failure) failures[res.failure] = (failures[res.failure] ?? 0) + 1;
        // A request counts if it was sent within the measured time, however long its response took.
        if (startedAt < measureFrom) continue;
        if (count === latencies.length) {
          const grown = new Float64Array(latencies.length * 2);
          grown.set(latencies);
          latencies = grown;
        }
        latencies[count++] = performance.now() - startedAt;
        bytes += res.bytes;
        statuses[res.status] = (statuses[res.status] ?? 0) + 1;
      }
      taken.forEach((n, s) => {
        used[s] = Math.max(used[s], n);
      });
      agent.destroy();
    }),
  );
  agents.clear();
  return { latencies: latencies.slice(0, count), bytes, statuses, failures, used };
}

parentPort.on('message', async (job) => {
  if (job.step === 'open') {
    parentPort.postMessage(await open(job));
  } else {
    const result = await run(job);
    parentPort.postMessage(result, [result.latencies.buffer]);
  }
});
