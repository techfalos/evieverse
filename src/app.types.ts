import type { FastifyServerOptions } from 'fastify';
import type { AuditLog } from './audit.types.js';
import type { Languages } from './language.js';
import type { TrustEngine } from './moderation/trust.js';
import type { KeyFetcher } from './originKeys.js';
import type { CliRelease } from './routes/cli.types.js';

/**
 * What `buildApp` takes beside its stores: Fastify's own server options, and what the app is given
 * in place of what it would load or make itself. The long-running server gives none; tests do, and
 * a function passes on its `server` options (createFunction).
 */
export interface AppOptions extends FastifyServerOptions {
  /** Refuse requests that don't carry this in X-Origin-Secret (functions/edge.ts). */
  edgeSecret?: string;
  /** The CLI the server ships, or null for none. By default, the one built with it, if it was (routes/cli.ts). */
  cli?: CliRelease | null;
  /** The trust plugins and the policy over them, which whoever gives them closes. By default, the ones the settings turn on, opened with the app and closed with it (moderation/trust.ts). */
  trust?: TrustEngine;
  /** The languages the server answers in. By default, the files of the languages folder (language.ts). */
  languages?: Languages;
  /** Where changes are written down, or null for nowhere. By default, the store `config.audit` names, if it names one (audit.ts). */
  audit?: AuditLog | null;
  /** What asks another server for the keys it signs with. By default, a request over https to a public address (http/publicFetch.ts). */
  keyFetcher?: KeyFetcher;
}
