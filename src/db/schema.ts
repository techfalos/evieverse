import type { ColumnType, Generated, Selectable } from 'kysely';

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
  /**
   * The username as a search compares it (GET /search): lowercase, without accents, cut to 255
   * characters (see foldUsername). Written with the username, by whatever writes that. Null only
   * on a row that something other than the server inserted, which no search finds.
   */
  username_folded: ColumnType<string | null, string, string | undefined>;
  created_at: number;
  /** When the user registered or last changed their username; the compactor re-syncs their credit in Redis. */
  updated_at: number;
  /** 1 for the server's admins, else 0: set by an admin (/admins), a deployment (BOOTSTRAP_ADMIN) or the operator (`npm run admin`). */
  admin: Generated<number>;
  /** 1 for the server's moderators, else 0: set by an admin (/moderators). They work through the moderation queue and the report queue, and moderate every hashtag: nothing else of an admin's. */
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
   * When a server moderator or an admin barred the user from claiming hashtags (PUT /claim-barred/:userId), or null.
   * It keeps them from claiming (POST /tags/:tag/claim), and from nothing else: the hashtags they moderate stay theirs.
   */
  claims_barred_at: number | null;
  /** Who barred them; null while they aren't barred. It has no foreign key, so it may name a user who is gone. */
  claims_barred_by: string | null;
  /** What the moderator said was the reason, if anything. Only moderators read it. */
  claims_bar_reason: string | null;
  /**
   * When the account was deleted (DELETE /users/:userId), or null. The row stays until the compactor has deleted
   * the content of the user's that is set for deletion (see purgeAccounts): until then the account is gone as far as
   * anyone is concerned, and its username is still taken.
   */
  deleted_at: number | null;
  /** What the user says of themselves on their profile (PATCH /users/:userId), as they wrote it; null for one who says nothing. */
  bio: string | null;
  /**
   * The addresses the user gives of where else they are found, in the order they gave them: a JSON
   * array of http and https URLs, read with `profileLinks` (src/profile.ts). Null for one who gives none.
   */
  links: string | null;
  /**
   * The id of the user's avatar (PUT /users/:userId/avatar), which names its file in the content
   * store: another image is another id. Null for a user who has none. The row of a closed
   * account is purged only once this is null again (see dropAvatars).
   */
  avatar_id: string | null;
  /** The content type of the user's avatar, which is the one every avatar is made as (AVATAR_TYPE in src/profile.ts); null with `avatar_id`. */
  avatar_type: string | null;
}

/**
 * The posts a user pinned to their profile (PUT /users/:userId/pinned/:contentId): one row for
 * each, of which a user has MAX_PINNED_POSTS at most (src/profile.ts). Each is one of the user's
 * own posts, and the row says nothing of whether it can be read: a post that is withheld, or set
 * for deletion, is pinned and not shown. The row goes with the post, and with the user's account.
 */
export interface PinnedPostsTable {
  user_id: string;
  content_id: string;
  /** When it was pinned. A profile gives the post pinned last first. */
  created_at: number;
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
  /** How many users like the content: its rows of `likes`, counted as they are added and taken away (POST and DELETE /like). */
  like_count: Generated<number>;
  /**
   * When a like of the content was last taken back (DELETE /like), or null if none ever was: how
   * a compactor run finds the content that lost a like since the last one, as the row of a like
   * that was taken back is gone (see `likes`).
   */
  unliked_at: Generated<number | null>;
  created_at: number;
  /** Set by DELETE /content/:id; the compactor removes the content from the feed index, then deletes it. */
  delete_requested_at: number | null;
  /**
   * Null for a post written here. On a repost of a post on another server, the SHA-256 (hex) of the
   * original's address: unique, so the server holds one entry per original.
   */
  origin_hash: string | null;
  /**
   * On a repost of a post on another server: when that server was first found to publish no post
   * at the original's address, or null while it publishes one as far as this server knows. The
   * entry is hidden while it is set, as content that waits in the moderation queue is (see
   * `withheld`), a later attestation of the post sets it back to null, and the compactor sets the
   * entry for deletion once it is REPOSTS_GONE_DAYS old. Null on a post written here.
   */
  origin_gone_at: Generated<number | null>;
  /**
   * On a repost of a post on another server: from when the server asks the original's server for
   * the post's attestation again (compactor/src/sweep.rs). Null on a post written here.
   */
  origin_check_at: Generated<number | null>;
  /**
   * The number of the post's last numbered write: a write of the post, an edit or a removal of a
   * comment on it, or a moderator's decision on one adds one with the row locked, and takes the
   * number for its row in `pending_writes` (see nextSeq). A new comment, and a like of one or its
   * taking back, take none.
   */
  seq: Generated<number>;
}

/**
 * What a row of `pending_writes` is: a post's write, the file of one more image of that write
 * (an image post of several images), or a comment's (as it now is, removed, or liked: a
 * `comment_like` row is a user's like of the comment, or the taking back of it).
 */
export type PendingKind = 'post' | 'post_file' | 'comment_put' | 'comment_remove' | 'comment_like';

/**
 * A write that committed and that the compactor hasn't applied yet: requests write nothing of a
 * post or a comment to the stores themselves. A run applies a post's rows in the order of `seq`,
 * and deletes each as it does (compactor/src/apply.rs).
 */
export interface PendingWritesTable {
  content_id: string;
  /** The write's number among the post's (see `content.seq`); 0 for a write that took none: a new comment, a like of one or its taking back. */
  seq: number;
  /**
   * What tells a post's writes that took no number apart, and makes a second one of the same fail:
   * the comment's id for a new comment, `<commentId>:<userId>` for a like, which is one row
   * whether the user last liked the comment or took the like back. '' on a numbered write,
   * but for a `post_file` row, which has its post write's number: there it is the image's place
   * among the post's images, counted from 1 ('2' for the second, which is the first to have a row).
   */
  write_key: Generated<string>;
  kind: PendingKind;
  /** The comment a comment's write is of; null on a post's. */
  comment_id: string | null;
  /**
   * What the write says, as JSON (see PendingPayload). Written as a string; PostgreSQL and MySQL
   * give it back parsed, and SQLite as the string, so it is read with `payloadOf`.
   */
  payload: ColumnType<unknown, string | null, string | null>;
  /**
   * The object under staged/ that holds the file the write came with, which the request wrote
   * once; null on a write with none. A post's row names its file, which for an image post of
   * several images is the first: each of the others is named by a `post_file` row of its own.
   */
  staged_key: string | null;
  /**
   * On a `comment_like` row: what it adds to the number of likes the content store has of the
   * comment, for whoever counts the two together (see pendingLikes). 1 for a like the store
   * doesn't have, -1 for the taking back of one it has, 0 for a row that leaves the store as it
   * is. Null on every other kind, and on a like committed by a server from before likes could be
   * taken back, which counts as 1.
   */
  net: Generated<number | null>;
  /** When the write was made. */
  created_at: number;
}

/**
 * A video that is yet to be processed: the one a write of a post, or a new comment, came with
 * (compactor/src/video). The write's commit adds the row, and the video worker deletes it in the commit
 * that puts the processed file in the write's row of `pending_writes`. Until then the write
 * says in its payload that it waits (`process`), and the compactor leaves it.
 */
export interface MediaJobsTable {
  /** The job; for a post's video, also the id of the version of the video it makes (see StoredVideo.id). */
  id: string;
  /** The post the write is of, or is a comment on. */
  content_id: string;
  /** With `write_key`: the row of `pending_writes` that names the staged file. */
  seq: number;
  write_key: Generated<string>;
  /** The comment the video came with; null on a post's. */
  comment_id: string | null;
  /** How many times a worker took the job: one taken more often than a video is tried is given up. */
  attempts: Generated<number>;
  /** Until when the worker that took the job has it; 0 on one nobody took. */
  claimed_until: Generated<number>;
  /** When the write was made. */
  created_at: number;
  /** The address the write's request came from, kept for the notice of a video that matches the pdq plugin's list; null where the server checks no videos. */
  client_ip: string | null;
  /** That request's User-Agent header, cut short; null likewise, and for a request that sent none. */
  client_user_agent: string | null;
}

/**
 * A file that matched the pdq trust plugin's list and is kept in the quarantine (src/quarantine.ts):
 * the object `files/<id>` of the quarantine's store.
 */
export interface QuarantineTable {
  id: string;
  /** Who sent the file. No foreign key: the row outlasts their account. */
  user_id: string;
  /** The SHA-256 of the file as it is kept; with `user_id`, the item. */
  sha256: string;
  /** What the file was sent as. */
  mime_type: string;
  size: number;
  /** What the admins were told of the match when the file was first kept, as JSON (MatchFacts). */
  facts: string;
  /** How many times the file matched: one more each time its user sent it again. */
  matches: Generated<number>;
  created_at: number;
  last_matched_at: number;
  /** When the report of it was made, as the admin who recorded it said; null until one is recorded. The file is deleted `quarantine.retentionDays` after this. */
  reported_at: number | null;
  /** The admin who recorded the report. */
  reported_by: string | null;
  /** What the authority calls the report, if the admin gave it. */
  report_id: string | null;
}

/** What was done with an item of the quarantine, and by whom: a row for each time, written before it is done, which outlasts the item. */
export interface QuarantineAccessTable {
  id: string;
  quarantine_id: string;
  /** stored, downloaded, reported, dismissed or expired (see QuarantineAction). */
  action: string;
  /** The admin; null where the server did it itself. */
  user_id: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: number;
}

/**
 * A staged file the compactor has applied and has yet to delete: it stays until the links that
 * were given to it have expired (compactor/src/apply.rs). Only where the content store signs links.
 */
export interface StagedRemovalsTable {
  /** The object under staged/, as the write's row named it. */
  staged_key: string;
  /** The post the write was of, or was a comment on: the run that deletes the post deletes the file with it. */
  content_id: string;
  /** From when the compactor can delete it. */
  remove_at: number;
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
  /**
   * The content's like count when it was reposted: the entry counts the likes since. One less
   * for each like from before the repost that was taken back since, so the entry's count doesn't
   * lose a like that wasn't its own.
   */
  likes_before: Generated<number>;
  /** When it was reposted, which is where its entry is placed. */
  created_at: number;
}

/**
 * A place of a repost that an admin or a server moderator removed, which the compactor is yet
 * to take away: the removal deleted the repost's rows of `reposts`, and left one of these for
 * each, which says where the content's entry is, and which hashtag comes off the content (see
 * contentWriter's unrepost). The run that has taken the place away deletes the row.
 */
export interface RepostRemovalsTable {
  /** Names the row: a place can be removed, given again and removed again before a run comes by. */
  id: string;
  content_id: string;
  /** The index the repost placed the content in: a hashtag it gave it, or "@<userId>", the reposter's own index. */
  tag: string;
  /** When the repost was made (`reposts.created_at`): the day its entry is in, and the day the summary has a copy under. */
  reposted_at: number;
  /** When it was removed. */
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
 * A user's like of a post: one row per user and post, as a like is given once. Taking it back
 * (DELETE /like) deletes the row. `content.like_count` is the running total, and `created_at` is
 * how the compactor finds the content liked since its last run; what lost a like since, it finds
 * by `content.unliked_at`. Likes of comments aren't here: they are in the content store.
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
 * writes of the same content between two runs queue once. Every row is a committed write's.
 */
export interface FeedQueueTable {
  content_id: string;
  /** A hashtag the write gave the content, kept on it or dropped from it, or its publisher's own index. */
  tag: string;
  /** Names the write that stamped the row last. A run deletes only the rows that still hold the token it read. */
  token: string;
  /** When the row was stamped. */
  created_at: number;
}

/** Who moderates which hashtag: the users an admin or one of the hashtag's moderators appointed, and those who claimed the hashtag (src/moderation/claims.ts). Admins and server moderators moderate every hashtag without a row. */
export interface TagModeratorsTable {
  tag: string;
  user_id: string;
  created_at: number;
  /**
   * 1 on the row of a moderator who claimed the hashtag, null on one who was appointed. A unique
   * index on it and the hashtag gives a hashtag one of them: of two claims made at once, the
   * second to commit is refused.
   */
  claimed: number | null;
  /**
   * When the moderator last did something as one on the hashtag (see recordAction), and when they
   * became its moderator until they have: one who did nothing since for
   * `tagging.moderatorInactiveDays` is one no more (src/moderation/activity.ts). Null on a row
   * from before the server kept it, until the compactor's next run sets it to its own time.
   */
  acted_at: number | null;
}

/** One of a hashtag's rules, which its moderators keep and anyone reads (GET /tags/:tag/rules): to a hashtag what ServerRulesTable is to the server. */
export interface TagRulesTable {
  id: string;
  /** The hashtag the rule is one of. */
  tag: string;
  /** Where the rule comes among the hashtag's others, lowest first. A response gives its place in the list instead, counted from 1. */
  sort_order: number;
  /** The rule's text. */
  body: string;
  created_at: number;
  /** When its text or its place was last changed by a request about it; created_at until then. */
  updated_at: number;
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

/** As what a moderator decided about content under a hashtag: the role that let them, as it was then. */
export type ModeratorRole = 'tag_moderator' | 'server_moderator' | 'admin';

/**
 * What moderators did to a post under a hashtag, one row for each time: the post's own record of
 * it, which GET /content/:contentId gives with the post, and GET /tags/:tag/log with the
 * hashtag's others. `tag_moderation` holds what stands now; these rows are never changed, and go
 * with the post.
 */
export interface TagModerationLogTable {
  id: string;
  content_id: string;
  tag: string;
  /** approved: the post was approved under the hashtag. removed: the hashtag was taken off the post. */
  decision: TagDecision;
  /** Who did it, which a response gives only to who moderates the hashtag (see moderates); null once that user is gone. */
  moderator_id: string | null;
  /** As what they did it, which is all a response says of them to anyone else. */
  moderator_role: ModeratorRole;
  /** Why, as the moderator said it, for a removal that came with a reason; null otherwise. */
  reason: string | null;
  /** When it was done. */
  created_at: number;
}

/** What a user has been sent: a message another user wrote them, or a notice of the server's (src/inbox.ts). */
export interface InboxTable {
  id: string;
  /** Whose inbox the row is in. */
  user_id: string;
  /** 'message', or a notice's kind: what happened (post_rejected, tag_removed, tag_muted, ...). */
  kind: string;
  /** Who wrote a message, or the post or comment that a notice of a mention is about; null on any other notice, and once that user is gone. */
  sender_id: string | null;
  /** The content a notice is about, which may be gone by the time it is read. */
  content_id: string | null;
  /** The comment a notice of a mention is about, on the post `content_id` names; null on anything else. */
  comment_id: string | null;
  /** The hashtag a notice is about. */
  tag: string | null;
  /** A message's text; on a notice about content, the start of the post; on a notice with facts of its own, those as JSON (`DETAILED` in src/inbox.ts). */
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
  /** The alternative text of an image ad's image, which describes it to those who can't see it; null on a text ad, and on an image ad with none. */
  image_alt: string | null;
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

/**
 * The words a post is found by (GET /search): one row per word and post, of the most frequent
 * words of its text or caption and of every one of its hashtags (src/search/keywords.ts). The
 * compactor writes them whenever it writes the post's meta file, which they are worked out from.
 * A post that is withheld from readers keeps its rows: a search leaves it out by its own row.
 */
export interface SearchTermsTable {
  /** The word or the hashtag, lowercase and without accents. */
  term: string;
  content_id: string;
  /** When the post was created (`content.created_at`): what the posts with a word are ordered by. */
  created_at: number;
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
  pending_writes: PendingWritesTable;
  media_jobs: MediaJobsTable;
  quarantine: QuarantineTable;
  quarantine_access: QuarantineAccessTable;
  staged_removals: StagedRemovalsTable;
  reposts: RepostsTable;
  repost_removals: RepostRemovalsTable;
  compactor_lease: CompactorLeaseTable;
  tag_moderators: TagModeratorsTable;
  tag_rules: TagRulesTable;
  tag_mutes: TagMutesTable;
  blocked_words: BlockedWordsTable;
  moderation_queue: ModerationQueueTable;
  tag_moderation: TagModerationTable;
  tag_moderation_log: TagModerationLogTable;
  reports: ReportsTable;
  comment_queue: CommentQueueTable;
  comment_reports: CommentReportsTable;
  inbox: InboxTable;
  user_blocks: UserBlocksTable;
  pinned_posts: PinnedPostsTable;
  server_rules: ServerRulesTable;
  monetization: MonetizationTable;
  search_terms: SearchTermsTable;
}

export type ContentRow = Selectable<ContentTable>;
export type RepostRow = Selectable<RepostsTable>;
export type MonetizationRow = Selectable<MonetizationTable>;
