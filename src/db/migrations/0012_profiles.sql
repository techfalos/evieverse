-- 0012_profiles
--
-- A user's profile says more of them than their name: a bio, links to where else they are found,
-- and an avatar, each of which is theirs to set and to take away again (PATCH /users/:userId,
-- PUT and DELETE /users/:userId/avatar), and the posts they pinned to it. A profile lists its
-- user's posts, newest first (GET /users/:userId/posts), by content_user_created_idx, which
-- 0006_export_indexes made.
--
-- bio: what the user says of themselves, as they wrote it, in the format a post's text is in
--   (src/format.ts). NULL for a user who says nothing.
-- links: the addresses the user gives of where else they are found, in the order they gave
--   them: a JSON array of http and https URLs, each as the WHATWG parser writes it (see
--   profileLinks in src/profile.ts). NULL for a user who gives none.
-- avatar_id: the id of the user's avatar, which names its file in the content store
--   (avatars/<user id>/<avatar id>): another image is another id, and another file. NULL for a
--   user who has none. It outlasts the closing of the account by a moment: the row of a closed
--   account is deleted only once this is NULL again, which is once the file is gone (see
--   dropAvatars in src/accounts.ts).
-- avatar_type: the content type of that file, which is the one every avatar is made as (see
--   standardAvatar in src/profile.ts). NULL with avatar_id.
ALTER TABLE users ADD COLUMN bio varchar(500);
ALTER TABLE users ADD COLUMN links text;
ALTER TABLE users ADD COLUMN avatar_id varchar(36);
ALTER TABLE users ADD COLUMN avatar_type varchar(64);

-- pinned_posts: the posts a user pinned to their profile (PUT /users/:userId/pinned/:contentId),
-- which the profile names, and which the list of the user's posts gives ahead of the others. One
-- row for each post a user pinned, of which a user has a few at most (MAX_PINNED_POSTS in
-- src/profile.ts, which the request that pins one more holds them to). A row is the user's
-- wish, and says nothing of whether the post can be read: one that is withheld, or set for
-- deletion, is pinned and not shown. The row goes with the post, and with the user's account.
--
-- content_id: the post, which is one of the user's own.
-- created_at: when it was pinned. A profile gives the post pinned last first.
CREATE TABLE pinned_posts (
  user_id     varchar(36) NOT NULL,
  content_id  varchar(36) NOT NULL,
  created_at  bigint      NOT NULL,
  CONSTRAINT pinned_posts_pk PRIMARY KEY (user_id, content_id),
  CONSTRAINT pinned_posts_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT pinned_posts_content_fk FOREIGN KEY (content_id) REFERENCES content (id) ON DELETE CASCADE
);
CREATE INDEX pinned_posts_content_idx ON pinned_posts (content_id);
