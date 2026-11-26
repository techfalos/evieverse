import type { Attestable, AttestableGone, PostAddress, PublishedKey, ReadAttestation, SigningKey } from './attestation.types.js';
import { addon } from './native.js';

/**
 * Attestations: what a server says of one of its own posts, signed, so that another server can
 * tell it is the post's own server that said it. A repost of a post on another server is made
 * from one (POST /repost, routes/reposts.ts), and from nothing else: what a client says of a post
 * elsewhere is believed only as far as that post's server signed it.
 *
 * A server signs with an Ed25519 key of its own (REPOSTS_SIGNING_KEYS), and publishes the public
 * half (GET /repost/keys). It gives the attestation of a post to anyone who asks (GET
 * /content/:id/attestation): the post's address there, its publisher, and its summary, with when
 * that was said and which key signed it. The reposter's client carries it to its own server, which
 * reads the address in it, asks the server at that address for its keys (originKeys.ts), and
 * checks the signature. So the keys a post is checked with are the ones served where the post is:
 * nobody signs for an address they don't serve.
 *
 * An attestation is two parts with a dot between them, each in base64url: the payload, which is
 * JSON, and the signature. What is signed is the payload's part as it is written, after a prefix
 * that says what the signature is for. So it is checked against the bytes that arrived, and JSON
 * is read only to learn what they say.
 *
 * What it doesn't say: that the post's server tells the truth about its own posts, which it is
 * free not to; who the person behind a publisher's name is, which is a name on that server and
 * nothing more; and that the post is still what it was, once the attestation is used.
 *
 * So a server that holds a repost is told what the post became by a later attestation of it, which
 * it asks the post's server for now and then (compactor/src/sweep.rs) and which anyone can bring sooner
 * (POST /repost/refresh): a newer one replaces the summary, and one that says the post is gone
 * (AttestedGone), which a server signs in place of whatever it doesn't publish, has the repost
 * hidden. It is deleted only if no attestation of the post follows for some days, since a post
 * that isn't published may only wait in a moderation queue. An older one changes nothing.
 *
 * How one is written, read and checked is Rust's (compactor/crates/core/src/attestation.rs),
 * which the compactor checks the ones it asks other servers for with too (compactor/src/sweep.rs):
 * these are that code's, reached through the addon (src/native.ts).
 */

/** The limits of an attestation, as the addon has them. */
const LIMITS = JSON.parse(addon().attestationLimits()) as { maxAgeMs: number; skewMs: number; maxChars: number };

/**
 * How long an attestation is taken for after it was issued. A client asks for one and sends it on
 * at once, so this is time enough, and a post that was changed or deleted since is reposted as it
 * was for no longer than this.
 */
export const ATTESTATION_MAX_AGE_MS = LIMITS.maxAgeMs;

/** How far ahead of this server's clock the clock of the server that issued an attestation may be. */
export const ATTESTATION_SKEW_MS = LIMITS.skewMs;

/**
 * The longest attestation a request can carry, in characters. A payload is little beside its
 * preview's text, and the alternative texts of an album's images come to less than half as much
 * again.
 */
export const MAX_ATTESTATION_CHARS = LIMITS.maxChars;

/**
 * The keys a server signs with, from its setting (`reposts.signingKeys`, which the configuration
 * has checked): the first signs, and all are published, so that what an earlier key signed is
 * still taken while a new one comes in.
 */
export function signingKeys(seeds: string[]): SigningKey[] {
  const keys = JSON.parse(addon().signingKeys(JSON.stringify(seeds))) as PublishedKey[];
  // The seed is there to sign with, and nowhere else: a key that is copied, sent or logged shows its public half only.
  return keys.map((key, at) => Object.defineProperty({ ...key }, 'seed', { value: seeds[at], enumerable: false }) as SigningKey);
}

/**
 * A key as another server published it, or null if what it published isn't an Ed25519 public key.
 * Its id is worked out here, from the key: the one it was published with is not read.
 */
export function publishedKey(publicKey: unknown): PublishedKey | null {
  const key = typeof publicKey === 'string' ? addon().publishedKey(publicKey) : null;
  return key === null ? null : (JSON.parse(key) as PublishedKey);
}

/** The attestation of `post`, or of there being none at an address, signed with `key` as of `issuedAt`. */
export function attest(key: SigningKey, post: Attestable | AttestableGone, issuedAt: number): string {
  return addon().attest(key.seed, JSON.stringify(post), issuedAt);
}

/**
 * An attestation taken apart, or null if `text` isn't written as one: what it says, and what that
 * comes to as an attestation (`said`), or what it says that one doesn't (`issues`). Who signed
 * it is not looked at yet (see signedBy).
 */
export function readAttestation(text: string): ReadAttestation | null {
  const read = addon().readAttestation(text);
  return read === null ? null : { ...(JSON.parse(read) as Omit<ReadAttestation, 'text'>), text };
}

/** Whether `key` signed the attestation: its signature is that key's, of the bytes that arrived. */
export function signedBy(key: PublishedKey, read: ReadAttestation): boolean {
  return addon().signedBy(key.publicKey, read.text);
}

/**
 * What an address says of the post it is of, or null if it doesn't end as a post's address does:
 * with its id, as GET /content/:id reads it.
 */
export function postOf(address: string): PostAddress | null {
  const post = addon().postOf(address);
  return post === null ? null : (JSON.parse(post) as PostAddress);
}
