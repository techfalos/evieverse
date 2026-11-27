-- 0020_post_counts
--
-- How popular a hashtag is, and how large the server: a hashtag says how many posts carry it
-- (GET /tags, which can list the hashtags by that), and the server how many posts it has
-- (GET /rules). The compactor counts both as its runs write the posts, and nothing else does: no
-- request adds to either.
--
-- A post is counted from the run that applies its first write until the run that deletes it,
-- but not while it is kept from readers: one that waits in the moderation queue, or the server's
-- entry for a post that is gone from its own server. It counts for each hashtag its meta file
-- has, which are the ones it was published with and the ones reposts gave it, without those a
-- moderator took off it.
--
-- A server that had posts before this counts each of them the next time a run writes it, and
-- all of them at once with `compactor reindex` (`npm run reindex`), which is to be run once
-- after the upgrade.
--
-- post_count: how many posts are counted for the hashtag. Always 0 on the row of a publisher's
--   own index ("@<userId>"), which is no hashtag.
-- tags_post_count_idx: what GET /tags?sort=popular reads the hashtags in order from, from its
--   end: the most posts first, and of those with as many, the last by name first.
ALTER TABLE tags ADD COLUMN post_count bigint NOT NULL DEFAULT 0;
CREATE INDEX tags_post_count_idx ON tags (post_count, name);

-- counted_tags: what the post is counted for, which is how a run knows what to add and what to
--   take away when the post changes: it is written in the transaction that changes the counts.
--   NULL while the post isn't counted: no run has applied it yet, or it is kept from readers. Else
--   the hashtags it is counted under, in the order of their names, with a space between each two,
--   and the empty string for a post that is counted and has no hashtag.
ALTER TABLE content ADD COLUMN counted_tags text;

-- What the compactor counts of the server as a whole, in one row ('server').
--
-- post_count: how many posts the server has: the rows of content whose counted_tags isn't NULL.
CREATE TABLE server_counts (
  id          varchar(32) NOT NULL,
  post_count  bigint      NOT NULL DEFAULT 0,
  CONSTRAINT server_counts_pk PRIMARY KEY (id)
);
INSERT INTO server_counts (id, post_count) VALUES ('server', 0);
