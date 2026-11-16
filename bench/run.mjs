// `npm run bench`: runs the benchmark in Docker (docker-compose.yml), and takes BENCHMARKS.md out of it.
// Plain JavaScript with nothing to install, so that all a run needs is Docker and Node.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const COMPOSE = ['compose', '-f', 'bench/docker-compose.yml'];
/** The most CPUs the load generator is given: more send no more than the server answers. */
const LOAD_CPUS = 4;

const fail = (message) => {
  console.error(`bench: ${message}`);
  process.exit(1);
};
/** What a command prints, or nothing if it fails. */
const output = (command, args, env = process.env) => {
  try {
    return execFileSync(command, args, { cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};

// Before the run adds to it.
const loadAverage = os.loadavg()[0];

const info = output('docker', ['info', '--format', '{{json .}}']);
if (!info) fail("the benchmark runs in Docker, which isn't answering (`docker info`): start it, and run this again");
const docker = JSON.parse(info);

// Every setting, from the environment or else settings.json: the containers have no defaults of their own.
const settings = Object.fromEntries(Object.entries(JSON.parse(readFileSync(new URL('./settings.json', import.meta.url), 'utf8'))).map(([name, fallback]) => [name, process.env[name] || fallback]));
const serverCpus = Number(settings.BENCH_SERVER_CPUS);
if (!(serverCpus > 0)) fail(`BENCH_SERVER_CPUS is a number of CPUs, got "${settings.BENCH_SERVER_CPUS}"`);
// What Docker has left after the server's, so that the two don't share any.
const loadCpus = Math.min(LOAD_CPUS, Math.floor(docker.NCPU - serverCpus));
if (loadCpus < 1) fail(`Docker has ${docker.NCPU} CPUs, which leaves none to send requests with once the server has ${serverCpus}: give the server fewer (BENCH_SERVER_CPUS), or Docker more`);

// What the report says of the machine and the code, which nothing inside a container can see.
const host = {
  cpu: os.cpus()[0]?.model.trim() ?? 'unknown CPU',
  cores: os.availableParallelism(),
  memoryBytes: os.totalmem(),
  os: `${os.type()} ${os.release()} (${os.arch()})`,
  loadAverage,
  docker: { version: docker.ServerVersion, os: docker.OperatingSystem, cpus: docker.NCPU, memoryBytes: docker.MemTotal },
  commit: output('git', ['rev-parse', '--short', 'HEAD']) || null,
  changed: output('git', ['status', '--porcelain', '--', 'src', 'languages', 'package-lock.json']) !== '',
};

const env = { ...process.env, ...settings, BENCH_LOAD_CPUS: String(loadCpus), BENCH_HOST: JSON.stringify(host) };
const compose = (args, stdio = 'inherit') => spawnSync('docker', [...COMPOSE, ...args], { cwd: ROOT, env, stdio });
/** Removes the containers and the server's volume. Quietly: there may be none. */
const remove = () => compose(['down', '--volumes', '--remove-orphans'], 'ignore').status === 0;

// An interrupt stops the containers, which get it too, and then this removes them, rather than ending here with them left.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {});

let status = 1;
try {
  // Whatever a run that was killed left: its server's posts would be in this one's way.
  remove();
  ({ status } = compose(['up', '--build', '--abort-on-container-exit', '--exit-code-from', 'load']));
  if (status === 0) {
    ({ status } = compose(['cp', 'load:/app/BENCHMARKS.md', 'BENCHMARKS.md']));
    if (status === 0) console.log(`bench: wrote ${ROOT}BENCHMARKS.md`);
  } else {
    // A server that needed more memory than it may use is killed, which ends the run: the logs above don't say why.
    const server = output('docker', [...COMPOSE, 'ps', '--all', '--quiet', 'server'], env);
    const [killed, code] = server ? output('docker', ['inspect', '--format', '{{.State.OOMKilled}} {{.State.ExitCode}}', server]).split(' ') : [];
    if (killed === 'true' || code === '137') {
      console.error(`bench: the server needed more memory than it may use (BENCH_SERVER_MEMORY=${settings.BENCH_SERVER_MEMORY}), and was killed`);
    }
  }
} finally {
  if (!remove()) console.error('bench: the containers are still there: `docker compose -f bench/docker-compose.yml down --volumes` removes them');
}
if (status !== 0) console.error('bench: the run failed, and wrote no file');
process.exit(status ?? 1);
