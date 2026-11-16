import { chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CliError } from './client.js';

/**
 * A server and an account's key on it, kept in <home>/profiles/<name>.json, where <home> is
 * ~/.evieverse (or EVIEVERSE_HOME). `login` writes one, and so does a Terraform deployment, for
 * the admin account it creates.
 */
export interface Profile {
  /** The server's base URL. */
  server: string;
  userId: string;
  /** The account's name when the profile was written; `whoami` asks the server for the one it has now. */
  username?: string;
  apiKey: string;
}

/** The name `login` saves a profile under when it isn't given one. */
export const DEFAULT_PROFILE = 'default';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const dir = (home: string) => join(home, 'profiles');
const file = (home: string, name: string) => join(dir(home), `${name}.json`);

function checkName(name: string): string {
  if (!NAME.test(name)) throw new CliError(`"${name}" can't name a profile: use letters, digits, ".", "_" and "-"`, 2);
  return name;
}

export async function listProfiles(home: string): Promise<string[]> {
  const files = await readdir(dir(home)).catch(() => [] as string[]);
  return files
    .filter((f) => f.endsWith('.json') && NAME.test(f.slice(0, -5)))
    .map((f) => f.slice(0, -5))
    .sort();
}

export async function readProfile(home: string, name: string): Promise<Profile> {
  const path = file(home, checkName(name));
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new CliError(`there is no profile "${name}" (${path}): sign in with \`evieverse login\``);
  }
  let p: Partial<Profile> | null = null;
  try {
    p = JSON.parse(raw) as Partial<Profile> | null;
  } catch {
    // Reported below, with what a profile holds.
  }
  if (typeof p?.server !== 'string' || typeof p.userId !== 'string' || typeof p.apiKey !== 'string') {
    throw new CliError(`${path} is not a profile: it needs "server", "userId" and "apiKey"`);
  }
  return { server: p.server.replace(/\/+$/, ''), userId: p.userId, apiKey: p.apiKey, ...(typeof p.username === 'string' && { username: p.username }) };
}

/** Writes a profile for its owner alone to read, as it holds a key. Returns its path. */
export async function writeProfile(home: string, name: string, profile: Profile): Promise<string> {
  const path = file(home, checkName(name));
  await mkdir(dir(home), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  // The mode above only applies to a file that wasn't there.
  await chmod(path, 0o600);
  return path;
}

export async function removeProfile(home: string, name: string): Promise<boolean> {
  const names = await listProfiles(home);
  if (!names.includes(name)) return false;
  await rm(file(home, name));
  return true;
}

/** The profile to use: the one named (by --profile, else EVIEVERSE_PROFILE), or the only one there is. */
export async function pickProfile(home: string, wanted: string | undefined): Promise<{ name: string; profile: Profile }> {
  if (wanted) return { name: wanted, profile: await readProfile(home, wanted) };
  const names = await listProfiles(home);
  if (names.length === 1) return { name: names[0]!, profile: await readProfile(home, names[0]!) };
  if (!names.length) throw new CliError('not signed in: run `evieverse login <server> <userId>`');
  throw new CliError(`there are several profiles (${names.join(', ')}): choose one with --profile <name> or EVIEVERSE_PROFILE`);
}
