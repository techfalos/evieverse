import { createHash, createHmac } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AwsCall, AwsCredentials, SecretRef, SecretsOptions } from './secrets.types.js';

/**
 * A function's secret settings, read from AWS Secrets Manager as its instance starts.
 *
 * A Lambda function's configuration is all the settings it is given, and anyone allowed to read
 * that configuration (`lambda:GetFunctionConfiguration`) reads every environment variable in it.
 * So a deployment keeps the secret ones (the database's and Redis's URLs, the edge secret, API
 * keys) out of it, in Secrets Manager, and gives the function FUNCTION_SECRETS instead: which
 * secrets to read, and which version of each. Only the function's role can read them.
 *
 * It is one HTTPS call for each secret, signed by hand: there is no AWS SDK in the image, as there
 * is no runtime client (lambdaRuntime.ts).
 */

/** How long one call to Secrets Manager may take. One that gets no answer in that time is given up on, and made again. */
const CALL_TIMEOUT_MS = 3000;

/** How many times a call is made before it has failed: one that got no answer, or a 5xx, is made again after a pause. */
const ATTEMPTS = 3;

/** The pause before a call that was refused for want of permission is made again, where the caller waits for the permission (`permissionWaitMs`). */
const PERMISSION_PAUSE_MS = 1000;

/** SHA-256 of `data`, in hex. */
const sha256 = (data: string) => createHash('sha256').update(data).digest('hex');

/** HMAC-SHA256 of `data` under `key`. */
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();

/**
 * The headers to send `call` with, signed with AWS Signature Version 4 as of `now`: the call's own,
 * `x-amz-date`, `x-amz-security-token` where the credentials have one, and `authorization`. `host`
 * is signed and left out, as whatever sends the request sets it.
 */
export function signV4(call: AwsCall, credentials: AwsCredentials, now: Date = new Date()): Record<string, string> {
  const time = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const date = time.slice(0, 8);
  const sent: Record<string, string> = {
    ...call.headers,
    'x-amz-date': time,
    ...(credentials.sessionToken && { 'x-amz-security-token': credentials.sessionToken }),
  };
  const signed: Record<string, string> = { ...sent, host: call.host };
  const names = Object.keys(signed).sort();
  // The method, the path, the query string (none), each header, a blank line, the headers' names, and the body's hash.
  const request = ['POST', '/', '', ...names.map((name) => `${name}:${signed[name]!.trim().replace(/\s+/g, ' ')}`), '', names.join(';'), sha256(call.body)].join('\n');
  const scope = `${date}/${call.region}/${call.service}/aws4_request`;
  const key = [date, call.region, call.service, 'aws4_request'].reduce<string | Buffer>(hmac, `AWS4${credentials.secretAccessKey}`);
  const signature = hmac(key, ['AWS4-HMAC-SHA256', time, scope, sha256(request)].join('\n')).toString('hex');
  return { ...sent, authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

/** The secrets FUNCTION_SECRETS names: a JSON list of `{ "id": ..., "version": ... }`. None where it isn't set. */
function secretRefs(value: string | undefined): SecretRef[] {
  if (!value?.trim()) return [];
  let refs: unknown;
  try {
    refs = JSON.parse(value);
  } catch {
    refs = null;
  }
  const valid = (ref: unknown): ref is SecretRef =>
    typeof ref === 'object' &&
    ref !== null &&
    typeof (ref as SecretRef).id === 'string' &&
    (ref as SecretRef).id !== '' &&
    ['string', 'undefined'].includes(typeof (ref as SecretRef).version);
  if (!Array.isArray(refs) || !refs.every(valid)) throw new Error('FUNCTION_SECRETS must be a JSON list of secrets, each {"id": "<ARN or name>", "version": "<version id>"} with the version optional');
  return refs;
}

/** A secret's value, which must be a JSON object: the settings it holds, by name. A failure names the secret and never its value. */
async function readSecret(ref: SecretRef, region: string, credentials: AwsCredentials, opts: SecretsOptions): Promise<Record<string, unknown>> {
  const endpoint = new URL(opts.endpoint ?? `https://secretsmanager.${region}.amazonaws.com`);
  const body = JSON.stringify({ SecretId: ref.id, ...(ref.version && { VersionId: ref.version }) });
  const call: AwsCall = {
    host: endpoint.host,
    service: 'secretsmanager',
    region,
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'secretsmanager.GetSecretValue' },
    body,
  };
  const failed = (why: string, cause?: unknown) => new Error(`could not read the secret ${ref.id} from Secrets Manager: ${why}`, { cause });
  const started = Date.now();
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    let text: string;
    try {
      // Signed for each attempt: a signature is good for a few minutes of the time it names.
      res = await fetch(endpoint, { method: 'POST', headers: signV4(call, credentials, new Date(opts.now?.() ?? Date.now())), body, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      text = await res.text();
    } catch (err) {
      if (attempt >= ATTEMPTS) throw failed(err instanceof Error ? err.message : String(err), err);
      await sleep(100 * 2 ** attempt);
      continue;
    }
    if (res.status >= 500 && attempt < ATTEMPTS) {
      await sleep(100 * 2 ** attempt);
      continue;
    }
    let answer: { SecretString?: unknown; __type?: unknown; Message?: unknown; message?: unknown } | null;
    try {
      answer = JSON.parse(text);
    } catch {
      answer = null;
    }
    if (res.status !== 200 && String(answer?.__type).endsWith('AccessDeniedException') && Date.now() - started < (opts.permissionWaitMs ?? 0)) {
      await sleep(PERMISSION_PAUSE_MS);
      continue;
    }
    // An error's body has its type and what Secrets Manager says of it; a secret's value is only in an answer of 200.
    if (res.status !== 200) throw failed([res.status, answer?.__type, answer?.Message ?? answer?.message].filter((part) => part !== undefined).join(' '));
    if (typeof answer?.SecretString !== 'string') throw failed('it has no text value');
    let settings: unknown;
    try {
      settings = JSON.parse(answer.SecretString);
    } catch {
      settings = null;
    }
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) throw failed('its value is not a JSON object of settings');
    return settings as Record<string, unknown>;
  }
}

/**
 * Reads the secrets FUNCTION_SECRETS names and puts the settings they hold into `env`, where the
 * rest of the function's settings are, and returns their names. A secret's setting takes the place
 * of one of that name in `env`, and of one in a secret named before it. Without FUNCTION_SECRETS
 * it does nothing: the function's settings are then all in its environment.
 *
 * The secrets are read with the function's own credentials, which Lambda puts in its environment
 * (AWS_ACCESS_KEY_ID and the rest), in its region (AWS_REGION). A secret that can't be read fails
 * this, and so the instance's start: nothing is served with half the settings.
 */
export async function loadSecrets(env: NodeJS.ProcessEnv = process.env, opts: SecretsOptions = {}): Promise<string[]> {
  const refs = secretRefs(env.FUNCTION_SECRETS);
  if (refs.length === 0) return [];
  const { AWS_REGION: region, AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey, AWS_SESSION_TOKEN: sessionToken } = env;
  if (!region || !accessKeyId || !secretAccessKey) {
    throw new Error('FUNCTION_SECRETS is read with the credentials Lambda gives a function (AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN), which are not set');
  }
  const credentials = { accessKeyId, secretAccessKey, ...(sessionToken && { sessionToken }) };
  // Read together, and merged in the order they are named in.
  const secrets = await Promise.all(refs.map((ref) => readSecret(ref, region, credentials, opts)));
  const names = new Set<string>();
  for (const settings of secrets) {
    for (const [name, value] of Object.entries(settings)) {
      if (value === null || value === undefined) continue;
      env[name] = typeof value === 'string' ? value : JSON.stringify(value);
      names.add(name);
    }
  }
  return [...names];
}
