-- 0005_origin_gone
--
-- The server's entry for a post on another server (content with an origin_hash) is no longer
-- deleted on that server's word that it publishes no post at the address. That word is signed for
-- whatever the other server doesn't publish, a post that only waits in its moderation queue
-- among them, and a post that waits may be published again. So the entry is hidden instead, comes
-- back with the next attestation of the post, and is deleted only once it has been hidden for
-- REPOSTS_GONE_DAYS. And the server no longer waits for a client to bring it such word: it asks
-- the other server itself, now and then.
--
-- origin_gone_at: NULL on a post written here, and on an entry whose original is published as
--   far as this server knows. Else when the original's server was first found to publish no post
--   at the address: the entry is hidden from then on, as content that waits in the moderation
--   queue is (no summary, in no index, 404 to readers), with its hashtags and the places reposts
--   gave it kept. A later attestation of the post sets it back to NULL. The compactor sets the
--   entry for deletion once this is REPOSTS_GONE_DAYS old.
-- origin_check_at: NULL on a post written here. On an entry, from when the server asks the
--   original's server for the post's attestation again (see src/originSweep.ts). The entries that
--   were here before this migration are asked about first: they are due at once, and are taken a
--   few at a time.
ALTER TABLE content ADD COLUMN origin_gone_at bigint;
ALTER TABLE content ADD COLUMN origin_check_at bigint;
UPDATE content SET origin_check_at = 0 WHERE origin_hash IS NOT NULL;
CREATE INDEX content_origin_gone_idx ON content (origin_gone_at);
CREATE INDEX content_origin_check_idx ON content (origin_check_at);
