import { azureLinkSigner, usesManagedIdentity } from './azureIdentity.js';
import { gcsSigner } from './gcsSigner.js';
import type { LinkSigner } from './linkSigner.types.js';

/**
 * The signer of links for a store that has no key to sign with and runs where it needs none, or
 * null: OpenDAL then signs the store's links itself, where it can.
 *
 * - `gcs` with neither `credential` nor `credential_path`, and no key file named by
 *   GOOGLE_APPLICATION_CREDENTIALS, which OpenDAL would sign with: as the service account the
 *   process runs as (gcsSigner.ts).
 * - `azblob` with neither `account_key` nor `sas_token`, in a process with a managed identity:
 *   as that identity (azureIdentity.ts).
 */
export function linkSigner(scheme: string, options: Record<string, string>, now: () => number = Date.now): LinkSigner | null {
  if (scheme === 'gcs' && !options.credential && !options.credential_path && !process.env.GOOGLE_APPLICATION_CREDENTIALS) return gcsSigner(options, { now });
  if (scheme === 'azblob' && usesManagedIdentity(options)) return azureLinkSigner(options, { now });
  return null;
}
