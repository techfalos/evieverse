/**
 * A server and an account's key on it, kept in <home>/profiles/<name>.json, where <home> is
 * ~/.evieverse (or EVIEVERSE_HOME). `login` writes one, and so does a Terraform deployment, for
 * the admin account it creates.
 */
export interface Profile {
  /** The server's base URL. */
  server: string;
  userId: string;
  /** The account's name when the profile was written; `whoami` asks the server for the one it has now. */
  username?: string;
  apiKey: string;
}
