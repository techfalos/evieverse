/** An HTTP request as a function receives it, whatever the platform calls its parts. */
export interface FunctionRequest {
  method: string;
  /** Path and query string. */
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body?: Buffer;
  /** The peer the platform saw: the client, or the last proxy before the function (see TRUST_PROXY). */
  remoteAddress?: string;
}

/**
 * The app's response to a `FunctionRequest`, whatever the platform calls its parts: a function's
 * `handle` returns it (`createFunction`), for the platform's entry point to put in its own form
 * (`toResult`, for AWS Lambda). The body is the bytes as the app sent them.
 */
export interface FunctionResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
}

/**
 * What a function (`createFunction`), or the step a deployment runs first (`checkSettings`,
 * `migrateDeployment`), can be given in place of the system's clock. Only tests give it.
 */
export interface FunctionOptions {
  /** Injectable clock (UTC epoch ms). */
  now?: () => number;
}
