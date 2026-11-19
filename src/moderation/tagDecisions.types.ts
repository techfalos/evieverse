import type { ModeratorRole, TagDecision } from '../db/schema.js';

/** Who decides about content under a hashtag, as the route that checked they may gives them to `approveTag` and `removeTag`. */
export interface Moderator {
  id: string;
  /** As what they decide (see moderatorRole), which the post's record of the decision keeps. */
  role: ModeratorRole;
}

/** What `removeTag` returns of the content it removed a hashtag from: what the route needs to tell its publisher of the removal. */
export interface Removal {
  /** The content's publisher. */
  userId: string;
  /** The hashtags the content is left with: none, if this was its last. */
  tags: string[];
}

/** A row of a post's record of what moderators did to it (`tag_moderation_log`), as `tagActions` reads it and `tagActionItem` gives it. */
export interface TagAction {
  tag: string;
  decision: TagDecision;
  /** As what the moderator did it. */
  moderator_role: ModeratorRole;
  /** Who did it, which only who moderates the hashtag is told (see tagActionItem). Null once their account is deleted. */
  moderator_id: string | null;
  /** Their username, and null, as `moderator_id` is. */
  moderator_username: string | null;
  /** Why, for a removal that came with a reason. */
  reason: string | null;
  created_at: number;
}

/** A row of a hashtag's log, as `tagLog` reads it and `tagLogItem` gives it: a row of a post's record, with the post it is of. */
export interface TagLogEntry extends TagAction {
  /** The row's own id, which tells two rows of one instant apart in a page's cursor. */
  id: string;
  content_id: string;
  /** The post's publisher. */
  publisher_id: string;
  publisher_username: string;
}
