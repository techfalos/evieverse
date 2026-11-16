import type { UploadLink } from './contentStore.types.js';

/**
 * What signs the links to a store's objects where OpenDAL can't: as the identity of the place the
 * process runs in (a Cloud Run service's account, a Container App's managed identity), with no key
 * for the deployment to keep. Signing is a call to a service of the cloud, so it can fail, and
 * a link not signed is a file that goes through the app instead (see ContentStore).
 */
export interface LinkSigner {
  /** A link to put the object `key` with, good for `seconds`: the request to make, without the content type, which the store adds. */
  upload(key: string, seconds: number): Promise<UploadLink>;
  /** The URL to read the object `key` at for `seconds`, or null where it signs none for reading. */
  download(key: string, seconds: number): Promise<string | null>;
}

/** What every signer is made with beside its store's options. */
export interface SignerOptions {
  /** Injectable clock (UTC epoch ms): when a link is signed, and so until when it is good. */
  now?: () => number;
}
