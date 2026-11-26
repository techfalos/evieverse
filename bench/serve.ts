import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { release } from 'node:os';
import type { Dataset } from './dataset.js';
import { startServer } from './server.js';
import { setting } from './settings.js';

/**
 * The benchmark's server, as its container runs it (docker-compose.yml): the server the load is
 * sent to, on one port, and on another what the load generator asks of it besides, which is what
 * it holds and what it has used. The container's CPUs and memory are what a run gives it, and
 * the report says what they were.
 */

/** Where the API listens. */
const PORT = 3000;
/** Where the server answers about itself: `/info` (ServerInfo), once it has its posts, and `/usage` (Usage). */
const CONTROL_PORT = 3001;
/** The volume the container has for the server's files. */
const DIR = '/data';

/** What the load generator needs of the server before it sends anything, and what the report says of it. */
export interface ServerInfo {
  /** The API's port. */
  port: number;
  dataset: Dataset;
  /** Milliseconds its disk takes to flush a small file. */
  flushMs: number;
  /** The CPUs its container may use, and the bytes of memory. */
  cpus: number;
  memoryBytes: number;
  node: string;
  kernel: string;
}

/**
 * What the server has used, which is what its two processes have: its own, and the compactor's
 * beside it. Two of these, either side of a load, say what the load took.
 */
export interface Usage {
  /** Milliseconds, on the server's clock. */
  at: number;
  /** CPU time of all their threads, since they started. */
  cpuSeconds: number;
  /** The memory they hold now (their resident sets), and the most each has held at any time, added up: they may not have held it at once. */
  memoryBytes: number;
  peakMemoryBytes: number;
}

/** The ticks the kernel counts a process's CPU time in (/proc/<pid>/stat), in a second: 100 on every Linux there is. */
const TICKS_PER_SECOND = 100;

/** The limits Docker put on this container, from where the kernel keeps them (cgroup v2). */
function limits(): { cpus: number; memoryBytes: number } {
  const read = (file: string) => {
    try {
      return readFileSync(`/sys/fs/cgroup/${file}`, 'utf8').trim();
    } catch {
      throw new Error(`can't read /sys/fs/cgroup/${file}: the benchmark's server runs in a container (\`npm run bench\`), on a Docker host with cgroup v2`);
    }
  };
  const [quota, period] = read('cpu.max').split(' ');
  const memory = read('memory.max');
  // A report that said what the server had, when it had the whole machine, would be wrong.
  if (quota === 'max' || memory === 'max') throw new Error("the server's container has no limit on its CPUs or on its memory: `npm run bench` starts it with both");
  return { cpus: Number(quota) / Number(period), memoryBytes: Number(memory) };
}

/** What a process of this container has used, as the kernel counts it: its CPU time, the memory it holds, and the most it has held. */
function usageOf(pid: number | 'self'): Omit<Usage, 'at'> {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  // After the process's name, which is in brackets and may hold anything: its state, and then numbers, of which the 12th and 13th are its time in user and in kernel mode.
  const numbers = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  // The kernel's own count of the most the process has held (VmHWM, in kB): between two loads' ends it may have held more than at either.
  const held = (name: string) => {
    const kb = new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm').exec(status);
    if (!kb) throw new Error(`/proc/${pid}/status doesn't say the memory the process holds (${name})`);
    return Number(kb[1]) * 1024;
  };
  return { cpuSeconds: (Number(numbers[11]) + Number(numbers[12])) / TICKS_PER_SECOND, memoryBytes: held('VmRSS'), peakMemoryBytes: held('VmHWM') };
}

function usage(): Usage {
  const used = [usageOf('self'), usageOf(compactorPid)];
  const sum = (of: (one: Omit<Usage, 'at'>) => number) => used.reduce((total, one) => total + of(one), 0);
  return { at: performance.now(), cpuSeconds: sum((one) => one.cpuSeconds), memoryBytes: sum((one) => one.memoryBytes), peakMemoryBytes: sum((one) => one.peakMemoryBytes) };
}

const startedAt = Date.now();
const log = (message: string) => console.log(`bench ${String(Math.round((Date.now() - startedAt) / 1000)).padStart(4)}s: ${message}`);

const { cpus, memoryBytes } = limits();
// Fewer posts, and there may be no picture among them, or too few to comment on.
const { dataset, flushMs, compactorPid } = await startServer({ posts: setting('BENCH_POSTS', 500), dir: DIR, host: '0.0.0.0', port: PORT, log });
const info: ServerInfo = { port: PORT, dataset, flushMs, cpus, memoryBytes, node: process.version, kernel: release() };

// Listens only now: the load generator waits for it, and so for the posts.
createServer((req, res) => {
  const body = req.url === '/info' ? info : req.url === '/usage' ? usage() : undefined;
  res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(body ?? {}));
}).listen(CONTROL_PORT, '0.0.0.0', () => log('the server is ready for its load'));
