import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Addon, Answered, Said, SaidTo } from './native.types.js';

/**
 * The Rust code, which is all under `compactor`: the addon, which is what the API shares with
 * the compactor (compactor/crates/node builds it), and the compactor itself, which is a program
 * of its own (see compactorPath). One implementation serves both sides: the trust plugins,
 * the moderation policy, the blocked words of the server and of its hashtags, the attestations
 * servers sign of their posts, the requests a server makes to an address somebody else chose, and
 * how a search reads the words it is asked with.
 *
 * It is loaded when first used, from the first of these that is there:
 *   - the file EVIEVERSE_ADDON names;
 *   - `native/evieverse.node` beside `src` or `dist`, where an image or a function's bundle has it;
 *   - what cargo last built in `compactor/target`, release or debug, whichever is newer.
 */

/** The folder `src` or `dist` is in. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The library's name as cargo writes it on this system. */
const LIBRARY = process.platform === 'win32' ? 'evieverse_node.dll' : process.platform === 'darwin' ? 'libevieverse_node.dylib' : 'libevieverse_node.so';

/** The compactor's binary by the name cargo and an image give it on this system. */
const BINARY = process.platform === 'win32' ? 'compactor.exe' : 'compactor';

/** The addon, once loaded. */
let loaded: Addon | undefined;

/** When a file was last written; 0 for one that isn't there. */
function writtenAt(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** Where the addon is. Throws, saying how to build it, if it is nowhere. */
export function addonPath(env: Record<string, string | undefined> = process.env): string {
  if (env.EVIEVERSE_ADDON) return env.EVIEVERSE_ADDON;
  const shipped = join(ROOT, 'native', 'evieverse.node');
  if (existsSync(shipped)) return shipped;
  const built = ['release', 'debug'].map((profile) => join(ROOT, 'compactor', 'target', profile, LIBRARY)).sort((a, b) => writtenAt(b) - writtenAt(a))[0]!;
  if (writtenAt(built) > 0) return built;
  throw new Error(
    `the server's addon is not built: \`npm run build:native\` builds it (it needs Rust: https://rustup.rs), or EVIEVERSE_ADDON names the file. Looked for ${shipped} and ${built}`,
  );
}

/**
 * Where the compactor's binary is, for what starts it from here (`npm run compact`, the benchmark,
 * the testbed's seed): the first of these that is there, as for the addon:
 *   - the file COMPACTOR_BIN names;
 *   - `native/compactor` beside `src` or `dist`, where an image has it;
 *   - what cargo last built in `compactor/target`, release or debug, whichever is newer.
 * Throws, saying how to build it, if it is nowhere.
 */
export function compactorPath(env: Record<string, string | undefined> = process.env): string {
  if (env.COMPACTOR_BIN) return env.COMPACTOR_BIN;
  const shipped = join(ROOT, 'native', BINARY);
  if (existsSync(shipped)) return shipped;
  const built = ['release', 'debug'].map((profile) => join(ROOT, 'compactor', 'target', profile, BINARY)).sort((a, b) => writtenAt(b) - writtenAt(a))[0]!;
  if (writtenAt(built) > 0) return built;
  throw new Error(`the compactor is not built: \`npm run build:native\` builds it (it needs Rust: https://rustup.rs), or COMPACTOR_BIN names the file. Looked for ${shipped} and ${built}`);
}

/** The addon, loaded once for the process. */
export function addon(): Addon {
  if (loaded) return loaded;
  const path = addonPath();
  const module = { exports: {} as Addon };
  try {
    process.dlopen(module, path);
  } catch (err) {
    throw new Error(`the server's addon could not be loaded from ${path}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  loaded = module.exports;
  return loaded;
}

/** Says what the addon said, where it belongs. */
export function say(to: SaidTo | undefined, said: Said[]): void {
  if (!to) return;
  for (const { level, fields, msg } of said) to[level](fields, msg);
}

/** What the addon answered a call with, read. */
export const answered = <T>(json: string): Answered<T> => JSON.parse(json) as Answered<T>;
