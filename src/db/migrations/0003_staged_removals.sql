-- 0003_staged_removals
--
-- The staged files the compactor has applied and has yet to delete. A file that waits under
-- staged/ is what GET /content/:id/raw serves until the compactor has copied it into place, and
-- where the store signs links, a reader is sent to it with a link that is good for a while (a
-- video is read with one link for as long as it plays). So the compactor doesn't delete a staged
-- file as it applies its write: in the transaction that deletes the write's row it adds a row
-- here, and a later run deletes the file once every link that was given to it has expired. Where
-- the store signs no links, files are deleted as they are applied, and there are no rows.
--
-- staged_key: the object under staged/ (see pending_writes.staged_key).
-- content_id: the post the write was of, or was a comment on. No foreign key: the rows don't go
--   with the post. The run that deletes the post deletes the files they name first, whatever
--   their time, and then the rows.
-- remove_at: from when the file can be deleted.
--
-- A row that is lost with its file left is the bucket's to clear, as any file left under
-- staged/ is.
CREATE TABLE staged_removals (
  staged_key  varchar(64) NOT NULL,
  content_id  varchar(36) NOT NULL,
  remove_at   bigint      NOT NULL,
  CONSTRAINT staged_removals_pk PRIMARY KEY (staged_key)
);
CREATE INDEX staged_removals_at_idx ON staged_removals (remove_at);
CREATE INDEX staged_removals_content_idx ON staged_removals (content_id);
