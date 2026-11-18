/** A claim to moderate a hashtag that waits (a row of `tag_claims`), with the username of who made it, as the routes read it (see claimItem). */
export interface Claim {
  tag: string;
  /** Who claims the hashtag. */
  user_id: string;
  username: string;
  /** When the claim was made. */
  created_at: number;
  /** Until when an admin or a server moderator can refuse it; the compactor grants it after. */
  review_until: number;
}

/** What `endClaim` did with a hashtag's claim. */
export interface EndedClaim {
  /** Whether there was a claim to end. */
  wasClaimed: boolean;
  /** Whose it was, for one that was there. */
  userId?: string;
  /** Whether it was refused, by an admin or a server moderator; false for one its own user withdrew. */
  refused: boolean;
}
