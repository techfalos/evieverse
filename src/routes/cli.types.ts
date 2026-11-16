import type { Release } from '../cli/client.types.js';

/** The CLI a server ships: the one file, and what describes it (scripts/build-cli.mjs writes both). */
export interface CliRelease extends Release {
  bundle: Buffer;
}
