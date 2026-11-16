import type { Config } from '../config.js';
import type { AdStore, PublisherStore, RelatedTagStore, SummaryStore } from '../storage/index.js';
import type { TagFeedReader } from '../tagfeed/reader.js';

/** Only the feed index, summaries, publisher credits, related hashtags and ads are passed in: hashtag feeds never touch the database. */
export interface FeedDeps {
  config: Config;
  feedReader: TagFeedReader;
  summaries: SummaryStore;
  publishers: PublisherStore;
  relatedTags: RelatedTagStore;
  ads: AdStore;
  now?: () => number;
}
