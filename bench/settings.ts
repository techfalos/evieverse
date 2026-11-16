// A run's settings come from the environment, or else from settings.json, the one place their defaults
// are written. run.mjs, which starts a run, reads both and gives the containers every setting, so
// nothing in them has a default of its own.

/** Something `npm run bench` gives the benchmark's containers through their environment. */
export function given(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} isn't set: \`npm run bench\` runs the benchmark, and sets it`);
  return value;
}

/** The same, where it is a whole number, at least `min`. */
export function setting(name: string, min = 1): number {
  const value = given(name);
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} is a whole number, ${min} or more, got "${value}"`);
  return n;
}
