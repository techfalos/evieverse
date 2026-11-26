/** What `claimTag` did with a user's claim to a hashtag. */
export interface Claimed {
  /** Since when the user moderates the hashtag: now, for a claim that was just made. */
  since: number;
  /** Whether they moderated it already, by a claim made before or by an appointment: nothing was changed, and nobody was told. */
  already: boolean;
}
