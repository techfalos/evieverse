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
CREATE TABLE users (
  id             varchar(36)   NOT NULL,
  username       varchar(64)   NOT NULL,
  publisher_url  varchar(2048),
  created_at     bigint        NOT NULL,
  updated_at     bigint        NOT NULL,
  CONSTRAINT users_pk PRIMARY KEY (id),
  CONSTRAINT users_username_uq UNIQUE (username)
);
CREATE INDEX users_updated_idx ON users (updated_at);

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
CREATE TABLE content (
  id          varchar(36)  NOT NULL,
  user_id     varchar(36)  NOT NULL,
  version     integer      NOT NULL,
  filename    varchar(512),
  mime_type   varchar(255) NOT NULL,
  size        bigint       NOT NULL,
  sha256      varchar(64)  NOT NULL,
  like_count  integer      NOT NULL DEFAULT 0,
  created_at  bigint       NOT NULL,
  updated_at  bigint       NOT NULL,
  CONSTRAINT content_pk PRIMARY KEY (id),
  CONSTRAINT content_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX content_user_idx ON content (user_id);

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
