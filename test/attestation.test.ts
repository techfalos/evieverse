import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { attest, AttestedGone, AttestedPost, publishedKey, readAttestation, saysGone, seedOf, signedBy, signingKeys, type Attestable } from '../src/attestation.js';
import type { SigningKey } from '../src/attestation.types.js';
import { loadConfig } from '../src/config.js';
import { fetchPublicJson, isPublicAddress } from '../src/http/publicFetch.js';
import { ownAddress, postAddress } from '../src/posts.js';

const ID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
const POST: Attestable = {
  url: `https://other.example/content/${ID}`,
  publisher: { userId: '11111111-1111-4111-8111-111111111111', username: 'Dana of the North' },
  mimeType: 'text/plain',
  aiGenerated: false,
  preview: { kind: 'text', text: 'Flooding closes the coast road. \u{1F30A}' },
};
const seed = (byte: number) => Buffer.alloc(32, byte);

describe('attestations', () => {
  const [key, other] = signingKeys([seed(1).toString('base64'), seed(2).toString('hex')]) as [SigningKey, SigningKey];

  it('reads a signing key from 32 bytes, in base64 or hex, and nothing else', () => {
    for (const text of [seed(1).toString('base64'), seed(1).toString('base64url'), seed(1).toString('hex'), seed(1).toString('hex').toUpperCase(), seed(1).toString('base64').replace('=', '')]) {
      expect(seedOf(text), text).toEqual(seed(1));
    }
    for (const text of ['', 'secret', seed(1).subarray(1).toString('base64'), Buffer.alloc(33, 1).toString('base64'), seed(1).toString('hex').slice(2), `${seed(1).toString('base64')} `]) {
      expect(seedOf(text), text).toBeNull();
    }
    // The same bytes make the same key, however they were written, and other bytes another.
    const [again] = signingKeys([seed(1).toString('hex')]);
    expect([again!.id, again!.publicKey]).toEqual([key.id, key.publicKey]);
    expect(other.id).not.toBe(key.id);
    expect(key.id).toMatch(/^[0-9a-f]{16}$/);
    expect(key.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('takes its keys from the configuration, which says which one is wrong and never what it is', () => {
    const load = (value: string) => loadConfig({}, { EVIEVERSE_CONFIG: '/nonexistent.json', REPOSTS_SIGNING_KEYS: value }).reposts.signingKeys;
    const [first, second] = [seed(1).toString('base64'), seed(2).toString('hex')];
    expect(loadConfig({}, { EVIEVERSE_CONFIG: '/nonexistent.json' }).reposts.signingKeys).toEqual([]);
    expect(load('')).toEqual([]);
    expect(load(first)).toEqual([first]);
    expect(load(`${first}, ${second}`)).toEqual([first, second]);
    expect(load(`${first}\n${second}\n`)).toEqual([first, second]);
    expect(loadConfig({ reposts: { signingKeys: [second, first] } }, { EVIEVERSE_CONFIG: '/nonexistent.json' }).reposts.signingKeys).toEqual([second, first]);
    let said = '';
    try {
      load(`${first},not-a-key-but-a-secret`);
    } catch (err) {
      said = String((err as Error).message);
    }
    expect(said).toContain('key 2 of REPOSTS_SIGNING_KEYS is not 32 random bytes');
    expect(said).not.toContain('not-a-key-but-a-secret');
    expect(said).not.toContain(first);
  });

  it('signs what a server says of a post, which only that key is found to have signed', () => {
    const attestation = attest(key, POST, 1_700_000_000_000);
    expect(attestation).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/);
    const read = readAttestation(attestation)!;
    expect(read.payload).toEqual({ v: 1, kid: key.id, issuedAt: 1_700_000_000_000, ...POST });
    expect(AttestedPost.parse(read.payload)).toEqual({ v: 1, kid: key.id, issuedAt: 1_700_000_000_000, ...POST });
    expect(signedBy(key, read)).toBe(true);
    expect(signedBy(other, read)).toBe(false);
    // The key a server publishes is enough to check with, and its id is the key's own, whatever it was published as.
    expect(publishedKey(key.publicKey)).toEqual({ id: key.id, publicKey: key.publicKey });
    expect(signedBy(publishedKey(key.publicKey)!, read)).toBe(true);
    for (const not of [undefined, null, 7, '', 'short', `${key.publicKey}A`, key.publicKey.replace(/.$/, '+')]) expect(publishedKey(not)).toBeNull();

    // A payload that was changed, a signature that was, and a signature moved from another attestation: none is the key's.
    const [payload, signature] = attestation.split('.') as [string, string];
    const changed = Buffer.from(JSON.stringify({ ...(read.payload as object), aiGenerated: true })).toString('base64url');
    expect(signedBy(key, readAttestation(`${changed}.${signature}`)!)).toBe(false);
    expect(signedBy(key, readAttestation(`${payload}.${attest(key, { ...POST, aiGenerated: true }, 1_700_000_000_000).split('.')[1]}`)!)).toBe(false);
    expect(signedBy(key, readAttestation(`${payload}.${'A'.repeat(86)}`)!)).toBe(false);
    // What the key signed for something else is no attestation: the payload's bytes alone, without what says they are one.
    const bare = sign(null, Buffer.from(payload), key.privateKey).toString('base64url');
    expect(signedBy(key, readAttestation(`${payload}.${bare}`)!)).toBe(false);
    // A key that isn't one signed nothing, and nothing is thrown for it.
    expect(signedBy({ id: key.id, publicKey: 'not a key' }, read)).toBe(false);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' }).n!;
    expect(signedBy({ id: key.id, publicKey: rsa }, read)).toBe(false);
  });

  it('reads only what is written as an attestation', () => {
    const attestation = attest(key, POST, 0);
    const [payload, signature] = attestation.split('.') as [string, string];
    for (const text of ['', '.', payload, `${payload}.`, `.${signature}`, `${payload}.${signature}.`, `${payload}.${signature.slice(1)}`, `${payload}=.${signature}`, ` ${attestation}`, `${attestation}\n`]) {
      expect(readAttestation(text), text).toBeNull();
    }
    expect(readAttestation(`${Buffer.from('{"v":1').toString('base64url')}.${signature}`)).toBeNull();
    // What is JSON is read, whatever it says: that is checked once it is known who signed it.
    expect(readAttestation(`${Buffer.from('[1]').toString('base64url')}.${signature}`)!.payload).toEqual([1]);
  });

  it('says a post only by an address that is one post, on its own server', () => {
    const said = (o: Record<string, unknown>) => AttestedPost.safeParse({ v: 1, kid: key.id, issuedAt: 0, ...POST, ...o });
    expect(said({}).success).toBe(true);
    // One address for a post, however it was written.
    expect(said({ url: `HTTPS://Other.Example/content/${ID.toUpperCase()}` }).data!.url).toBe(POST.url);
    expect(said({ url: `https://other.example/sub/content/${ID}` }).success).toBe(true);
    for (const url of [`${POST.url}/raw`, `${POST.url}/`, `${POST.url}?a=b`, `${POST.url}#top`, `https://dana:pw@other.example/content/${ID}`, `ftp://other.example/content/${ID}`, `https://other.example/posts/${ID}`, 'nowhere']) {
      expect(said({ url }).success, url).toBe(false);
    }
    for (const o of [{ v: 2 }, { kid: 'KEY' }, { kid: undefined }, { issuedAt: -1 }, { issuedAt: 1.5 }, { issuedAt: '0' }, { aiGenerated: undefined }, { aiGenerated: 'false' }, { publisher: undefined }, { preview: undefined }]) {
      expect(said(o).success, JSON.stringify(o)).toBe(false);
    }
  });

  it('signs that there is no post at an address, which reads as that and not as a post', () => {
    const read = readAttestation(attest(key, { url: POST.url, gone: true }, 1_700_000_000_000))!;
    expect(read.payload).toEqual({ v: 1, kid: key.id, issuedAt: 1_700_000_000_000, url: POST.url, gone: true });
    expect([signedBy(key, read), signedBy(other, read)]).toEqual([true, false]);
    expect([saysGone(read.payload), AttestedGone.safeParse(read.payload).success, AttestedPost.safeParse(read.payload).success]).toEqual([true, true, false]);
    // A post's attestation doesn't say so, and nothing else does: it is said with `true`, of an address that is one post's.
    const post = readAttestation(attest(key, POST, 0))!.payload;
    expect([saysGone(post), AttestedGone.safeParse(post).success]).toEqual([false, false]);
    for (const not of [null, 'gone', [true], { gone: 'true' }, { gone: 1 }, { gone: false }]) expect(saysGone(not), JSON.stringify(not)).toBe(false);
    expect(AttestedGone.safeParse({ v: 1, kid: key.id, issuedAt: 0, url: `${POST.url}/raw`, gone: true }).success).toBe(false);
  });

  it("knows this server's own address, and the address of a post under it", () => {
    expect(ownAddress('')).toBeNull();
    expect(ownAddress('not an address')).toBeNull();
    expect(ownAddress('https://API.example.com/')).toBe('https://api.example.com');
    expect(ownAddress('https://api.example.com/v1//')).toBe('https://api.example.com/v1');
    expect(postAddress('https://api.example.com', ID)).toBe(`https://api.example.com/content/${ID}`);
  });
});

describe('requests to an address somebody else chose', () => {
  it('tells the public internet from everything else', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '2a00:1450:4001:81b::200e']) {
      expect(isPublicAddress(address), address).toBe(true);
    }
    const not = [
      // This host, private networks, link-local (the cloud metadata address among them), carrier-grade NAT.
      ...['0.0.0.0', '127.0.0.1', '127.8.8.8', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.127.255.255'],
      // Documentation, benchmarking, multicast, reserved, broadcast.
      ...['192.0.2.1', '198.51.100.1', '203.0.113.1', '198.18.0.1', '192.0.0.1', '224.0.0.1', '240.0.0.1', '255.255.255.255'],
      // The same in IPv6, and IPv6 addresses that carry an IPv4 one.
      ...['::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '2001:db8::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', '64:ff9b::a00:1', '2002:a00:1::', '2001::1'],
      // The older ways of writing an IPv4 address as an IPv6 one, a public one too, and the range that was IPv6's private one.
      ...['::10.0.0.1', '::a00:1', '::127.0.0.1', '::169.254.169.254', '::8.8.8.8', '::ffff:0:10.0.0.1', '::ffff:0:a9fe:a9fe', 'fec0::1', 'feff::1'],
      // What isn't an address at all.
      ...['', 'localhost', 'other.example', '10.0.0', '8.8.8.8:443', '[::1]'],
    ];
    for (const address of not) expect(isPublicAddress(address), address).toBe(false);
  });

  it('asks nothing of an address that is not https, or not public: said before any connection is made', async () => {
    await expect(fetchPublicJson('http://other.example/repost/keys')).rejects.toThrow('http://other.example is not an https address');
    await expect(fetchPublicJson('not an address')).rejects.toThrow();
    await expect(fetchPublicJson('https://127.0.0.1/repost/keys')).rejects.toThrow('127.0.0.1 is not an address on the public internet');
    await expect(fetchPublicJson('https://169.254.169.254/latest/meta-data/')).rejects.toThrow('169.254.169.254 is not an address on the public internet');
    await expect(fetchPublicJson('https://10.1.2.3/repost/keys')).rejects.toThrow('10.1.2.3 is not an address on the public internet');
    await expect(fetchPublicJson('https://[::1]/repost/keys')).rejects.toThrow('::1 is not an address on the public internet');
    await expect(fetchPublicJson('https://[::ffff:10.0.0.1]/repost/keys')).rejects.toThrow('is not an address on the public internet');
    await expect(fetchPublicJson('https://[::10.0.0.1]/repost/keys')).rejects.toThrow('::a00:1 is not an address on the public internet');
    // Nor of any port but the one https has, on a public address either: the port that is its own is the one left out.
    await expect(fetchPublicJson('https://other.example:8443/repost/keys')).rejects.toThrow('https://other.example:8443 is not on the port of https');
    await expect(fetchPublicJson('https://93.184.216.34:22/repost/keys')).rejects.toThrow('https://93.184.216.34:22 is not on the port of https');
    await expect(fetchPublicJson('https://127.0.0.1:443/repost/keys')).rejects.toThrow('127.0.0.1 is not an address on the public internet');
    // An address written as a number is the address the URL parser makes of it.
    await expect(fetchPublicJson('https://2130706433/repost/keys')).rejects.toThrow('127.0.0.1 is not an address on the public internet');
    await expect(fetchPublicJson('https://0x7f.1/repost/keys')).rejects.toThrow('127.0.0.1 is not an address on the public internet');
    // A name is held to the addresses it resolves to.
    await expect(fetchPublicJson('https://localhost/repost/keys')).rejects.toThrow("localhost resolves to an address that isn't on the public internet");
  });
});
