import { spawn } from 'node:child_process';
import { compactorPath } from './native.js';

/**
 * `npm run compact` and `npm run reindex`: runs the compactor with what the command was given,
 * and ends as it ends. The compactor is a program of its own (compactor/src/main.rs), which reads
 * the environment and the config file the server reads, and logs as the server does: this only
 * finds it (see compactorPath) and gets out of its way.
 *
 *   npm run compact                          pass after pass, until it is stopped
 *   npm run compact -- --once                one pass
 *   npm run compact -- --rebuild --once      the whole feed index again, after Redis lost data
 *   npm run reindex                          what search reads, again
 *
 * A deployment that has the binary runs it as it is, without this.
 */

/** The compactor's process, which reads and writes what this process would. */
const child = spawn(compactorPath(), process.argv.slice(2), { stdio: 'inherit' });

child.once('error', (err) => {
  console.error(`The compactor could not be started: ${err.message}`);
  process.exit(1);
});
// What ends this process ends the compactor, which finishes the pass it is making first: this waits for it.
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
child.once('exit', (code) => process.exit(code ?? 1));
