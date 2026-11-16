-- 0002_pending_appends
--
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
