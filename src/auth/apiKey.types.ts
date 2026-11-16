/**
 * The user whose credentials a request carries, as their row says they are when the request
 * arrives. `authenticate` makes it, and the routes and moderation go by it for what the user may
 * do.
 */
export interface AuthUser {
  id: string;
  username: string;
  admin: boolean;
  /** A server moderator: one who works through the moderation queue. An admin does too, without being one. */
  moderator: boolean;
  /** The code of the language the server answers the user in (see languageOf). */
  language: string;
  /** Whether the user takes part in messages between users: on, until they turn it off. */
  messages: boolean;
  /** Whether anyone can list whom the user follows: off, until they turn it on. */
  showFollowing: boolean;
  /** Whether anyone can list who follows the user: off, until they turn it on. */
  showFollowers: boolean;
  /** Whether a server moderator or an admin banned the user: they are refused posts, comments, likes, messages and upload links (see refuseBanned). */
  banned: boolean;
}
