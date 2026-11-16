-- 0008_federated_content
--
-- Content federated from another server: POST /federated indexes a feed record the origin server
-- sent, without its bytes, which stay on that server. origin_server is its base URL, and
-- origin_content_id and origin_version name the content there; all three are null for content
-- stored here. Each user has at most one row per origin content, which later versions update. A
-- unique index treats nulls as distinct on every supported database, so local content never conflicts.
ALTER TABLE content ADD COLUMN origin_server varchar(255);
ALTER TABLE content ADD COLUMN origin_content_id varchar(36);
ALTER TABLE content ADD COLUMN origin_version integer;
CREATE UNIQUE INDEX content_origin_uq ON content (user_id, origin_server, origin_content_id);
