import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../config.js';
import { challengeRequired, tooManyRequests } from '../http/errors.js';
import { msg, type Message } from '../language.js';
import type { HotStore } from '../storage/index.js';
import { iso } from '../time.js';
import { challengeText, renderChallenge } from './image.js';

/** Fields of a request that answers a challenge; form fields arrive as strings. */
export const ChallengeFields = {
  challengeId: z.string().uuid().optional(),
  challengeAnswer: z.string().max(64).optional(),
  challengeNonce: z.union([z.string().max(64), z.number().int().min(0)]).transform(String).optional(),
};
export interface ChallengeSolution {
  challengeId?: string;
  challengeAnswer?: string;
  challengeNonce?: string;
}

/** What a 428 response carries. */
export interface Challenge {
  id: string;
  /** A PNG of the characters that are the answer. */
  image: string;
  expiresAt: string;
  expiresInSeconds: number;
  /** This is challenge `step` of the `steps` the request needs, solved one after another. */
  step: number;
  steps: number;
  /** The nonce is any string that makes the SHA-256 of `prefix + nonce` start with `bits` zero bits. */
  proofOfWork: { algorithm: 'SHA-256'; prefix: string; bits: number };
}

/** Where a challenge stands in the run a request needs; for a post, `streak` is what set `steps`. */
interface Step {
  step: number;
  steps: number;
  streak?: number;
}

interface Issued extends Step {
  /** 'register', or 'post:<userId>'. */
  scope: string;
  answer: string;
  issuedAt: number;
  expiresAt: number;
  bits: number;
}

export const challengeKey = (id: string) => `chal:${id}`;

export function leadingZeroBits(hash: Buffer): number {
  let bits = 0;
  for (const byte of hash) {
    if (byte) return bits + Math.clz32(byte) - 24;
    bits += 8;
  }
  return bits;
}

/**
 * How many challenges a post needs after `streak` posts in a row with challenges: 1, 1, then 2 for as
 * long as the run goes on. Nobody is asked to solve more than two one after another.
 */
const postSteps = (streak: number) => (streak < 2 ? 1 : 2);

const normalizeAnswer = (s: string) => s.toUpperCase().replace(/[\s-]/g, '');

/** When a user's posts in the last minute were: epoch ms separated by spaces, oldest first. Kept a minute. */
export const recentPostsKey = (userId: string) => `posts:${userId}`;
/** A user's run of posts, as `<last> <streak>` (see PostRun). Kept one post window. */
export const postRunKey = (userId: string) => `run:${userId}`;

/** Of the times a user's recent posts are stored as, those less than a minute before `at`. */
const postsInMinute = (stored: string | null, at: number) =>
  (stored ? stored.split(' ').map(Number) : []).filter((t) => t > at - 60_000);

/**
 * A user's run of posts: when they last posted or were challenged to (a post within the window after
 * it must solve challenges), and how many posts in a row they made with challenges, which sets how
 * many the next one needs, and is the place in the run a post's challenges are solved for. A user with
 * none stored hasn't posted within the window.
 */
interface PostRun {
  last: number;
  streak: number;
}

/** A value in the hot store that requests change by compare-and-set. */
interface Cell<T> {
  key: string;
  ttlMs: number;
  read(stored: string | null): T;
  /** Null: nothing worth keeping, so the key is deleted. */
  write(value: T): string | null;
}

const postRun = (userId: string, ttlMs: number): Cell<PostRun | null> => ({
  key: postRunKey(userId),
  ttlMs,
  read(stored) {
    if (!stored) return null;
    const [last, streak] = stored.split(' ').map(Number);
    return { last: last!, streak: streak! };
  },
  write: (run) => run && `${run.last} ${run.streak}`,
});

/** Throws 429 if `times`, the user's posts in the minute before `at`, are already `limit`. */
function refuseOverLimit(times: number[], at: number, limit: number) {
  if (times.length < limit) return;
  const seconds = Math.max(1, Math.ceil((times[times.length - limit]! + 60_000 - at) / 1000));
  throw tooManyRequests(msg('post.rate_limited', { rate: msg('post.rate', { count: limit }), count: seconds }), seconds);
}

/**
 * Challenges people solve to register, and to post again soon after posting: the characters in a
 * distorted image, plus a proof of work the client's software does meanwhile. Each lives in Redis for
 * `ttlSeconds`, and any answer uses it up, right or wrong, so every guess costs a new image and a new
 * proof of work. What a user posted lately is in Redis too, and nothing here reads the database.
 * Settings are read on every request.
 */
export class Challenges {
  private readonly now: () => number;

  constructor(private readonly deps: { hot: HotStore; config: Config; now?: () => number }) {
    this.now = deps.now ?? Date.now;
  }

  private get settings() {
    return this.deps.config.challenge;
  }

  async issue(scope: string, { step, steps, streak }: Step = { step: 1, steps: 1 }): Promise<Challenge> {
    const { ttlSeconds, powBits: bits } = this.settings;
    const id = randomUUID();
    const answer = challengeText();
    const issuedAt = this.now();
    const issued: Issued = { scope, answer, issuedAt, expiresAt: issuedAt + ttlSeconds * 1000, bits, step, steps, streak };
    // Kept a minute past expiresAt, so a late answer is told it was late.
    await this.deps.hot.set(challengeKey(id), JSON.stringify(issued), (ttlSeconds + 60) * 1000);
    return {
      id,
      image: `data:image/png;base64,${renderChallenge(answer).toString('base64')}`,
      expiresAt: iso(issued.expiresAt),
      expiresInSeconds: ttlSeconds,
      step,
      steps,
      proofOfWork: { algorithm: 'SHA-256', prefix: `${id}:`, bits },
    };
  }

  /**
   * The challenge `solution` answers, if it was issued for `scope`, and why it doesn't solve it, or null
   * if it does. The checks that don't need the answer come first, so an answer sent too soon or without
   * the work says nothing about whether it was right.
   */
  private async check(scope: string, solution: ChallengeSolution): Promise<{ issued?: Issued; failed: Message | null }> {
    const raw = await this.deps.hot.take(challengeKey(solution.challengeId!));
    if (!raw) return { failed: msg('challenge.used') };
    const issued = JSON.parse(raw.toString('utf8')) as Issued;
    if (issued.scope !== scope) return { failed: msg('challenge.other_request') };
    const at = this.now();
    const fail = (failed: Message) => ({ issued, failed });
    if (at > issued.expiresAt) return fail(msg('challenge.expired'));
    if (at - issued.issuedAt < this.settings.minSolveMs) return fail(msg('challenge.too_quick'));
    const hash = createHash('sha256').update(`${solution.challengeId}:${solution.challengeNonce ?? ''}`).digest();
    if (leadingZeroBits(hash) < issued.bits) return fail(msg('challenge.wrong_proof_of_work'));
    const answer = Buffer.from(normalizeAnswer(solution.challengeAnswer ?? ''));
    const expected = Buffer.from(issued.answer);
    if (answer.length !== expected.length || !timingSafeEqual(answer, expected)) return fail(msg('challenge.wrong_characters'));
    return { issued, failed: null };
  }

  /** Returns if `solution` solves a registration challenge; otherwise throws 428 with a new one. */
  async register(solution: ChallengeSolution): Promise<void> {
    if (!this.settings.register) return;
    const failed = solution.challengeId === undefined ? undefined : (await this.check('register', solution)).failed;
    if (failed === null) return;
    throw challengeRequired(failed ? msg('challenge.solve_new', { reason: failed }) : msg('challenge.register'), await this.issue('register'));
  }

  /**
   * Lets a post (/store) through, or throws 429 or 428. A post past
   * `postRateLimitPerMinute` in the last minute is refused outright, with when to try again, before any
   * challenge, so nobody solves challenges for a post that can't go through. Otherwise it may need
   * challenges (see `passPostChallenges`).
   *
   * Posts claim their place by compare-and-set in Redis, so concurrent posts can't get past the limit,
   * or past fewer challenges, together. Call the returned function if the post then fails: it gives the
   * claims back, so the post doesn't count, and a retry costs no more.
   */
  private async admitPost(userId: string, solution: ChallengeSolution): Promise<() => Promise<void>> {
    const at = this.now();
    const limit = this.deps.config.postRateLimitPerMinute;
    if (limit > 0) refuseOverLimit(await this.changeRecentPosts(userId, at, (times) => times), at, limit);
    const release = await this.passPostChallenges(userId, solution, at);
    if (limit === 0) return release;
    try {
      // Another post may have taken the last place since the check above.
      const times = await this.changeRecentPosts(userId, at, (times) => (times.length < limit ? [...times, at] : times));
      refuseOverLimit(times, at, limit);
    } catch (err) {
      await release();
      throw err;
    }
    return async () => {
      const without = (times: number[]) => {
        const i = times.indexOf(at);
        return i < 0 ? times : [...times.slice(0, i), ...times.slice(i + 1)];
      };
      await this.changeRecentPosts(userId, at, without).catch(() => {});
      await release();
    };
  }

  /** Lets a post through (see admitPost), then writes it; a post whose write fails doesn't count. */
  async admitting<T>(userId: string, solution: ChallengeSolution, write: () => Promise<T>): Promise<T> {
    const release = await this.admitPost(userId, solution);
    try {
      return await write();
    } catch (err) {
      await release();
      throw err;
    }
  }

  /**
   * Replaces what a cell holds with `change(value)`, unless that returns `value` itself, and returns the
   * `value` it was given. A compare-and-set on the whole value, tried again if another post changed it
   * meanwhile.
   */
  private async change<T>(cell: Cell<T>, change: (value: T) => T): Promise<T> {
    const { hot } = this.deps;
    for (let attempt = 0; attempt < 20; attempt++) {
      const stored = (await hot.get(cell.key))?.toString('utf8') ?? null;
      const value = cell.read(stored);
      const next = change(value);
      if (next === value) return value;
      if (await hot.swap(cell.key, stored, cell.write(next), cell.ttlMs)) return value;
    }
    throw tooManyRequests(msg('post.too_many_at_once'), 1);
  }

  /** Changes the user's posts in the minute before `at` (see `change`). */
  private changeRecentPosts(userId: string, at: number, change: (times: number[]) => number[]): Promise<number[]> {
    const cell: Cell<number[]> = {
      key: recentPostsKey(userId),
      ttlMs: 60_000,
      read: (stored) => postsInMinute(stored, at),
      write: (times) => times.join(' ') || null,
    };
    return this.change(cell, change);
  }

  /**
   * Returns if a post at `at` needs no challenge, or `solution` solves the last it needs; otherwise
   * throws 428 with the next. A post needs challenges while the user's last post, or last challenge to
   * post, was less than `postWindowSeconds` ago; after a quiet window the next post passes without one,
   * and the run starts over. A post after `streak` challenged ones in the run needs `postSteps(streak)`
   * challenges, solved one after another: each right answer gets the next, and a wrong one a new
   * challenge at the same step. Of concurrent posts only one passes without a challenge, and only one
   * passes at each point of the run, so solving runs in parallel gains nothing.
   */
  private async passPostChallenges(userId: string, solution: ChallengeSolution, at: number): Promise<() => Promise<void>> {
    const windowSeconds = this.settings.postWindowSeconds;
    if (windowSeconds === 0) return async () => {};
    const windowMs = windowSeconds * 1000;
    const change = (to: (run: PostRun | null) => PostRun | null) => this.change(postRun(userId, windowMs), to);
    /** Whether a whole window has gone by since the run's last post or challenge. */
    const over = (run: PostRun) => run.last <= at - windowMs;

    // After a quiet window the post claims the next one, and the run starts over. Otherwise it's in the run, and moves its window on.
    const before = await change((run) => (!run || over(run) ? { last: at, streak: 0 } : run.last < at ? { ...run, last: at } : run));
    if (!before || over(before)) {
      return async () => {
        // A failure here only means the retry needs a challenge.
        await change((run) => (run?.last === at ? null : run)).catch(() => {});
      };
    }

    const scope = `post:${userId}`;
    const { issued, failed } = solution.challengeId === undefined ? { issued: undefined, failed: undefined } : await this.check(scope, solution);
    if (issued && failed) throw challengeRequired(msg('challenge.solve_new', { reason: failed }), await this.issue(scope, issued));
    if (issued && issued.step < issued.steps) {
      throw challengeRequired(msg('challenge.solve_next', { step: issued.step, steps: issued.steps }), await this.issue(scope, { ...issued, step: issued.step + 1 }));
    }
    if (issued) {
      const streak = issued.streak ?? 0;
      const was = await change((run) => ((run?.streak ?? 0) === streak ? { last: run?.last ?? at, streak: streak + 1 } : run));
      if ((was?.streak ?? 0) === streak) {
        return async () => {
          await change((run) => (run?.streak === streak + 1 ? { ...run, streak } : run)).catch(() => {});
        };
      }
    }

    const streak = (await change((run) => run))?.streak ?? 0;
    const steps = postSteps(streak);
    const reason = issued ? msg('challenge.overtaken') : (failed ?? msg('challenge.posted_recently', { seconds: windowSeconds }));
    // After a challenge that didn't let the post through, the ones to solve are new ones.
    const need = msg(issued || failed ? 'challenge.to_post_new' : 'challenge.to_post', { reason, count: steps });
    throw challengeRequired(need, await this.issue(scope, { step: 1, steps, streak }));
  }
}
