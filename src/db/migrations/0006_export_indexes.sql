-- 0006_export_indexes
--
-- A user's export of their own data (GET /users/:userId/export, src/export.ts) reads each kind
-- of thing the server holds of them a page at a time, in a set order, each page starting after
-- the last row of the one before it. Where an index holds a user's rows in that order, a page
-- reads the rows it returns. Where none does, every page reads all of the user's rows and sorts
-- them: the more a user has, the more each page costs, and the more pages there are.
--
-- Likes, follows, blocks, mutes and inboxes have such an index already. These are the three that
-- had none, of the things a user can have a great many of.

-- A user's posts, oldest first, then by id. content_user_idx finds them, in no order.
CREATE INDEX content_user_created_idx ON content (user_id, created_at, id);

-- A user's reposts by the content they reposted, which is what makes the rows of one repost one
-- record. reposts_user_idx finds them, in no order.
CREATE INDEX reposts_user_content_idx ON reposts (user_id, content_id);

-- The messages a user sent, oldest first, then by id. inbox_sender_idx finds them, in no order.
CREATE INDEX inbox_sender_created_idx ON inbox (sender_id, created_at, id);
