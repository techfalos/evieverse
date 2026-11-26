import { spawnSync } from 'node:child_process';
import { ADDON, RUST_DIR } from './rust.js';

/**
 * Before any test: builds the Rust code the tests run, which is the compactor's binary, with
 * the command the tests drive it by (`compactor harness`, see test/harness.ts), and the addon
 * the API loads (compactor/crates/node), with the trust plugin tests configure.
 * Cargo does nothing where they are up to date, so the tests never run against code older than
 * what is beside them.
 *
 * With COMPACTOR_BIN and EVIEVERSE_ADDON both set, the ones they name are run as they are, and
 * nothing is built: for a machine that is given them, such as an image that holds no Rust
 * toolchain. They must then be built with the features the tests need: `harness` of the
 * binary, and `test-plugin` of the addon.
 */
export default function setup() {
  if (process.env.COMPACTOR_BIN && process.env.EVIEVERSE_ADDON) return;
  // In the folder of the Rust code: the workspace is there, and so is the toolchain's pin.
  const built = spawnSync('cargo', ['build', '--locked', '-p', 'compactor', '-p', 'evieverse-node', '--features', 'compactor/harness,evieverse-node/test-plugin'], {
    cwd: RUST_DIR,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (built.error) {
    throw new Error(
      `the tests run the compactor's binary and the server's addon, and cargo, which builds them, did not start (${built.error.message}): install Rust (https://rustup.rs), or set COMPACTOR_BIN and EVIEVERSE_ADDON to ones that are built`,
    );
  }
  if (built.status !== 0) throw new Error("the tests run the compactor's binary and the server's addon, which did not build: see what cargo said above");
  // The one just built, whatever else is on this machine: every test's process is started with this.
  process.env.EVIEVERSE_ADDON ||= ADDON;
}
