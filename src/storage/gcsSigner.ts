import { createHash } from 'node:crypto';
import { ask, rootPrefix } from './cloudCall.js';
import type { GcsSignerOptions } from './gcsSigner.types.js';
import type { LinkSigner } from './linkSigner.types.js';

/**
 * Links to the objects of a Cloud Storage bucket, signed as the service account the process runs
 * as, with no key of that account anywhere.
 *
 * A signed URL is signed with a service account's private key. OpenDAL signs with one it is given
 * (`credential`, `credential_path`), which is a key that never expires, to be kept and rotated. On
 * Cloud Run, Compute Engine and GKE there is another way: the metadata server says which account
 * the process runs as and gives a token for it, and with that token IAM signs for the account
 * (`signBlob`), with a key Google keeps. The account must be allowed to sign as itself: the role
 * `roles/iam.serviceAccountTokenCreator` on itself, and the IAM Credentials API on in its project.
 *
 * The link is a V4 signed URL (https://cloud.google.com/storage/docs/access-control/signed-urls),
 * the same as OpenDAL makes with a key: of the path-style URL, with only the host signed.
 */

/** A token is asked for again when it has less than this left: the metadata server gives a new one from a few minutes before the old one ends. */
const TOKEN_MARGIN_MS = 60_000;

/** The longest a V4 signed URL can be good for: seven days. */
const MAX_SECONDS = 604_800;

/** Percent-encodes all but the unreserved characters (RFC 3986), as a canonical request has its path's segments and its query. */
const encode = (text: string) => encodeURIComponent(text).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * A signer of links to the objects of the `gcs` store with these options: its `bucket`, under its
 * `root` if it has one, at its `endpoint` if it isn't Google's own.
 */
export function gcsSigner(options: Record<string, string>, opts: GcsSignerOptions = {}): LinkSigner {
  const now = opts.now ?? Date.now;
  const endpoint = new URL(options.endpoint || 'https://storage.googleapis.com');
  const iam = (opts.iamEndpoint ?? 'https://iamcredentials.googleapis.com').replace(/\/+$/, '');
  const prefix = rootPrefix(options.root);
  let account: string | undefined;
  let token: { value: string; until: number } | undefined;

  /** What the metadata server says of the account the process runs as. GCE_METADATA_HOST is where it is, if not at its usual name. */
  const metadata = (path: string) =>
    ask('the metadata server', `http://${process.env.GCE_METADATA_HOST || 'metadata.google.internal'}/computeMetadata/v1/instance/service-accounts/default/${path}`, {
      headers: { 'metadata-flavor': 'Google' },
    });

  /** The account's email, which doesn't change while the process runs. */
  const email = async () => (account ??= (await (await metadata('email')).text()).trim());

  /** A token for the account, kept until shortly before it expires. */
  const accessToken = async () => {
    if (token && token.until > now()) return token.value;
    const { access_token: value, expires_in: seconds } = (await (await metadata('token')).json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof value !== 'string' || typeof seconds !== 'number') throw new Error('the metadata server gave no token');
    token = { value, until: now() + seconds * 1000 - TOKEN_MARGIN_MS };
    return value;
  };

  /** The URL to make a `method` request for the object `key` at, for `seconds` from now. */
  const sign = async (method: string, key: string, seconds: number): Promise<string> => {
    const [signer, bearer] = await Promise.all([email(), accessToken()]);
    const time = new Date(now()).toISOString().replace(/[-:]|\.\d{3}/g, '');
    const scope = `${time.slice(0, 8)}/auto/storage/goog4_request`;
    const path = `/${[options.bucket ?? '', ...`${prefix}${key}`.split('/')].map(encode).join('/')}`;
    // In the order of their names, as a canonical request has them.
    const query = [
      ['X-Goog-Algorithm', 'GOOG4-RSA-SHA256'],
      ['X-Goog-Credential', `${signer}/${scope}`],
      ['X-Goog-Date', time],
      ['X-Goog-Expires', String(Math.min(seconds, MAX_SECONDS))],
      ['X-Goog-SignedHeaders', 'host'],
    ]
      .map(([name, value]) => `${name}=${encode(value!)}`)
      .join('&');
    // The method, the path, the query, each signed header, a blank line, the signed headers' names, and no hash of a body.
    const request = [method, path, query, `host:${endpoint.host}`, '', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
    const toSign = ['GOOG4-RSA-SHA256', time, scope, createHash('sha256').update(request).digest('hex')].join('\n');
    const res = await ask('IAM, asked to sign a link as the service account,', `${iam}/v1/projects/-/serviceAccounts/${encode(signer)}:signBlob`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ payload: Buffer.from(toSign).toString('base64') }),
    });
    const { signedBlob } = (await res.json()) as { signedBlob?: unknown };
    if (typeof signedBlob !== 'string') throw new Error('IAM, asked to sign a link as the service account, gave no signature');
    return `${endpoint.origin}${path}?${query}&X-Goog-Signature=${Buffer.from(signedBlob, 'base64').toString('hex')}`;
  };

  return {
    upload: async (key, seconds) => ({ method: 'PUT', url: await sign('PUT', key, seconds), headers: {} }),
    download: (key, seconds) => sign('GET', key, seconds),
  };
}
