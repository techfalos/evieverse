-- 0001_initial
--
-- Portable schema for PostgreSQL, MySQL 8+ (InnoDB, utf8mb4 defaults) and SQLite 3.
-- Constraints are declared at table level because MySQL ignores inline column REFERENCES.
--
-- Conventions:
--   * Every id is a UUID string; users are only ever referenced by users.id, never by username.
--   * Every *_at column is UTC epoch milliseconds (BIGINT).
--   * Content bytes live in the content store at content/<id>, beside a meta file; summaries live in
--     the summary store, and the feed index in Redis. The feed never reads this database.

-- Publishers and readers. Relations always use id; username is unique but used only for display.
-- updated_at: when the user registered or last changed their username, which tells the compactor to
-- rewrite their publisher credit in Redis. What a user posted lately, which the post challenges and
-- the limit on posts a minute go by, is kept in Redis, not here.
--
-- admin: 1 for the server's admins. Admins set it for each other (/admins), a deployment for its
-- first one (BOOTSTRAP_ADMIN), and the operator with `npm run admin`. An admin can delete any
-- content, appoint server moderators, tag moderators and admins, and keep the server's blocked
-- words, and can do whatever a server moderator can, and whatever a tag moderator can on every
-- hashtag.
--
-- moderator: 1 for the server's moderators, whom admins appoint (/moderators). A server moderator
-- works through the moderation queue (see moderation_queue): reads it and the content that waits in
-- it, and accepts or rejects that content. And through the report queue (see reports): accepts or
-- deletes the content users reported. Nothing else an admin can do comes with it. The two roles
-- are set apart: an admin needs no 1 here, and losing the admin role leaves this as it is.
--
-- language: the code of the language the server answers the user in, which is the name of a file
-- of src/languages (en, pt-BR). The user registers in it, and can change it (PATCH /users/:userId).
-- NULL for an account the operator set up, which is answered in the server's default language
-- (DEFAULT_LANGUAGE), as is a user whose language the server no longer has a file for.
--
-- messages: 1 for a user who takes part in messages between users, which is every user until they
-- turn it off (PATCH /users/:userId): 0 for one who is sent none, and sends none. The server's
-- notices reach their inbox either way (see inbox).
--
-- show_following, show_followers: 1 for a user who lets anyone list whom they follow, or who
-- follows them (GET /users/:userId/following, /followers). Both are 0 until the user turns them on
-- (PATCH /users/:userId), each on its own: a list that isn't shown is its user's alone to read.
-- show_following covers the user's following feed too (GET /feed/following), which names whom
-- they follow.
--
-- banned_at: when a server moderator or an admin banned the user (PUT /banned/:userId); NULL for a
-- user who isn't banned. A banned user keeps their account and their key, and can read, but is
-- refused whatever writes a post, a comment or a message: /store, comments, /messages and /uploads.
-- Nobody who is an admin or a server moderator is banned. banned_by is who banned them (NULL once
-- that user is gone), and ban_reason what they said, if anything: only moderators read either.
--
-- deleted_at: when the account was deleted (DELETE /users/:userId); NULL for one that wasn't. The
-- row is not deleted with it, since content references it and cascades: the account's keys are
-- revoked, its relations to other users go, and its content is set for deletion (see content), which
-- the compactor completes. It then deletes the row, once no content of the user's is left. Until
-- then the account is gone as far as anyone is concerned (it can't sign in, and no lookup finds it),
-- but its username stays taken. An account with no content is deleted at once, with no stage in between.
CREATE TABLE users (
  id              varchar(36)  NOT NULL,
  username        varchar(64)  NOT NULL,
  created_at      bigint       NOT NULL,
  updated_at      bigint       NOT NULL,
  admin           smallint     NOT NULL DEFAULT 0,
  moderator       smallint     NOT NULL DEFAULT 0,
  language        varchar(35),
  messages        smallint     NOT NULL DEFAULT 1,
  show_following  smallint     NOT NULL DEFAULT 0,
  show_followers  smallint     NOT NULL DEFAULT 0,
  banned_at       bigint,
  banned_by       varchar(36),
  ban_reason      varchar(500),
  deleted_at      bigint,
  CONSTRAINT users_pk PRIMARY KEY (id),
  CONSTRAINT users_username_uq UNIQUE (username),
  CONSTRAINT users_banned_by_fk FOREIGN KEY (banned_by) REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX users_updated_idx ON users (updated_at);
CREATE INDEX users_banned_idx ON users (banned_at);
CREATE INDEX users_deleted_idx ON users (deleted_at);

-- API keys are stored as sha256 hashes, and looked up by them.
CREATE TABLE api_keys (
  id          varchar(36)  NOT NULL,
  user_id     varchar(36)  NOT NULL,
  key_hash    varchar(128) NOT NULL,
  created_at  bigint       NOT NULL,
  revoked_at  bigint,
  CONSTRAINT api_keys_pk PRIMARY KEY (id),
  CONSTRAINT api_keys_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX api_keys_user_hash_idx ON api_keys (user_id, key_hash);

-- One row per piece of content. Its bytes are at content/<id> in the content store. The meta file
-- beside them holds what describes them (content type, size, text, hashtags, and when they were last
-- written), so none of that is kept here. Content has one version: an update overwrites the bytes and
-- the meta file, and the last write wins.
--
-- ai_generated: whether the publisher declared the content as created with AI: 1 if so, else 0. /store
-- sets it on every write, and an update that doesn't say keeps the value. The flag also goes into the
-- meta file, the summary and the feed index entries, which is where feeds read and filter it from.
--
-- delete_requested_at: DELETE /content/:id only sets it. The content stays in the database and in the
-- feed index until a compactor run removes its entries from every hashtag's day indexes. That run then
-- deletes the row (the rows referencing it cascade) and the bytes, so the feed never shows content
-- the database no longer has. Once set, updates and likes are refused.
CREATE TABLE content (
  id                   varchar(36)  NOT NULL,
  user_id              varchar(36)  NOT NULL,
  ai_generated         smallint     NOT NULL DEFAULT 0,
  like_count           integer      NOT NULL DEFAULT 0,
  created_at           bigint       NOT NULL,
  delete_requested_at  bigint,
  CONSTRAINT content_pk PRIMARY KEY (id),
  CONSTRAINT content_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX content_user_idx ON content (user_id);
CREATE INDEX content_delete_requested_idx ON content (delete_requested_at);

-- Flat hashtags, and each publisher's own index ("@<userId>"). Which content carries a tag is recorded
-- only in the content's meta file and in the tag's index in Redis. last_appended_at is when a post
-- was last published or updated under the tag, which /tags lists hashtags by; the rows are also how
-- a compactor run asked to rebuild every index finds them all.
CREATE TABLE tags (
  name              varchar(64) NOT NULL,
  created_at        bigint      NOT NULL,
  last_appended_at  bigint      NOT NULL,
  CONSTRAINT tags_pk PRIMARY KEY (name)
);
CREATE INDEX tags_last_appended_idx ON tags (last_appended_at);

-- How often hashtags are on the same post, which is what makes two of them related: a feed asked for
-- one hashtag can add the posts of those that tend to come with it (addRelated). /store adds one to
-- a row for every pair of hashtags a post has (tag_a < tag_b), and to one row per hashtag
-- (tag_a = tag_b), which counts the posts that carry it and so says what share of them a pair is. A
-- new post counts all of its hashtags, and an update the ones it adds. Counts only go up: they
-- build up as posts are written, and nothing is taken off for a post that is deleted, or that
-- loses a hashtag.
--
-- Feeds never read this table. The compactor works out each hashtag's related hashtags from it and
-- keeps them in Redis, for the hashtags whose rows changed since its last run, which updated_at
-- and its index find.
CREATE TABLE tag_pairs (
  tag_a       varchar(64) NOT NULL,
  tag_b       varchar(64) NOT NULL,
  posts       integer     NOT NULL DEFAULT 0,
  updated_at  bigint      NOT NULL,
  CONSTRAINT tag_pairs_pk PRIMARY KEY (tag_a, tag_b)
);
CREATE INDEX tag_pairs_b_idx ON tag_pairs (tag_b);
CREATE INDEX tag_pairs_updated_idx ON tag_pairs (updated_at);

-- One permanent like per user per content item; content.like_count is the running total.
CREATE TABLE likes (
  user_id     varchar(36) NOT NULL,
  content_id  varchar(36) NOT NULL,
  created_at  bigint      NOT NULL,
  CONSTRAINT likes_pk PRIMARY KEY (user_id, content_id),
  CONSTRAINT likes_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT likes_content_fk FOREIGN KEY (content_id) REFERENCES content (id) ON DELETE CASCADE
);
CREATE INDEX likes_content_idx ON likes (content_id);
CREATE INDEX likes_created_idx ON likes (created_at);

-- Who follows whom. Following feeds show the posts of the users someone follows, read from each
-- publisher's own index in Redis, and the follows themselves are copied to Redis too, so those feeds
-- never read this table. The compactor rewrites the Redis copy for users who followed someone since
-- its last run, which it finds by created_at. The lists of a user's follows, and of who follows
-- them (by follows_followee_idx), are read from here: each is shown to others only if its user
-- says so (users.show_following, users.show_followers).
CREATE TABLE follows (
  follower_id  varchar(36) NOT NULL,
  followee_id  varchar(36) NOT NULL,
  created_at   bigint      NOT NULL,
  CONSTRAINT follows_pk PRIMARY KEY (follower_id, followee_id),
  CONSTRAINT follows_follower_fk FOREIGN KEY (follower_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT follows_followee_fk FOREIGN KEY (followee_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX follows_followee_idx ON follows (followee_id, created_at);
CREATE INDEX follows_created_idx ON follows (created_at);

-- The queue the feed index is written from: a piece of content, and a hashtag's index (or its
-- publisher's own) that a write changed its place in, by giving it the hashtag, updating it there or
-- dropping it. It is the only way into the index. /store inserts the rows in the transaction that
-- commits the write, and each compactor run takes every row there is: it rebuilds the content's
-- entry in that index from the database and the meta file, which drops it where the content no
-- longer carries the hashtag, and then deletes the row.
--
-- One row per content and hashtag, so writes of the same content between two runs queue once. A
-- later write stamps the row again with its own token, and a run deletes only the rows that still
-- hold the token it read: a write that commits while a run is under way is the next run's.
--
-- An update also queues its rows before it writes anything, uncommitted (committed = 0), in case it
-- stops half way with the stores already changed. Its commit stamps them as committed. A run leaves
-- an uncommitted row alone until it is COMPACT_GRACE_SECONDS old, which is when the update is taken
-- to have stopped.
CREATE TABLE feed_queue (
  content_id  varchar(36) NOT NULL,
  tag         varchar(64) NOT NULL,
  token       varchar(36) NOT NULL,
  committed   smallint    NOT NULL,
  created_at  bigint      NOT NULL,
  CONSTRAINT feed_queue_pk PRIMARY KEY (content_id, tag),
  CONSTRAINT feed_queue_content_fk FOREIGN KEY (content_id) REFERENCES content (id) ON DELETE CASCADE
);
CREATE INDEX feed_queue_token_idx ON feed_queue (token);

-- Moderation is decided when content is written, and what moderators decide afterwards is copied into
-- the feed index, so feeds never read the next six tables.
--
-- tag_moderators: who moderates which hashtag. A moderator can approve content under the hashtag or
-- remove the hashtag from it, mute users on it and keep its blocked words.
CREATE TABLE tag_moderators (
  tag         varchar(64) NOT NULL,
  user_id     varchar(36) NOT NULL,
  created_at  bigint      NOT NULL,
  CONSTRAINT tag_moderators_pk PRIMARY KEY (tag, user_id),
  CONSTRAINT tag_moderators_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX tag_moderators_user_idx ON tag_moderators (user_id);

-- tag_mutes: users muted on a hashtag. Their new posts and updates don't get it.
CREATE TABLE tag_mutes (
  user_id     varchar(36) NOT NULL,
  tag         varchar(64) NOT NULL,
  created_at  bigint      NOT NULL,
  CONSTRAINT tag_mutes_pk PRIMARY KEY (user_id, tag),
  CONSTRAINT tag_mutes_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX tag_mutes_tag_idx ON tag_mutes (tag, created_at);

-- blocked_words: words and phrases, normalised (lowercase, without accents, words separated by single
-- spaces). The list of tag '*' is the server's: a post containing one of them gets a trust score of
-- 0, which by default has it refused. Any other tag's list only drops that hashtag from a post
-- containing one of them.
CREATE TABLE blocked_words (
  tag         varchar(64)  NOT NULL,
  word        varchar(100) NOT NULL,
  created_at  bigint       NOT NULL,
  CONSTRAINT blocked_words_pk PRIMARY KEY (tag, word)
);

-- moderation_queue: the posts that wait for a server moderator or an admin, whatever their hashtags.
-- /store gives every post and update a trust score (0-100), which only routes it: a low score has it
-- refused, a high one published, and one in between puts it here (TRUST_SCORE_DELETE_BELOW,
-- TRUST_SCORE_ALLOW_FROM). Content with a row is stored like any other but is in no feed index, and
-- only its publisher, server moderators and admins can read it. A server moderator or an admin
-- accepts it, which deletes the row and publishes the content, or rejects it, which sets the content
-- for deletion (the row then goes with it). An update that scores high enough deletes the row and
-- publishes the content too.
--
-- trust_score: the score of the content's last write. This is the only place a trust score is kept.
-- created_at: when the content joined the queue; an update that keeps it there leaves it as it is.
CREATE TABLE moderation_queue (
  content_id   varchar(36) NOT NULL,
  trust_score  smallint    NOT NULL,
  created_at   bigint      NOT NULL,
  CONSTRAINT moderation_queue_pk PRIMARY KEY (content_id),
  CONSTRAINT moderation_queue_content_fk FOREIGN KEY (content_id) REFERENCES content (id) ON DELETE CASCADE
);
CREATE INDEX moderation_queue_created_idx ON moderation_queue (created_at);

-- tag_moderation: what a hashtag's moderators decided about a piece of content under it. Every post
-- is published under its hashtags unmoderated, and is in each hashtag's moderation queue (the
-- hashtag's feed, filtered to unmoderated posts) until one of its moderators decides. No row: nobody
-- has yet.
--
-- decision: 'approved' flags the content's entry in the hashtag's index as moderated, which takes it
-- out of the queue; an update of the content deletes the row, so it is unmoderated again. 'removed'
-- takes the hashtag off the content, and stays: later updates don't get the hashtag back.
-- moderator_id: who decided; NULL once that user is gone.
-- applied_at: NULL until a compactor run has applied the decision: rebuilt the content's entry in
-- the hashtag's day index and, for 'removed', written the content's meta file and summary again
-- without the hashtag (or set the content for deletion, if it was its last). Feeds show the decision
-- from then on.
CREATE TABLE tag_moderation (
  content_id    varchar(36) NOT NULL,
  tag           varchar(64) NOT NULL,
  decision      varchar(16) NOT NULL,
  moderator_id  varchar(36),
  decided_at    bigint      NOT NULL,
  applied_at    bigint,
  CONSTRAINT tag_moderation_pk PRIMARY KEY (content_id, tag),
  CONSTRAINT tag_moderation_content_fk FOREIGN KEY (content_id) REFERENCES content (id) ON DELETE CASCADE,
  CONSTRAINT tag_moderation_moderator_fk FOREIGN KEY (moderator_id) REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX tag_moderation_applied_idx ON tag_moderation (applied_at);
CREATE INDEX tag_moderation_moderator_idx ON tag_moderation (moderator_id);

-- reports: who reported which content to the server's moderators, one row per user per piece of
-- content (POST /report). The report queue is the content with a report nobody has decided on
-- (accepted_at IS NULL), which waits for a server moderator or an admin, longest reported first. They
-- accept the content, which stamps those rows, or delete it, which sets it for deletion (the rows
-- then go with it). A reported post stays published while it waits. Feeds never read this table.
--
-- reason: what the user said is wrong with the content, if anything.
-- created_at: when it was reported. The earliest of a post's undecided reports orders the queue.
-- accepted_at: when the content was accepted in spite of the report; NULL while it waits. The row
-- stays for as long as the content does, so a user reports a post once: one whose report was
-- answered can't put the post back in the queue, though another user's report does.
CREATE TABLE reports (
  content_id   varchar(36)  NOT NULL,
  user_id      varchar(36)  NOT NULL,
  reason       varchar(500),
  created_at   bigint       NOT NULL,
  accepted_at  bigint,
  CONSTRAINT reports_pk PRIMARY KEY (content_id, user_id),
  CONSTRAINT reports_content_fk FOREIGN KEY (content_id) REFERENCES content (id) ON DELETE CASCADE,
  CONSTRAINT reports_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX reports_user_idx ON reports (user_id);
CREATE INDEX reports_open_idx ON reports (accepted_at, content_id, created_at);

-- Comments on posts are not in this database: each is an object in the content store, at
-- comments/<post id>/<comment id>.json, and a post's are listed from there (and from Redis, which
-- caches them). Whether a post takes comments is in its meta file. The next two tables hold only the
-- comments that wait for a server moderator or an admin, so that they wait in the same two queues
-- as posts do. A comment that is written, read and never held or reported never has a row.
--
-- comment_queue: the comments that wait in the moderation queue, beside the posts of
-- moderation_queue. A comment gets a trust score as a post does, by the same plugins and the same
-- thresholds: a low score has it refused, a high one published, and one in between puts it here.
-- Its object is then at comments/<post id>/held/<comment id>.json, where no reader lists it, and
-- only its author, server moderators and admins can read it. Accepting it deletes the row and moves
-- the object in among the post's comments; rejecting it deletes both.
--
-- content_id: the post the comment is on. The row goes with the post.
-- trust_score: the comment's score. This is the only place it is kept.
-- created_at: when the comment was written, which is when it joined the queue.
CREATE TABLE comment_queue (
  comment_id   varchar(36) NOT NULL,
  content_id   varchar(36) NOT NULL,
  trust_score  smallint    NOT NULL,
  created_at   bigint      NOT NULL,
  CONSTRAINT comment_queue_pk PRIMARY KEY (comment_id),
  CONSTRAINT comment_queue_content_fk FOREIGN KEY (content_id) REFERENCES content (id) ON DELETE CASCADE
);
CREATE INDEX comment_queue_created_idx ON comment_queue (created_at);
CREATE INDEX comment_queue_content_idx ON comment_queue (content_id);

-- comment_reports: who reported which comment, one row per user per comment (POST /report with a
-- commentId). It is to comments what reports is to posts, and the report queue is both: the comments
-- with a report nobody has decided on wait there among the posts, longest reported first. A server
-- moderator or an admin accepts the comment, which stamps those rows, or deletes it, which deletes
-- them with it. A reported comment stays published while it waits.
--
-- content_id: the post the comment is on. The rows go with the post.
-- reason, created_at, accepted_at: as in reports.
CREATE TABLE comment_reports (
  comment_id   varchar(36)  NOT NULL,
  user_id      varchar(36)  NOT NULL,
  content_id   varchar(36)  NOT NULL,
  reason       varchar(500),
  created_at   bigint       NOT NULL,
  accepted_at  bigint,
  CONSTRAINT comment_reports_pk PRIMARY KEY (comment_id, user_id),
  CONSTRAINT comment_reports_content_fk FOREIGN KEY (content_id) REFERENCES content (id) ON DELETE CASCADE,
  CONSTRAINT comment_reports_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX comment_reports_user_idx ON comment_reports (user_id);
CREATE INDEX comment_reports_content_idx ON comment_reports (content_id);
CREATE INDEX comment_reports_open_idx ON comment_reports (accepted_at, comment_id, created_at);

-- inbox: what a user has been sent, which only they read (GET /users/:userId/inbox), newest first:
-- the messages other users wrote them, and the server's notices of what moderation did to their
-- posts and of their mutes on hashtags. Feeds never read it.
--
-- kind: 'message' for a message, whose sender is sender_id and whose text is body. Any other kind is
-- a notice, named after what happened (post_rejected, tag_removed, tag_muted and so on: src/inbox.ts).
-- A notice holds no wording: it is said in its reader's language when the inbox is read, from its
-- kind and tag. Its body is the start of the post it is about, which may be gone by the time it is
-- read, and that is also why content_id is no foreign key.
-- sender_id: who wrote a message. NULL on a notice, and once that user is gone.
-- read_at: NULL until the user marks the row as read.
--
-- The compactor deletes the rows older than INBOX_RETENTION_DAYS, once a day, which created_at's
-- own index finds.
CREATE TABLE inbox (
  id          varchar(36)   NOT NULL,
  user_id     varchar(36)   NOT NULL,
  kind        varchar(32)   NOT NULL,
  sender_id   varchar(36),
  content_id  varchar(36),
  tag         varchar(64),
  body        varchar(2000),
  created_at  bigint        NOT NULL,
  read_at     bigint,
  CONSTRAINT inbox_pk PRIMARY KEY (id),
  CONSTRAINT inbox_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT inbox_sender_fk FOREIGN KEY (sender_id) REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX inbox_user_idx ON inbox (user_id, created_at);
CREATE INDEX inbox_sender_idx ON inbox (sender_id);
CREATE INDEX inbox_created_idx ON inbox (created_at);

-- user_blocks: whom a user blocks. No message goes between user_id and blocked_id, either way
-- (POST /messages looks for both rows by the primary key). It is about messages only: follows and
-- feeds go on as they were.
CREATE TABLE user_blocks (
  user_id     varchar(36) NOT NULL,
  blocked_id  varchar(36) NOT NULL,
  created_at  bigint      NOT NULL,
  CONSTRAINT user_blocks_pk PRIMARY KEY (user_id, blocked_id),
  CONSTRAINT user_blocks_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT user_blocks_blocked_fk FOREIGN KEY (blocked_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX user_blocks_user_idx ON user_blocks (user_id, created_at);
CREATE INDEX user_blocks_blocked_idx ON user_blocks (blocked_id);

-- Keeps compactor runs from overlapping, whether they come from two copies of the compactor process
-- (a deploy replacing one, a rebuild started by hand) or from several nodes. A run takes the lease by
-- setting holder and expires_at once the lease has expired (a run that finds it held skips), renews
-- it as it goes, and checks it before every write that publishes a head or deletes anything. Without
-- it, a slower run could publish a head built before a deletion over the head of a newer run that
-- had already deleted the content.
CREATE TABLE compactor_lease (
  id          varchar(32) NOT NULL,
  holder      varchar(36),
  expires_at  bigint      NOT NULL,
  CONSTRAINT compactor_lease_pk PRIMARY KEY (id)
);
INSERT INTO compactor_lease (id, holder, expires_at) VALUES ('compactor', NULL, 0);
