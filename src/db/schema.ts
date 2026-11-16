import type { Generated, Selectable } from 'kysely';

/**
 * All timestamps are UTC epoch milliseconds stored as BIGINT, which behaves identically across dialects.
 * The schema is defined by the portable SQL in ./migrations; keep these types in sync with it.
 */

export interface UsersTable {
  /** UUID; the only user identifier used in relations and lookups. */
  id: string;
  /** Unique display name; never used as a key. */
  username: string;
  created_at: number;
  /** When the user registered or last changed their username; the compactor re-syncs their credit in Redis. */
  updated_at: number;
  /** 1 for the server's admins, else 0: set by an admin (/admins), a deployment (BOOTSTRAP_ADMIN) or the operator (`npm run admin`). */
  admin: Generated<number>;
  /** 1 for the server's moderators, else 0: set by an admin (/moderators). They work through the moderation queue and the report queue, and nothing else of an admin's. */
  moderator: Generated<number>;
  /**
   * The code of the language the server answers the user in (a file of src/languages): the one they
   * registered in, or changed to since (PATCH /users/:userId). Null: the server's default.
   */
  language: string | null;
  /** 1 for a user who takes part in messages between users, else 0: theirs to turn off (PATCH /users/:userId). Notices reach them either way. */
  messages: Generated<number>;
}

export interface ApiKeysTable {
  id: string;
  user_id: string;
  key_hash: string;
  created_at: number;
  revoked_at: number | null;
}

/** What describes the bytes (content type, size, text, hashtags, last write) is in the meta file at content/<id>.meta.json. */
export interface ContentTable {
  id: string;
  user_id: string;
  /** 1 if the publisher declared the content created with AI, else 0. */
  ai_generated: Generated<number>;
  like_count: Generated<number>;
  created_at: number;
  /** Set by DELETE /content/:id; the compactor removes the content from the feed index, then deletes it. */
  delete_requested_at: number | null;
}

export interface TagsTable {
  /** A single hashtag word, e.g. "mumbai", or "@<userId>": a publisher's own index. */
  name: string;
  created_at: number;
  last_appended_at: number;
  /** Tail windows starting before this time have been merged into the tag's day indexes. */
  compacted_at: Generated<number>;
}

/**
 * How many posts carry two hashtags together (tag_a < tag_b), or carry one hashtag (tag_a = tag_b).
 * Counted as posts are written, and never taken off; the compactor works out related hashtags from it.
 */
export interface TagPairsTable {
  tag_a: string;
  /** The other hashtag of the pair, or tag_a again on the row that counts tag_a's own posts. */
  tag_b: string;
  posts: Generated<number>;
  /** When the row was last counted on, which tells the compactor whose related hashtags to work out again. */
  updated_at: number;
}

export interface LikesTable {
  user_id: string;
  content_id: string;
  created_at: number;
}

/** One row per user following another. Follows are public, like posts. */
export interface FollowsTable {
  follower_id: string;
  followee_id: string;
  created_at: number;
}

/** A tag whose tail may not hold a committed write's line for the content; the compactor rebuilds the entry of stale ones. */
export interface PendingAppendsTable {
  content_id: string;
  /** A hashtag the write gave the content or dropped from it, or its publisher's own index. */
  tag: string;
  /** When the write that left the row was made; a later write to the same tag re-stamps it. */
  created_at: number;
}

/** Who moderates which hashtag. Admins moderate every hashtag without a row. */
export interface TagModeratorsTable {
  tag: string;
  user_id: string;
  created_at: number;
}

/** A user muted on a hashtag: their new posts and updates don't get it. */
export interface TagMutesTable {
  user_id: string;
  tag: string;
  created_at: number;
}

/** A normalised word or phrase. Tag '*' is the server's list, which brings a post's trust score to 0; any other tag's list drops that tag. */
export interface BlockedWordsTable {
  tag: string;
  word: string;
  created_at: number;
}

/** Content that waits for a server moderator or an admin to accept or reject it: stored, but in no feed index. */
export interface ModerationQueueTable {
  content_id: string;
  /** The trust score (0-100) of the content's last write, which sent it here. Kept nowhere else. */
  trust_score: number;
  /** When the content joined the queue. */
  created_at: number;
}

export type TagDecision = 'approved' | 'removed';

/** What a hashtag's moderators decided about a piece of content under it; no row until they have. */
export interface TagModerationTable {
  content_id: string;
  tag: string;
  /** approved: the content is flagged as moderated in the hashtag's index. removed: the hashtag is taken off the content, for good. */
  decision: TagDecision;
  /** Who decided; null once that user is gone. */
  moderator_id: string | null;
  decided_at: number;
  /** When a compactor run applied the decision to the content and the hashtag's index; null until one has. */
  applied_at: number | null;
}

/** What a user has been sent: a message another user wrote them, or a notice of the server's (src/inbox.ts). */
export interface InboxTable {
  id: string;
  /** Whose inbox the row is in. */
  user_id: string;
  /** 'message', or a notice's kind: what happened (post_rejected, tag_removed, tag_muted, ...). */
  kind: string;
  /** Who wrote a message; null on a notice, and once that user is gone. */
  sender_id: string | null;
  /** The content a notice is about, which may be gone by the time it is read. */
  content_id: string | null;
  /** The hashtag a notice is about. */
  tag: string | null;
  /** A message's text; on a notice about content, the start of the post. */
  body: string | null;
  created_at: number;
  /** When its owner marked it as read; null until then. */
  read_at: number | null;
}

/** A user who blocks another: no message goes between the two, either way. */
export interface UserBlocksTable {
  user_id: string;
  blocked_id: string;
  created_at: number;
}

/**
 * A user's report of a piece of content to the server's moderators. The content with a report nobody
 * has decided on is the report queue, which server moderators and admins work through.
 */
export interface ReportsTable {
  content_id: string;
  /** Who reported it. Each user reports a piece of content once. */
  user_id: string;
  /** What they said is wrong with it, if anything. */
  reason: string | null;
  created_at: number;
  /** When the content was accepted in spite of the report; null while it waits. */
  accepted_at: number | null;
}

/**
 * A comment that waits for a server moderator or an admin to accept or reject it, in the moderation
 * queue beside the posts of moderation_queue. Comments themselves are objects in the content store
 * (CommentStore): only the ones that wait have a row.
 */
export interface CommentQueueTable {
  comment_id: string;
  /** The post the comment is on. */
  content_id: string;
  /** The comment's trust score (0-100), which sent it here. Kept nowhere else. */
  trust_score: number;
  /** When the comment was written, and so joined the queue. */
  created_at: number;
}

/**
 * A user's report of a comment to the server's moderators: to comments what ReportsTable is to
 * posts. The comments with a report nobody has decided on are in the report queue, among the posts.
 */
export interface CommentReportsTable {
  comment_id: string;
  /** Who reported it. Each user reports a comment once. */
  user_id: string;
  /** The post the comment is on. */
  content_id: string;
  /** What they said is wrong with it, if anything. */
  reason: string | null;
  created_at: number;
  /** When the comment was accepted in spite of the report; null while it waits. */
  accepted_at: number | null;
}

/** One row ('compactor'): which compactor run may publish heads and delete, and until when. */
export interface CompactorLeaseTable {
  id: string;
  /** Random id of the run holding the lease; null once released. */
  holder: string | null;
  expires_at: number;
}

export interface Database {
  users: UsersTable;
  api_keys: ApiKeysTable;
  content: ContentTable;
  tags: TagsTable;
  tag_pairs: TagPairsTable;
  likes: LikesTable;
  follows: FollowsTable;
  pending_appends: PendingAppendsTable;
  compactor_lease: CompactorLeaseTable;
  tag_moderators: TagModeratorsTable;
  tag_mutes: TagMutesTable;
  blocked_words: BlockedWordsTable;
  moderation_queue: ModerationQueueTable;
  tag_moderation: TagModerationTable;
  reports: ReportsTable;
  comment_queue: CommentQueueTable;
  comment_reports: CommentReportsTable;
  inbox: InboxTable;
  user_blocks: UserBlocksTable;
}

export type ContentRow = Selectable<ContentTable>;
