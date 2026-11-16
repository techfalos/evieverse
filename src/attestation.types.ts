import type { KeyObject } from 'node:crypto';

/** A key a server signs attestations with, as it publishes it (GET /repost/keys): anyone checks a signature with it. */
export interface PublishedKey {
  /** What an attestation names its key by: the start of the SHA-256 of the public key, in hex. */
  id: string;
  /** The Ed25519 public key: its 32 bytes, in base64url. */
  publicKey: string;
}

/** A key of this server's own, which signs: the published key, and the private key it was made from. */
export interface SigningKey extends PublishedKey {
  privateKey: KeyObject;
}

/** An attestation taken apart, before anything of it is believed: what it says, the bytes that were signed, and the signature. */
export interface ReadAttestation {
  /** The payload as JSON reads it. Whether it is a post's is `AttestedPost`'s to say. */
  payload: unknown;
  signed: Buffer;
  signature: Buffer;
}
