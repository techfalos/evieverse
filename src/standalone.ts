import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { compactorPath } from './native.js';
import { answering, supervise } from './supervisor.js';
import type { Part } from './supervisor.types.js';

/**
 * A whole server in one container (the `standalone` target of the Dockerfile): Valkey, which
 * holds the feed index, the API (server.ts) and the compactor (compactor/src/main.rs), as three
 * processes this one starts, in that order, and ends together (see supervise). When one of them
 * ends, the others are stopped and this exits with 1, so the container ends, and Docker starts it
 * again where it is told to (`--restart unless-stopped`). SIGINT and SIGTERM stop them all, and
 * this then exits with 0.
 *
 * The Valkey is the container's own: it listens on the loopback address alone, with no
 * password, and keeps its data beside the server's (VALKEY_DIR, on the volume), written to disk
 * every second, so the feed index is there when the container starts again. It may hold
 * VALKEY_MAXMEMORY, and then evicts only what has a time to live, as every server's Redis must.
 * The image sets REDIS_URL to it (OWN_VALKEY), so that a command run in the container beside
 * these finds it (`docker exec ... compactor --rebuild --once`). With REDIS_URL set to anything
 * else, the server uses the Redis or Valkey that names, and none is started here.
 *
 * The API and the compactor read their settings from the same environment, so they share the
 * database and the stores: SQLite and the content's files on the volume, unless the settings
 * say otherwise (DB_DIALECT and DATABASE_URL, CONTENT_SCHEME and CONTENT_OPTIONS).
 */

/** The port the container's own Valkey listens on, on the loopback address. */
const VALKEY_PORT = 6379;

/** Where the container's own Valkey is, which is what REDIS_URL says in a container that uses it, or doesn't say at all. */
const OWN_VALKEY = `redis://127.0.0.1:${VALKEY_PORT}`;

/** Says what this process does, as the server says what it does: a line of JSON for each thing. */
const log = pino({ name: 'standalone' });

/** The programs of the container, in the order they are started. */
const parts: Part[] = [];

/** The Redis the API and the compactor use: the one REDIS_URL names, or the container's own. */
const redisUrl = process.env.REDIS_URL || OWN_VALKEY;

if (redisUrl === OWN_VALKEY) {
  const dir = process.env.VALKEY_DIR || '/app/data/valkey';
  mkdirSync(dir, { recursive: true });
  // prettier-ignore
  const args = [
    '--bind', '127.0.0.1', '--port', String(VALKEY_PORT), '--dir', dir,
    // An append-only file, on disk every second, and no snapshots beside it: what a crash loses is a second, which the compactor's next passes write again or `compactor --rebuild --once` does.
    '--appendonly', 'yes', '--appendfsync', 'everysec', '--save', '',
    // Only keys with a time to live are ever evicted (hot summaries, superseded index keys), never a live head or day index.
    '--maxmemory', process.env.VALKEY_MAXMEMORY || '512mb', '--maxmemory-policy', 'volatile-lru',
  ];
  parts.push({ name: 'valkey', command: 'valkey-server', args, ready: (signal) => answering('127.0.0.1', VALKEY_PORT, signal) });
}

/** What the API and the compactor are started with: this process's environment, and where Redis is. */
const env = { ...process.env, REDIS_URL: redisUrl };
// The API first: it brings the schema up to date as it starts, which the compactor waits for.
parts.push({ name: 'server', command: process.execPath, args: [fileURLToPath(new URL('./server.js', import.meta.url))], env });
parts.push({ name: 'compactor', command: compactorPath(), args: [], env });

/** The three, running. */
const running = supervise(parts, { log: (line) => log.info(line) });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => running.stop(`${signal}: shutting down`));
process.exit(await running.done);
