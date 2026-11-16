import type { SignerOptions } from './linkSigner.types.js';

/** What `gcsSigner` is made with beside its store's options. */
export interface GcsSignerOptions extends SignerOptions {
  /** Where the IAM Credentials API is, as a URL. By default Google's own. Only tests give one. */
  iamEndpoint?: string;
}
