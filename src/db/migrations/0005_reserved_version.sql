-- 0005_reserved_version
--
-- The highest version number handed out for the content, committed or not. /store reserves a new
-- number for an update before it writes any bytes, so no two writes ever share a
-- content/<id>/<version> key, and a failed write removes only its own. Versions can therefore skip
-- numbers. The commit still requires the version the update started from, so of two concurrent
-- updates only one commits.
ALTER TABLE content ADD COLUMN reserved_version integer NOT NULL DEFAULT 0;
UPDATE content SET reserved_version = version;
