import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSecrets, signV4 } from '../src/functions/secrets.js';

/** A stand-in for Secrets Manager: answers each GetSecretValue with what `answer` makes of its request, and keeps the requests. */
async function secretsManager(answer: (body: { SecretId: string; VersionId?: string }, call: number) => { status?: number; body: object | string }) {
  const requests: { headers: http.IncomingHttpHeaders; body: { SecretId: string; VersionId?: string } }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push({ headers: req.headers, body });
      const { status = 200, body: answered } = answer(body, requests.length);
      res.writeHead(status, { 'content-type': 'application/x-amz-json-1.1' }).end(typeof answered === 'string' ? answered : JSON.stringify(answered));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve))),
  };
}

/** A function's environment as Lambda sets it, and the secrets a deployment names in it. */
const lambdaEnv = (secrets: object[], more: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  AWS_REGION: 'eu-west-1',
  AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  AWS_SESSION_TOKEN: 'session-token',
  FUNCTION_SECRETS: JSON.stringify(secrets),
  ...more,
});

describe('the secrets of a function', () => {
  let sm: Awaited<ReturnType<typeof secretsManager>> | undefined;
  afterEach(async () => {
    await sm?.close();
    sm = undefined;
  });

  it('signs a request as AWS Signature Version 4 says', () => {
    // "post-vanilla" of AWS's Signature Version 4 test suite: a POST to / with a host, a date and no body.
    const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
    const vanilla = { host: 'example.amazonaws.com', service: 'service', region: 'us-east-1', headers: {}, body: '' };
    expect(signV4(vanilla, credentials, new Date(Date.UTC(2015, 7, 30, 12, 36, 0)))).toEqual({
      'x-amz-date': '20150830T123600Z',
      authorization:
        'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b',
    });
    // A role's credentials come with a session token, which is sent and signed.
    const signed = signV4({ ...vanilla, headers: { 'content-type': 'application/x-amz-json-1.1' } }, { ...credentials, sessionToken: 'token' }, new Date(Date.UTC(2015, 7, 30, 12, 36, 0)));
    expect(signed).toMatchObject({ 'content-type': 'application/x-amz-json-1.1', 'x-amz-security-token': 'token' });
    expect(signed.authorization).toContain('SignedHeaders=content-type;host;x-amz-date;x-amz-security-token,');
    expect(signed.host).toBeUndefined();
  });

  it('reads each secret by its version and puts its settings in the environment, a later secret over an earlier one', async () => {
    sm = await secretsManager(({ SecretId }) => ({
      body: {
        SecretString: JSON.stringify(
          SecretId === 'arn:fn'
            ? { DATABASE_URL: 'postgres://proxy', REDIS_URL: 'rediss://redis', URLHAUS_AUTH_KEY: 'KEY' }
            : { DATABASE_URL: 'postgres://direct', REDIS_URL: 'rediss://redis' },
        ),
      },
    }));
    const env = lambdaEnv(
      [
        { id: 'arn:fn', version: 'v-fn' },
        { id: 'arn:app', version: 'v-app' },
      ],
      { DATABASE_URL: 'postgres://stale', LOG_LEVEL: 'info' },
    );
    const names = await loadSecrets(env, { endpoint: sm.endpoint, now: () => Date.UTC(2026, 10, 16, 18, 30) });
    expect(names.sort()).toEqual(['DATABASE_URL', 'REDIS_URL', 'URLHAUS_AUTH_KEY']);
    // The second secret's over the first's, and both over what the environment had.
    expect(env).toMatchObject({ DATABASE_URL: 'postgres://direct', REDIS_URL: 'rediss://redis', URLHAUS_AUTH_KEY: 'KEY', LOG_LEVEL: 'info' });

    expect(sm.requests.map((r) => r.body).sort((a, b) => a.SecretId.localeCompare(b.SecretId))).toEqual([
      { SecretId: 'arn:app', VersionId: 'v-app' },
      { SecretId: 'arn:fn', VersionId: 'v-fn' },
    ]);
    for (const { headers } of sm.requests) {
      expect(headers).toMatchObject({
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': 'secretsmanager.GetSecretValue',
        'x-amz-date': '20261116T183000Z',
        'x-amz-security-token': 'session-token',
      });
      expect(headers.authorization).toMatch(
        /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261116\/eu-west-1\/secretsmanager\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target, Signature=[0-9a-f]{64}$/,
      );
    }
  });

  it('reads the current version of a secret named without one, and nothing where no secret is named', async () => {
    sm = await secretsManager(() => ({ body: { SecretString: '{"PORT":3000,"EMPTY":null}' } }));
    const env = lambdaEnv([{ id: 'name-only' }]);
    expect(await loadSecrets(env, { endpoint: sm.endpoint })).toEqual(['PORT']);
    expect(env.PORT).toBe('3000');
    expect(sm.requests[0]!.body).toEqual({ SecretId: 'name-only' });

    // A function that isn't given FUNCTION_SECRETS has its settings in its environment, and calls nothing.
    expect(await loadSecrets({ FUNCTION_SECRETS: ' ' }, { endpoint: sm.endpoint })).toEqual([]);
    expect(await loadSecrets({}, { endpoint: sm.endpoint })).toEqual([]);
    expect(sm.requests).toHaveLength(1);
  });

  it('asks again after an answer of 5xx, and gives up on one that says why not', async () => {
    sm = await secretsManager((_body, call) => (call < 3 ? { status: 500, body: { __type: 'InternalServiceError' } } : { body: { SecretString: '{"REDIS_URL":"rediss://redis"}' } }));
    const env = lambdaEnv([{ id: 'arn:fn', version: 'v1' }]);
    expect(await loadSecrets(env, { endpoint: sm.endpoint })).toEqual(['REDIS_URL']);
    expect(sm.requests).toHaveLength(3);
    await sm.close();

    sm = await secretsManager(() => ({ status: 400, body: { __type: 'ResourceNotFoundException', Message: "Secrets Manager can't find the specified secret value for VersionId: v0" } }));
    await expect(loadSecrets(lambdaEnv([{ id: 'arn:fn', version: 'v0' }]), { endpoint: sm.endpoint })).rejects.toThrow(
      "could not read the secret arn:fn from Secrets Manager: 400 ResourceNotFoundException Secrets Manager can't find the specified secret value for VersionId: v0",
    );
    expect(sm.requests).toHaveLength(1);
  });

  it('waits out a refusal for want of permission only where it is told to', async () => {
    const denied = { status: 400, body: { __type: 'AccessDeniedException', Message: 'not authorized to perform: secretsmanager:GetSecretValue' } };
    sm = await secretsManager((_body, call) => (call === 1 ? denied : { body: { SecretString: '{"REDIS_URL":"rediss://redis"}' } }));
    // A function that starts takes the refusal as it is.
    await expect(loadSecrets(lambdaEnv([{ id: 'arn:fn' }]), { endpoint: sm.endpoint })).rejects.toThrow(/400 AccessDeniedException not authorized/);
    await sm.close();

    // The step a deploy runs first asks again: the deploy may only just have granted it.
    sm = await secretsManager((_body, call) => (call === 1 ? denied : { body: { SecretString: '{"REDIS_URL":"rediss://redis"}' } }));
    expect(await loadSecrets(lambdaEnv([{ id: 'arn:fn' }]), { endpoint: sm.endpoint, permissionWaitMs: 10_000 })).toEqual(['REDIS_URL']);
    expect(sm.requests).toHaveLength(2);
  });

  it('refuses a secret that holds no settings, without repeating what it holds', async () => {
    sm = await secretsManager(() => ({ body: { SecretString: 'hunter2' } }));
    const failed = await loadSecrets(lambdaEnv([{ id: 'arn:fn' }]), { endpoint: sm.endpoint }).then(
      () => '',
      (err: Error) => err.message,
    );
    expect(failed).toBe('could not read the secret arn:fn from Secrets Manager: its value is not a JSON object of settings');
    expect(failed).not.toContain('hunter2');
  });

  it('refuses a FUNCTION_SECRETS it cannot read, and credentials that are not there', async () => {
    for (const value of ['arn:fn', '{"id":"arn:fn"}', '[{"version":"v1"}]', '[{"id":"arn:fn","version":3}]']) {
      await expect(loadSecrets({ FUNCTION_SECRETS: value }), value).rejects.toThrow(/^FUNCTION_SECRETS must be a JSON list of secrets/);
    }
    await expect(loadSecrets({ FUNCTION_SECRETS: '[{"id":"arn:fn"}]', AWS_REGION: 'eu-west-1' })).rejects.toThrow(/credentials Lambda gives a function/);
  });
});
