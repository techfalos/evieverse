/**
 * A credit: the user a post, a repost or a comment is shown as being by, with their id and their
 * username. Made from a row of `users`, or read from Redis by PublisherStore, which gives an empty
 * username for a user it has no credit for; feed records, posts and comments show it.
 */
export interface Publisher {
  userId: string;
  username: string;
}
