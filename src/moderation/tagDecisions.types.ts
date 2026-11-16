/** What `removeTag` returns of the content it removed a hashtag from: what the route needs to tell its publisher of the removal. */
export interface Removal {
  /** The content's publisher. */
  userId: string;
  /** The hashtags the content is left with: none, if this was its last. */
  tags: string[];
}
