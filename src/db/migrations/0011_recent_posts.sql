-- 0011_recent_posts
--
-- When the user's posts in the last minute were, as epoch milliseconds separated by spaces, oldest first.
-- A post past POST_RATE_LIMIT_PER_MINUTE of them is refused. Posts add themselves with a
-- compare-and-set on the whole list, so concurrent posts can't get past the limit together.
ALTER TABLE users ADD COLUMN recent_posts text;
