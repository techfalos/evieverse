-- 0004_superseded_versions
--
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
