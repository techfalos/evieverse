-- 0015_moderator_activity
--
-- A hashtag's moderator stays one by moderating it (src/moderation/activity.ts): one who did
-- nothing as its moderator for TAG_MODERATOR_INACTIVE_DAYS is one no more, which the compactor
-- sees to. Nothing said when a moderator last did anything: a mute, a blocked word and a rule
-- don't name who made them, and a post's record of a decision goes with the post. So the
-- moderator's own row says it:
--
-- acted_at: when the moderator last did something as one on the hashtag, and when they became
--   its moderator until they have. NULL on the rows that were here before this migration, of
--   which nothing is known: the compactor's next run sets them to its own time, so the
--   moderators a server already has are counted from when it was updated, and none loses a
--   hashtag for what was never written down.
--
-- The index is how a run finds the moderators whose time is up, and the rows it is yet to set.
ALTER TABLE tag_moderators ADD COLUMN acted_at bigint;
CREATE INDEX tag_moderators_acted_idx ON tag_moderators (acted_at);
