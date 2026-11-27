import type { Config } from '../config.js';
import type { AdStore, CommentStore, PublisherStore, RelatedTagStore, SummaryStore } from '../storage/index.js';
import type { TagFeedReader } from '../tagfeed/reader.js';

/** Only the feed index, summaries, publisher credits, the comment store (for how many comments each post has), related hashtags and ads are passed in: hashtag feeds never touch the database. */
export interface FeedDeps {
  config: Config;
  feedReader: TagFeedReader;
  /** Reads publishers' own indexes, which an engaged feed reads to learn which posts are by the users its reader has liked and viewed. */
  authorReader: TagFeedReader;
  summaries: SummaryStore;
  publishers: PublisherStore;
  /** Read for how many comments each of a page's posts has (see CommentStore.liveCounts), and nothing else. */
  comments: CommentStore;
  relatedTags: RelatedTagStore;
  ads: AdStore;
  now?: () => number;
}
