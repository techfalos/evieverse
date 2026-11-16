-- 0001_initial
--
-- Portable schema for PostgreSQL, MySQL 8+ (InnoDB, utf8mb4 defaults) and SQLite 3.
-- Constraints are declared at table level because MySQL ignores inline column REFERENCES.
--
-- Conventions:
--   * Every id is a UUID string; users are only ever referenced by users.id, never by username.
--   * Every *_at column is UTC epoch milliseconds (BIGINT).
--   * Content bytes live in the content store at content/<id>/<version>; summaries live in the
--     per-hashtag tag files of the tag store. The feed never reads this database.

-- Publishers and readers. Relations always use id; username is unique but used only for display.
-- updated_at tells the compactor to rewrite the user's records in the tag files.
--
-- last_post_at: when the user last posted, through /store or /federated. A post less than
-- CHALLENGE_POST_WINDOW_SECONDS after it must solve a challenge first. A post claims the window with
-- a conditional update, so of several concurrent posts only one passes without a challenge, and a
-- post that fails sets it back to null. Null: no post that counts.
--
-- post_streak: how many posts in a row the user made with challenges, since a minute went by without
-- a post or a challenge (last_post_at). The next post needs more challenges the longer the run: 1, 1,
-- 2, 4, 8, … A post claims its place with a conditional update on it, so only one post passes at each
-- count.
--
-- recent_posts: when the user's posts in the last minute were, as epoch milliseconds separated by
-- spaces, oldest first. A post past POST_RATE_LIMIT_PER_MINUTE of them is refused. Posts add
-- themselves with a compare-and-set on the whole list, so concurrent posts can't get past the limit
-- together.
--
-- following_changed_at: when the user last followed or unfollowed someone. Setting it is the first
-- statement of every follow and unfollow, which locks the user's row: a user's follows then take
-- turns, and the limit on how many users they follow holds. The compactor rewrites the Redis copy of
-- the follows of users whose follows changed since its last run. Null: never changed.
--
-- admin: 1 for the server's admins, which its operator sets with `npm run admin`. An admin can delete
-- any content, appoint tag moderators and keep the server's blocked words, and can do whatever a tag
-- moderator can on every hashtag.
CREATE TABLE users (
  id                    varchar(36)   NOT NULL,
  username              varchar(64)   NOT NULL,
  publisher_url         varchar(2048),
  created_at            bigint        NOT NULL,
  updated_at            bigint        NOT NULL,
  last_post_at          bigint,
  post_streak           integer       NOT NULL DEFAULT 0,
  recent_posts          text,
  following_changed_at  bigint,
  admin                 smallint      NOT NULL DEFAULT 0,
  CONSTRAINT users_pk PRIMARY KEY (id),
  CONSTRAINT users_username_uq UNIQUE (username)
);
CREATE INDEX users_updated_idx ON users (updated_at);
CREATE INDEX users_following_changed_idx ON users (following_changed_at);

-- API keys are stored as sha256 hashes; key_prefix narrows the lookup.
CREATE TABLE api_keys (
  id          varchar(36)  NOT NULL,
  user_id     varchar(36)  NOT NULL,
  key_prefix  varchar(32)  NOT NULL,
  key_hash    varchar(128) NOT NULL,
  created_at  bigint       NOT NULL,
  revoked_at  bigint,
  CONSTRAINT api_keys_pk PRIMARY KEY (id),
  CONSTRAINT api_keys_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX api_keys_user_prefix_idx ON api_keys (user_id, key_prefix);

-- One row per piece of content. The current bytes are at content/<id>/<version> in the content store.
--
-- reserved_version: the highest version number handed out for the content, committed or not. /store
-- reserves a new number for an update before it writes any bytes, so no two writes ever share a
-- content/<id>/<version> key, and a failed write removes only its own. Versions can therefore skip
-- numbers. The commit still requires the version the update started from, so of two concurrent
-- updates only one commits.
--
-- ai_generated: whether the publisher declared the current version as created with AI: 1 if so, else
-- 0. /store sets it on every version, and an update that doesn't say keeps the previous version's
-- value. The flag also goes into the version's meta file, its summary and its feed index entries,
-- which is where feeds read and filter it from.
--
-- delete_requested_at: DELETE /content/:id only sets it. The content stays in the database and in the
-- tag files until a compactor run removes its records from every hashtag's files. That run then
-- deletes the row (the rows referencing it cascade) and the bytes, so the feed never shows content
-- the database no longer has. Once set, new versions and likes are refused.
--
-- origin_server, origin_content_id, origin_version: content federated from another server. POST
-- /federated indexes a feed record the origin server sent, without its bytes, which stay on that
-- server. origin_server is its base URL, and origin_content_id and origin_version name the content
-- there; all three are null for content stored here. Each user has at most one row per origin
-- content, which later versions update. A unique index treats nulls as distinct on every supported
-- database, so local content never conflicts.
CREATE TABLE content (
  id                   varchar(36)  NOT NULL,
  user_id              varchar(36)  NOT NULL,
  version              integer      NOT NULL,
  reserved_version     integer      NOT NULL DEFAULT 0,
  filename             varchar(512),
  mime_type            varchar(255) NOT NULL,
  size                 bigint       NOT NULL,
  sha256               varchar(64)  NOT NULL,
  ai_generated         smallint     NOT NULL DEFAULT 0,
  like_count           integer      NOT NULL DEFAULT 0,
  created_at           bigint       NOT NULL,
  updated_at           bigint       NOT NULL,
  delete_requested_at  bigint,
  origin_server        varchar(255),
  origin_content_id    varchar(36),
  origin_version       integer,
  CONSTRAINT content_pk PRIMARY KEY (id),
  CONSTRAINT content_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX content_user_idx ON content (user_id);
CREATE INDEX content_delete_requested_idx ON content (delete_requested_at);
CREATE UNIQUE INDEX content_origin_uq ON content (user_id, origin_server, origin_content_id);

-- Flat hashtags. Which content carries a tag is recorded only in that tag's file in the tag store.
-- last_appended_at / compacted_at let the compactor find tags with unmerged tail files.
CREATE TABLE tags (
  name              varchar(64) NOT NULL,
  created_at        bigint      NOT NULL,
  last_appended_at  bigint      NOT NULL,
  compacted_at      bigint      NOT NULL DEFAULT 0,
  CONSTRAINT tags_pk PRIMARY KEY (name)
);
CREATE INDEX tags_last_appended_idx ON tags (last_appended_at);

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
-- never read this table.
CREATE TABLE follows (
  follower_id  varchar(36) NOT NULL,
  followee_id  varchar(36) NOT NULL,
  created_at   bigint      NOT NULL,
  CONSTRAINT follows_pk PRIMARY KEY (follower_id, followee_id),
  CONSTRAINT follows_follower_fk FOREIGN KEY (follower_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT follows_followee_fk FOREIGN KEY (followee_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX follows_followee_idx ON follows (followee_id, created_at);

-- A content version whose records may not be in its hashtags' tail files yet. /store inserts the
-- row in the transaction that writes the version, appends to the tails only after that commits,
-- then deletes the row. Rows left behind (a failed append, a crashed node) are completed by the
-- compactor from the database and the version's meta file.
CREATE TABLE pending_appends (
  content_id  varchar(36) NOT NULL,
  version     integer     NOT NULL,
  created_at  bigint      NOT NULL,
  CONSTRAINT pending_appends_pk PRIMARY KEY (content_id, version),
  CONSTRAINT pending_appends_content_fk FOREIGN KEY (content_id) REFERENCES content (id) ON DELETE CASCADE
);
CREATE INDEX pending_appends_created_idx ON pending_appends (created_at);

-- A content version replaced by a newer one, waiting to be erased. /store inserts the row in the
-- transaction that commits the newer version. The compactor rebuilds the old version's hashtags
-- without it, then erases its bytes and meta file and deletes the row. Readers stop showing the old
-- version at once, through the tombstones /store appends to its hashtags.
CREATE TABLE superseded_versions (
  content_id  varchar(36) NOT NULL,
  version     integer     NOT NULL,
  created_at  bigint      NOT NULL,
  CONSTRAINT superseded_versions_pk PRIMARY KEY (content_id, version),
  CONSTRAINT superseded_versions_content_fk FOREIGN KEY (content_id) REFERENCES content (id) ON DELETE CASCADE
);
CREATE INDEX superseded_versions_created_idx ON superseded_versions (created_at);

-- Moderation is decided when a version is written, so feeds never read the next four tables.
--
-- tag_moderators: who moderates which hashtag. A moderator can remove the hashtag from content, mute
-- users on it and keep its blocked words.
CREATE TABLE tag_moderators (
  tag         varchar(64) NOT NULL,
  user_id     varchar(36) NOT NULL,
  created_at  bigint      NOT NULL,
  CONSTRAINT tag_moderators_pk PRIMARY KEY (tag, user_id),
  CONSTRAINT tag_moderators_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX tag_moderators_user_idx ON tag_moderators (user_id);

-- tag_mutes: users muted on a hashtag. Their new posts and versions don't get it.
CREATE TABLE tag_mutes (
  user_id     varchar(36) NOT NULL,
  tag         varchar(64) NOT NULL,
  created_at  bigint      NOT NULL,
  CONSTRAINT tag_mutes_pk PRIMARY KEY (user_id, tag),
  CONSTRAINT tag_mutes_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX tag_mutes_tag_idx ON tag_mutes (tag, created_at);

-- blocked_words: words and phrases, normalised (lowercase, without accents, words separated by single
-- spaces). The list of tag '*' is the server's: a post containing one of them isn't published. Any
-- other tag's list only drops that hashtag from a post containing one of them.
CREATE TABLE blocked_words (
  tag         varchar(64)  NOT NULL,
  word        varchar(100) NOT NULL,
  created_at  bigint       NOT NULL,
  CONSTRAINT blocked_words_pk PRIMARY KEY (tag, word)
);

-- removed_tags: hashtags a moderator removed from content. Its later versions don't get them back.
CREATE TABLE removed_tags (
  content_id  varchar(36) NOT NULL,
  tag         varchar(64) NOT NULL,
  created_at  bigint      NOT NULL,
  CONSTRAINT removed_tags_pk PRIMARY KEY (content_id, tag),
  CONSTRAINT removed_tags_content_fk FOREIGN KEY (content_id) REFERENCES content (id) ON DELETE CASCADE
);

-- Keeps compactor runs from overlapping, whether they come from a scheduled job that outlasts its
-- interval or from several nodes. A run takes the lease by setting holder and expires_at once the
-- lease has expired (a run that finds it held skips), renews it as it goes, and checks it before
-- every write that publishes a head or deletes anything. Without it, a slower run could publish a
-- head built before a deletion over the head of a newer run that had already deleted the content.
CREATE TABLE compactor_lease (
  id          varchar(32) NOT NULL,
  holder      varchar(36),
  expires_at  bigint      NOT NULL,
  CONSTRAINT compactor_lease_pk PRIMARY KEY (id)
);
INSERT INTO compactor_lease (id, holder, expires_at) VALUES ('compactor', NULL, 0);
