/** What a reindex did, or has done so far. */
export interface ReindexResult {
  /** The posts whose terms are now those of their meta file, whether or not they were already. */
  posts: number;
  /** The posts that have no meta file yet: the compactor writes their terms with it, when it applies them. */
  pending: number;
  /** The users whose folded name was not the one their username folds to, and is now. */
  usernames: number;
}
