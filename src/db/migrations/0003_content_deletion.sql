-- 0003_content_deletion
--
-- DELETE /content/:id only sets delete_requested_at. The content stays in the database and in the
-- tag files until a compactor run removes its records from every hashtag's files. That run then
-- deletes the row (likes and pending_appends cascade) and the bytes, so the feed never shows
-- content the database no longer has. Once set, new versions and likes are refused.
ALTER TABLE content ADD COLUMN delete_requested_at bigint;
CREATE INDEX content_delete_requested_idx ON content (delete_requested_at);
