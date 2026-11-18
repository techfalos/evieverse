-- 0013_repost_removals
--
-- An admin or a server moderator can remove one user's repost of a post
-- (DELETE /content/:contentId/reposts/:userId). The post stays, with what its publisher and other
-- reposts gave it: what goes is what that repost added, its place in the reposter's own index and
-- the hashtags it gave the post.
--
-- The request deletes the repost's rows of reposts, so from then on nothing reads it as a repost,
-- and the user can make it again, unless they are banned. What is left of it is in what only the
-- compactor writes: the entries in the feed index, the hashtags in the post's meta file and
-- summary, and the copy of the summary under the day of the repost. The deleted rows were what
-- said where those are, so the request leaves a row here for each of them, in the same commit,
-- and the compactor's next run takes the places away by these.
--
-- repost_removals: the places of reposts that were removed and that the compactor is yet to take
-- away. One row for each row of reposts the removal deleted.
--
-- id: names the row. A place can be removed, given again by another repost and removed again
--   before a run comes by, and each time is a row of its own.
-- content_id: the post that was reposted. The rows go with it.
-- tag: the index the repost placed the post in: a hashtag it gave the post, or "@<userId>", the
--   reposter's own index, as in reposts.
-- reposted_at: when the repost was made (reposts.created_at), which is the day the entry is in,
--   and the day the summary has a copy under.
-- created_at: when it was removed.
--
-- A row is deleted by the run that has taken its place away, unless a write of the post is still
-- to be applied: such a write may hold the hashtag, as the post had it when the write was made,
-- and the row is what takes it off that too.
CREATE TABLE repost_removals (
  id           varchar(36) NOT NULL,
  content_id   varchar(36) NOT NULL,
  tag          varchar(64) NOT NULL,
  reposted_at  bigint      NOT NULL,
  created_at   bigint      NOT NULL,
  CONSTRAINT repost_removals_pk PRIMARY KEY (id),
  CONSTRAINT repost_removals_content_fk FOREIGN KEY (content_id) REFERENCES content (id) ON DELETE CASCADE
);
CREATE INDEX repost_removals_content_idx ON repost_removals (content_id);
