-- 0018_views_dislikes
--
-- A post counts how often it was viewed, and, on a server that has dislikes on (DISLIKES), how
-- many users dislike it. Both come with the post wherever it is read: GET /content/:id and the
-- feeds, beside its likes.
--
-- view_count: how many times the post was viewed by a user account: GET /content/:id, sent with a
--   user's credentials, adds one each time (src/routes/content.ts). It counts views, not viewers:
--   a user who opens the post twice is counted twice. Nothing takes one off.
-- viewed_at: when the post was last viewed so, or NULL if it never was. A view leaves no row, so
--   the post says it: it is how a compactor run finds the content viewed since the last one,
--   whose entries in the feed indexes it then writes again with the count as it now is.
ALTER TABLE content ADD COLUMN view_count bigint NOT NULL DEFAULT 0;
ALTER TABLE content ADD COLUMN viewed_at bigint;
CREATE INDEX content_viewed_idx ON content (viewed_at);

-- dislike_count: how many users dislike the post: its rows of dislikes, counted as they are added
--   and taken away (POST and DELETE /dislike). It starts at 0 and has nothing to do with
--   like_count: a dislike takes no like off, and orders no feed. It is kept whether dislikes are
--   on or off, and shown only while they are on.
-- disliked_at: when a dislike of the post was last given or taken back, or NULL if none ever
--   was: how a compactor run finds the content whose count changed since the last one, as it
--   finds the content that lost a like by unliked_at (0010_unlikes).
ALTER TABLE content ADD COLUMN dislike_count integer NOT NULL DEFAULT 0;
ALTER TABLE content ADD COLUMN disliked_at bigint;
CREATE INDEX content_disliked_idx ON content (disliked_at);

-- One dislike per user per content item, which stays until the user takes it back, as a like does
-- (likes); content.dislike_count is the running total. A user may both like and dislike a post:
-- the two are counted apart.
CREATE TABLE dislikes (
  user_id     varchar(36) NOT NULL,
  content_id  varchar(36) NOT NULL,
  created_at  bigint      NOT NULL,
  CONSTRAINT dislikes_pk PRIMARY KEY (user_id, content_id),
  CONSTRAINT dislikes_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT dislikes_content_fk FOREIGN KEY (content_id) REFERENCES content (id) ON DELETE CASCADE
);
CREATE INDEX dislikes_content_idx ON dislikes (content_id);
