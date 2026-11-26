import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Comment, ContentMeta } from '../src/storage/index.js';
import { COMPACTOR_BIN } from './rust.js';

/** What a pass of the compactor came to. */
export interface RunResult {
  /** The indexes it compacted: hashtags, and publishers' own. */
  tags: string[];
  /** The posts it deleted. */
  deleted: string[];
  /** Whether it made no pass, because another run held the lease. */
  skipped: boolean;
}

/** What a pass is asked for (see the compactor's `--all` and `--rebuild`). */
export interface RunOptions {
  all?: boolean;
  rebuild?: boolean;
}

/** The compactor's calls to its stores that a test can watch, and what the test is told of each. */
export interface Calls {
  'hot.mget': { keys: string[] };
  'hot.set': { key: string };
  'hot.setMany': { keys: string[] };
  'hot.del': { keys: string[] };
  'hot.expire': { keys: string[] };
  'hot.persist': { keys: string[] };
  'hot.exists': { keys: string[] };
  'content.putFile': { key: string };
  'content.putBytes': { key: string };
  'content.putMeta': { meta: ContentMeta };
  'content.removeStaged': { key: string };
  'comments.put': { comment: Comment; held: boolean };
  'comments.publish': { comment: Comment };
  'comments.addLike': { postId: string; commentId: string; userId: string };
  'comments.removeLike': { postId: string; commentId: string; userId: string };
  'comments.remove': { postId: string; commentId: string };
}

/** What a test does about the calls it watches. */
export interface Probe<A> {
  /**
   * Run before each call is made, which waits for it. What it throws is what the call fails
   * with, without being made. For a call that says which of its keys are there (`hot.persist`,
   * `hot.exists`), it may return which of them the call is to say so of, the others being said
   * to be gone.
   */
  before?: (args: A) => unknown;
  /** Run once each call is made, which returns when this has. What it throws is what the call fails with, though it was made. */
  after?: (args: A) => unknown;
}

/** The calls a test watches, as it has seen them. */
export interface Watch<A> {
  /** What each call was made with, in the order they were made in. */
  calls: A[];
  /** Forgets the calls seen so far. */
  clear(): void;
  /** Watches no longer: the calls are made as they are. */
  stop(): void;
}

/** What a reindex did (see `compactor reindex`). */
export interface ReindexResult {
  /** The posts whose terms were brought up to their meta files. */
  posts: number;
  /** The posts the compactor hasn't applied yet, which it indexes when it does. */
  pending: number;
  /** The users whose folded name was wrong, and is now right. */
  usernames: number;
}

/** What answers for the other servers the compactor's process would ask: a test reaches none. */
export interface Fetchers {
  /** Another server's keys, by the address they are asked at: the body of its answer. */
  keys?: (address: string) => Promise<unknown>;
  /** The attestation of a post on another server, by the address it is asked at: the status and the body of its answer. */
  attestation?: (address: string) => Promise<{ status: number; body: unknown }>;
}

/** What a test gives the harness beside the settings. */
export interface HarnessOptions {
  fetchers?: Fetchers;
  /** The trust plugins the test describes, as it describes them to the API's addon (see `openTrust`). */
  plugins?: { testPlugins?: unknown[]; onlyTestPlugins?: boolean };
}

/** A line the harness wrote: its answer to a command, a call it shows the test, or what it asks the test for another server. */
type Line = {
  ready?: true;
  id?: number;
  ok?: unknown;
  error?: string;
  probe?: number;
  when?: 'before' | 'after';
  op?: string;
  args?: unknown;
  fetch?: number;
  kind?: 'keys' | 'attestation';
  address?: string;
};

/** A probe that does the first of these it is given once, and nothing after: what `mockImplementationOnce` was. */
export function once<A>(probe: Probe<A>): Probe<A> {
  let left = { before: probe.before, after: probe.after };
  return {
    ...(probe.before && {
      before: (args: A) => {
        const run = left.before;
        left = { ...left, before: undefined };
        return run?.(args);
      },
    }),
    ...(probe.after && {
      after: (args: A) => {
        const run = left.after;
        left = { ...left, after: undefined };
        return run?.(args);
      },
    }),
  };
}

/** A probe that fails the calls it is shown, without their being made. */
export const failing = (message: string): Probe<unknown> => ({
  before: () => {
    throw new Error(message);
  },
});

/** A probe that lets a call be made, and then fails it: as a run killed right after it would leave things. */
export const killedAfter = (): Probe<unknown> => ({
  after: () => {
    throw new Error('killed');
  },
});

/**
 * The compactor a test runs: the Rust binary's `harness` command (compactor/src/harness.rs), a
 * process of the test's own that reads the settings the test's server has and makes what the
 * test asks of it: a pass, the applying of the writes that wait, a compactor that is up. It
 * tells the time by the test's clock, which every line sent to it carries.
 *
 * `overrides` is what the test gave `loadConfig`, beside an empty environment: written to a
 * file in `dir`, which is the configuration the process reads.
 */
export async function startHarness(dir: string, overrides: unknown, clock: { now: number }, { fetchers = {}, plugins }: HarnessOptions = {}) {
  const configPath = join(dir, 'compactor.config.json');
  writeFileSync(configPath, JSON.stringify(overrides));
  const child: ChildProcessWithoutNullStreams = spawn(COMPACTOR_BIN, ['harness'], {
    cwd: dir,
    // Nothing of this process's own, so that what the harness resolves is what the test gave it.
    env: {
      EVIEVERSE_CONFIG: configPath,
      ...(process.env.PATH && { PATH: process.env.PATH }),
      ...(process.env.EVIEVERSE_HARNESS_LOG && { EVIEVERSE_HARNESS_LOG: process.env.EVIEVERSE_HARNESS_LOG }),
      ...(plugins && { EVIEVERSE_HARNESS_PLUGINS: JSON.stringify(plugins) }),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
    if (process.env.EVIEVERSE_HARNESS_LOG) process.stderr.write(chunk);
  });

  /** The commands that wait for their answer, by their number. */
  const asked = new Map<number, { resolve: (ok: unknown) => void; reject: (err: Error) => void }>();
  /** What the test watches, by the call. */
  const watches = new Map<string, { probe: Probe<never>; calls: unknown[] }>();
  let nextId = 0;
  /** Why the process is gone, once it is. */
  let ended: Error | undefined;
  let closing = false;

  const send = (line: Record<string, unknown>) => {
    if (ended) return;
    child.stdin.write(`${JSON.stringify({ ...line, now: clock.now })}\n`);
  };

  /** Sends a command, and returns what it is answered with. */
  const ask = <T>(cmd: string, more: Record<string, unknown> = {}): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (ended) return reject(ended);
      const id = ++nextId;
      asked.set(id, { resolve: resolve as (ok: unknown) => void, reject });
      send({ id, cmd, ...more });
    });

  /** Answers a call the harness shows: with what the test's probe makes of it. */
  const shown = async ({ probe: call, when, op, args }: Line) => {
    const watch = watches.get(op!);
    try {
      if (when === 'before') {
        watch?.calls.push(args);
        const said = await (watch?.probe.before as ((args: unknown) => unknown) | undefined)?.(args);
        send({ reply: call, after: Boolean(watch?.probe.after), ...(Array.isArray(said) && { mask: said }) });
      } else {
        await (watch?.probe.after as ((args: unknown) => unknown) | undefined)?.(args);
        send({ reply: call });
      }
    } catch (err) {
      send({ reply: call, fail: err instanceof Error ? err.message : String(err) });
    }
  };

  /** Answers what the harness asks for another server: with what the test has answer for it. */
  const fetched = async ({ fetch: call, kind, address }: Line) => {
    try {
      const fetcher = fetchers[kind!];
      if (!fetcher) throw new Error(`a test asked ${address}, and no test reaches another server`);
      send({ reply: call, answer: await fetcher(address!) });
    } catch (err) {
      send({ reply: call, fail: err instanceof Error ? err.message : String(err) });
    }
  };

  let ready!: () => void;
  let unready!: (err: Error) => void;
  const started = new Promise<void>((resolve, reject) => {
    ready = resolve;
    unready = reject;
  });

  createInterface({ input: child.stdout }).on('line', (text) => {
    if (!text.trim()) return;
    const line = JSON.parse(text) as Line;
    if (line.ready) return ready();
    if (line.probe !== undefined) return void shown(line);
    if (line.fetch !== undefined) return void fetched(line);
    const waiting = asked.get(line.id!);
    if (!waiting) return;
    asked.delete(line.id!);
    if (line.error !== undefined) waiting.reject(new Error(line.error));
    else waiting.resolve(line.ok);
  });

  const exited = new Promise<void>((resolve) => {
    const gone = (why: string) => {
      ended ??= new Error(`the compactor's harness ${why}${stderr ? `: ${stderr.trim()}` : ''}`);
      unready(ended);
      // A command that was under way as the test closed the harness is over with it, and is no failure of the test's.
      for (const { resolve: answer, reject } of asked.values()) closing ? answer(undefined) : reject(ended);
      asked.clear();
      resolve();
    };
    child.on('error', (err) => gone(`did not run (${err.message}): ${COMPACTOR_BIN}. \`cargo build --features harness\`, in the folder compactor, builds it`));
    child.on('exit', (code, signal) => gone(`ended (${signal ?? code})`));
  });
  // A line that can't be written is the process's end, which `exit` tells.
  child.stdin.on('error', () => {});

  await started;

  const tell = () => void ask('watch', { ops: [...watches.keys()] }).catch(() => {});

  return {
    /** One pass (see `Compactor::run_once`). Fails as the pass does. */
    runOnce: (opts: RunOptions = {}): Promise<RunResult> => ask<RunResult>('run', { ...opts }),
    /**
     * Applies the writes that requests committed, as a pass starts by doing, and nothing else of
     * a pass. False, with nothing applied, if a run holds the lease.
     */
    apply: (): Promise<boolean> => ask<boolean>('apply'),
    /**
     * Starts a compactor that makes pass after pass, as the one of a deployment does. What it
     * returns stops it, and resolves once the pass it was making has ended.
     */
    start(): () => Promise<void> {
      const up = ask<null>('start');
      return async () => {
        await up;
        await ask<null>('stop');
      };
    },
    /**
     * Watches the compactor's calls of one kind to its stores, from the next command on: each is
     * recorded, and held up or failed as `probe` says. In place of what watched the same calls before.
     */
    watch<K extends keyof Calls>(op: K, probe: Probe<Calls[K]> = {}): Watch<Calls[K]> {
      const watch = { probe: probe as Probe<never>, calls: [] as Calls[K][] };
      watches.set(op, watch);
      tell();
      return {
        calls: watch.calls,
        clear: () => void (watch.calls.length = 0),
        stop: () => {
          if (watches.get(op) !== watch) return;
          watches.delete(op);
          tell();
        },
      };
    },
    /** Watches nothing any more: every call is made as it is. */
    unwatch() {
      watches.clear();
      tell();
    },
    /** Has the compactor's content store say its links last `ms`: a store that signs links, which no test has. */
    linkMs: (ms: number): Promise<null> => ask<null>('linkMs', { ms }),
    /**
     * One look of the origin sweep, which asks other servers after the posts this one holds
     * reposts of (compactor/src/sweep.rs): the test's `fetchers` answer for them. Returns how
     * many entries were due.
     */
    sweep: (): Promise<number> => ask<number>('sweep'),
    /**
     * Has the video worker take the oldest video that waits and see it through
     * (compactor/src/video/worker.rs). False if none waited. `ffmpegPath` is where its ffmpeg
     * is, in place of the settings'.
     */
    video: (opts: { ffmpegPath?: string } = {}): Promise<boolean> => ask<boolean>('video', { ...opts }),
    /** What a process that is to process videos checks before it starts: fails where it has no ffmpeg to do it with. */
    videoCheck: (opts: { ffmpegPath?: string } = {}): Promise<null> => ask<null>('videoCheck', { ...opts }),
    /** What a process that runs the compactor does of users' indexes of their comments as it starts (compactor/src/author_index.rs). */
    authorIndex: (): Promise<null> => ask<null>('authorIndex'),
    /** What `compactor reindex` does (compactor/src/reindex.rs). `progress` is told where it was after each step, once it is done. */
    async reindex(progress: (soFar: ReindexResult) => void = () => {}): Promise<ReindexResult> {
      const done = await ask<{ result: ReindexResult; progress: ReindexResult[] }>('reindex');
      done.progress.forEach((soFar) => progress(soFar));
      return done.result;
    },
    /** What the compactor logged since this was last asked. */
    logs: () => ask<{ level: string; fields: Record<string, unknown>; msg: string }[]>('logs'),
    /** Ends the process. */
    async close() {
      closing = true;
      child.stdin.end();
      const killed = setTimeout(() => child.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(killed);
    },
  };
}

export type Harness = Awaited<ReturnType<typeof startHarness>>;
