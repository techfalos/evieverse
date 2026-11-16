import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import { createOperator } from './storage/opendal.js';

const gzipAsync = promisify(gzip);

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
  /** The request's whole body, but for what REDACTED hides. For a multipart request, its text fields and a description of its file: the file's bytes are in the content store. */
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

declare module 'fastify' {
  interface FastifyRequest {
    /** What the audit log is told of this request that only its handler knows. Null until the request starts. */
    audit: AuditContext | null;
  }
}

/** The fields of a body that are secrets, and so are never written down. */
const REDACTED = ['apiKey'];

/** The fields of a response worth keeping in the record: the ids of what the request made or changed. */
const RESULT_IDS = ['contentId', 'commentId', 'messageId', 'uploadId', 'userId'];

/** The methods that change something. The rest read (a route that reads and is not a GET is a bug in the route). */
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The largest record a failed write still falls back to the application log with. Log services cap
 * an entry at about 256 KB (CloudWatch, Cloud Logging), and the record is logged as base64.
 */
const FALLBACK_MAX_BYTES = 150 * 1024;

export interface AuditLog {
  /** Writes the record, and resolves once it is durable. */
  write(record: AuditRecord): Promise<string>;
}

/** The object a record is stored as: one gzipped JSON document, under its UTC hour. */
export function auditKey(record: Pick<AuditRecord, 'id' | 'time'>): string {
  const [date, time] = record.time.split('T') as [string, string];
  return `${date.replaceAll('-', '/')}/${time.slice(0, 2)}/${Date.parse(record.time)}-${record.id}.json.gz`;
}

/**
 * The audit log in an OpenDAL store (any scheme: s3, gcs, azblob, fs ...), which the deployment
 * moves to cold storage with the store's own lifecycle rules. Null where no store is configured.
 */
export function createAuditLog({ scheme, options }: Config['audit']): AuditLog | null {
  if (!scheme) return null;
  const op = createOperator(scheme, options ?? {});
  return {
    async write(record) {
      const key = auditKey(record);
      await op.write(key, await gzipAsync(JSON.stringify(record)), { contentType: 'application/gzip' });
      return key;
    },
  };
}

function redact(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body;
  const out = { ...(body as Record<string, unknown>) };
  for (const field of REDACTED) if (field in out) out[field] = '[redacted]';
  return out;
}

/** The ids a response names, from its JSON: nothing else of it is kept, as some responses hold secrets (a new API key). */
function resultOf(payload: unknown): Record<string, string> {
  if (typeof payload !== 'string' || !payload.startsWith('{')) return {};
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    return Object.fromEntries(RESULT_IDS.flatMap((field) => (typeof parsed[field] === 'string' ? [[field, parsed[field]]] : [])));
  } catch {
    return {};
  }
}

/**
 * For a multipart request, which Fastify leaves unread for the route to take apart: its text fields
 * and a description of its file. The file's bytes are not kept, as they are stored as the post's.
 */
export function auditMultipart(req: FastifyRequest, fields: Record<string, string>, file?: { filename: string | null; mimeType: string; size: number }): void {
  if (req.audit) req.audit.body = { multipart: true, fields: redact(fields), file: file ?? null };
}

/**
 * Writes down every request that changed something: a POST, PUT, PATCH or DELETE that the server
 * answered as done (a status below 400), and no other. Reads are never written, whatever they are.
 *
 * The record is written before the response is sent, so a client that was told its request went
 * through can rely on it being in the log, and a function that stops as it responds can't lose it.
 * A write that fails is not the client's to answer for, as the change has been made: it is logged as
 * an error, with the record itself where it is small enough for the application log to hold it, so
 * that it can be recovered from there.
 *
 * Call it before the routes are added, as hooks only apply to routes added after them.
 */
export function registerAudit(app: FastifyInstance, audit: AuditLog | null, now: () => number = Date.now): void {
  app.decorateRequest('audit', null);
  if (!audit) {
    app.log.info('audit log is off: set AUDIT_SCHEME to write every change to one');
    return;
  }
  app.addHook('onRequest', async (req) => {
    req.audit = {};
  });
  app.addHook('onSend', async (req, reply, payload) => {
    if (!WRITES.has(req.method) || reply.statusCode >= 400) return payload;
    const record: AuditRecord = {
      version: 1,
      id: randomUUID(),
      time: new Date(now()).toISOString(),
      requestId: String(req.id),
      method: req.method,
      url: req.url,
      route: req.routeOptions.url ?? null,
      params: req.params ?? null,
      query: req.query ?? null,
      status: reply.statusCode,
      userId: req.audit?.userId ?? null,
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
      body: redact(req.audit?.body ?? req.body ?? null),
      result: resultOf(payload),
    };
    try {
      const key = await audit.write(record);
      // The metadata, for the application log's own retention; the whole record is the object.
      req.log.info({ audit: key, method: record.method, route: record.route, status: record.status, userId: record.userId, ...record.result }, 'audit');
    } catch (err) {
      const fallback = await gzipAsync(JSON.stringify(record)).then((zipped) => zipped.toString('base64'), () => '');
      req.log.error(
        { err, audit: record.id, method: record.method, route: record.route, status: record.status, ...(fallback && fallback.length <= FALLBACK_MAX_BYTES && { record: fallback }) },
        'audit log write failed',
      );
    }
    return payload;
  });
}
