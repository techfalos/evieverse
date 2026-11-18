import type { StoreDeps } from './deps.types.js';
import { tooManyRequests } from './http/errors.js';
import { msg } from './language.js';
import { MINUTE } from './time.js';

/**
 * What a user sends that is limited: a post (/store, and a repost), or a comment, which an edit of
 * one counts as. Both go by the same rule, each with its own setting and its own key.
 */
export type Sent = 'post' | 'comment';

/** What the limit is kept with, and held to: the hot store, the settings, which are read on every request, and the clock. */
type LimitDeps = Pick<StoreDeps, 'hot' | 'config' | 'now'>;

/** Gives back the place a post or a comment claimed, when it then fails. */
type Release = () => Promise<void>;

/** When a user's posts in the last minute were: epoch ms separated by spaces, oldest first. Kept a minute. */
const recentPostsKey = (userId: string) => `posts:${userId}`;
/** When a user's comments in the last minute were, as their posts' times are kept. Kept a minute. */
const recentCommentsKey = (userId: string) => `cmtsent:${userId}`;

/**
 * Replaces the times `key` holds, of what the user sent in the minute before `at`, with
 * `to(times)`, unless that returns `times` itself, and returns the `times` it was given. A
 * compare-and-set on the whole value, tried again if another request changed it meanwhile.
 */
async function change({ hot }: LimitDeps, sent: Sent, key: string, at: number, to: (times: number[]) => number[]): Promise<number[]> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const stored = (await hot.get(key))?.toString('utf8') ?? null;
    const times = (stored ? stored.split(' ').map(Number) : []).filter((t) => t > at - MINUTE);
    const next = to(times);
    if (next === times || (await hot.swap(key, stored, next.join(' ') || null, MINUTE))) return times;
  }
  throw tooManyRequests(msg(sent === 'post' ? 'post.too_many_at_once' : 'comment.too_many_at_once'), 1);
}

/**
 * Lets a post or a comment through, or throws 429 with when to try again: one past the most a user
 * sends in any minute (`postRateLimitPerMinute`, `comments.perMinute`; 0: no limit) is refused. The
 * minute is the one before the request, not one of the clock's, so no burst across the turn of a
 * minute gets more through.
 *
 * Each claims its place by compare-and-set in Redis, so concurrent ones can't get past the limit
 * together, and nothing here reads the database. Call the returned function if it then fails: it
 * gives the place back, so it doesn't count.
 */
async function admit(deps: LimitDeps, sent: Sent, userId: string): Promise<Release> {
  const { config, now = Date.now } = deps;
  const limit = sent === 'post' ? config.postRateLimitPerMinute : config.comments.perMinute;
  if (limit === 0) return async () => {};
  const at = now();
  const key = sent === 'post' ? recentPostsKey(userId) : recentCommentsKey(userId);

  // Adds this one's time, where the minute has room for it.
  const before = await change(deps, sent, key, at, (times) => (times.length < limit ? [...times, at] : times));
  if (before.length >= limit) {
    const seconds = Math.max(1, Math.ceil((before[before.length - limit]! + MINUTE - at) / 1000));
    throw tooManyRequests(
      sent === 'post' ? msg('post.rate_limited', { rate: msg('post.rate', { count: limit }), count: seconds }) : msg('comment.rate_limited', { count: seconds }),
      seconds,
    );
  }
  return async () => {
    await change(deps, sent, key, at, (times) => {
      const i = times.indexOf(at);
      return i < 0 ? times : [...times.slice(0, i), ...times.slice(i + 1)];
    }).catch(() => {});
  };
}

/**
 * Lets a post or a comment through (see admit), then writes it; one whose write fails doesn't
 * count. An update of a post is a post, a repost is one too, and an edit of a comment is a comment.
 */
export async function admitting<T>(deps: LimitDeps, sent: Sent, userId: string, write: () => Promise<T>): Promise<T> {
  const release = await admit(deps, sent, userId);
  try {
    return await write();
  } catch (err) {
    await release();
    throw err;
  }
}
