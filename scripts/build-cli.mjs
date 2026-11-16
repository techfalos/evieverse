// Builds the CLI the server ships (src/cli) into one file that Node.js 20 or newer runs on any OS,
// and the manifest that describes it:
//
//   dist/cli/evieverse.mjs     the CLI, served at /cli/evieverse.mjs
//   dist/cli/manifest.json     { version, build, sha256, size }
//
// `npm run build` runs it after the server is compiled; `node scripts/build-cli.mjs <dir>` writes
// the two files elsewhere.
//
// `build` is what a server holds the CLI to (src/routes/cli.ts): the first 16 hex characters of the
// SHA-256 of the bundle as it is before its own build is written into it. It changes whenever the
// CLI's code or the version in package.json does, and not otherwise.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = resolve(process.argv[2] ?? join(root, 'dist', 'cli'));
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function bundle(buildId) {
  const { outputFiles } = await build({
    // Paths in the bundle's comments are relative to this, wherever the script is run from.
    absWorkingDir: root,
    entryPoints: ['src/cli/bin.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    define: { __CLI_VERSION__: JSON.stringify(version), __CLI_BUILD__: JSON.stringify(buildId) },
    legalComments: 'none',
    write: false,
  });
  return Buffer.from(outputFiles[0].contents);
}

const buildId = sha256(await bundle('')).slice(0, 16);
const cli = await bundle(buildId);
const manifest = { version, build: buildId, sha256: sha256(cli), size: cli.length };

mkdirSync(outdir, { recursive: true });
writeFileSync(join(outdir, 'evieverse.mjs'), cli);
writeFileSync(join(outdir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`CLI ${version} (build ${buildId}): ${cli.length} bytes in ${outdir}`);
