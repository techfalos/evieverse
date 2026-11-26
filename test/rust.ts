import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The folder all of the Rust code is in: the Cargo workspace, where cargo is run, and where the
 * toolchain it is built with is pinned.
 */
export const RUST_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'compactor');

/**
 * The compactor's binary, as the tests run it: COMPACTOR_BIN where that names one that is built
 * already, and otherwise the one test/globalSetup.ts builds before the tests start.
 */
export const COMPACTOR_BIN = process.env.COMPACTOR_BIN || join(RUST_DIR, 'target', 'debug', process.platform === 'win32' ? 'compactor.exe' : 'compactor');

/** The addon the API loads, as test/globalSetup.ts builds it for the tests: with the trust plugin a test configures. */
export const ADDON = join(RUST_DIR, 'target', 'debug', process.platform === 'win32' ? 'evieverse_node.dll' : process.platform === 'darwin' ? 'libevieverse_node.dylib' : 'libevieverse_node.so');

/** What a run of the compactor's binary came to. */
export interface Ran {
  /** The exit code: 0 where it did what it was asked. */
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs the compactor's binary to its end, with exactly this environment (none of the test
 * process's own, so what it resolves is what the test gave it), in the folder `cwd`.
 */
export function runCompactor(args: string[], env: Record<string, string | undefined>, cwd: string): Ran {
  const given = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  try {
    const stdout = execFileSync(COMPACTOR_BIN, args, { env: given, cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const failed = err as { status?: number | null; stdout?: string; stderr?: string; code?: string };
    if (typeof failed.status !== 'number') {
      throw new Error(`the compactor's binary did not run (${failed.code ?? String(err)}): ${COMPACTOR_BIN}. \`cargo build\`, in the folder compactor, builds it`, { cause: err });
    }
    return { code: failed.status, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}
