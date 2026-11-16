import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DelegationKey, IdentityToken, ManagedIdentity } from './azureIdentity.types.js';
import { ask, rootPrefix } from './cloudCall.js';
import type { LinkSigner, SignerOptions } from './linkSigner.types.js';

/**
 * Azure Blob Storage as the managed identity of the place the process runs in, with no account
 * key. An account key does everything to every container of its account and never expires; an
 * identity does what its roles allow, and there is nothing of it to keep.
 *
 * Two things stand between OpenDAL and a Container App's identity, and this is both:
 *
 * - OpenDAL asks for the identity's token the way a virtual machine's metadata service is asked
 *   (`api-version=2018-02-01`). A Container App, like App Service and Functions, gives tokens at
 *   IDENTITY_ENDPOINT, to a request that carries IDENTITY_HEADER, and from `2019-08-01` on. So
 *   the process runs a relay on its own loopback address that takes the one request and makes the
 *   other, and tells OpenDAL to ask there (AZURE_IMDS_ENDPOINT).
 * - OpenDAL signs links with an account key and no other way. With an identity, a link is signed
 *   with a user delegation key, which Blob Storage gives the identity for a while: a link signed
 *   with it does what the link says and the identity may do, whichever is less.
 *
 * Both apply where the process has such an identity (IDENTITY_ENDPOINT and IDENTITY_HEADER are
 * set) and the store's options have neither an `account_key` nor a `sas_token`.
 */

/** The version of the identity endpoint's API asked for: the first that Container Apps, App Service and Functions answer. */
const IDENTITY_API_VERSION = '2019-08-01';

/** The resource a token for Blob Storage is asked for. */
const STORAGE_RESOURCE = 'https://storage.azure.com/';

/** The version of Blob Storage's API the delegation key is asked of and links are signed for: the one OpenDAL's own requests name. */
const STORAGE_API_VERSION = '2022-11-02';

/** A token with less than this left is not given out, and a new one is asked for: what OpenDAL is given must outlast the calls it makes with it. */
const TOKEN_MARGIN_MS = 5 * 60_000;

/** How long a user delegation key is asked for, where links don't last longer: it signs every link of that hour. */
const KEY_SECONDS = 3600;

/** The longest a user delegation key can be good for, less a day: seven days is the service's limit. */
const MAX_KEY_SECONDS = 6 * 86_400;

/** How far in the past a user delegation key is said to start, so that it is good at once by a clock that runs behind this one. */
const KEY_BACKDATE_MS = 5 * 60_000;

/** The tokens asked for so far, by the endpoint, the identity and the resource they are of. */
const tokens = new Map<string, IdentityToken>();

/** The relay of this process, once there is one: done when it takes requests. */
let relay: Promise<void> | undefined;

/** A time as Blob Storage writes it: ISO 8601, to the second. */
const stamp = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** The managed identity the environment tells of, or null where it tells of none. */
export function managedIdentity(env: NodeJS.ProcessEnv = process.env): ManagedIdentity | null {
  const { IDENTITY_ENDPOINT: endpoint, IDENTITY_HEADER: header, AZURE_CLIENT_ID: clientId } = env;
  return endpoint && header ? { endpoint, header, ...(clientId && { clientId }) } : null;
}

/** Whether an `azblob` store with these options is the managed identity's to reach: it has no key of its own, and there is an identity. */
export function usesManagedIdentity(options: Record<string, string>, env: NodeJS.ProcessEnv = process.env): boolean {
  return !options.account_key && !options.sas_token && managedIdentity(env) !== null;
}

/**
 * A token of the process's managed identity for `resource`, kept until shortly before it expires.
 * `clientId` says which identity, where it isn't the one AZURE_CLIENT_ID names.
 */
export async function identityToken(resource: string = STORAGE_RESOURCE, now: () => number = Date.now, clientId?: string): Promise<IdentityToken> {
  const identity = managedIdentity();
  if (!identity) throw new Error('this process has no managed identity: IDENTITY_ENDPOINT and IDENTITY_HEADER are not set');
  const client = clientId || identity.clientId;
  const kept = [identity.endpoint, client ?? '', resource].join(' ');
  const token = tokens.get(kept);
  if (token && token.expiresOn * 1000 - now() > TOKEN_MARGIN_MS) return token;
  const url = new URL(identity.endpoint);
  url.searchParams.set('api-version', IDENTITY_API_VERSION);
  url.searchParams.set('resource', resource);
  if (client) url.searchParams.set('client_id', client);
  const res = await ask('the managed identity endpoint', url, { headers: { 'x-identity-header': identity.header } });
  const { access_token: accessToken, expires_on: expires } = (await res.json()) as { access_token?: unknown; expires_on?: unknown };
  const expiresOn = Number(expires);
  if (typeof accessToken !== 'string' || !expires || !Number.isFinite(expiresOn)) throw new Error('the managed identity endpoint gave no token');
  const fresh = { accessToken, expiresOn };
  tokens.set(kept, fresh);
  return fresh;
}

/** Answers one request to the relay: a token for the resource it names, in the form a virtual machine's metadata service gives one. */
async function relayToken(req: http.IncomingMessage, res: http.ServerResponse, secret: Buffer): Promise<void> {
  const given = Buffer.from(String(req.headers['x-identity-header'] ?? ''));
  if (req.method !== 'GET' || given.length !== secret.length || !timingSafeEqual(given, secret)) {
    res.writeHead(403).end();
    return;
  }
  const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
  const resource = query.get('resource') || STORAGE_RESOURCE;
  try {
    const token = await identityToken(resource, Date.now, query.get('client_id') ?? undefined);
    // expires_on as the seconds of the Unix epoch, in a string: the one form OpenDAL reads.
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: token.accessToken, expires_on: String(token.expiresOn), resource, token_type: 'Bearer' }));
  } catch (err) {
    res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  }
}

/**
 * Starts the relay of this process, if it has none, and tells OpenDAL of it. Done when the relay
 * takes requests: no operator that is to use it may call the store before (see createOperator).
 *
 * It listens on 127.0.0.1 alone, on a port the system picks, and answers only a request that
 * carries a secret made here, which OpenDAL is given beside the address (AZURE_MSI_SECRET), so
 * nothing else on the machine gets a token of it. It doesn't keep the process running. Where the
 * deployment says itself where OpenDAL is to ask (AZURE_IMDS_ENDPOINT is set), there is no relay.
 */
export function startTokenRelay(): Promise<void> {
  relay ??= new Promise<void>((resolve, reject) => {
    if (process.env.AZURE_IMDS_ENDPOINT) return resolve();
    const secret = randomBytes(32).toString('hex');
    const server = http.createServer((req, res) => void relayToken(req, res, Buffer.from(secret)));
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      // OpenDAL reads these when it first needs a token, which is after this (see createOperator).
      process.env.AZURE_IMDS_ENDPOINT = `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`;
      process.env.AZURE_MSI_SECRET = secret;
      resolve();
    });
    server.unref();
  });
  return relay;
}

/**
 * A signer of the links to put a blob with, for the `azblob` store with these options: in its
 * `container`, under its `root` if it has one, at its `endpoint`. Each is a user delegation SAS
 * (https://learn.microsoft.com/rest/api/storageservices/create-user-delegation-sas) to create
 * or write that one blob, and the request to make with it is the one OpenDAL's link signed with
 * an account key asks for.
 *
 * The identity needs a role that lets it ask for the key, on the account (Storage Blob
 * Delegator), beside the one that lets it write the blobs (Storage Blob Data Contributor).
 * It signs no links to read with: OpenDAL offers none for `azblob` either, and a file is read
 * through the app.
 */
export function azureLinkSigner(options: Record<string, string>, opts: SignerOptions = {}): LinkSigner {
  const now = opts.now ?? Date.now;
  const endpoint = new URL(options.endpoint ?? '');
  const base = `${endpoint.origin}${endpoint.pathname.replace(/\/+$/, '')}`;
  const account = options.account_name || endpoint.hostname.split('.')[0]!;
  const container = options.container ?? '';
  const prefix = rootPrefix(options.root);
  // A link is for HTTPS alone wherever the store is reached by it, which is everywhere but an emulator.
  const protocol = endpoint.protocol === 'https:' ? 'https' : '';
  let key: DelegationKey | undefined;

  /** A user delegation key that is good for `seconds` more at least: the one in hand, or a new one. */
  const delegationKey = async (seconds: number): Promise<DelegationKey> => {
    if (key && Date.parse(key.expiry) - now() > (seconds + 60) * 1000) return key;
    const { accessToken } = await identityToken(STORAGE_RESOURCE, now);
    const lasts = Math.min(Math.max(KEY_SECONDS, 2 * seconds), MAX_KEY_SECONDS);
    const res = await ask('Blob Storage, asked for a user delegation key,', `${base}/?restype=service&comp=userdelegationkey`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'x-ms-version': STORAGE_API_VERSION, 'content-type': 'application/xml' },
      body: `<?xml version="1.0" encoding="utf-8"?><KeyInfo><Start>${stamp(now() - KEY_BACKDATE_MS)}</Start><Expiry>${stamp(now() + lasts * 1000)}</Expiry></KeyInfo>`,
    });
    const xml = await res.text();
    const field = (name: string) => {
      const found = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml);
      if (!found) throw new Error(`Blob Storage, asked for a user delegation key, gave one with no ${name}`);
      return found[1]!;
    };
    key = { oid: field('SignedOid'), tid: field('SignedTid'), start: field('SignedStart'), expiry: field('SignedExpiry'), service: field('SignedService'), version: field('SignedVersion'), value: field('Value') };
    return key;
  };

  return {
    async upload(name, seconds) {
      const signedWith = await delegationKey(seconds);
      const blob = `${prefix}${name}`;
      const expiry = stamp(Math.min(now() + seconds * 1000, Date.parse(signedWith.expiry)));
      // What is signed, a field to a line, as the version of the API has them: the permissions (create and
      // write), no start, the expiry, the blob, the key's six fields, three ids not used, no IP range, the
      // protocol, the version, the kind of resource (a blob), and seven things a link to write has none of.
      const toSign = [
        'cw',
        '',
        expiry,
        `/blob/${account}/${container}/${blob}`,
        signedWith.oid,
        signedWith.tid,
        signedWith.start,
        signedWith.expiry,
        signedWith.service,
        signedWith.version,
        '',
        '',
        '',
        '',
        protocol,
        STORAGE_API_VERSION,
        'b',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
      ].join('\n');
      const query = new URLSearchParams({
        sv: STORAGE_API_VERSION,
        sr: 'b',
        sp: 'cw',
        se: expiry,
        ...(protocol && { spr: protocol }),
        skoid: signedWith.oid,
        sktid: signedWith.tid,
        skt: signedWith.start,
        ske: signedWith.expiry,
        sks: signedWith.service,
        skv: signedWith.version,
        sig: createHmac('sha256', Buffer.from(signedWith.value, 'base64')).update(toSign, 'utf8').digest('base64'),
      });
      return { method: 'PUT', url: `${base}/${container}/${blob.split('/').map(encodeURIComponent).join('/')}?${query}`, headers: { 'x-ms-blob-type': 'BlockBlob' } };
    },
    download: async () => null,
  };
}
