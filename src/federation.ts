import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { ChallengeFields, type Challenge } from './challenge/challenges.js';
import type { Config } from './config.js';
import { badRequest } from './http/errors.js';
import type { FeedRecord } from './tagfeed/layout.js';

const MAX_SERVERS = 10;
/** Of each server's answer, only the JSON's contentId, version and error are kept. */
const MAX_RESPONSE_BYTES = 64 * 1024;

/** "https://b.example/api/?x" -> "https://b.example/api": what /federated is appended to, and what feeds show as the origin. */
export function serverBase(url: string): string {
  const u = new URL(url);
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

export const ServerUrl = z.url({ protocol: /^https?$/ }).transform(serverBase);

const parseJson = (v: unknown) => {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

/**
 * A server the user has registered with, and their username (or userId) and API key there; and, when
 * it answered an earlier attempt with a challenge, the solution, which is passed on to it.
 */
const FederatedServer = z.object({
  serverAddress: ServerUrl,
  serverUser: z.string().trim().min(1).max(64),
  serverKey: z.string().min(1).max(256),
  ...ChallengeFields,
});
export type FederatedServer = z.infer<typeof FederatedServer>;

/** A challenge another server answered with, passed back to the client only if it has this exact shape. */
const RelayedChallenge = z.object({
  id: z.string().uuid(),
  image: z.string().regex(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/),
  expiresAt: z.iso.datetime(),
  expiresInSeconds: z.number().int().positive(),
  step: z.number().int().positive(),
  steps: z.number().int().positive(),
  proofOfWork: z.object({ algorithm: z.literal('SHA-256'), prefix: z.string().max(100), bits: z.number().int().min(0).max(32) }),
});

/** One server or a list of them; a form field holds the JSON. */
export const FederatedServers = z.preprocess(
  parseJson,
  z.union([FederatedServer.transform((s) => [s]), z.array(FederatedServer).min(1).max(MAX_SERVERS)]),
);

export type FederationResult =
  | { serverAddress: string; ok: true; status: number; contentId: string; version: number }
  | { serverAddress: string; ok: false; status?: number; error: string; challenge?: Challenge };

/**
 * Other servers link back to federated content, so this server's base URL must be absolute; and
 * operators can limit which servers it sends to (the addresses come from users).
 */
export function checkFederation(config: Config, servers: FederatedServer[]) {
  if (!/^https?:\/\//.test(config.publicBaseUrl)) {
    throw badRequest("federation needs PUBLIC_BASE_URL set to this server's absolute URL, which other servers link back to");
  }
  const allowed = config.federation.allowedServers;
  const refused = allowed.length ? servers.filter((s) => !allowed.includes(s.serverAddress)) : [];
  if (refused.length) throw badRequest(`this server doesn't federate to ${refused.map((s) => s.serverAddress).join(', ')}`);
}

/**
 * Sends the feed record (never the bytes) to each server's /federated, in parallel, with the user's
 * credentials there. `origin` is this server's base URL, where the content stays. Each result says what
 * that server answered, including any challenge, which the client solves to try again; nothing here
 * fails the request that stored the content.
 */
export async function federate(
  record: FeedRecord,
  origin: string,
  servers: FederatedServer[],
  opts: { timeoutMs: number; log: FastifyBaseLogger },
): Promise<FederationResult[]> {
  return Promise.all(
    servers.map(async ({ serverAddress, serverUser, serverKey, ...solution }): Promise<FederationResult> => {
      try {
        const res = await fetch(`${serverAddress}/federated`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: serverUser, apiKey: serverKey, origin, entry: record, ...solution }),
          redirect: 'manual',
          signal: AbortSignal.timeout(opts.timeoutMs),
        });
        const body = (await readJson(res)) as { contentId?: unknown; version?: unknown; error?: unknown; challenge?: unknown } | null;
        if (res.ok && typeof body?.contentId === 'string' && typeof body.version === 'number') {
          return { serverAddress, ok: true, status: res.status, contentId: body.contentId, version: body.version };
        }
        const error = typeof body?.error === 'string' ? body.error.slice(0, 200) : `HTTP ${res.status}`;
        opts.log.warn({ serverAddress, status: res.status, error, contentId: record.contentId }, 'federation refused');
        const challenge = res.status === 428 ? RelayedChallenge.safeParse(body?.challenge).data : undefined;
        return { serverAddress, ok: false, status: res.status, error, ...(challenge && { challenge }) };
      } catch (err) {
        opts.log.warn({ err, serverAddress, contentId: record.contentId }, 'federation failed');
        const timedOut = (err as Error).name === 'TimeoutError';
        return { serverAddress, ok: false, error: timedOut ? `no answer within ${opts.timeoutMs} ms` : 'could not reach the server' };
      }
    }),
  );
}

/** The response's JSON, or null if it isn't JSON or is larger than MAX_RESPONSE_BYTES. */
async function readJson(res: Response): Promise<unknown> {
  if (!res.body) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    // Leaving the loop cancels the rest of the body.
    if (size > MAX_RESPONSE_BYTES) return null;
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}
