/**
 * The addon: the Rust code the API shares with the compactor (compactor/crates/node), as Node
 * loads it. Everything crosses as JSON in a string, and src/native.ts is the one module that
 * calls it: the rest of the API reads what that makes of it.
 */
export interface Addon {
  /** Whether it was built with the plugin a test configures (compactor/crates/trust/src/testing.rs). */
  hasTestPlugin(): boolean;
  /** Opens a server with its settings, as JSON: the number it is then called by. */
  open(config: string, options: string): number;
  /** The trust plugins an open server runs, by name, in the order they run in. */
  pluginNames(handle: number): string[];
  /** Whether one of an open server's plugins reads a post's images. */
  readsImages(handle: number): boolean;
  /** Calls an open server: what to do, the time as the API counts it, and what to do it with, as JSON. Answers JSON. */
  call(handle: number, method: string, now: number, asked: string): Promise<string>;
  /** Closes a server: its connections to the database are closed, and it is called no more. */
  close(handle: number): Promise<void>;
  /** The limits of a list of blocked words, as JSON. */
  wordLimits(): string;
  /** Lowercase, without the accents of Latin letters. */
  fold(text: string): string;
  /** Whether an entry of a list of blocked words is a pattern. */
  isPattern(entry: string): boolean;
  /** An entry of a list of blocked words as it is stored; null for one that can't be. */
  normalizeWord(input: string): string | null;
  /** The lists that have one of their entries in one of the texts: JSON in, JSON out. */
  scanTexts(asked: string): Promise<string>;
  /** The limits of an attestation, as JSON. */
  attestationLimits(): string;
  /** The keys the seeds of a JSON list make, as a server publishes them: JSON. Throws for a seed that isn't one, named by its place. */
  signingKeys(seeds: string): string;
  /** A key as another server published it, with its id, as JSON; null for what isn't an Ed25519 public key. */
  publishedKey(publicKey: string): string | null;
  /** The attestation of what a server says of a post (JSON), signed with the key a seed makes as of a time. */
  attest(seed: string, said: string, issuedAt: number): string;
  /** An attestation taken apart, as JSON: its payload, and what it says or what is wrong with that. Null for what isn't written as one. */
  readAttestation(text: string): string | null;
  /** Whether the key a server published signed an attestation. */
  signedBy(publicKey: string, text: string): boolean;
  /** What the address of a post says of where it is, as JSON; null for an address that isn't a post's. */
  postOf(address: string): string | null;
  /** Whether a text is an IP address on the public internet. */
  isPublicAddress(address: string): boolean;
  /** What the server at an address answers a GET with, which is JSON: asked only as a server asks an address somebody else chose. */
  fetchPublicJson(address: string): Promise<string>;
  /** The terms a search for a text looks for. */
  queryTerms(q: string): string[];
  /** A username as a search compares it. */
  foldUsername(username: string): string;
}

/** One thing the addon said for the log while it was called, or between two calls. */
export interface Said {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  /** What it is about. */
  fields: Record<string, unknown>;
  msg: string;
}

/**
 * What a call of an open server comes to: its answer (`ok`), what the sender is told of what it
 * refuses (`refused`), or why it could not be done at all (`failed`). With what was said for the
 * request's log, and what was said since the last call by what goes on between them.
 */
export type Answered<T> = ({ ok: T } | { refused: unknown } | { failed: string }) & { logs: Said[]; background: Said[] };

/** What takes what the addon said: a request's log, or the app's. */
export type SaidTo = Record<Said['level'], (fields: Record<string, unknown>, msg: string) => void>;
