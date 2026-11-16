import { open, readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { Operator } from 'opendal';
import { startTokenRelay, usesManagedIdentity } from './azureIdentity.js';

/** The directory each local `fs` operator made here keeps its files in. */
const roots = new WeakMap<Operator, string>();

/** OpenDAL reports missing paths as a generic error whose message has "NotFound" in it. */
export function isNotFound(err: unknown): boolean {
  return /NotFound/.test((err as Error)?.message ?? '');
}

/**
 * `op`, with each of its calls to the store made once `ready` is done. What an operator says of
 * itself without asking the store (`capability`), its blocking calls and `layer` are not held back.
 */
function after(ready: Promise<void>, op: Operator): Operator {
  // What `ready` failed with is each call's own failure; with no call made it is nobody's, and not the process's end.
  ready.catch(() => {});
  return new Proxy(op, {
    get(target, name) {
      const value: unknown = Reflect.get(target, name, target);
      if (typeof value !== 'function') return value;
      if (typeof name !== 'string' || ['constructor', 'capability', 'layer'].includes(name) || name.endsWith('Sync')) return value.bind(target);
      return (...args: unknown[]) => ready.then(() => value.apply(target, args));
    },
  });
}

/**
 * Local `fs` roots are created on demand; temp-then-rename writes make overwrites atomic for readers.
 *
 * An `azblob` store with no key of its own, where the process has a managed identity, is reached
 * as that identity, whose tokens OpenDAL gets through a relay in this process (azureIdentity.ts).
 * The relay starts here and takes a moment to listen, and OpenDAL looks for it when it first needs
 * a token, so the operator's calls wait for it: one made at once would look where no relay is yet.
 */
export function createOperator(scheme: string, options: Record<string, string>): Operator {
  const opts = { ...options };
  if (scheme === 'fs' && opts.root && !opts.atomic_write_dir) opts.atomic_write_dir = `${opts.root.replace(/\/+$/, '')}/.tmp`;
  const op = new Operator(scheme, opts);
  if (scheme === 'fs' && opts.root) roots.set(op, resolve(opts.root));
  return scheme === 'azblob' && usesManagedIdentity(opts) ? after(startTokenRelay(), op) : op;
}

/** The file an object of a local `fs` operator is, or null for an operator of any other kind. */
function localFile(op: Operator, key: string): string | null {
  const root = roots.get(op);
  if (root === undefined) return null;
  const file = resolve(root, key);
  // Keys are made of ids. One that led out of the store would be a bug, and not a file to read.
  if (!file.startsWith(root + sep)) throw new Error(`"${key}" is not an object of the store`);
  return file;
}

/** Whether an error of Node's says a local file isn't there (ENOENT): what isNotFound says of OpenDAL's errors. */
const missing = (err: unknown) => (err as NodeJS.ErrnoException)?.code === 'ENOENT';

/**
 * A whole object, or null if there is none.
 *
 * A local file is read by Node, not through OpenDAL. OpenDAL's fs reader, which isn't told how
 * much it is to read, takes 2 to 3 MB of memory for every read under way, however small the file,
 * and keeps it: 1,200 summaries of 310 bytes read at once, which is fifty 30-day feeds, took a
 * process to 3.7 GB, and the same reads by Node to 0.1 GB. It can be told the size, but that has
 * to be asked for first, and a file replaced in between would be read cut short. Node opens the
 * file once, and reads the old file or the new one, whole.
 */
export async function readObject(op: Operator, key: string): Promise<Buffer | null> {
  const file = localFile(op, key);
  try {
    return file === null ? await op.read(key) : await readFile(file);
  } catch (err) {
    if (file === null ? isNotFound(err) : missing(err)) return null;
    throw err;
  }
}

/**
 * An object's bytes, as a stream. One that isn't there fails here, with an error isNotFound knows.
 *
 * A local file's by Node, as in readObject and for the same reason: OpenDAL's reader held tens of
 * megabytes for every stream under way.
 */
export async function streamObject(op: Operator, key: string): Promise<Readable> {
  const file = localFile(op, key);
  if (file === null) return (await op.reader(key)).createReadStream();
  try {
    // Opened before there is a stream, so that the stream is of a file that is there. It closes the file when it ends or is destroyed.
    return (await open(file)).createReadStream();
  } catch (err) {
    throw missing(err) ? new Error(`NotFound: the store has no "${key}"`, { cause: err }) : err;
  }
}
