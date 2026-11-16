import { createHash, createHmac, createSign, createVerify, generateKeyPairSync } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { azureLinkSigner } from '../src/storage/azureIdentity.js';
import { ContentStore } from '../src/storage/contentStore.js';
import { gcsSigner } from '../src/storage/gcsSigner.js';
import { linkSigner } from '../src/storage/linkSigner.js';
import { createOperator } from '../src/storage/opendal.js';

interface Seen {
  method: string;
  url: URL;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A stand-in for a cloud's services: answers each request with what `answer` makes of it, and keeps the requests. */
async function fake(answer: (req: Seen) => { status?: number; body?: string | object }) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const request = { method: req.method ?? '', url: new URL(req.url ?? '/', 'http://fake'), headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      seen.push(request);
      const { status = 200, body = '' } = answer(request);
      res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json' }).end(typeof body === 'string' ? body : JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    host,
    url: `http://${host}`,
    seen,
    /** How many of the requests so far were for a path that ends so. */
    count: (path: string) => seen.filter((req) => req.url.pathname.endsWith(path)).length,
    close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve))),
  };
}

let cloud: Awaited<ReturnType<typeof fake>> | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await cloud?.close();
  cloud = undefined;
});

describe('links to a Cloud Storage bucket, signed as the service account the process runs as', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ACCOUNT = 'app@proj.iam.gserviceaccount.com';
  const SERVICE_ACCOUNT = '/computeMetadata/v1/instance/service-accounts/default';

  /** The metadata server and IAM in one: `iam` answers signBlob in IAM's place, where a test has it fail. */
  const google = async (iam?: () => { status: number; body: string } | undefined) => {
    cloud = await fake((req) => {
      if (req.url.pathname.startsWith('/computeMetadata/')) {
        if (req.headers['metadata-flavor'] !== 'Google') return { status: 403 };
        if (req.url.pathname === `${SERVICE_ACCOUNT}/email`) return { body: `${ACCOUNT}\n` };
        if (req.url.pathname === `${SERVICE_ACCOUNT}/token`) return { body: { access_token: `token-${cloud!.count('/token')}`, expires_in: 3600, token_type: 'Bearer' } };
        return { status: 404 };
      }
      if (req.method !== 'POST' || req.url.pathname !== `/v1/projects/-/serviceAccounts/${encodeURIComponent(ACCOUNT)}:signBlob`) return { status: 404 };
      if (!/^Bearer token-\d+$/.test(req.headers.authorization ?? '')) return { status: 401 };
      const failed = iam?.();
      if (failed) return failed;
      const { payload } = JSON.parse(req.body) as { payload: string };
      return { body: { keyId: 'key', signedBlob: createSign('RSA-SHA256').update(Buffer.from(payload, 'base64')).sign(privateKey).toString('base64') } };
    });
    vi.stubEnv('GCE_METADATA_HOST', cloud.host);
    return cloud;
  };

  /** Whether a link's signature is the account's, over the canonical request the documented V4 process gives for it. */
  const signedAs = (link: string, method: string, path: string, time: string) => {
    const url = new URL(link);
    const date = time.slice(0, 8);
    const query =
      `X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=app%40proj.iam.gserviceaccount.com%2F${date}%2Fauto%2Fstorage%2Fgoog4_request` +
      `&X-Goog-Date=${time}&X-Goog-Expires=900&X-Goog-SignedHeaders=host`;
    expect(link).toBe(`https://storage.googleapis.com${path}?${query}&X-Goog-Signature=${url.searchParams.get('X-Goog-Signature')}`);
    const request = `${method}\n${path}\n${query}\nhost:storage.googleapis.com\n\nhost\nUNSIGNED-PAYLOAD`;
    const toSign = `GOOG4-RSA-SHA256\n${time}\n${date}/auto/storage/goog4_request\n${createHash('sha256').update(request).digest('hex')}`;
    return createVerify('RSA-SHA256').update(toSign).verify(publicKey, Buffer.from(url.searchParams.get('X-Goog-Signature')!, 'hex'));
  };

  it('signs V4 URLs through IAM, with a token and the name of the account from the metadata server', async () => {
    const { url: iamEndpoint, count, seen } = await google();
    let now = Date.UTC(2026, 0, 2, 3, 4, 5);
    const signer = gcsSigner({ bucket: 'media', root: '/pre/fix/' }, { iamEndpoint, now: () => now });

    const read = await signer.download('content/a b', 900);
    expect(signedAs(read!, 'GET', '/media/pre/fix/content/a%20b', '20260102T030405Z')).toBe(true);
    const upload = await signer.upload('uploads/user/1', 900);
    expect([upload.method, upload.headers]).toEqual(['PUT', {}]);
    expect(signedAs(upload.url, 'PUT', '/media/pre/fix/uploads/user/1', '20260102T030405Z')).toBe(true);
    // A link to read is none to write with: the method is part of what is signed.
    expect(signedAs(upload.url, 'GET', '/media/pre/fix/uploads/user/1', '20260102T030405Z')).toBe(false);

    // The account is asked for once, and a token once for as long as it lasts.
    expect([count('/email'), count('/token'), count(':signBlob')]).toEqual([1, 1, 2]);
    expect(seen.filter((req) => req.url.pathname.endsWith(':signBlob')).map((req) => req.headers.authorization)).toEqual(['Bearer token-1', 'Bearer token-1']);
    now += 3590_000;
    expect(signedAs((await signer.download('content/c', 900))!, 'GET', '/media/pre/fix/content/c', '20260102T040355Z')).toBe(true);
    expect([count('/email'), count('/token')]).toEqual([1, 2]);
    expect(seen.at(-1)!.headers.authorization).toBe('Bearer token-2');
  });

  it('gives a link to read again for half the time it is good for, and one signature to requests made together', async () => {
    const { url: iamEndpoint, count } = await google();
    let now = Date.UTC(2026, 0, 2);
    const options = { bucket: 'media' };
    const store = new ContentStore({ scheme: 'gcs', options, signedUrlSeconds: 900 }, () => now, gcsSigner(options, { iamEndpoint, now: () => now }));

    const first = await store.signedUrl('c1');
    expect(new URL(first!).pathname).toBe('/media/content/c1');
    expect(await store.signedUrl('c1')).toBe(first);
    expect(count(':signBlob')).toBe(1);
    const together = await Promise.all([store.signedUrl('c2'), store.signedUrl('c2'), store.signedUrl({ adId: 'ad' })]);
    expect(together[1]).toBe(together[0]);
    expect(new URL(together[2]!).pathname).toBe('/media/ads/ad');
    expect(count(':signBlob')).toBe(3);

    now += 449_000;
    expect(await store.signedUrl('c1')).toBe(first);
    now += 1000;
    const second = await store.signedUrl('c1');
    expect(second).not.toBe(first);
    expect(new URL(second!).searchParams.get('X-Goog-Date')).toBe('20260102T000730Z');
    expect(count(':signBlob')).toBe(4);
    // A post that is deleted takes its link with it.
    await store.remove('c1').catch(() => {});
    await store.signedUrl('c1');
    expect(count(':signBlob')).toBe(5);

    // An upload link is the signer's too, with the content type the client is to send.
    const upload = await store.presignUpload('user', 'upload', 'video/mp4');
    expect([upload!.method, upload!.headers]).toEqual(['PUT', { 'content-type': 'video/mp4' }]);
    expect(new URL(upload!.url).pathname).toBe('/media/uploads/user/upload');
  });

  it('gives no link while IAM fails, says why, and gives links again once it answers', async () => {
    let failing: { status: number; body: string } | undefined = { status: 403, body: "Permission 'iam.serviceAccounts.signBlob' denied" };
    const { url: iamEndpoint, count } = await google(() => failing);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    let now = Date.UTC(2026, 0, 2);
    const options = { bucket: 'media' };
    const store = new ContentStore({ scheme: 'gcs', options, signedUrlSeconds: 900 }, () => now, gcsSigner(options, { iamEndpoint, now: () => now }));

    expect(await store.signedUrl('c1')).toBeNull();
    expect(logged).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logged.mock.calls[0]![0] as string)).toMatchObject({ level: 'error', err: expect.stringContaining("answered 403: Permission 'iam.serviceAccounts.signBlob' denied") });
    // Not asked again for half a minute, whatever the link is for.
    expect(await store.presignUpload('user', 'upload', 'video/mp4')).toBeNull();
    expect(await store.signedUrl('c1')).toBeNull();
    expect(count(':signBlob')).toBe(1);

    // A 5xx is asked once more before it is a failure.
    now += 30_000;
    failing = { status: 503, body: 'unavailable' };
    expect(await store.presignUpload('user', 'upload', 'video/mp4')).toBeNull();
    expect(count(':signBlob')).toBe(3);
    expect(logged).toHaveBeenCalledTimes(2);

    now += 30_000;
    failing = undefined;
    expect(await store.signedUrl('c1')).toMatch(/^https:\/\/storage\.googleapis\.com\/media\/content\/c1\?/);
    expect((await store.presignUpload('user', 'upload', 'video/mp4'))!.method).toBe('PUT');
    expect(logged).toHaveBeenCalledTimes(2);
  });

  it('is the signer of a gcs store that has no key, and of no other', () => {
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '');
    expect(linkSigner('gcs', { bucket: 'media' })).not.toBeNull();
    expect(linkSigner('gcs', { bucket: 'media', credential: 'e30=' })).toBeNull();
    expect(linkSigner('gcs', { bucket: 'media', credential_path: '/key.json' })).toBeNull();
    expect(linkSigner('s3', { bucket: 'media' })).toBeNull();
    expect(linkSigner('fs', { root: '/tmp' })).toBeNull();
    // OpenDAL signs with the key file the environment names.
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '/key.json');
    expect(linkSigner('gcs', { bucket: 'media' })).toBeNull();
  });
});

describe('Azure Blob Storage as the managed identity of the process', () => {
  const KEY = { oid: '11111111-1111-4111-8111-111111111111', tid: '22222222-2222-4222-8222-222222222222', value: Buffer.from('a user delegation key of 32 byte').toString('base64') };
  const ACCOUNT_KEY = Buffer.from('k'.repeat(32)).toString('base64');
  const stamp = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

  /** The identity endpoint of a Container App and Blob Storage in one, and the environment a Container App with an identity has. */
  const azure = async () => {
    cloud = await fake((req) => {
      if (req.url.pathname === '/msi/token') {
        if (req.headers['x-identity-header'] !== 'identity-header' || req.url.searchParams.get('api-version') !== '2019-08-01') return { status: 400, body: 'not a request of this endpoint' };
        return { body: { access_token: 'identity-token', expires_on: String(Math.floor(Date.now() / 1000) + 3600), resource: req.url.searchParams.get('resource'), token_type: 'Bearer', client_id: req.url.searchParams.get('client_id') } };
      }
      if (req.headers.authorization !== 'Bearer identity-token') return { status: 403, body: 'AuthenticationFailed' };
      if (req.method === 'POST' && req.url.search === '?restype=service&comp=userdelegationkey') {
        const asked = (name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(req.body)![1];
        return {
          body:
            `<?xml version="1.0" encoding="utf-8"?><UserDelegationKey><SignedOid>${KEY.oid}</SignedOid><SignedTid>${KEY.tid}</SignedTid>` +
            `<SignedStart>${asked('Start')}</SignedStart><SignedExpiry>${asked('Expiry')}</SignedExpiry><SignedService>b</SignedService>` +
            `<SignedVersion>2022-11-02</SignedVersion><Value>${KEY.value}</Value></UserDelegationKey>`,
        };
      }
      return { status: req.method === 'PUT' ? 201 : 404 };
    });
    vi.stubEnv('IDENTITY_ENDPOINT', `${cloud.url}/msi/token`);
    vi.stubEnv('IDENTITY_HEADER', 'identity-header');
    vi.stubEnv('AZURE_CLIENT_ID', 'client-id');
    return cloud;
  };

  /** The signature Azure documents for a user delegation SAS of version 2020-12-06 and later: the fields of a link, a line each. */
  const signature = (fields: { se: string; blob: string; skt: string; ske: string; spr: string }) =>
    createHmac('sha256', Buffer.from(KEY.value, 'base64'))
      .update(['cw', '', fields.se, fields.blob, KEY.oid, KEY.tid, fields.skt, fields.ske, 'b', '2022-11-02', '', '', '', '', fields.spr, '2022-11-02', 'b', '', '', '', '', '', '', ''].join('\n'))
      .digest('base64');

  it('reaches the store with the identity\'s token, which OpenDAL gets through the relay, from the first call on', async () => {
    const { url, seen } = await azure();
    const options = { container: 'media', endpoint: url, account_name: 'acct' };
    // Made at once, before the relay listens: the calls wait for it.
    const op = createOperator('azblob', options);
    await op.write('audit/record', 'written as the identity');
    const store = new ContentStore({ scheme: 'azblob', options, signedUrlSeconds: 900 });
    expect(await store.statUpload('user', 'none')).toBeNull();
    // What an operator says of itself is not held back, and is as ever.
    expect(op.capability().write).toBe(true);

    const [token, put, head] = [seen.filter((req) => req.url.pathname === '/msi/token'), seen.filter((req) => req.method === 'PUT'), seen.filter((req) => req.method === 'HEAD')];
    // The endpoint is asked as a Container App's is, and for the identity the app names.
    expect(token.length).toBeGreaterThan(0);
    expect(Object.fromEntries(token[0]!.url.searchParams)).toEqual({ 'api-version': '2019-08-01', resource: 'https://storage.azure.com/', client_id: 'client-id' });
    expect(put.map((req) => [req.url.pathname, req.headers.authorization, req.body])).toEqual([['/media/audit/record', 'Bearer identity-token', 'written as the identity']]);
    expect(head.map((req) => [req.url.pathname, req.headers.authorization])).toEqual([['/media/uploads/user/none', 'Bearer identity-token']]);

    // The relay is on this machine alone, and answers only what has its secret: OpenDAL, which was told it.
    const relay = process.env.AZURE_IMDS_ENDPOINT!;
    expect(new URL(relay).hostname).toBe('127.0.0.1');
    const ask = (secret?: string) => fetch(`${relay}?api-version=2018-02-01&resource=${encodeURIComponent('https://storage.azure.com/')}`, { headers: { metadata: 'true', ...(secret && { 'x-identity-header': secret }) } });
    expect((await ask()).status).toBe(403);
    expect((await ask('identity-header')).status).toBe(403);
    const answered = await ask(process.env.AZURE_MSI_SECRET);
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({ access_token: 'identity-token', expires_on: expect.stringMatching(/^\d+$/), resource: 'https://storage.azure.com/', token_type: 'Bearer' });
  });

  it('gives the upload link an account key would, signed with a user delegation key', async () => {
    // What OpenDAL gives with an account key: the request a client makes with the link is the same either way.
    const keyed = new ContentStore({ scheme: 'azblob', options: { container: 'media', endpoint: 'https://acct.blob.core.windows.net', account_name: 'acct', account_key: ACCOUNT_KEY }, signedUrlSeconds: 900 });
    const withKey = await keyed.presignUpload('user', 'upload', 'image/png');
    expect([withKey!.method, withKey!.headers]).toEqual(['PUT', { 'x-ms-blob-type': 'BlockBlob', 'content-type': 'image/png' }]);
    expect(withKey!.url.split('?')[0]).toBe('https://acct.blob.core.windows.net/media/uploads/user/upload');

    const { url, seen } = await azure();
    let now = Math.floor(Date.now() / 1000) * 1000;
    const options = { container: 'media', endpoint: url, account_name: 'acct' };
    const store = new ContentStore({ scheme: 'azblob', options, signedUrlSeconds: 900 }, () => now);
    const link = await store.presignUpload('user', 'upload', 'image/png');
    expect([link!.method, link!.headers]).toEqual([withKey!.method, withKey!.headers]);
    expect(link!.url.split('?')[0]).toBe(`${url}/media/uploads/user/upload`);

    // The key is asked of the service as the identity, from a little before now, for an hour.
    const keys = () => seen.filter((req) => req.method === 'POST');
    expect(keys().map((req) => [req.headers['x-ms-version'], req.body])).toEqual([
      ['2022-11-02', `<?xml version="1.0" encoding="utf-8"?><KeyInfo><Start>${stamp(now - 300_000)}</Start><Expiry>${stamp(now + 3600_000)}</Expiry></KeyInfo>`],
    ]);
    const [skt, ske, se] = [stamp(now - 300_000), stamp(now + 3600_000), stamp(now + 900_000)];
    expect(Object.fromEntries(new URL(link!.url).searchParams)).toEqual({
      sv: '2022-11-02',
      sr: 'b',
      // To create or write the one blob, and nothing else: not to read it, and not to delete it.
      sp: 'cw',
      se,
      skoid: KEY.oid,
      sktid: KEY.tid,
      skt,
      ske,
      sks: 'b',
      skv: '2022-11-02',
      sig: signature({ se, blob: '/blob/acct/media/uploads/user/upload', skt, ske, spr: '' }),
    });

    // One key signs the links of its hour, and a new one is asked for before a link would outlast it.
    await store.presignUpload('user', 'another', 'image/png');
    expect(keys()).toHaveLength(1);
    now += 3000_000;
    const later = new URL((await store.presignUpload('user', 'later', 'image/png'))!.url).searchParams;
    expect(keys()).toHaveLength(2);
    expect([later.get('skt'), later.get('ske'), later.get('se')]).toEqual([stamp(now - 300_000), stamp(now + 3600_000), stamp(now + 900_000)]);
    // It signs no link to read with, as OpenDAL gives none for azblob: the file is read through the app.
    expect(await store.signedUrl('c1')).toBeNull();
    expect(await keyed.signedUrl('c1')).toBeNull();
  });

  it('signs for HTTPS alone where the store is reached by it, and for a store under a root', async () => {
    const { url } = await azure();
    const real = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => real(String(input).replace('https://acct.blob.core.windows.net', url), init));
    const now = Math.floor(Date.now() / 1000) * 1000;
    const link = await azureLinkSigner({ container: 'media', endpoint: 'https://acct.blob.core.windows.net', root: '/pre/fix' }, { now: () => now }).upload('uploads/user/a b', 900);
    expect(link.url.split('?')[0]).toBe('https://acct.blob.core.windows.net/media/pre/fix/uploads/user/a%20b');
    const query = new URL(link.url).searchParams;
    expect(query.get('spr')).toBe('https');
    // The account is the one the endpoint names, and the blob is signed by its name as it is, not as a URL has it.
    expect(query.get('sig')).toBe(
      signature({ se: stamp(now + 900_000), blob: '/blob/acct/media/pre/fix/uploads/user/a b', skt: stamp(now - 300_000), ske: stamp(now + 3600_000), spr: 'https' }),
    );
  });

  it('is how an azblob store with no key is reached where there is an identity, and no other store', async () => {
    const options = { container: 'media', endpoint: 'https://acct.blob.core.windows.net' };
    vi.stubEnv('IDENTITY_ENDPOINT', '');
    vi.stubEnv('IDENTITY_HEADER', '');
    // No identity: OpenDAL's own ways of finding credentials are left to it.
    expect(linkSigner('azblob', options)).toBeNull();
    vi.stubEnv('IDENTITY_ENDPOINT', 'http://127.0.0.1:1/msi/token');
    vi.stubEnv('IDENTITY_HEADER', 'identity-header');
    expect(linkSigner('azblob', options)).not.toBeNull();
    expect(linkSigner('azblob', { ...options, account_key: ACCOUNT_KEY })).toBeNull();
    expect(linkSigner('azblob', { ...options, sas_token: 'sv=2022-11-02&sig=abc' })).toBeNull();
  });
});
