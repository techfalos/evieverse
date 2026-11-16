-- 0010_post_streak
--
-- How many posts in a row the user made with challenges, since a minute went by without a post or a
-- challenge (last_post_at). The next post needs more challenges the longer the run: 1, 1, 2, 4, 8, …
-- A post claims its place with a conditional update on it, so only one post passes at each count.
ALTER TABLE users ADD COLUMN post_streak integer NOT NULL DEFAULT 0;
