import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { BUNDLE_PATH, CLI_HEADER, isRelease } from '../cli/client.js';
import type { Release } from '../cli/client.types.js';
import type { Config } from '../config.js';
import { badRequest, HttpError, notFound } from '../http/errors.js';
import { msg } from '../language.js';
import type { CliRelease } from './cli.types.js';

/** dist/cli, beside the built server. A server run from source has none. */
const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli');

/** The CLI built with this server, or null if it wasn't built (`npm run dev`). */
export function loadCliRelease(dir = CLI_DIR): CliRelease | null {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const bundle = readFileSync(join(dir, 'evieverse.mjs'));
  if (!isRelease(manifest) || createHash('sha256').update(bundle).digest('hex') !== manifest.sha256) {
    throw new Error(`${dir} doesn't hold the CLI its manifest.json describes: build the server again`);
  }
  const { version, build, sha256, size } = manifest;
  return { version, build, sha256, size, bundle };
}

/** What describes the CLI the server ships, without the file itself: what GET /cli and a 426 tell a client. */
const manifestOf = ({ version, build, sha256, size }: CliRelease): Release => ({ version, build, sha256, size });

/**
 * Makes the CLI keep up with the server: a request that names another build of the CLI than the
 * server's (CLI_HEADER) is answered 426 with the server's, whatever it asked for, and the CLI then
 * replaces itself. Other clients don't send the header, and nothing is asked of them.
 */
export function requireCliBuild(app: FastifyInstance, release: CliRelease) {
  app.addHook('onRequest', async (req) => {
    const build = req.headers[CLI_HEADER];
    // /cli and the paths under it are the ones a CLI of any build may ask for: where it gets the server's.
    if (build === undefined || build === release.build || /^\/cli(?:[/?]|$)/.test(req.url)) return;
    throw new HttpError(426, msg('cli.outdated', { version: release.version, build: release.build }), undefined, { cli: manifestOf(release) });
  });
}

/** The server's address as clients reach it: PUBLIC_BASE_URL, or else the one this request came to. */
function baseUrl(config: Config, req: FastifyRequest): string {
  if (config.publicBaseUrl) return config.publicBaseUrl.replace(/\/+$/, '');
  // A host as a URL has it: a name or an address, and perhaps a port. Anything else doesn't go into a script.
  if (!/^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/.test(req.host) || !['http', 'https'].includes(req.protocol)) throw badRequest(msg('cli.no_address'));
  return `${req.protocol}://${req.host}`;
}

/** For macOS and Linux: `curl -fsSL <server>/cli/install.sh | sh`. All of it is in a function, so a download cut short runs none of it. */
const installSh = (server: string, { version, sha256 }: CliRelease) => `#!/bin/sh
# Installs the evieverse CLI that ${server} ships into ~/.evieverse/bin (or
# $EVIEVERSE_HOME/bin): the CLI, which is one file that Node.js 20 or newer runs, and a
# \`evieverse\` command that runs it.
set -eu

main() {
  server='${server}'
  sha256='${sha256}'
  bin="\${EVIEVERSE_HOME:-$HOME/.evieverse}/bin"

  if ! command -v node >/dev/null 2>&1; then
    echo "evieverse needs Node.js 20 or newer (https://nodejs.org), and there is no node here." >&2
    exit 1
  fi
  if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
    echo "evieverse needs Node.js 20 or newer (https://nodejs.org), and node here is $(node --version)." >&2
    exit 1
  fi

  mkdir -p "$bin"
  download="$bin/evieverse.mjs.download"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$server${BUNDLE_PATH}" -o "$download"
  else
    wget -qO "$download" "$server${BUNDLE_PATH}"
  fi
  # Checked with node, as it's the one tool every system this gets this far on has.
  if ! node -e '
    const [file, sha256] = process.argv.slice(1);
    const found = require("crypto").createHash("sha256").update(require("fs").readFileSync(file)).digest("hex");
    process.exit(found === sha256 ? 0 : 1);
  ' "$download" "$sha256"; then
    rm -f "$download"
    echo "The download is not the CLI this server ships. The server may be mid-deploy: try again in a minute." >&2
    exit 1
  fi
  mv "$download" "$bin/evieverse.mjs"

  cat > "$bin/evieverse" <<'EOF'
#!/bin/sh
exec node "$(dirname "$0")/evieverse.mjs" "$@"
EOF
  chmod +x "$bin/evieverse"

  echo "Installed evieverse ${version} in $bin"
  case ":$PATH:" in
    *":$bin:"*) ;;
    *) echo "Add it to your PATH, in ~/.profile for example:  export PATH=\\"$bin:\\$PATH\\"" ;;
  esac
  echo "Then sign in:  evieverse login $server <your userId>"
}

main
`;

/** For Windows: `irm <server>/cli/install.ps1 | iex` in PowerShell. */
const installPs1 = (server: string, { version, sha256 }: CliRelease) => `# Installs the evieverse CLI that ${server} ships into ~\\.evieverse\\bin (or
# $env:EVIEVERSE_HOME\\bin): the CLI, which is one file that Node.js 20 or newer runs, and a
# evieverse.cmd that runs it.
$ErrorActionPreference = 'Stop'
$server = '${server}'
$sha256 = '${sha256}'
$root = if ($env:EVIEVERSE_HOME) { $env:EVIEVERSE_HOME } else { Join-Path $HOME '.evieverse' }
$bin = Join-Path $root 'bin'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'evieverse needs Node.js 20 or newer (https://nodejs.org), and there is no node here.'
}
$node = node --version
if ([int]$node.TrimStart('v').Split('.')[0] -lt 20) {
  throw "evieverse needs Node.js 20 or newer (https://nodejs.org), and node here is $node."
}

New-Item -ItemType Directory -Force -Path $bin | Out-Null
$download = Join-Path $bin 'evieverse.mjs.download'
Invoke-WebRequest -UseBasicParsing -Uri "$server${BUNDLE_PATH}" -OutFile $download
if ((Get-FileHash -Algorithm SHA256 -Path $download).Hash.ToLower() -ne $sha256) {
  Remove-Item -Path $download
  throw 'The download is not the CLI this server ships. The server may be mid-deploy: try again in a minute.'
}
Move-Item -Force -Path $download -Destination (Join-Path $bin 'evieverse.mjs')
Set-Content -Path (Join-Path $bin 'evieverse.cmd') -Encoding ASCII -Value @('@echo off', 'node "%~dp0evieverse.mjs" %*')

Write-Host "Installed evieverse ${version} in $bin"
if (-not (($env:Path -split ';') -contains $bin)) {
  Write-Host "Add it to your PATH, then open a new terminal:"
  Write-Host "  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';$bin', 'User')"
}
Write-Host "Then sign in:  evieverse login $server <your userId>"
`;

/**
 * The CLI this server ships, for anyone to download: what it is (GET /cli), the file itself, and a
 * script for each kind of system that installs it. What its commands may do is decided where they
 * arrive, by the key they come with.
 */
export function cliRoutes(app: FastifyInstance, { config, cli }: { config: Config; cli: CliRelease | null }) {
  const shipped = (): CliRelease => {
    if (!cli) throw notFound(msg('cli.not_built'));
    return cli;
  };

  app.get('/cli', async (req) => {
    const release = shipped();
    const server = baseUrl(config, req);
    return {
      ...manifestOf(release),
      url: `${server}${BUNDLE_PATH}`,
      install: { sh: `curl -fsSL ${server}/cli/install.sh | sh`, powershell: `irm ${server}/cli/install.ps1 | iex` },
    };
  });

  // Never from a cache: an update must get the build the server now ships.
  app.get(BUNDLE_PATH, async (_req, reply) =>
    reply.header('content-type', 'text/javascript; charset=utf-8').header('cache-control', 'no-store').send(shipped().bundle),
  );

  for (const [name, script] of [['install.sh', installSh], ['install.ps1', installPs1]] as const) {
    app.get(`/cli/${name}`, async (req, reply) =>
      reply.header('content-type', 'text/plain; charset=utf-8').header('cache-control', 'no-store').send(script(baseUrl(config, req), shipped())),
    );
  }
}
