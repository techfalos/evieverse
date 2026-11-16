/** What the audit log keeps of a request that changed something. Bump `version` if a field changes meaning. */
export interface AuditRecord {
  version: 1;
  id: string;
  /** When the server answered, ISO 8601 UTC. */
  time: string;
  requestId: string;
  method: string;
  /** As requested: path and query string. */
  url: string;
  /** The route it matched, with its parameters unfilled (`/content/:contentId`). */
  route: string | null;
  params: unknown;
  query: unknown;
  status: number;
  /** Who made the request, as authenticated; null for one that named nobody (registering). */
  userId: string | null;
  ip: string;
  userAgent: string | null;
  /** The request's whole body, but for the secrets `redact` hides (the API key). For a multipart request, its text fields and a description of its file: the file's bytes are in the content store. */
  body: unknown;
  /** The ids the response named (a new post's, comment's, user's ...), which only the response says. */
  result: Record<string, string>;
}

/** What a request adds to the record beyond what Fastify already knows (see `req.audit`). */
export interface AuditContext {
  userId?: string;
  /** Set by a route that reads its body itself, as /store does with a multipart one (see auditMultipart). */
  body?: unknown;
}

/**
 * Where audit records are written. `createAuditLog` makes the one that writes to the store
 * `config.audit` names, and a test can give `buildApp` another; `registerAudit` writes each record
 * to it. `write` resolves to the key the record is stored under.
 */
export interface AuditLog {
  /** Writes the record, and resolves once it is durable. */
  write(record: AuditRecord): Promise<string>;
}
