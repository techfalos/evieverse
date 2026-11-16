import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD, CliError } from './client.js';
import { run, UPDATED } from './main.js';

/**
 * The CLI's entry point, which scripts/build-cli.mjs bundles into the one file a server ships
 * (dist/cli/evieverse.mjs). It needs Node 20 or newer and nothing else, on any OS.
 */

/** The bundle's own file. Run from source this is one module of several, which an update can't replace. */
const selfPath = BUILD === 'dev' ? null : realpathSync(fileURLToPath(import.meta.url));

/** Reads a line without showing it; from a pipe, everything there is. */
async function readSecret(prompt: string): Promise<string> {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) {
    let piped = '';
    for await (const chunk of stdin) piped += String(chunk);
    return piped;
  }
  stderr.write(prompt);
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const finish = (settle: () => void) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write('\n');
      settle();
    };
    // In raw mode the terminal sends what is typed as it is: nothing is echoed, and Enter and Ctrl-C are characters.
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n' || char === '\u0004') return finish(() => resolve(value));
        if (char === '\u0003') return finish(() => reject(new CliError('cancelled', 130)));
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.resume();
  });
}

process.exitCode = await run(process.argv.slice(2), {
  fetch,
  env: process.env,
  out: (text) => console.log(text),
  err: (text) => console.error(text),
  home: process.env.EVIEVERSE_HOME || join(homedir(), '.evieverse'),
  selfPath,
  readSecret,
  rerun: (argv: string[]) =>
    new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, [selfPath!, ...argv], { stdio: 'inherit', env: { ...process.env, [UPDATED]: '1' } });
      child.on('error', reject);
      child.on('exit', (code) => resolve(code ?? 1));
    }),
});
