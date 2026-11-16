import type { Profile } from './profiles.js';

// Set by the build (scripts/build-cli.mjs); absent when the CLI is run from source.
declare const __CLI_VERSION__: string | undefined;
declare const __CLI_BUILD__: string | undefined;

/** The server's version this CLI was built with, for people to read. */
export const VERSION = typeof __CLI_VERSION__ === 'string' ? __CLI_VERSION__ : 'dev';
/** Which build of the CLI this is. A server answers only the build it ships (see CLI_HEADER). */
export const BUILD = typeof __CLI_BUILD__ === 'string' ? __CLI_BUILD__ : 'dev';

/**
 * The header the CLI names its build in on every request. A server that ships another build answers
 * 426 with its own, and the CLI replaces itself with that one. Requests without the header, which is
 * every other client's, are never refused for it.
 */
export const CLI_HEADER = 'x-evieverse-cli';

/** Where a server serves the CLI it ships. */
export const BUNDLE_PATH = '/cli/evieverse.mjs';

/** The CLI a server ships, as GET /cli and a 426 describe it. */
export interface Release {
  version: string;
  build: string;
  /** Of the file at BUNDLE_PATH, in hex. */
  sha256: string;
  size: number;
}

export const isRelease = (v: unknown): v is Release => {
  const r = v as Release | null;
  return typeof r?.version === 'string' && typeof r.build === 'string' && typeof r.sha256 === 'string' && typeof r.size === 'number';
};

/** A failure to report in a line and exit with, as opposed to a bug. */
export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode = 1,
  ) {
    super(message);
  }
}

/** The server refused the request. */
export class ApiError extends CliError {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The server ships another build of the CLI than this one, and answers nothing until it's that one. */
export class UpdateRequired extends Error {
  constructor(
    public readonly server: string,
    public readonly release: Release,
  ) {
    super(`the server needs build ${release.build} of the CLI`);
  }
}

export interface Api {
  server: string;
  request<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, timeoutMs?: number): Promise<T>;
}

/** "https://api.example.com/" -> "https://api.example.com" */
export function serverUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new CliError(`"${input}" is not a server's URL, such as https://api.example.com`, 2);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new CliError(`"${input}" is not an http or https URL`, 2);
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** What the server said was wrong: its `error`, and what zod found in an invalid request. */
function reason(status: number, data: unknown): string {
  const body = data as { error?: unknown; details?: unknown } | null;
  if (status === 401) return "the server doesn't know this userId and API key";
  if (typeof body?.error !== 'string') return `the server answered ${status}`;
  const issues = Array.isArray(body.details) ? body.details.map((i: { message?: unknown }) => i?.message).filter((m) => typeof m === 'string') : [];
  return issues.length ? `${body.error}: ${issues.join('; ')}` : body.error;
}

/** Requests to a profile's server with its key, as JSON. */
export function apiClient(fetchFn: typeof fetch, profile: Pick<Profile, 'server' | 'userId' | 'apiKey'>, build = BUILD): Api {
  const { server } = profile;
  return {
    server,
    async request<T>(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
      let res: Response;
      let text: string;
      try {
        res = await fetchFn(`${server}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${profile.apiKey}`,
            'x-user-id': profile.userId,
            [CLI_HEADER]: build,
            // Only with a body: the server refuses an empty one that claims to be JSON.
            ...(body !== undefined && { 'content-type': 'application/json' }),
          },
          ...(body !== undefined && { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        text = await res.text();
      } catch (err) {
        const e = err as Error & { cause?: { message?: string } };
        const why = e.name === 'TimeoutError' ? `no answer in ${timeoutMs / 1000} seconds` : (e.cause?.message ?? e.message);
        throw new CliError(`could not reach ${server}: ${why}`);
      }
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        // Not the server's own answer: a gateway's error page, say.
      }
      const release = (data as { cli?: unknown } | null)?.cli;
      if (res.status === 426 && isRelease(release)) throw new UpdateRequired(server, release);
      if (!res.ok) throw new ApiError(res.status, reason(res.status, data));
      return data as T;
    },
  };
}
