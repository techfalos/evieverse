import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Config } from '../config.js';
import type { Trust, TrustAlgorithm, TrustChange, TrustContext, TrustPlugin, TrustPost } from './trust.types.js';

/**
 * A post's trust score: how far the server trusts it, from 0 (not at all) to 100. It serves one
 * purpose, which is to say where the post goes (see routeOf), and is kept nowhere but in the
 * moderation queue, beside a post that waits there.
 *
 * The score is worked out by plugins. Every folder of src/plugins/trust is one: an algorithm that
 * looks at a post and may lower its score. Every post and update starts at 100 and goes through
 * each of the ones the server runs (see trustOf): all of them, but for the optional ones it didn't
 * turn on (see loadTrustPlugins).
 *
 * A comment on a post is scored the same way, by the same plugins, and its score sends it where a
 * post's would. A plugin tells one from a post by `commentOn`.
 */

/** The lowest score there is: no trust at all. No change takes a score below it, and a plugin sets it for what the server shouldn't keep (a blocked word, a malware link). */
export const MIN_TRUST_SCORE = 0;
/** The score every post and comment starts at, and keeps unless a plugin lowers it: the server trusts it wholly. */
export const MAX_TRUST_SCORE = 100;

/** src/plugins/trust, or dist/plugins/trust beside the built server. */
const TRUST_PLUGINS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'trust');

/** Whether `n` is a number a score can be worked out with: neither NaN nor infinite. */
const isNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * The score once a plugin's change is applied to it: never higher than it was, never under 0, and a
 * whole number. A change that isn't one is the plugin's mistake, and an error.
 */
function lowered(score: number, change: TrustChange, plugin: string): number {
  const { set, reduce } = change as { set?: unknown; reduce?: unknown };
  let next: number;
  if (set !== undefined && reduce === undefined && isNumber(set)) next = set;
  else if (reduce !== undefined && set === undefined && isNumber(reduce) && reduce >= 0) next = score - reduce;
  else throw new Error(`the trust plugin ${plugin} must answer { set: <number> } or { reduce: <number, 0 or more> }, not ${JSON.stringify(change)}`);
  return Math.max(MIN_TRUST_SCORE, Math.min(score, Math.floor(next)));
}

/**
 * A post's trust score: 100, as each plugin in turn leaves it. The plugins run one after another,
 * in the order given (that of their folders' names), each told the score so far. Where they
 * disagree the lower score wins: none can raise what another lowered.
 *
 * A plugin that fails, fails the post: nothing is published that a plugin didn't get to look at.
 */
export async function trustOf(plugins: TrustPlugin[], post: TrustPost, ctx: Omit<TrustContext, 'score'>): Promise<Trust> {
  const trust: Trust = { score: MAX_TRUST_SCORE };
  for (const plugin of plugins) {
    const change = await plugin.assess(post, { ...ctx, score: trust.score });
    if (!change) continue;
    const next = lowered(trust.score, change, plugin.name);
    if (next === trust.score) continue;
    trust.score = next;
    // The plugin's reason, if it is one: its own words, or a message of the language files.
    trust.reason =
      typeof change.reason === 'string' || (typeof change.reason === 'object' && change.reason !== null && typeof (change.reason as { key?: unknown }).key === 'string')
        ? change.reason
        : undefined;
  }
  return trust;
}

/** Whether `value` is what a plugin's index file must export as its default: an object with an `assess` function. */
const isAlgorithm = (value: unknown): value is TrustAlgorithm =>
  typeof value === 'object' && value !== null && typeof (value as TrustAlgorithm).assess === 'function';

/**
 * The trust plugins the server runs: one per folder of `dir`, each the default export of the
 * folder's index file, in the order of the folders' names. A plugin that says it is optional is
 * one of them only if `optional` names it, which is the server's `trust.optionalPlugins`; any
 * other runs whatever that says.
 *
 * A folder that doesn't hold a plugin is an error, whether or not its plugin would run, and so is
 * a name that no folder has, so the server doesn't start without an algorithm it was meant to have.
 */
export async function loadTrustPlugins(optional: readonly string[] = [], dir = TRUST_PLUGINS_DIR): Promise<TrustPlugin[]> {
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const unknown = optional.filter((name) => !names.includes(name));
  if (unknown.length) {
    throw new Error(`TRUST_OPTIONAL_PLUGINS names ${unknown.join(', ')}, which ${unknown.length === 1 ? "isn't a folder" : "aren't folders"} of ${dir}: it has ${names.join(', ') || 'none'}`);
  }
  const plugins: TrustPlugin[] = [];
  for (const name of names) {
    // Built, or run from source.
    const file = ['index.js', 'index.ts'].map((index) => join(dir, name, index)).find((path) => existsSync(path));
    if (!file) throw new Error(`the trust plugin ${name} has no index file in ${join(dir, name)}`);
    const algorithm = ((await import(pathToFileURL(file).href)) as { default?: unknown }).default;
    if (!isAlgorithm(algorithm)) throw new Error(`the trust plugin ${name} must export an object with an assess function as its default (${file})`);
    // The gate: an optional plugin the server didn't turn on is left out, and never sees a post.
    if (algorithm.optional === true && !optional.includes(name)) continue;
    plugins.push({ name, assess: (post, ctx) => algorithm.assess(post, ctx) });
  }
  return plugins;
}

/**
 * Where a score sends a post. delete: it is refused, and nothing of it is kept. queue: it is stored
 * but not published until an admin accepts it. allow: it is published.
 */
export type TrustRoute = 'delete' | 'queue' | 'allow';

/**
 * Where `score` sends a post or a comment, by the server's `trust` settings: `delete` if it is
 * less than `deleteBelow`, `queue` if it is less than `allowFrom`, and `allow` otherwise.
 */
export function routeOf(score: number, { deleteBelow, allowFrom }: Pick<Config['trust'], 'deleteBelow' | 'allowFrom'>): TrustRoute {
  if (score < deleteBelow) return 'delete';
  return score < allowFrom ? 'queue' : 'allow';
}
