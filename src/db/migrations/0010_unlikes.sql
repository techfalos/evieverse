-- 0010_unlikes
--
-- A like can be taken back (DELETE /like): a like of a post, and a like of a comment.
--
-- A post's like is a row of likes, which the unlike deletes, with one off the post's like_count.
-- The compactor finds the content liked since its last run by the rows' created_at, and a row
-- that is gone says nothing. So the post says it:
--
-- unliked_at: when a like of the content was last taken back, or NULL if none ever was. It is
--   how a compactor run finds the content that lost a like since the last one, whose entries
--   in the feed indexes it then writes again with the count as it now is.
ALTER TABLE content ADD COLUMN unliked_at bigint;
CREATE INDEX content_unliked_idx ON content (unliked_at);

-- A comment's likes are in the content store, where the compactor makes them from the rows of
-- pending_writes (kind comment_like, one for each user and comment). Such a row is now what the
-- user last asked for, a like or its taking back (its payload says which), and until the
-- compactor has applied it, the number of the comment's likes is the store's with the rows
-- that wait. A row that takes a like back counts against the store's number, and one that only
-- undoes the row that waited before it counts as nothing, so each row says what it comes to:
--
-- net: on a comment_like row, what the row adds to the number of likes the content store has
--   of the comment. 1 for a like the store doesn't have, -1 for the taking back of one it has,
--   and 0 for a row that leaves the store as it is (a like taken back before it was made
--   there, or one given again before its taking back was applied). NULL on every other kind of
--   row, and on a like that was committed before this migration or by a server that is yet to
--   be updated, which is a like the store doesn't have: it counts as 1.
ALTER TABLE pending_writes ADD COLUMN net smallint;
