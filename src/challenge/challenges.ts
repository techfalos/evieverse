import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../config.js';
import { challengeRequired, notFound, tooManyRequests } from '../http/errors.js';
import { msg, type MessageKey } from '../language.js';
import type { Message } from '../language.types.js';
import type { HotStore } from '../storage/index.js';
import { iso, MINUTE } from '../time.js';
import { renderSpoken, shippedVoices, type Voices } from './audio.js';
import type { Challenge, ChallengeSolution } from './challenges.types.js';
import { challengeText, renderChallenge } from './image.js';

/** Fields of a request that answers a challenge; form fields arrive as strings. */
export const ChallengeFields = {
  challengeId: z.string().uuid().optional(),
  challengeAnswer: z.string().max(64).optional(),
  challengeNonce: z.union([z.string().max(64), z.number().int().min(0)]).transform(String).optional(),
};

/** What a refusal or a challenge says of a post, and of a comment. */
const WORDS = {
  post: { atOnce: 'post.too_many_at_once', overtaken: 'challenge.overtaken', toSend: 'challenge.to_post', toSendNew: 'challenge.to_post_new' },
  comment: { atOnce: 'comment.too_many_at_once', overtaken: 'challenge.comment_overtaken', toSend: 'challenge.to_comment', toSendNew: 'challenge.to_comment_new' },
} as const satisfies Record<Sent, Record<string, MessageKey>>;

/** Where a challenge stands in the run a request needs; for a post or a comment, `streak` is what set `steps`. */
interface Step {
  step: number;
  steps: number;
  streak?: number;
}

/**
 * A challenge as the hot store keeps it until it is answered: `issue` writes it, `audio` reads it,
 * and `check` takes it to compare an answer with.
 */
interface Issued extends Step {
  /** 'register', 'post:<userId>' or 'comment:<userId>'. */
  scope: string;
  answer: string;
  issuedAt: number;
  expiresAt: number;
  bits: number;
  /** The language the request was answered in, which is the one the answer is read out in. */
  language: string;
  /** What makes the audio of this challenge unlike that of another with its answer: 16 bytes, in base64. */
  seed: string;
}

/** A challenge as it was issued (see Issued), as JSON. Kept until an answer takes it, or a minute past its expiry. */
export const challengeKey = (id: string) => `chal:${id}`;

/** How many zero bits `hash` starts with, which is what a proof of work is measured by: all of its bits, if every byte is zero. */
export function leadingZeroBits(hash: Buffer): number {
  let bits = 0;
  for (const byte of hash) {
    if (byte) return bits + Math.clz32(byte) - 24;
    bits += 8;
  }
  return bits;
}

/**
 * What a user sends that is limited: a post (/store), or a comment, which an edit of one counts as.
 * Both go by the same rules, each with its own settings, keys and challenges (see `Pace`).
 */
type Sent = 'post' | 'comment';

/** The settings a post or a comment is limited by. */
interface Pace {
  /** The most a user sends in a minute, whatever they solve (0: no limit). */
  limit: number;
  /** How long a run lasts after its last post or comment, or challenge (0: none ever needs a challenge). */
  windowMs: number;
  /**
   * Comments: how many a user sends in a minute before the next needs challenges. Posts have no
   * such number: the first after a quiet window needs none, and every other one does.
   */
  unchallenged?: number;
}

/** When a user's posts in the last minute were: epoch ms separated by spaces, oldest first. Kept a minute. */
const recentPostsKey = (userId: string) => `posts:${userId}`;
/** A user's run of posts, as `<last> <streak>` (see Run). Kept one post window. */
const postRunKey = (userId: string) => `run:${userId}`;
/** When a user's comments in the last minute were, as their posts' times are kept. Kept a minute. */
const recentCommentsKey = (userId: string) => `cmtsent:${userId}`;
/** A user's run of challenged comments, as their run of posts is kept. Kept a minute. */
const commentRunKey = (userId: string) => `cmtrun:${userId}`;

/**
 * A user's run of posts or of comments: when they last sent one that is in it, or were challenged
 * to (one within the window after it is in the run too), and how many in a row they sent with
 * challenges, which sets how many the next one needs, and is the place in the run a chain of
 * challenges is solved for. A user with none stored has no run going.
 *
 * Every post is in the run, which the first after a quiet window starts, without a challenge. Only
 * the comments that need challenges are in theirs: the ones a minute has room for go by it.
 */
interface Run {
  last: number;
  streak: number;
}

/** A value in the hot store that requests change by compare-and-set. */
interface Cell<T> {
  key: string;
  ttlMs: number;
  /** What it is kept for, which words the refusal of one that can't change it. */
  sent: Sent;
  read(stored: string | null): T;
  /** Null: nothing worth keeping, so the key is deleted. */
  write(value: T): string | null;
}

/** Throws 429 if `times`, what the user sent in the minute before `at`, are already `limit`. */
function refuseOverLimit(sent: Sent, times: number[], at: number, limit: number) {
  if (times.length < limit) return;
  const seconds = Math.max(1, Math.ceil((times[times.length - limit]! + MINUTE - at) / 1000));
  throw tooManyRequests(
    sent === 'post' ? msg('post.rate_limited', { rate: msg('post.rate', { count: limit }), count: seconds }) : msg('comment.rate_limited', { count: seconds }),
    seconds,
  );
}

/** Gives back what a post or a comment claimed, when it then fails. */
type Release = () => Promise<void>;

/** Where a challenge's characters are read out (routes/challenges.ts). */
const challengeAudioUrl = (publicBaseUrl: string, id: string) => `${publicBaseUrl}/challenges/${id}/audio`;

/**
 * Challenges people solve to register, to post again soon after posting, and to comment past a few
 * comments a minute: the characters in a distorted image, which are read out to whoever can't read
 * it, plus a proof of work the client's software does meanwhile. Each lives in Redis for
 * `ttlSeconds`, and any answer uses it up, right or wrong, so every guess costs a new image and a
 * new proof of work. What a user posted and commented lately is in Redis too, and nothing here
 * reads the database. Settings are read on every request.
 *
 * `language` is the one a request is answered in, which a challenge issued for it is read out in.
 */
export class Challenges {
  private readonly now: () => number;
  private readonly voices: Voices;

  /** `voices` are the ones the server ships unless given: read here, so one that can't be stops the app as it starts. */
  constructor(private readonly deps: { hot: HotStore; config: Config; now?: () => number; voices?: Voices }) {
    this.now = deps.now ?? Date.now;
    this.voices = deps.voices ?? shippedVoices();
  }

  private get settings() {
    return this.deps.config.challenge;
  }

  async issue(scope: string, language: string, { step, steps, streak }: Step = { step: 1, steps: 1 }): Promise<Challenge> {
    const { ttlSeconds, powBits: bits } = this.settings;
    const id = randomUUID();
    const answer = challengeText();
    const issuedAt = this.now();
    const issued: Issued = { scope, answer, issuedAt, expiresAt: issuedAt + ttlSeconds * 1000, bits, language, seed: randomBytes(16).toString('base64'), step, steps, streak };
    // Kept a minute past expiresAt, so a late answer is told it was late.
    await this.deps.hot.set(challengeKey(id), JSON.stringify(issued), (ttlSeconds + 60) * 1000);
    return {
      id,
      image: `data:image/png;base64,${renderChallenge(answer).toString('base64')}`,
      audio: challengeAudioUrl(this.deps.config.publicBaseUrl, id),
      expiresAt: iso(issued.expiresAt),
      expiresInSeconds: ttlSeconds,
      step,
      steps,
      proofOfWork: { algorithm: 'SHA-256', prefix: `${id}:`, bits },
    };
  }

  /**
   * A challenge's characters read out, as a WAV (see renderSpoken), in the voice of the language it
   * was issued in, or of the server's default language if that one has no voice. 404 for a challenge
   * that was answered, or is too old to be. Only the id says whose it is, which nobody but the one
   * it was issued to knows.
   *
   * Listening leaves the challenge as it was, to be answered once, and the audio is made from what
   * the challenge holds each time it is asked for, the same every time: nothing of it is kept.
   */
  async audio(id: string): Promise<Buffer> {
    const raw = await this.deps.hot.get(challengeKey(id));
    if (!raw) throw notFound(msg('challenge.used'));
    const issued = JSON.parse(raw.toString('utf8')) as Issued;
    // One issued before challenges were read out has no seed, and is gone within minutes.
    if (this.now() > issued.expiresAt || !issued.seed) throw notFound(msg('challenge.expired'));
    return renderSpoken(issued.answer, this.voices.for(issued.language, this.deps.config.defaultLanguage), Buffer.from(issued.seed, 'base64'));
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
    if (leadingZeroBits(createHash('sha256').update(`${solution.challengeId}:${solution.challengeNonce ?? ''}`).digest()) < issued.bits) {
      return fail(msg('challenge.wrong_proof_of_work'));
    }
    const answer = Buffer.from((solution.challengeAnswer ?? '').toUpperCase().replace(/[\s-]/g, ''));
    const expected = Buffer.from(issued.answer);
    if (answer.length !== expected.length || !timingSafeEqual(answer, expected)) return fail(msg('challenge.wrong_characters'));
    return { issued, failed: null };
  }

  /**
   * Returns if `solution` solves a registration challenge; otherwise throws 428 with a new one. No
   * setting turns this off: the route spares an admin's request the call, and nobody else's.
   */
  async register(solution: ChallengeSolution, language: string): Promise<void> {
    const failed = solution.challengeId === undefined ? undefined : (await this.check('register', solution)).failed;
    if (failed === null) return;
    throw challengeRequired(failed ? msg('challenge.solve_new', { reason: failed }) : msg('challenge.register'), await this.issue('register', language));
  }

  /** The settings posts go by, and the ones comments do. */
  private pace(sent: Sent): Pace {
    const { config } = this.deps;
    if (sent === 'post') return { limit: config.postRateLimitPerMinute, windowMs: this.settings.postWindowSeconds * 1000 };
    const unchallenged = this.settings.commentsPerMinute;
    return { limit: config.comments.perMinute, windowMs: unchallenged > 0 ? MINUTE : 0, unchallenged };
  }

  /**
   * Lets a post (/store) or a comment through, or throws 429 or 428. One past the limit in the last
   * minute (`postRateLimitPerMinute`, `comments.perMinute`) is refused outright, with when to try
   * again, before any challenge, so nobody solves challenges for what can't go through. Otherwise it
   * may need challenges (see `passChallenges`): a post does unless a quiet window came before it,
   * and a comment once the user sent `challenge.commentsPerMinute` in the last minute.
   *
   * Each claims its place by compare-and-set in Redis, so concurrent ones can't get past the limit,
   * or past fewer challenges, together. Call the returned function if it then fails: it gives the
   * claims back, so it doesn't count, and a retry costs no more.
   */
  private async admit(sent: Sent, userId: string, solution: ChallengeSolution, language: string): Promise<Release> {
    const at = this.now();
    const { limit, windowMs, unchallenged } = this.pace(sent);
    /** The times of what the user sent in the minute before `at`: epoch ms, oldest first. */
    const recent: Cell<number[]> = {
      key: sent === 'post' ? recentPostsKey(userId) : recentCommentsKey(userId),
      ttlMs: MINUTE,
      sent,
      read: (stored) => (stored ? stored.split(' ').map(Number) : []).filter((t) => t > at - MINUTE),
      write: (times) => times.join(' ') || null,
    };
    /** Adds this one's time, where the minute has room for it. */
    const add = (times: number[]) => (limit === 0 || times.length < limit ? [...times, at] : times);
    const forget: Release = async () => {
      await this.change(recent, (times: number[]) => {
        const i = times.indexOf(at);
        return i < 0 ? times : [...times.slice(0, i), ...times.slice(i + 1)];
      }).catch(() => {});
    };
    /** Whether a comment after these needs no challenge: the minute still has one of those to give. */
    const spare = (times: number[]) => windowMs > 0 && unchallenged !== undefined && times.length < unchallenged;
    // Posts are counted for their limit alone. Comments are for their challenges too.
    const counted = limit > 0 || (windowMs > 0 && unchallenged !== undefined);

    // What the user sent in the last minute. A comment that needs no challenge claims its place among them here.
    const before = counted ? await this.change(recent, (times) => (spare(times) ? add(times) : times)) : [];
    if (limit > 0) refuseOverLimit(sent, before, at, limit);
    if (spare(before)) return forget;

    const release: Release =
      windowMs > 0
        ? await this.passChallenges(
            sent,
            userId,
            solution,
            language,
            at,
            windowMs,
            sent === 'post' ? msg('challenge.posted_recently', { seconds: windowMs / 1000 }) : msg('challenge.commented_recently', { count: before.length }),
          )
        : async () => {};
    if (!counted) return release;
    try {
      // Another may have taken the last place since the check above.
      const times = await this.change(recent, add);
      if (limit > 0) refuseOverLimit(sent, times, at, limit);
    } catch (err) {
      await release();
      throw err;
    }
    return async () => {
      await forget();
      await release();
    };
  }

  /**
   * Lets a post or a comment through (see admit), then writes it; one whose write fails doesn't
   * count. An update of a post is a post, and an edit of a comment a comment.
   */
  async admitting<T>(sent: Sent, userId: string, solution: ChallengeSolution, language: string, write: () => Promise<T>): Promise<T> {
    const release = await this.admit(sent, userId, solution, language);
    try {
      return await write();
    } catch (err) {
      await release();
      throw err;
    }
  }

  /**
   * Replaces what a cell holds with `change(value)`, unless that returns `value` itself, and returns the
   * `value` it was given. A compare-and-set on the whole value, tried again if another request changed it
   * meanwhile.
   */
  private async change<T>(cell: Cell<T>, change: (value: T) => T): Promise<T> {
    const { hot } = this.deps;
    for (let attempt = 0; attempt < 20; attempt++) {
      const stored = (await hot.get(cell.key))?.toString('utf8') ?? null;
      const value = cell.read(stored);
      const next = change(value);
      if (next === value || (await hot.swap(cell.key, stored, cell.write(next), cell.ttlMs))) return value;
    }
    throw tooManyRequests(msg(WORDS[cell.sent].atOnce), 1);
  }

  /**
   * Returns if a post or a comment at `at` needs no challenge, or `solution` solves the last it needs;
   * otherwise throws 428 with the next, which says `recently` for why.
   *
   * A post needs challenges while the user's last post, or last challenge to post, was less than
   * `postWindowSeconds` ago; after a quiet window the next post passes without one, and the run starts
   * over. A comment that comes here needs them, since the user's minute has no more room for one that
   * doesn't (see admit), and its run is of such comments alone: it starts over once a minute goes by
   * with none of them, and no challenge to comment.
   *
   * One after `streak` challenged ones in the run needs one challenge, or two once `streak` reaches two,
   * solved one after another: each right answer gets the next, and a wrong one a new challenge at the
   * same step. Of concurrent posts only one passes without a challenge, and only one post or comment
   * passes at each point of its run, so solving runs in parallel gains nothing.
   */
  private async passChallenges(sent: Sent, userId: string, solution: ChallengeSolution, language: string, at: number, windowMs: number, recently: Message): Promise<Release> {
    const change = (to: (run: Run | null) => Run | null) =>
      this.change(
        {
          key: sent === 'post' ? postRunKey(userId) : commentRunKey(userId),
          ttlMs: windowMs,
          sent,
          read(stored) {
            if (!stored) return null;
            const [last, streak] = stored.split(' ').map(Number);
            return { last: last!, streak: streak! };
          },
          write: (run) => run && `${run.last} ${run.streak}`,
        },
        to,
      );
    /** Whether a whole window has gone by since the run's last post or comment, or challenge. */
    const over = (run: Run) => run.last <= at - windowMs;
    const words = WORDS[sent];

    // After a quiet window the run starts over. Otherwise this one is in the run, and moves its window on.
    const before = await change((run) => (!run || over(run) ? { last: at, streak: 0 } : run.last < at ? { ...run, last: at } : run));
    // The post that starts a run claimed the window, and needs no challenge. A comment is here because it needs one.
    if (sent === 'post' && (!before || over(before))) {
      return async () => {
        // A failure here only means the retry needs a challenge.
        await change((run) => (run?.last === at ? null : run)).catch(() => {});
      };
    }

    const scope = `${sent}:${userId}`;
    const { issued, failed } = solution.challengeId === undefined ? { issued: undefined, failed: undefined } : await this.check(scope, solution);
    if (issued && failed) throw challengeRequired(msg('challenge.solve_new', { reason: failed }), await this.issue(scope, language, issued));
    if (issued && issued.step < issued.steps) {
      throw challengeRequired(msg('challenge.solve_next', { step: issued.step, steps: issued.steps }), await this.issue(scope, language, { ...issued, step: issued.step + 1 }));
    }
    if (issued) {
      const streak = issued.streak ?? 0;
      if (((await change((run) => ((run?.streak ?? 0) === streak ? { last: run?.last ?? at, streak: streak + 1 } : run)))?.streak ?? 0) === streak) {
        return async () => {
          await change((run) => (run?.streak === streak + 1 ? { ...run, streak } : run)).catch(() => {});
        };
      }
    }

    const streak = (await change((run) => run))?.streak ?? 0;
    // How many challenges this one needs after `streak` in a row with challenges: 1, 1, then 2 for as long
    // as the run goes on. Nobody is asked to solve more than two one after another.
    const steps = streak < 2 ? 1 : 2;
    throw challengeRequired(
      // After a challenge that didn't let it through, the ones to solve are new ones.
      msg(issued || failed ? words.toSendNew : words.toSend, { reason: issued ? msg(words.overtaken) : (failed ?? recently), count: steps }),
      await this.issue(scope, language, { step: 1, steps, streak }),
    );
  }
}
