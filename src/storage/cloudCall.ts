import { setTimeout as sleep } from 'node:timers/promises';

/**
 * What the signers of links (gcsSigner.ts, azureIdentity.ts) share: how they call the services of
 * the cloud they run in, and where in a bucket an OpenDAL store keeps its objects.
 */

/** How long one call may take. One that gets no answer in that time is given up on. */
const CALL_TIMEOUT_MS = 3000;

/** How many times a call is made before it has failed: one that got no answer, or a 5xx, is made once more. */
const ATTEMPTS = 2;

/** The pause before a call is made again. */
const PAUSE_MS = 100;

/** How much of the body of an answer that is an error goes into the error thrown for it. */
const ERROR_BODY_CHARS = 300;

/**
 * The answer to an HTTP call, which must be a 2xx. `what` is who was asked, for the error of a call
 * that failed: it says no more than that and what was answered, which for these services is why
 * (a permission that is missing, an API that is off), and never what was sent.
 */
export async function ask(what: string, url: string | URL, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
    } catch (err) {
      if (attempt < ATTEMPTS) {
        await sleep(PAUSE_MS);
        continue;
      }
      throw new Error(`${what} gave no answer: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    if (res.ok) return res;
    const body = await res.text().catch(() => '');
    if (res.status >= 500 && attempt < ATTEMPTS) {
      await sleep(PAUSE_MS);
      continue;
    }
    throw new Error(`${what} answered ${res.status}: ${body.slice(0, ERROR_BODY_CHARS)}`);
  }
}

/**
 * What an OpenDAL store with the option `root` puts before the key of each of its objects:
 * "pre/fix/" for a root of "/pre/fix", and nothing for none.
 */
export function rootPrefix(root: string | undefined): string {
  const path = (root ?? '').split('/').filter(Boolean).join('/');
  return path && `${path}/`;
}
