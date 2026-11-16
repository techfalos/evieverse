import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The release of Evieverse this code is, or for a modified version, the one it is based on: the
 * version in package.json, which is beside src/ in the source and beside dist/ once built (the
 * image keeps it there). GET /rules gives it with the modification disclosure.
 */
export const RELEASE: string = (() => {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  let version: unknown;
  try {
    ({ version } = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown });
  } catch (err) {
    throw new Error(`could not read the release of Evieverse from ${file}: ${(err as Error).message}`);
  }
  if (typeof version !== 'string' || !version) throw new Error(`${file} names no version, which is the release of Evieverse this server says it runs`);
  return version;
})();
