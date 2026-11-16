import { createHash } from 'node:crypto';
import { rename, rm, stat, writeFile } from 'node:fs/promises';
import { BUNDLE_PATH, CliError, isRelease } from './client.js';
import type { Release } from './client.types.js';

/** The commands that install the CLI a server ships, which is how to get it back if an update can't be made. */
export const installHint = (server: string) =>
  `install it again with \`curl -fsSL ${server}/cli/install.sh | sh\` (macOS, Linux) or \`irm ${server}/cli/install.ps1 | iex\` (Windows)`;

/** The CLI a server ships (GET /cli). */
export async function latestRelease(fetchFn: typeof fetch, server: string): Promise<Release> {
  const res = await fetchFn(`${server}/cli`).catch((err: Error) => {
    throw new CliError(`could not reach ${server}: ${err.message}`);
  });
  if (res.status === 404) throw new CliError(`${server} doesn't ship a CLI`);
  const release: unknown = res.ok ? await res.json().catch(() => null) : null;
  if (!isRelease(release)) throw new CliError(`${server} answered ${res.status} when asked for its CLI, without saying which it ships`);
  return release;
}

/**
 * Downloads the CLI a server ships, which must be the file `release` describes. The hash comes from the
 * same server as the file, so it tells a whole download of the right build from a cut-off one or one
 * from a node still running the previous build; it doesn't vouch for the server.
 */
async function downloadRelease(fetchFn: typeof fetch, server: string, release: Release): Promise<Buffer> {
  const res = await fetchFn(`${server}${BUNDLE_PATH}`).catch((err: Error) => {
    throw new CliError(`could not download the CLI from ${server}: ${err.message}`);
  });
  if (!res.ok) throw new CliError(`could not download the CLI from ${server}: it answered ${res.status}`);
  const bundle = Buffer.from(await res.arrayBuffer());
  if (createHash('sha256').update(bundle).digest('hex') !== release.sha256 || bundle.length !== release.size) {
    throw new CliError(`the CLI downloaded from ${server} isn't build ${release.build}: the server may be mid-deploy, so try again in a minute`);
  }
  return bundle;
}

/**
 * Replaces this CLI's own file (`selfPath`) with the one `server` ships: downloaded, checked, written
 * beside it and renamed over it, so the file is never half one and half the other. A copy run from
 * source has no file of its own to replace (`selfPath` is null).
 */
export async function installRelease(fetchFn: typeof fetch, selfPath: string | null, server: string, release: Release): Promise<void> {
  if (!selfPath) {
    throw new CliError(`${server} needs build ${release.build} of the CLI, and a copy run from source can't update itself: build it, or ${installHint(server)}`);
  }
  const bundle = await downloadRelease(fetchFn, server, release);
  const tmp = `${selfPath}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, bundle, { mode: (await stat(selfPath)).mode & 0o777 });
    await rename(tmp, selfPath);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw new CliError(`could not replace ${selfPath} (${(err as Error).message}): ${installHint(server)}`);
  }
}
