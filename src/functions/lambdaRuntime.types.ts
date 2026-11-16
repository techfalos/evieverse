/** An API Gateway HTTP API request (payload format 2.0), as far as it is read here. */
export interface HttpApiEvent {
  rawPath: string;
  rawQueryString?: string;
  /** Names in lower case; the values of a repeated header joined by commas. */
  headers?: Record<string, string | undefined>;
  cookies?: string[];
  requestContext: { http: { method: string; sourceIp?: string } };
  body?: string;
  isBase64Encoded?: boolean;
}

/**
 * The response to an API Gateway HTTP API request (payload format 2.0): what `toResult` makes of
 * the app's response, and what `httpApiHandler` answers by itself. The body is text, or base64
 * where `isBase64Encoded` says so.
 */
export interface HttpApiResult {
  statusCode: number;
  headers: Record<string, string>;
  cookies?: string[];
  body: string;
  isBase64Encoded: boolean;
}

/** What the Runtime API says of an invocation beside its event, in its headers: `runLambda` reads it and passes it to the handler. */
export interface Invocation {
  requestId: string;
  /** When Lambda ends the invocation (UTC epoch ms). */
  deadline: number;
}
