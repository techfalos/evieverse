import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { answering, pings, supervise } from '../src/supervisor.js';
import type { Part } from '../src/supervisor.types.js';

/**
 * What runs the programs of the one container (src/supervisor.ts), with programs of a line each
 * in place of Valkey, the API and the compactor: each writes what becomes of it to a file all of
 * them share, which is what the tests read.
 */
describe('the supervisor of the one container', () => {
  let dir: string;
  let record: string;
  const servers: Server[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'supervisor-'));
    record = join(dir, 'record');
  });
  afterEach(async () => {
    for (const server of servers.splice(0)) server.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** What the programs wrote, a line each, in the order they wrote it. */
  const recorded = async () => (await readFile(record, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  /** Resolves once the programs wrote `line`. */
  const until = async (line: string) => {
    while (!(await recorded()).includes(line)) await new Promise((resolve) => setTimeout(resolve, 10));
  };
  /** A program that says it is up, and then does what `then` is: by default it stays up until it is told to end, says so, and ends `endsAfterMs` later. */
  const program = (name: string, { then, endsAfterMs = 0, ready }: { then?: string; endsAfterMs?: number; ready?: Part['ready'] } = {}): Part => {
    const say = (what: string) => `require('fs').appendFileSync(${JSON.stringify(record)}, ${JSON.stringify(`${name} ${what}\n`)});`;
    const stays = `process.on('SIGTERM', () => { ${say('told')} setTimeout(() => { ${say('ended')} process.exit(0); }, ${endsAfterMs}); }); setInterval(() => {}, 1000);`;
    return { name, command: process.execPath, args: ['-e', `${say('up')} ${then ?? stays}`], ...(ready && { ready }) };
  };

  it('starts its parts in order, each one that others need before them, and stops them in the reverse', async () => {
    const log: string[] = [];
    const store = program('store', { ready: () => until('store up').then(() => new Promise((resolve) => setTimeout(resolve, 100))) });
    const running = supervise([store, program('api', { endsAfterMs: 150 }), program('worker')], { log: (line) => log.push(line) });
    await Promise.all([until('api up'), until('worker up')]);
    // What the others need was up, and ready, before either of them was started.
    expect((await recorded())[0]).toBe('store up');
    running.stop('asked to stop');
    running.stop('asked again, which changes nothing');
    expect(await running.done).toBe(0);
    const lines = await recorded();
    // The two that need the store were told together, and the store only once both had ended.
    expect(lines.slice(3).sort()).toEqual(['api ended', 'api told', 'store ended', 'store told', 'worker ended', 'worker told']);
    expect(lines.indexOf('store told')).toBeGreaterThan(lines.indexOf('api ended'));
    expect(lines.indexOf('store told')).toBeGreaterThan(lines.indexOf('worker ended'));
    expect(lines.indexOf('worker told')).toBeLessThan(lines.indexOf('api ended'));
    expect(log).toEqual(['started store', 'started api', 'started worker', 'asked to stop']);
  });

  it('stops the rest when one of them ends, whatever it ended with', async () => {
    for (const [then, how] of [
      ['setTimeout(() => process.exit(3), 300);', 'ended with 3'],
      ['setTimeout(() => process.exit(0), 300);', 'ended with 0'],
      ["setTimeout(() => process.kill(process.pid, 'SIGKILL'), 300);", 'was ended by SIGKILL'],
    ] as const) {
      await rm(record, { force: true });
      const log: string[] = [];
      const running = supervise([program('store', { ready: () => until('store up') }), program('api'), program('worker', { then })], { log: (line) => log.push(line) });
      expect(await running.done, how).toBe(1);
      expect(await recorded(), how).toEqual(expect.arrayContaining(['api told', 'api ended', 'store told', 'store ended']));
      expect(log.at(-1), how).toBe(`worker ${how}: stopping the rest`);
    }
  });

  it('starts nothing more once a part has ended, or was never there', async () => {
    const log: string[] = [];
    // The store ends while it is waited for: what needs it is never started.
    const gone = supervise([program('store', { then: 'process.exit(1);', ready: (signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve())) }), program('api')], {
      log: (line) => log.push(line),
    });
    expect(await gone.done).toBe(1);
    expect(await recorded()).toEqual(['store up']);
    expect(log).toEqual(['started store', 'store ended with 1: stopping the rest']);

    const missing = supervise([program('api'), { name: 'worker', command: join(dir, 'no-such-program'), args: [] }], { log: (line) => log.push(line) });
    expect(await missing.done).toBe(1);
    expect(log.at(-1)).toMatch(/^worker could not be started \(.*ENOENT.*\): stopping the rest$/);

    // One that fails as it is waited for is stopped, and the wait is given up.
    const unready = supervise([program('store', { ready: () => Promise.reject(new Error('no answer')) }), program('api')], { log: (line) => log.push(line) });
    expect(await unready.done).toBe(1);
    expect(log.at(-1)).toBe('store did not become ready (no answer): stopping');
  });

  it('kills a part that does not end when it is told to', async () => {
    const log: string[] = [];
    const stubborn = program('worker', { then: "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);" });
    const running = supervise([program('api'), stubborn], { graceMs: 200, log: (line) => log.push(line) });
    await Promise.all([until('api up'), until('worker up')]);
    const asked = Date.now();
    running.stop('asked to stop');
    expect(await running.done).toBe(0);
    expect(Date.now() - asked).toBeGreaterThanOrEqual(190);
    expect(log.at(-1)).toBe('worker is still running 200 ms after it was told to end: killing it');
  });

  it('waits for a Redis-protocol server until it takes commands', async () => {
    /** A server that answers every PING with `answer()`. */
    const listening = async (answer: () => string) => {
      const server = createServer((socket) => socket.on('data', () => socket.write(answer())));
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      return (server.address() as AddressInfo).port;
    };
    let loading = true;
    const port = await listening(() => (loading ? '-LOADING Valkey is loading the dataset in memory\r\n' : '+PONG\r\n'));
    expect(await pings('127.0.0.1', port)).toBe(false);
    const never = new AbortController();
    let ready = false;
    const waited = answering('127.0.0.1', port, never.signal, 20).then(() => (ready = true));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(ready).toBe(false);
    loading = false;
    await waited;
    expect(await pings('127.0.0.1', port)).toBe(true);

    // Nothing listens, or what listens says nothing: no answer, and a wait that ends when it is told to.
    const silent = await listening(() => '');
    expect(await pings('127.0.0.1', silent, 100)).toBe(false);
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const free = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    expect(await pings('127.0.0.1', free)).toBe(false);
    const given = new AbortController();
    const up = answering('127.0.0.1', free, given.signal, 20);
    setTimeout(() => given.abort(), 60);
    await up;
  });
});
