import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { mountOf, requireVolume } from '../src/db/volume.js';

/** One line of /proc/self/mountinfo: a file system of `type` mounted at `point`, which is written as the file has it. */
const mount = (point: string, type: string, id = 1) => `${id} 0 254:1 / ${point} rw,relatime shared:${id} master:1 - ${type} /dev/vda1 rw`;

/** What a container sees, with a volume at `volume` if one is given: its own layer at the root, and the mounts every container has. */
const container = (...volumes: string[]) =>
  [
    mount('/', 'overlay'),
    mount('/proc', 'proc', 2),
    mount('/dev', 'tmpfs', 3),
    mount('/dev/shm', 'tmpfs', 4),
    mount('/etc/hosts', 'ext4', 5),
    ...volumes.map((v, i) => mount(v, 'ext4', 6 + i)),
    '',
  ].join('\n');

/** What DB_REQUIRE_VOLUME asks of a SQLite database (src/db/volume.ts), which the Docker image turns on. */
describe('a database that has to be on a volume', () => {
  let dir: string;
  beforeAll(async () => {
    // As the check sees it: without the links the system's temporary directory is reached through.
    dir = await realpath(await mkdtemp(join(tmpdir(), 'evieverse-volume-')));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('finds the mount a path is on', () => {
    const mounts = container('/app/data', '/app/data/inner', '/mnt/my\\040disk');
    expect(mountOf('/app/data/evieverse.sqlite', mounts)).toEqual({ point: '/app/data', type: 'ext4' });
    expect(mountOf('/app/data', mounts)).toEqual({ point: '/app/data', type: 'ext4' });
    expect(mountOf('/app/data/inner/db', mounts)).toEqual({ point: '/app/data/inner', type: 'ext4' });
    // A directory whose name begins as a mount point does is not under it.
    expect(mountOf('/app/database/evieverse.sqlite', mounts)).toEqual({ point: '/', type: 'overlay' });
    expect(mountOf('/dev/shm/evieverse.sqlite', mounts)).toEqual({ point: '/dev/shm', type: 'tmpfs' });
    // A space in a mount point is written as its code.
    expect(mountOf('/mnt/my disk/db', mounts)).toEqual({ point: '/mnt/my disk', type: 'ext4' });
    // Of two mounts at one point, the later is the one on top.
    expect(mountOf('/app/data/db', `${container('/app/data')}${mount('/app/data', 'tmpfs', 9)}\n`)).toEqual({ point: '/app/data', type: 'tmpfs' });
    // Fields that some lines have and others don't come before the " - ", and don't move what is after it.
    expect(mountOf('/data/db', '7 0 254:1 / /data rw - xfs /dev/vdb rw\n')).toEqual({ point: '/data', type: 'xfs' });
    expect(mountOf('/data/db', 'not a mountinfo\n')).toBeNull();
    expect(mountOf('/data/db', '')).toBeNull();
  });

  it('takes a file on a mounted volume, and refuses one that would be lost with its container', () => {
    const file = join(dir, 'evieverse.sqlite');
    // On a volume: at the directory, above it, and for a directory that isn't there yet.
    expect(() => requireVolume(file, container(dir))).not.toThrow();
    expect(() => requireVolume(join(dir, 'not', 'yet', 'there.sqlite'), container(dir))).not.toThrow();
    expect(() => requireVolume(file, container(tmpdirRoot(dir)))).not.toThrow();

    // In the container's own files.
    expect(() => requireVolume(file, container())).toThrow(`DB_REQUIRE_VOLUME is on, and the SQLite database at ${file} is in the container's own files, not on a mounted volume: it would be lost with this container.`);
    expect(() => requireVolume(file, container(`${dir}-other`))).toThrow('not on a mounted volume');
    // The error says what to do about it.
    expect(() => requireVolume(file, container())).toThrow('Mount a volume where the database is (docker run -v evieverse:/app/data ...), or use Postgres or MySQL (DB_DIALECT and DATABASE_URL)');
    // In memory, by its address or by where its file is.
    expect(() => requireVolume(':memory:', container(dir))).toThrow('is in memory (DATABASE_URL=:memory:)');
    expect(() => requireVolume(file, `${container()}${mount(dir, 'tmpfs', 9)}\n`)).toThrow(`is on ${dir}, which is kept in memory (tmpfs)`);
    // Nothing that says what is mounted: refused, not taken on trust.
    expect(() => requireVolume(file, '')).toThrow('not on a mounted volume');
  });

  it('is asked for by DB_REQUIRE_VOLUME, and refuses the database before it is created', async () => {
    expect(loadConfig({}, { REDIS_URL: 'redis://localhost' }).db.requireVolume).toBeUndefined();
    expect(loadConfig({}, { REDIS_URL: 'redis://localhost', DB_REQUIRE_VOLUME: 'true' }).db.requireVolume).toBe(true);
    expect(loadConfig({}, { REDIS_URL: 'redis://localhost', DB_REQUIRE_VOLUME: 'false' }).db.requireVolume).toBe(false);
    expect(loadConfig({}, { REDIS_URL: 'redis://localhost', FIRST_ADMIN_PROFILE: ' /app/data/admin-profile.json ' }).firstAdminProfile).toBe('/app/data/admin-profile.json');
    expect(loadConfig({}, { REDIS_URL: 'redis://localhost' }).firstAdminProfile).toBeUndefined();

    await expect(createDb({ dialect: 'sqlite', url: ':memory:', poolSize: 1, requireVolume: true })).rejects.toThrow('DB_REQUIRE_VOLUME is on, and the SQLite database is in memory');
    // Off, as it is unless a setting turns it on, nothing is asked of where the database is.
    const db = await createDb({ dialect: 'sqlite', url: ':memory:', poolSize: 1, requireVolume: false });
    await db.destroy();
  });
});

/** The first directory of an absolute path: a mount point that is well above `path`. */
function tmpdirRoot(path: string): string {
  return `/${path.split('/')[1]}`;
}
