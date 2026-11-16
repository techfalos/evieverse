/** The CLI a server ships, as GET /cli and a 426 describe it. */
export interface Release {
  version: string;
  build: string;
  /** Of the file at BUNDLE_PATH, in hex. */
  sha256: string;
  size: number;
}

/**
 * Requests to one server with one profile's key, which `apiClient` makes and the commands send
 * theirs through. `request` resolves with the server's answer, parsed as JSON (null if it isn't
 * any), and throws a `CliError` if the server can't be reached or doesn't answer within `timeoutMs`
 * (60 seconds unless given), an `ApiError` if it refuses, and an `UpdateRequired` if it wants
 * another build of the CLI.
 */
export interface Api {
  server: string;
  request<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, timeoutMs?: number): Promise<T>;
}
