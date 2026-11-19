-- 0016_quarantine
--
-- The files that matched the pdq trust plugin's list of hashes of known child sexual abuse
-- material are kept, where the operator turns the quarantine on (QUARANTINE_SCHEME), and videos
-- are checked against the list as images are.
--
-- A file that matched was refused and nothing of it was kept, which left the operator with
-- nothing to report, and nothing to keep once they had: in the United States a report to the
-- CyberTipline has the provider keep what it reported for a year. The quarantine is a store of
-- its own (src/quarantine.ts), which only an admin reads a file of, through the API, and these
-- two tables are what the server knows of it: what is there, and who read it.
--
-- quarantine: one row for each file that is kept. The file is the object files/<id> of the
-- quarantine's store, written before the row is.
--
-- id: the item, which names its file.
-- user_id: who sent the file. No foreign key: the row outlasts the closing of their account,
--   which is no way out of a report.
-- sha256: the SHA-256 of the file as it is kept. With user_id it is the item: the same file
--   sent again by the same user is kept once, and counted (matches).
-- mime_type: what the file was sent as (image/jpeg, video/quicktime ...). An admin is given it as
--   bytes to save (application/octet-stream), whatever this says.
-- size: the file's size, in bytes.
-- facts: what the admins were told of the match when the file was first kept, as JSON
--   (MatchFacts in src/plugins/trust/pdq/report.types.ts): who sent it, when, from where, as
--   what, its hashes and the listed hash it is near. The notice in their inboxes holds the same,
--   and goes after INBOX_RETENTION_DAYS; this stays as long as the file does.
-- matches: how many times the file matched: 1, and one more each time the user sent it again.
-- created_at: when the file was first kept.
-- last_matched_at: when it last matched.
-- reported_at: when the report of it was made to the authorities, as the admin who recorded it
--   said (POST /moderation/quarantine/:id/report). NULL until one is recorded. The file is
--   deleted QUARANTINE_RETENTION_DAYS after this, and never while it is NULL.
-- reported_by: the admin who recorded the report. No foreign key, as user_id has none.
-- report_id: what the authority calls the report (a CyberTipline report's number), if the admin
--   gave it.
CREATE TABLE quarantine (
  id               varchar(36)  NOT NULL,
  user_id          varchar(36)  NOT NULL,
  sha256           varchar(64)  NOT NULL,
  mime_type        varchar(255) NOT NULL,
  size             bigint       NOT NULL,
  facts            text         NOT NULL,
  matches          integer      NOT NULL DEFAULT 1,
  created_at       bigint       NOT NULL,
  last_matched_at  bigint       NOT NULL,
  reported_at      bigint,
  reported_by      varchar(36),
  report_id        varchar(200),
  CONSTRAINT quarantine_pk PRIMARY KEY (id),
  CONSTRAINT quarantine_file_uq UNIQUE (user_id, sha256)
);
CREATE INDEX quarantine_created_idx ON quarantine (created_at, id);
CREATE INDEX quarantine_reported_idx ON quarantine (reported_at);

-- quarantine_access: what was done with each item, and by whom: the quarantine's own log. A row
-- is written before the thing it records is done, so no file is read without one. The rows
-- outlast the item: they are what says, afterwards, that a file was there, who read it, and
-- when it was deleted. Nothing deletes them.
--
-- quarantine_id: the item. No foreign key: the item's row goes when its file does.
-- action: stored (the server kept the file), downloaded (an admin read the file), reported (an
--   admin recorded a report of it), dismissed (an admin deleted one that was never reported),
--   expired (the compactor deleted it, its time after the report being over).
-- user_id: the admin. NULL where the server did it itself (stored, expired).
-- ip, user_agent: where the admin's request came from, as the server counts it, and its
--   User-Agent header, cut short. NULL where the server did it itself.
-- created_at: when.
CREATE TABLE quarantine_access (
  id             varchar(36)  NOT NULL,
  quarantine_id  varchar(36)  NOT NULL,
  action         varchar(16)  NOT NULL,
  user_id        varchar(36),
  ip             varchar(64),
  user_agent     varchar(255),
  created_at     bigint       NOT NULL,
  CONSTRAINT quarantine_access_pk PRIMARY KEY (id)
);
CREATE INDEX quarantine_access_item_idx ON quarantine_access (quarantine_id, created_at);

-- A video is checked by the video worker, some time after the request that sent it was
-- answered, so what a notice of a match says of that request is kept with the job until then.
-- Written only where the server runs the pdq plugin, and deleted with the job.
--
-- client_ip: the address the request came from, as the server counts it. NULL where the server
--   checks no videos.
-- client_user_agent: its User-Agent header, cut short. NULL likewise, and for a request that
--   sent none.
ALTER TABLE media_jobs ADD COLUMN client_ip varchar(64);
ALTER TABLE media_jobs ADD COLUMN client_user_agent varchar(255);
