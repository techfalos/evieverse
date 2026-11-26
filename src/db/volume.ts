import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Where Linux lists the mounts a process sees, one a line: the mount point is the fifth field, and the file system's type the first after the " - ". */
const MOUNTINFO = '/proc/self/mountinfo';

/** The file systems that are kept in memory: what is on a mount of one is gone with its container, as what is in the container's own layer is. */
const IN_MEMORY = new Set(['tmpfs', 'ramfs']);

/**
 * The mount that `path` is on, as `mountinfo` (the text of /proc/self/mountinfo) lists it: the one
 * with the longest mount point that is the path or a directory above it, and of two at one mount
 * point the later, which is the one on top. `point` is where it is mounted and `type` its file
 * system. Null if no line names one, as of a text that is not a mountinfo.
 */
export function mountOf(path: string, mountinfo: string): { point: string; type: string } | null {
  let found: { point: string; type: string } | null = null;
  for (const line of mountinfo.split('\n')) {
    const fields = line.split(' ');
    const separator = fields.indexOf('-');
    if (separator < 6 || fields[separator + 1] === undefined) continue;
    // A space, a tab, a newline or a backslash in a mount point is written as a backslash and its code in octal.
    const point = fields[4]!.replace(/\\([0-7]{3})/g, (_, code: string) => String.fromCharCode(parseInt(code, 8)));
    const above = point === '/' || path === point || path.startsWith(`${point}/`);
    if (above && (found === null || point.length >= found.point.length)) found = { point, type: fields[separator + 1]! };
  }
  return found;
}

/**
 * Throws if the SQLite database at `url` would be lost with the container this process is in:
 * one in memory, or a file that is not on a mounted volume. What `db.requireVolume`
 * (DB_REQUIRE_VOLUME) asks for, which the Docker image turns on: a container's own files go when
 * the container is replaced, and the server's users, posts and admin with them.
 *
 * A file is on a volume if the directory it is in, or the nearest one above it that exists, is on
 * a mount other than the root's, of a file system that is not kept in memory. That takes a volume
 * and a directory of the host's alike, and can't tell a volume Docker made without a name, which
 * is not used again by the next container: mount one by name.
 *
 * `mountinfo` is the text of /proc/self/mountinfo, read here unless given. Where there is none,
 * which is anywhere but Linux, nothing says what is mounted, and this throws too.
 */
export function requireVolume(url: string, mountinfo?: string): void {
  const refused = (why: string) =>
    new Error(
      `DB_REQUIRE_VOLUME is on, and the SQLite database ${why}: it would be lost with this container. Mount a volume where the database is (docker run -v evieverse:/app/data ...), or use Postgres or MySQL (DB_DIALECT and DATABASE_URL)`,
    );
  if (url === ':memory:') throw refused('is in memory (DATABASE_URL=:memory:)');
  let dir = resolve(dirname(url));
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  dir = realpathSync(dir);
  let mounts = mountinfo;
  if (mounts === undefined) {
    try {
      mounts = readFileSync(MOUNTINFO, 'utf8');
    } catch {
      throw new Error(`DB_REQUIRE_VOLUME is on, and ${MOUNTINFO} can't be read, so nothing says whether the SQLite database at ${url} is on a mounted volume: it is checked on Linux alone, as in a container`);
    }
  }
  const mount = mountOf(dir, mounts);
  if (mount === null || mount.point === '/') throw refused(`at ${url} is in the container's own files, not on a mounted volume`);
  if (IN_MEMORY.has(mount.type)) throw refused(`at ${url} is on ${mount.point}, which is kept in memory (${mount.type})`);
}
