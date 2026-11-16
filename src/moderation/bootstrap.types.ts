/**
 * What `ensureAdmin` found of the admin account and did to it. The migration step prints it (see
 * `describeAdmin`), and the one a deployment of functions runs returns it too (`Deployed`).
 */
export interface EnsuredAdmin {
  userId: string;
  /** The account's name now, which is `username` only if this created it: it may have been renamed since. */
  username: string;
  created: boolean;
  /** Whether the key was added, or other keys of the account revoked. */
  keyChanged: boolean;
  /** Whether the key was the account's once and has been replaced since: it stays revoked, and the account keeps the key it has. */
  keyReplaced: boolean;
}
