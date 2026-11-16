-- 0006_compactor_lease
--
-- Keeps compactor runs from overlapping, whether they come from a scheduled job that outlasts its
-- interval or from several nodes. A run takes the lease by setting holder and expires_at once the
-- lease has expired (a run that finds it held skips), renews it as it goes, and checks it before
-- every write that publishes a head or deletes anything. Without it, a slower run could publish a
-- head built before a deletion over the head of a newer run that had already deleted the content.
CREATE TABLE compactor_lease (
  id          varchar(32) NOT NULL,
  holder      varchar(36),
  expires_at  bigint      NOT NULL,
  CONSTRAINT compactor_lease_pk PRIMARY KEY (id)
);
INSERT INTO compactor_lease (id, holder, expires_at) VALUES ('compactor', NULL, 0);
