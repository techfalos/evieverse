import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../config.js';
import { challengeRequired, notFound } from '../http/errors.js';
import { msg } from '../language.js';
import type { Message } from '../language.types.js';
import type { HotStore } from '../storage/index.js';
import { iso } from '../time.js';
import { renderSpoken, shippedVoices, type Voices } from './audio.js';
import type { Challenge, ChallengeSolution } from './challenges.types.js';
import { challengeText, renderChallenge } from './image.js';

/** Fields of a request that answers a challenge; form fields arrive as strings. */
export const ChallengeFields = {
  challengeId: z.string().uuid().optional(),
  challengeAnswer: z.string().max(64).optional(),
  challengeNonce: z.union([z.string().max(64), z.number().int().min(0)]).transform(String).optional(),
};

/**
 * A challenge as the hot store keeps it until it is answered: `issue` writes it, `audio` reads it,
 * and `check` takes it to compare an answer with.
 */
interface Issued {
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

/** Where a challenge's characters are read out (routes/challenges.ts). */
const challengeAudioUrl = (publicBaseUrl: string, id: string) => `${publicBaseUrl}/challenges/${id}/audio`;

/**
 * The challenge people solve to register: the characters in a distorted image, which are read out
 * to whoever can't read it, plus a proof of work the client's software does meanwhile. Each lives
 * in Redis for `ttlSeconds`, and any answer uses it up, right or wrong, so every guess costs a new
 * image and a new proof of work. Nothing here reads the database. Settings are read on every
 * request.
 *
 * Nothing else takes one: posts and comments are held to a limit a minute alone (src/sendLimit.ts).
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

  async issue(language: string): Promise<Challenge> {
    const { ttlSeconds, powBits: bits } = this.settings;
    const id = randomUUID();
    const answer = challengeText();
    const issuedAt = this.now();
    const issued: Issued = { answer, issuedAt, expiresAt: issuedAt + ttlSeconds * 1000, bits, language, seed: randomBytes(16).toString('base64') };
    // Kept a minute past expiresAt, so a late answer is told it was late.
    await this.deps.hot.set(challengeKey(id), JSON.stringify(issued), (ttlSeconds + 60) * 1000);
    return {
      id,
      image: `data:image/png;base64,${renderChallenge(answer).toString('base64')}`,
      audio: challengeAudioUrl(this.deps.config.publicBaseUrl, id),
      expiresAt: iso(issued.expiresAt),
      expiresInSeconds: ttlSeconds,
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
   * Why `solution` doesn't solve the challenge it answers, or null if it does. The checks that don't
   * need the answer come first, so an answer sent too soon or without the work says nothing about
   * whether it was right.
   */
  private async check(solution: ChallengeSolution): Promise<Message | null> {
    const raw = await this.deps.hot.take(challengeKey(solution.challengeId!));
    if (!raw) return msg('challenge.used');
    const issued = JSON.parse(raw.toString('utf8')) as Issued;
    const at = this.now();
    if (at > issued.expiresAt) return msg('challenge.expired');
    if (at - issued.issuedAt < this.settings.minSolveMs) return msg('challenge.too_quick');
    if (leadingZeroBits(createHash('sha256').update(`${solution.challengeId}:${solution.challengeNonce ?? ''}`).digest()) < issued.bits) {
      return msg('challenge.wrong_proof_of_work');
    }
    const answer = Buffer.from((solution.challengeAnswer ?? '').toUpperCase().replace(/[\s-]/g, ''));
    const expected = Buffer.from(issued.answer);
    if (answer.length !== expected.length || !timingSafeEqual(answer, expected)) return msg('challenge.wrong_characters');
    return null;
  }

  /**
   * Returns if `solution` solves a registration challenge; otherwise throws 428 with a new one. No
   * setting turns this off: the route spares an admin's request the call, and nobody else's.
   */
  async register(solution: ChallengeSolution, language: string): Promise<void> {
    const failed = solution.challengeId === undefined ? undefined : await this.check(solution);
    if (failed === null) return;
    throw challengeRequired(failed ? msg('challenge.solve_new', { reason: failed }) : msg('challenge.register'), await this.issue(language));
  }
}
