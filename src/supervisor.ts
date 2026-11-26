import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { Part, Supervised, SuperviseOptions } from './supervisor.types.js';

/**
 * Runs a few programs as one: what the container that holds a whole server is (src/standalone.ts),
 * which is Valkey, the API and the compactor side by side. They are started in the order they
 * are given, live together, and end together: none of them is of any use without the others, so
 * when one ends the rest are stopped, and what started them all (Docker) decides what comes next.
 */

/** How long a part has to end once it is told to, unless the caller says otherwise: longer than a compactor's pass or a request takes to finish. */
const DEFAULT_GRACE_MS = 20_000;

/** How long one PING waits for its answer, in milliseconds. */
const PING_TIMEOUT_MS = 1000;

/** How long to wait between two PINGs of a server that hasn't answered yet, in milliseconds. */
const PING_EVERY_MS = 200;

/**
 * Starts `parts`, in order, and keeps them running together. A part with `ready` is waited for
 * before the next is started. Once one of them ends, or can't be started, the others are stopped
 * and `done` resolves with 1. `stop` ends them all, and `done` then resolves with 0.
 *
 * Stopping is SIGTERM, and SIGKILL for a part that is still there `graceMs` later. The parts
 * that others wait for (`ready`) are stopped last, in the reverse of the order they were started
 * in, each once everything started after it has ended: so a program is never left running
 * without what it needs.
 */
export function supervise(parts: Part[], { graceMs = DEFAULT_GRACE_MS, log = () => {} }: SuperviseOptions = {}): Supervised {
  /** The parts that were started, in order: `ended` says how each ended, and `over` that it has. */
  const running: { part: Part; kill: (signal: NodeJS.Signals) => void; ended: Promise<string>; over: boolean }[] = [];
  const stopped = new AbortController();
  let stopping: Promise<void> | undefined;
  let code = 0;

  const end = async (one: (typeof running)[number]) => {
    if (one.over) return;
    one.kill('SIGTERM');
    const kill = setTimeout(() => {
      log(`${one.part.name} is still running ${graceMs} ms after it was told to end: killing it`);
      one.kill('SIGKILL');
    }, graceMs);
    await one.ended;
    clearTimeout(kill);
  };

  const stop = (why: string): Promise<void> => {
    stopping ??= (async () => {
      log(why);
      stopped.abort();
      await Promise.all(running.filter(({ part }) => !part.ready).map(end));
      for (const needed of running.filter(({ part }) => part.ready).reverse()) await end(needed);
    })();
    return stopping;
  };

  const start = (part: Part) => {
    const child = spawn(part.command, part.args, { stdio: 'inherit', env: part.env ?? process.env });
    const one: (typeof running)[number] = {
      part,
      kill: (signal) => void child.kill(signal),
      over: false,
      ended: new Promise<string>((resolve) => {
        child.once('error', (err) => resolve(`could not be started (${err.message})`));
        child.once('exit', (exit, signal) => resolve(signal ? `was ended by ${signal}` : `ended with ${exit}`));
      }),
    };
    running.push(one);
    void one.ended.then((how) => {
      one.over = true;
      if (stopping) return;
      // Whatever it ended with: a part that ends when nothing asked it to has failed.
      code = 1;
      void stop(`${part.name} ${how}: stopping the rest`);
    });
    return one;
  };

  const done = (async () => {
    for (const part of parts) {
      if (stopping) break;
      const one = start(part);
      log(`started ${part.name}`);
      if (!part.ready) continue;
      try {
        await Promise.race([part.ready(stopped.signal), one.ended]);
      } catch (err) {
        code = 1;
        void stop(`${part.name} did not become ready (${err instanceof Error ? err.message : String(err)}): stopping`);
      }
    }
    if (!stopped.signal.aborted) await new Promise<void>((resolve) => stopped.signal.addEventListener('abort', () => resolve(), { once: true }));
    await stopping;
    return code;
  })();

  return { done, stop: (why) => void stop(why) };
}

/**
 * Whether the Redis-protocol server at an address answers PING with PONG. Not one that isn't
 * there yet, and not one that is still reading its data from disk, which answers that it is
 * loading: neither takes commands.
 */
export function pings(host: string, port: number, timeoutMs = PING_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const over = (answered: boolean) => {
      socket.destroy();
      resolve(answered);
    };
    socket.setTimeout(timeoutMs, () => over(false));
    socket.once('error', () => over(false));
    socket.once('connect', () => socket.write('PING\r\n'));
    socket.once('data', (data) => over(data.toString().startsWith('+PONG')));
  });
}

/** Resolves once the Redis-protocol server at an address takes commands (see pings), or once `signal` says the wait is over. */
export async function answering(host: string, port: number, signal: AbortSignal, everyMs = PING_EVERY_MS): Promise<void> {
  while (!signal.aborted && !(await pings(host, port))) await delay(everyMs, undefined, { signal }).catch(() => {});
}
