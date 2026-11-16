-- 0002_pending_writes
--
-- The compactor becomes the only writer of what the content store holds of posts and comments
-- (content/, comments/) and of summaries. A request that writes a post, a comment or a like of a
-- comment no longer writes any of those: it commits a row here, in the order the post's writes
-- were made, and each compactor run applies the rows in that order and deletes them. So nothing
-- a request does can land on a post or a comment that was deleted meanwhile, and two writes of
-- one post never leave parts of both.
--
-- Deploy it to every node at once: a node of the version before still writes meta files itself.

-- seq: the number of the post's last write. Every write of the post, or of anything under it (a
-- comment, a like of one), locks the post's row, adds one, and takes the number for its row in
-- pending_writes, all in the transaction that commits it. A write of a post that is set for
-- deletion finds no row to number, and is refused.
ALTER TABLE content ADD COLUMN seq bigint NOT NULL DEFAULT 0;

-- pending_writes: the writes that committed and that no compactor run has applied yet, one row
-- each. A run applies a post's rows in the order of seq and deletes each as it is applied. The
-- rows go with the post.
--
-- kind: what the write is.
--   'post'            the post itself, new or an update. payload is { meta }: its meta file as the
--                     write makes it. Only the newest such row of a post is applied.
--   'comment_put'     a comment as it now is: new, edited, held or published. payload is
--                     { comment, held }: the comment, and whether it waits in the moderation queue.
--   'comment_remove'  the comment is removed for good.
--   'comment_like'    a user's like of the comment. payload is { userId }.
-- comment_id: the comment a comment write is of. NULL on a post's.
-- payload: JSON. The type is json because it is the one PostgreSQL and MySQL both have that holds
--   a post's whole text (MySQL's text ends at 64 KB). PostgreSQL and MySQL give it back parsed, and
--   SQLite as the string it was given (see payloadOf).
-- staged_key: the object in the content store, under staged/, that holds the file the write came
--   with: a post's image, video or audio, or a comment's image or video. The request wrote it once,
--   before it committed, and nothing writes it again. The run that applies the row copies it into
--   place and deletes it. NULL on a write with no file: a text post's text and a link's URL are in
--   the payload.
-- created_at: when the write was made.
CREATE TABLE pending_writes (
  content_id  varchar(36) NOT NULL,
  seq         bigint      NOT NULL,
  kind        varchar(16) NOT NULL,
  comment_id  varchar(36),
  payload     json,
  staged_key  varchar(64),
  created_at  bigint      NOT NULL,
  CONSTRAINT pending_writes_pk PRIMARY KEY (content_id, seq),
  CONSTRAINT pending_writes_content_fk FOREIGN KEY (content_id) REFERENCES content (id) ON DELETE CASCADE
);
CREATE INDEX pending_writes_comment_idx ON pending_writes (comment_id);

-- An update no longer queues rows before it commits, since it writes nothing before it commits:
-- every row of feed_queue is a committed write's, and a run takes them all.
ALTER TABLE feed_queue DROP COLUMN committed;
