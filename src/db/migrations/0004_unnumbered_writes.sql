-- 0004_unnumbered_writes
--
-- A new comment, and a like of a comment, no longer take the post's next write number, and so no
-- longer lock the post's row or update it: the comments and the likes of one post commit side by
-- side, however many arrive at once. Nothing depends on the order they committed in. A new
-- comment is before every other write of that comment, whose author sends those once they have
-- it, and the likes of a comment are a set.
--
-- Such a row has seq 0, which sorts it before every numbered write of its post, and a key of its
-- own:
--
-- write_key: what tells the rows of a post that took no number apart, and what makes a second
--   one of the same fail. The comment's id for a new comment, and '<commentId>:<userId>' for a
--   like, which is how a user's second like of a comment is found. '' on a numbered write, which
--   its number tells apart: a post's own, an edit of a comment, a removal, a moderator's decision.
--
-- The key is part of the primary key, and SQLite changes no primary key in place, so the table
-- is made again and its rows are copied. Every row there is has a number, and keeps it. The
-- names of the constraints are new because the old ones are taken until the old table is dropped.
CREATE TABLE pending_writes_keyed (
  content_id  varchar(36) NOT NULL,
  seq         bigint      NOT NULL,
  write_key   varchar(80) NOT NULL DEFAULT '',
  kind        varchar(16) NOT NULL,
  comment_id  varchar(36),
  payload     json,
  staged_key  varchar(64),
  created_at  bigint      NOT NULL,
  CONSTRAINT pending_writes_keyed_pk PRIMARY KEY (content_id, seq, write_key),
  CONSTRAINT pending_writes_keyed_content_fk FOREIGN KEY (content_id) REFERENCES content (id) ON DELETE CASCADE
);
INSERT INTO pending_writes_keyed (content_id, seq, write_key, kind, comment_id, payload, staged_key, created_at)
  SELECT content_id, seq, '', kind, comment_id, payload, staged_key, created_at FROM pending_writes;
DROP TABLE pending_writes;
ALTER TABLE pending_writes_keyed RENAME TO pending_writes;
-- The index the old table had, which went with it.
CREATE INDEX pending_writes_comment_idx ON pending_writes (comment_id);
