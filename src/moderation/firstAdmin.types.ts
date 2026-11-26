/**
 * The admin account a server created the first time it started (see `createFirstAdmin`), with its
 * API key: the one time the key can be read, as the database keeps its hash alone.
 */
export interface FirstAdmin {
  userId: string;
  username: string;
  apiKey: string;
}
