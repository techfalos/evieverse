import type { TrustPlugin } from './moderation/trust.types.js';

/** What another server answered a request for a post's attestation with: the status, and the body read as JSON. */
export interface AttestationAnswer {
  status: number;
  body: unknown;
}

/**
 * What `createOriginSweep` is given in place of what it would make or load itself. The processes
 * that run it give none; tests do.
 */
export interface OriginSweepOptions {
  /** What asks another server for a post's attestation: a GET of `address`. By default, a request over https to a public address (http/publicFetch.ts). It throws if there is no answer to read. */
  fetcher?: (address: string) => Promise<AttestationAnswer>;
  /** What asks another server for the keys it signs with (see OriginKeys). By default, the same kind of request. */
  keyFetcher?: (address: string) => Promise<unknown>;
  /** The trust plugins what a post now says is scored by, in the order they run. By default, the server's own (moderation/trust.ts). */
  trustPlugins?: TrustPlugin[];
  /** How long to wait between two servers asked, in milliseconds. By default, PAUSE_MS. */
  pauseMs?: number;
}
