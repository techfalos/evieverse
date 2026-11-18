/**
 * The answer to a challenge as a request sends it (see `ChallengeFields`): the challenge's id, the
 * characters of its image, and the nonce of its proof of work. A request that answers none has
 * none of them. The route parses it, and `Challenges` checks it.
 */
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
  /** Where the same characters are read out, for whoever can't read the image: a WAV, for as long as the challenge can be answered. */
  audio: string;
  expiresAt: string;
  expiresInSeconds: number;
  /** The nonce is any string that makes the SHA-256 of `prefix + nonce` start with `bits` zero bits. */
  proofOfWork: { algorithm: 'SHA-256'; prefix: string; bits: number };
}
