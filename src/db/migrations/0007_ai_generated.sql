-- 0007_ai_generated
--
-- Whether the publisher declared the current version as created with AI: 1 if so, else 0. /store
-- sets it on every version, and an update that doesn't say keeps the previous version's value. The
-- flag also goes into the version's meta file, its summary and its feed index entries, which is
-- where feeds read and filter it from. Existing content counts as not created with AI.
ALTER TABLE content ADD COLUMN ai_generated smallint NOT NULL DEFAULT 0;
