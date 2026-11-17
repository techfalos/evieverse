import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { z } from 'zod';
import type { PublishedKey, ReadAttestation, SigningKey } from './attestation.types.js';
import { LinkUrl, MAX_TEXT_CHARS } from './posts.js';
import { MINUTE } from './time.js';

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
 * anyone can bring (POST /repost/refresh): a newer one replaces the summary, and one that says the
 * post is gone (AttestedGone), which a server signs in place of a post it no longer publishes,
 * has the repost deleted. An older one changes nothing.
 */

/** A post's address on its own server ends with its id, as GET /content/:id reads it. */
export const POST_PATH = /\/content\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * How long an attestation is taken for after it was issued. A client asks for one and sends it on
 * at once, so this is time enough, and a post that was changed or deleted since is reposted as it
 * was for no longer than this.
 */
export const ATTESTATION_MAX_AGE_MS = 10 * MINUTE;

/** How far ahead of this server's clock the clock of the server that issued an attestation may be. */
export const ATTESTATION_SKEW_MS = MINUTE;

/**
 * The longest attestation a request can carry, in characters. A payload is little beside its
 * preview's text, which is at most MAX_TEXT_CHARS UTF-16 code units: up to six bytes each as JSON
 * writes the ones it escapes, and a third more in base64.
 */
export const MAX_ATTESTATION_CHARS = 400_000;

/** What is signed starts with this: a signature made with the same key for anything else is no attestation's. */
const CONTEXT = 'evieverse-repost-attestation-v1.';

/** An Ed25519 private key is made from this many random bytes. */
const SEED_BYTES = 32;

/** What comes before the seed in an Ed25519 private key as PKCS #8 writes it, which is how Node reads one. */
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');

/** An Ed25519 public key as a server publishes it: its 32 bytes in base64url, which is 43 characters. */
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;

/** An attestation as it is written: the payload and the signature, each in base64url, with a dot between them. */
const WRITTEN = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{86})$/;

/**
 * What every attestation says: `v` is the version of this format, `kid` the id of the key that
 * signed (see PublishedKey), `issuedAt` when, in UTC epoch milliseconds, by the clock of the
 * server that signed, and `url` the post it is of.
 */
const Signed = {
  v: z.literal(1),
  kid: z.string().regex(/^[0-9a-f]{16}$/),
  issuedAt: z.number().int().min(0),
  /**
   * The post's address on its own server: https://other.example/content/<id>, with nothing after
   * the id and nobody's credentials in it. Its id is read in lower case, so that a post has one
   * address however it was written (see `content.origin_hash`).
   */
  url: LinkUrl.refine((href) => {
    const url = new URL(href);
    return POST_PATH.test(url.pathname) && !url.search && !url.hash && !url.username && !url.password;
  }).transform((href) => href.replace(POST_PATH, (path) => path.toLowerCase())),
};

/** What an attestation says of a post that is there: the post, as its own server gives it. */
export const AttestedPost = z.object({
  ...Signed,
  /** Who published it there. The name is one line: it is kept on a line of the summary. */
  publisher: z.object({
    userId: z.string().uuid(),
    username: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .refine((name) => !/[\u0000-\u001f\u007f\u0085\u2028\u2029]/.test(name)),
  }),
  /** Its content type, as one line of a summary holds it. Needed of an image, video or audio; a text's and a link's are their own. */
  mimeType: z
    .string()
    .trim()
    .max(255)
    .regex(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/)
    .transform((type) => type.toLowerCase())
    .optional(),
  aiGenerated: z.boolean(),
  /**
   * Its summary, as feeds show it there. An image's, video's or audio's has no `url`: the bytes
   * are read at the post's address.
   */
  preview: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('text'), text: z.string().trim().min(1).max(MAX_TEXT_CHARS) }),
    z.object({ kind: z.enum(['image', 'video', 'audio']), text: z.string().trim().max(MAX_TEXT_CHARS).optional() }),
    z.object({ kind: z.literal('link'), url: LinkUrl }),
  ]),
});
export type AttestedPost = z.infer<typeof AttestedPost>;

/**
 * What an attestation says of an address at which the server publishes no post: `gone`, and
 * nothing of a post. It is what a server signs for a post it deleted, and for anything else that
 * isn't published there, which it doesn't tell apart for anyone.
 */
export const AttestedGone = z.object({ ...Signed, gone: z.literal(true) });
export type AttestedGone = z.infer<typeof AttestedGone>;

/** What a server says of a post to attest it: all of an attestation but what signing adds. */
export type Attestable = Omit<AttestedPost, 'v' | 'kid' | 'issuedAt'>;

/** What a server says of an address it publishes no post at, to attest that. */
export type AttestableGone = Omit<AttestedGone, 'v' | 'kid' | 'issuedAt'>;

/** Whether a payload says its post is gone: it is then read as an AttestedGone, and as a post otherwise. */
export const saysGone = (payload: unknown): boolean => typeof payload === 'object' && payload !== null && (payload as { gone?: unknown }).gone === true;

/** The id of a public key, given as it is published: the first 8 bytes of its SHA-256, in hex. */
const keyId = (publicKey: string) => createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex').slice(0, 16);

/**
 * The 32 bytes a signing key is made from, as a setting writes them: in base64 (either alphabet,
 * padded or not) or in hex. Null for anything else.
 */
export function seedOf(text: string): Buffer | null {
  const bytes = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, 'hex') : /^[A-Za-z0-9+/_-]{43}=?$/.test(text) ? Buffer.from(text, 'base64') : null;
  return bytes?.length === SEED_BYTES ? bytes : null;
}

/**
 * The keys a server signs with, from its setting (`reposts.signingKeys`, which the configuration
 * has checked): the first signs, and all are published, so that what an earlier key signed is
 * still taken while a new one comes in.
 */
export function signingKeys(seeds: string[]): SigningKey[] {
  return seeds.map((text) => {
    const seed = seedOf(text);
    if (!seed) throw new Error('a signing key is 32 random bytes, in base64 or hex');
    const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' });
    const publicKey = createPublicKey(privateKey).export({ format: 'jwk' }).x!;
    return { id: keyId(publicKey), publicKey, privateKey };
  });
}

/**
 * A key as another server published it, or null if what it published isn't an Ed25519 public key.
 * Its id is worked out here, from the key: the one it was published with is not read.
 */
export function publishedKey(publicKey: unknown): PublishedKey | null {
  return typeof publicKey === 'string' && PUBLIC_KEY.test(publicKey) ? { id: keyId(publicKey), publicKey } : null;
}

/** The attestation of `post`, or of there being none at an address, signed with `key` as of `issuedAt`. */
export function attest(key: SigningKey, post: Attestable | AttestableGone, issuedAt: number): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, kid: key.id, issuedAt, ...post })).toString('base64url');
  return `${payload}.${sign(null, Buffer.from(CONTEXT + payload), key.privateKey).toString('base64url')}`;
}

/** An attestation taken apart, or null if `text` isn't written as one. Nothing of it is checked yet. */
export function readAttestation(text: string): ReadAttestation | null {
  const [, payload, signature] = WRITTEN.exec(text) ?? [];
  if (payload === undefined || signature === undefined) return null;
  try {
    return { payload: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')), signed: Buffer.from(CONTEXT + payload), signature: Buffer.from(signature, 'base64url') };
  } catch {
    return null;
  }
}

/** Whether `key` signed the attestation: its signature is that key's, of the bytes that arrived. */
export function signedBy(key: PublishedKey, { signed, signature }: ReadAttestation): boolean {
  try {
    return verify(null, signed, createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.publicKey }, format: 'jwk' }), signature);
  } catch {
    return false;
  }
}
