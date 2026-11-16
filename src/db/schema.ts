import type { Generated, Selectable } from 'kysely';

/**
 * All timestamps are UTC epoch milliseconds stored as BIGINT, which behaves identically across dialects.
 * The schema is defined by the portable SQL in ./migrations; keep these types in sync with it.
 */

/**
 * The server's users, one row per account: publishers and readers, each with their roles, their
 * settings, and whether they are banned or deleted. Every other table names a user by `id` alone.
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
   * The code of the language the server answers the user in (a file of the languages folder): the one they
   * registered in, or changed to since (PATCH /users/:userId). Null: the server's default.
   */
  language: string | null;
  /** 1 for a user who takes part in messages between users, else 0: theirs to turn off (PATCH /users/:userId). Notices reach them either way. */
  messages: Generated<number>;
  /**
   * 1 for a user who lets anyone list whom they follow, and read their following feed, which names them, else 0:
   * off until they turn it on (PATCH /users/:userId). They can always read both themselves.
   */
  show_following: Generated<number>;
  /** The same for the list of who follows them. */
  show_followers: Generated<number>;
  /**
   * When a server moderator or an admin banned the user (PUT /banned/:userId), or null. A banned user is refused
   * whatever writes a post, a comment or a message. Never set on an admin or a server moderator.
   */
  banned_at: number | null;
  /** Who banned them; null while they aren't banned, and once that user is gone. */
  banned_by: string | null;
  /** What the moderator said was the reason, if anything. Only moderators read it. */
  ban_reason: string | null;
  /**
   * When the account was deleted (DELETE /users/:userId), or null. The row stays until the compactor has deleted
   * the content of the user's that is set for deletion (see purgeAccounts): until then the account is gone as far as
   * anyone is concerned, and its username is still taken.
   */
  deleted_at: number | null;
}

/**
 * The API keys users were given (src/auth/apiKey.ts). A key is never stored: its row holds the
 * SHA-256 (hex) of it, which a request's key is looked up by. A key works until it is revoked,
 * which replacing it or deleting the account does. The row is kept: revoked, it is what says the
 * key was replaced (see ensureAdmin).
 */
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
  /**
   * Null for a post written here. On a repost of a post on another server, the SHA-256 (hex) of the
   * original's address: unique, so the server holds one entry per original.
   */
  origin_hash: string | null;
}

/**
 * A place a repost gave content: a hashtag the reposter added to it, or the reposter's own index
 * ("@<userId>"). There the content is placed as a new post, at the time of the repost, counting
 * the likes since. The content itself isn't copied.
 */
export interface RepostsTable {
  content_id: string;
  /** A hashtag the repost gave the content, or "@<userId>": the reposter's own index. */
  tag: string;
  /** Who reposted; null once that user is gone. */
  user_id: string | null;
  /** The content's like count when it was reposted: the entry counts the likes since. */
  likes_before: Generated<number>;
  /** When it was reposted, which is where its entry is placed. */
  created_at: number;
}

/**
 * The tags posts were published or reposted under: one row per hashtag, and per user's own index.
 * Which content carries a tag isn't here: that is in the content's meta file, and in the tag's
 * index. The rows are what /tags lists hashtags from, and how a compactor run asked to rebuild
 * every index (`--all`) finds them all.
 */
export interface TagsTable {
  /** A single hashtag word, e.g. "mumbai", or "@<userId>": a publisher's own index. */
  name: string;
  created_at: number;
  /** When a post was last published or updated under the tag, which /tags lists hashtags by. */
  last_appended_at: number;
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

/**
 * A user's like of a post: one row per user and post, as a like is given once and not taken back.
 * `content.like_count` is the running total, and `created_at` is how the compactor finds the
 * content liked since its last run. Likes of comments aren't here: they are in the content store.
 */
export interface LikesTable {
  user_id: string;
  content_id: string;
  created_at: number;
}

/** One row per user following another. Each side lists its follows to others only if its user says so (users.show_following, users.show_followers). */
export interface FollowsTable {
  follower_id: string;
  followee_id: string;
  created_at: number;
}

/**
 * The queue the feed index is written from: content whose entry in a tag's index the compactor
 * rebuilds, from the database and the meta file, on its next run. One row per content and tag, so
 * writes of the same content between two runs queue once.
 */
export interface FeedQueueTable {
  content_id: string;
  /** A hashtag the write gave the content, kept on it or dropped from it, or its publisher's own index. */
  tag: string;
  /** Names the write that stamped the row last. A run deletes only the rows that still hold the token it read. */
  token: string;
  /**
   * 1 once the write committed. 0 on the rows an update queues before it writes anything: a run
   * leaves those until they are COMPACT_GRACE_SECONDS old, when the update is taken to have stopped.
   */
  committed: number;
  /** When the row was stamped. */
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

/** A normalised word or phrase, or a pattern between slashes. Tag '*' is the server's list, which brings a post's trust score to 0; any other tag's list drops that tag. */
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
  /** Who decided; null once that user is gone, and on the removal of a repost's hashtag that an update of the content was refused. */
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
 * queue beside the posts of moderation_queue: a new one, or one whose author edited it. Comments
 * themselves are objects in the content store (CommentStore), and so are their likes: only the
 * comments that wait have a row.
 */
export interface CommentQueueTable {
  comment_id: string;
  /** The post the comment is on. */
  content_id: string;
  /** The trust score (0-100) of the comment, or of its last edit, which sent it here. Kept nowhere else. */
  trust_score: number;
  /** When the comment joined the queue: when it was written, or when the edit that sent it here was made. */
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

export type AdKind = 'text' | 'image';

/**
 * The ads the server shows, which its admins keep (/monetization/ads): in hashtag feeds and at the
 * end of posts, where the server turns each on. The compactor copies the ones that haven't ended
 * to Redis (AdStore), which is where they are shown from.
 */
export interface MonetizationTable {
  id: string;
  /** text: the ad is its text. image: an image, at ads/<id> in the content store, with an optional caption in `text`. */
  kind: AdKind;
  /** A text ad's text, or an image ad's caption; null for an image ad with none. */
  text: string | null;
  /** Where the ad leads when it is followed, if anywhere. Who is shown the ad gets the server's link to it, which counts the click (adClickUrl). */
  url: string | null;
  /** How many times the ad's link was followed: counted as it happens, and never taken off. */
  clicks: Generated<number>;
  /** The content type of an image ad's image, read from its bytes; null on a text ad. */
  image_type: string | null;
  /** Null: the ad appears all the time, under every hashtag. Otherwise the hashtags it is targeted at, separated by single spaces. */
  tags: string | null;
  /** The ad is shown from this instant... */
  starts_at: number;
  /** ...until this one; null for an ad with no end. */
  ends_at: number | null;
  /** The admin who created it; null once that user is gone. */
  created_by: string | null;
  created_at: number;
  /** When it was created or last changed. */
  updated_at: number;
}

/** One of the server's rules, which its admins keep and anyone reads (GET /rules). */
export interface ServerRulesTable {
  id: string;
  /** Where the rule comes among the others, lowest first. A response gives its place in the list instead, counted from 1. */
  sort_order: number;
  /** The rule's text. */
  body: string;
  created_at: number;
  /** When its text or its place was last changed by a request about it; created_at until then. */
  updated_at: number;
}

/** One row ('compactor'): which compactor run may publish heads and delete, and until when. */
export interface CompactorLeaseTable {
  id: string;
  /** Random id of the run holding the lease; null once released. */
  holder: string | null;
  expires_at: number;
}

/** The database's tables by name, each with the type of its rows: what Kysely checks every query against (`Db`). */
export interface Database {
  users: UsersTable;
  api_keys: ApiKeysTable;
  content: ContentTable;
  tags: TagsTable;
  tag_pairs: TagPairsTable;
  likes: LikesTable;
  follows: FollowsTable;
  feed_queue: FeedQueueTable;
  reposts: RepostsTable;
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
  server_rules: ServerRulesTable;
  monetization: MonetizationTable;
}

export type ContentRow = Selectable<ContentTable>;
export type RepostRow = Selectable<RepostsTable>;
export type MonetizationRow = Selectable<MonetizationTable>;
