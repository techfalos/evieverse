import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { challengeRequired, tooManyRequests } from '../http/errors.js';
import type { HotStore } from '../storage/index.js';
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
 * How many challenges a post needs after `streak` posts in a row with challenges: 1, 1, 2, 4, 8, …, so
 * from the second on, each costs as many as the whole run before it.
 */
export const postSteps = (streak: number) => (streak < 2 ? 1 : 2 ** (streak - 1));

const normalizeAnswer = (s: string) => s.toUpperCase().replace(/[\s-]/g, '');

/** Of the times in `users.recent_posts`, those less than a minute before `at`. */
const postsInMinute = (stored: string | null, at: number) =>
  (stored ? stored.split(' ').map(Number) : []).filter((t) => t > at - 60_000);

/** Throws 429 if `times`, the user's posts in the minute before `at`, are already `limit`. */
function refuseOverLimit(times: number[], at: number, limit: number) {
  if (times.length < limit) return;
  const seconds = Math.max(1, Math.ceil((times[times.length - limit]! + 60_000 - at) / 1000));
  const most = limit === 1 ? 'once' : `${limit} times`;
  throw tooManyRequests(`you can post at most ${most} a minute; try again in ${seconds} second${seconds === 1 ? '' : 's'}`, seconds);
}

/**
 * Challenges people solve to register, and to post again soon after posting: the characters in a
 * distorted image, plus a proof of work the client's software does meanwhile. Each lives in Redis for
 * `ttlSeconds`, and any answer uses it up, right or wrong, so every guess costs a new image and a new
 * proof of work. Settings are read on every request.
 */
export class Challenges {
  private readonly now: () => number;

  constructor(private readonly deps: { db: Db; hot: HotStore; config: Config; now?: () => number }) {
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
      expiresAt: new Date(issued.expiresAt).toISOString(),
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
  private async check(scope: string, solution: ChallengeSolution): Promise<{ issued?: Issued; failed: string | null }> {
    const raw = await this.deps.hot.take(challengeKey(solution.challengeId!));
    if (!raw) return { failed: 'the challenge has expired or was already used' };
    const issued = JSON.parse(raw.toString('utf8')) as Issued;
    if (issued.scope !== scope) return { failed: 'the challenge was issued for another request' };
    const at = this.now();
    const fail = (failed: string) => ({ issued, failed });
    if (at > issued.expiresAt) return fail('the challenge has expired');
    if (at - issued.issuedAt < this.settings.minSolveMs) return fail('the challenge was answered too quickly');
    const hash = createHash('sha256').update(`${solution.challengeId}:${solution.challengeNonce ?? ''}`).digest();
    if (leadingZeroBits(hash) < issued.bits) return fail('the proof of work is wrong');
    const answer = Buffer.from(normalizeAnswer(solution.challengeAnswer ?? ''));
    const expected = Buffer.from(issued.answer);
    if (answer.length !== expected.length || !timingSafeEqual(answer, expected)) return fail('the characters are wrong');
    return { issued, failed: null };
  }

  /** Returns if `solution` solves a registration challenge; otherwise throws 428 with a new one. */
  async register(solution: ChallengeSolution): Promise<void> {
    if (!this.settings.register) return;
    const failed = solution.challengeId === undefined ? undefined : (await this.check('register', solution)).failed;
    if (failed === null) return;
    throw challengeRequired(failed ? `${failed}; solve the new challenge` : 'solve the challenge to register', await this.issue('register'));
  }

  /**
   * Lets a post (/store or /federated) through, or throws 429 or 428. A post past
   * `postRateLimitPerMinute` in the last minute is refused outright, with when to try again, before any
   * challenge, so nobody solves challenges for a post that can't go through. Otherwise it may need
   * challenges (see `passPostChallenges`).
   *
   * Posts claim their place with conditional updates, so concurrent posts can't get past the limit, or
   * past fewer challenges, together. Call the returned function if the post then fails: it gives the
   * claims back, so the post doesn't count, and a retry costs no more.
   */
  async admitPost(userId: string, solution: ChallengeSolution): Promise<() => Promise<void>> {
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

  /**
   * Replaces the user's posts in the minute before `at` with `change(times)`, unless it returns `times`
   * itself, and returns the `times` it was given. A compare-and-set on the whole column, tried again if
   * another post changed it meanwhile.
   */
  private async changeRecentPosts(userId: string, at: number, change: (times: number[]) => number[]): Promise<number[]> {
    const { db } = this.deps;
    for (let attempt = 0; attempt < 20; attempt++) {
      const { recent_posts: stored } = await db.selectFrom('users').select('recent_posts').where('id', '=', userId).executeTakeFirstOrThrow();
      const times = postsInMinute(stored, at);
      const next = change(times);
      if (next === times) return times;
      const swapped = await db
        .updateTable('users')
        .set({ recent_posts: next.join(' ') || null })
        .where('id', '=', userId)
        .where('recent_posts', stored === null ? 'is' : '=', stored)
        .executeTakeFirst();
      if (Number(swapped.numUpdatedRows) === 1) return times;
    }
    throw tooManyRequests('too many posts at once; try again in 1 second', 1);
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
    const { db } = this.deps;
    const windowSeconds = this.settings.postWindowSeconds;
    if (windowSeconds === 0) return async () => {};
    const user = () => db.updateTable('users').where('id', '=', userId);
    const free = await user()
      .set({ last_post_at: at, post_streak: 0 })
      .where((eb) => eb.or([eb('last_post_at', 'is', null), eb('last_post_at', '<=', at - windowSeconds * 1000)]))
      .executeTakeFirst();
    if (Number(free.numUpdatedRows) === 1) {
      return async () => {
        // A failure here only means the retry needs a challenge.
        await user().set({ last_post_at: null }).where('last_post_at', '=', at).execute().catch(() => {});
      };
    }

    await user().set({ last_post_at: at }).where('last_post_at', '<', at).execute();
    const scope = `post:${userId}`;
    const { issued, failed } = solution.challengeId === undefined ? { issued: undefined, failed: undefined } : await this.check(scope, solution);
    if (issued && failed) throw challengeRequired(`${failed}; solve the new challenge`, await this.issue(scope, issued));
    if (issued && issued.step < issued.steps) {
      throw challengeRequired(`solved ${issued.step} of ${issued.steps}; solve the next challenge`, await this.issue(scope, { ...issued, step: issued.step + 1 }));
    }
    if (issued) {
      const streak = issued.streak ?? 0;
      const admitted = await user().set({ post_streak: streak + 1 }).where('post_streak', '=', streak).executeTakeFirst();
      if (Number(admitted.numUpdatedRows) === 1) {
        return async () => {
          await user().set({ post_streak: streak }).where('post_streak', '=', streak + 1).execute().catch(() => {});
        };
      }
    }

    const { post_streak: streak } = await db.selectFrom('users').select('post_streak').where('id', '=', userId).executeTakeFirstOrThrow();
    const steps = postSteps(streak);
    const fresh = issued || failed ? 'new ' : '';
    const why = issued ? 'another post went through meanwhile' : (failed ?? `you posted or were challenged less than ${windowSeconds} seconds ago`);
    const need = steps === 1 ? `the ${fresh}challenge` : `${steps} ${fresh}challenges`;
    throw challengeRequired(`${why}; solve ${need} to post`, await this.issue(scope, { step: 1, steps, streak }));
  }
}
