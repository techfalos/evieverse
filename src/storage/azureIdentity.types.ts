/** The managed identity of the place a process runs in, as Azure Container Apps, App Service and Functions tell a process of it in its environment. */
export interface ManagedIdentity {
  /** IDENTITY_ENDPOINT: the URL that gives the identity's tokens, reachable from the process alone. */
  endpoint: string;
  /** IDENTITY_HEADER: what a request to the endpoint must carry, so that nothing but the process can be made to ask. */
  header: string;
  /** AZURE_CLIENT_ID: which identity, where the app has more than its own (a user-assigned one). */
  clientId?: string;
}

/** A token of a managed identity for one resource. */
export interface IdentityToken {
  accessToken: string;
  /** When it expires, in seconds of the Unix epoch. */
  expiresOn: number;
}

/**
 * A user delegation key: what Azure Storage gives an identity to sign links with as itself, for a
 * while. Its fields are as the service gives them, and each goes into the links signed with it.
 */
export interface DelegationKey {
  /** The identity's object id (SignedOid). */
  oid: string;
  /** The identity's tenant (SignedTid). */
  tid: string;
  /** From when the key is good (SignedStart). */
  start: string;
  /** Until when the key is good (SignedExpiry): no link signed with it is good for longer. */
  expiry: string;
  /** The service it is for (SignedService): `b`, Blob Storage. */
  service: string;
  /** The version of the service that made it (SignedVersion). */
  version: string;
  /** The key itself, in base64. */
  value: string;
}
