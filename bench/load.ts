import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

/** A request as it is sent. One with a body is sent as JSON. */
export interface Request {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * Where a load's requests come from.
 *
 * `list`: these requests, round and round.
 *
 * `pairs`: a request whose body is one of `first` followed by one of `second`, a different pair
 * each time, for requests that only do their work once (a like, which a user gives a post once).
 * The load generator moves `base` on after every run, so no run is given a pair an earlier one had.
 */
export type RequestSource =
  | { kind: 'list'; requests: Request[] }
  | { kind: 'pairs'; method: string; path: string; headers?: Record<string, string>; first: string[]; second: string[]; base: number };

export const list = (requests: Request[]): RequestSource => ({ kind: 'list', requests });

/** What to send: one source, or several with the share of the requests each is to have, in percent. */
export type Workload = RequestSource | { source: RequestSource; percent: number }[];

export interface LoadOptions {
  /** Connections, opened before the load and kept open, each sending its next request when its last is answered. */
  connections: number;
  /** Seconds of requests sent before the measured ones, and not counted. */
  warmupSeconds: number;
  durationSeconds: number;
}

/** What a run measured: of the requests sent within `durationSeconds`. Times are milliseconds from sending a request to the end of its response. */
export interface LoadResult {
  connections: number;
  durationSeconds: number;
  requests: number;
  requestsPerSecond: number;
  /** The average size of a response's body. */
  responseBytes: number;
  mean: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  /** How many responses had each status. 0: the request failed, without a response or part of the way through one. */
  statuses: Record<string, number>;
  /** How many requests failed in each way: what was sent, and what went wrong. Counts the ones that opened connections and the warm-up's too. */
  failures: Record<string, number>;
}

interface WorkerResult {
  latencies: Float64Array;
  bytes: number;
  statuses: Record<string, number>;
  failures: Record<string, number>;
  used: number[];
}

/** Adds up what each thread counted. */
function tally(counts: Record<string, number>[]): Record<string, number> {
  const total: Record<string, number> = {};
  for (const each of counts) for (const [key, n] of Object.entries(each)) total[key] = (total[key] ?? 0) + n;
  return total;
}

/** The order sources take turns in: a hundred turns, each source with its share of them, spread evenly. */
function scheduleOf(percents: number[]): number[] {
  if (percents.reduce((sum, p) => sum + p, 0) !== 100 || percents.some((p) => !Number.isInteger(p) || p < 0)) {
    throw new Error(`the shares of a workload are whole percents that add up to 100, got ${percents.join(', ')}`);
  }
  const given = percents.map(() => 0);
  return Array.from({ length: 100 }, (_, turn) => {
    // The source furthest behind its share so far.
    const behind = percents.map((p, s) => (p * (turn + 1)) / 100 - given[s]!);
    const s = behind.indexOf(Math.max(...behind));
    given[s]!++;
    return s;
  });
}

/**
 * Sends requests to a server, over HTTP connections that are kept open, and times them. The
 * connections belong to threads, each of which sends requests and reads responses on a CPU of
 * its own: `threads` of them, which is the CPUs the load generator's container has.
 */
export class LoadGenerator {
  private readonly workers: Worker[];

  /**
   * `host`: the server's address, as numbers, so that no connection waits for a name to be looked up.
   * `opening`: the request each connection is opened with, before a load. A cheap one.
   */
  constructor(private readonly host: string, private readonly port: number, private readonly opening: Request, readonly threads: number) {
    const file = fileURLToPath(new URL('./load-worker.mjs', import.meta.url));
    this.workers = Array.from({ length: threads }, () => new Worker(file));
  }

  /** Has a thread do a step, and gives what it answers. */
  private ask<T>(worker: Worker, job: object): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const failed = (err: unknown) => reject(err instanceof Error ? err : new Error(String(err)));
      worker.once('error', failed);
      worker.once('message', (answer: T) => {
        worker.off('error', failed);
        resolve(answer);
      });
      worker.postMessage(job);
    });
  }

  /**
   * Opens the connections, and when every one is open, sends the load over them.
   *
   * In that order, because a server busy with requests is slow to take new connections: opened
   * as the load starts, many of them spend the run waiting to be accepted, or time out, and what
   * is measured is fewer connections than were asked for.
   */
  async run(workload: Workload, { connections, warmupSeconds, durationSeconds }: LoadOptions): Promise<LoadResult> {
    const parts = Array.isArray(workload) ? workload : [{ source: workload, percent: 100 }];
    const sources = parts.map((p) => p.source);
    const schedule = scheduleOf(parts.map((p) => p.percent));
    const ids = Array.from({ length: connections }, (_, i) => i);
    const workers = this.workers.filter((_, w) => w < connections);
    const to = { host: this.host, port: this.port };

    const opened = await Promise.all(
      workers.map((worker, w) =>
        this.ask<{ failures: Record<string, number> }>(worker, { step: 'open', ...to, connections: ids.filter((id) => id % workers.length === w), request: this.opening }),
      ),
    );
    const results = await Promise.all(
      workers.map((worker) => this.ask<WorkerResult>(worker, { step: 'run', ...to, total: connections, warmupMs: warmupSeconds * 1000, durationMs: durationSeconds * 1000, sources, schedule })),
    );

    // The pairs this run was given aren't given again.
    sources.forEach((source, s) => {
      if (source.kind === 'pairs') source.base += Math.max(...results.map((r) => r.used[s]!)) * connections;
    });

    const requests = results.reduce((n, r) => n + r.latencies.length, 0);
    const latencies = new Float64Array(requests);
    let at = 0;
    for (const r of results) {
      latencies.set(r.latencies, at);
      at += r.latencies.length;
    }
    latencies.sort();
    const percentile = (p: number) => (requests ? latencies[Math.min(requests - 1, Math.ceil((p / 100) * requests) - 1)]! : 0);

    return {
      connections,
      durationSeconds,
      requests,
      requestsPerSecond: requests / durationSeconds,
      responseBytes: requests ? results.reduce((n, r) => n + r.bytes, 0) / requests : 0,
      mean: requests ? latencies.reduce((sum, ms) => sum + ms, 0) / requests : 0,
      p50: percentile(50),
      p90: percentile(90),
      p99: percentile(99),
      max: requests ? latencies[requests - 1]! : 0,
      statuses: tally(results.map((r) => r.statuses)),
      failures: tally([...opened, ...results].map((r) => r.failures)),
    };
  }

  async close() {
    await Promise.all(this.workers.map((worker) => worker.terminate()));
  }
}
