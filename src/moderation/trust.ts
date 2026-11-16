import type { FastifyBaseLogger } from 'fastify';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import type { Text } from '../language.js';

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
export const MIN_TRUST_SCORE = 0;
export const MAX_TRUST_SCORE = 100;

/** What a plugin is told of a new post, of an update, or of a comment. */
export interface TrustPost {
  /** Its publisher, or a comment's author. */
  userId: string;
  /** The content an update writes over; absent for a new post, and for a comment. */
  contentId?: string;
  /** For a comment: the post it is on. Absent for a post. */
  commentOn?: string;
  /** The hashtags it was sent with, normalised, before moderation drops any. A comment has none. */
  tags: string[];
  /**
   * What there is of it to read: its text or caption or link, and its filename. A comment's text, and the name of its image or video.
   * A text, a caption and a comment's text are as their readers read them: without their formatting, and with each link's address
   * after its label, with a space after it where the text goes on (plainText in format.ts).
   */
  texts: string[];
}

/** What a plugin works with. */
export interface TrustContext {
  db: Db;
  config: Config;
  now: () => number;
  /** The log of the request that sent the post, for what its operator should know. Absent where a post is scored outside a request. */
  log?: FastifyBaseLogger;
  /** The post's score as the plugins before this one left it. */
  score: number;
}

/**
 * What a plugin does to a post's score: sets it, or reduces it by so much. Either way the score
 * only goes down: a plugin that sets it higher than it is changes nothing.
 *
 * `reason` is what the publisher is told if this change is what has the post refused: a message of
 * the language files (`msg`, src/language.ts), which they are told in their language, or the
 * plugin's own words, which they are told as written.
 */
export type TrustChange = ({ set: number; reduce?: never } | { reduce: number; set?: never }) & { reason?: Text };

/** What a plugin's index file exports as its default. */
export interface TrustAlgorithm {
  /**
   * Whether the plugin is optional: one that runs only on a server that turns it on, by naming it
   * in `trust.optionalPlugins` (TRUST_OPTIONAL_PLUGINS). A plugin that doesn't say runs on every server.
   */
  optional?: boolean;
  /** Looks at a post, and says what to do to its score. null, or nothing, leaves it as it is. */
  assess(post: TrustPost, ctx: TrustContext): TrustChange | null | undefined | void | Promise<TrustChange | null | undefined | void>;
}

/** A plugin as loaded: its algorithm, named after its folder. */
export interface TrustPlugin extends TrustAlgorithm {
  name: string;
}

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

export interface Trust {
  score: number;
  /** The reason given with the change that brought the score to what it is, if it gave one. */
  reason?: Text;
}

/** A plugin's reason, if it is one: its own words, or a message of the language files. */
const isReason = (reason: unknown): reason is Text =>
  typeof reason === 'string' || (typeof reason === 'object' && reason !== null && typeof (reason as { key?: unknown }).key === 'string');

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
    trust.reason = isReason(change.reason) ? change.reason : undefined;
  }
  return trust;
}

/** src/plugins/trust, or dist/plugins/trust beside the built server. */
const TRUST_PLUGINS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'trust');

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

export function routeOf(score: number, { deleteBelow, allowFrom }: Pick<Config['trust'], 'deleteBelow' | 'allowFrom'>): TrustRoute {
  if (score < deleteBelow) return 'delete';
  return score < allowFrom ? 'queue' : 'allow';
}
