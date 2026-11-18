-- 0009_search
--
-- Search (GET /search, src/routes/search.ts) finds users by the start of their username, and
-- posts by the words of their text and by their hashtags. Neither had anything to be found by: a
-- username is compared as it is written, case and accents included, and what a post says is in
-- its meta file in the content store, not in this database.
--
-- search_terms: the words a post is found by, one row for each word and post. They are the most
-- frequent words of its text or caption and every one of its hashtags, each lowercase and without
-- accents (src/search/keywords.ts): not the whole text. The compactor writes them whenever it
-- writes the post's meta file, which is what they are worked out from, so they are those of the
-- post as its newest applied write has it, with the hashtags reposts gave it and without the
-- ones moderators removed. `npm run reindex` writes those of the posts that were there before
-- this table was (src/search/reindex.ts).
--
-- A post has its rows whether it is published or not: one that waits in the moderation queue, or
-- whose original is gone from its own server, keeps them, and a search leaves it out by its row
-- of content, as it does a post set for deletion. The rows go with the post.
--
-- term: the word, or the hashtag. A search for several words finds the posts that have a row for
--   each of them.
-- created_at: when the post was created (content.created_at), which never changes. It is here
--   so that the newest posts with a word are read from search_terms_newest_idx in their order,
--   without the rows of content being read to sort them.
CREATE TABLE search_terms (
  term        varchar(64) NOT NULL,
  content_id  varchar(36) NOT NULL,
  created_at  bigint      NOT NULL,
  CONSTRAINT search_terms_pk PRIMARY KEY (term, content_id),
  CONSTRAINT search_terms_content_fk FOREIGN KEY (content_id) REFERENCES content (id) ON DELETE CASCADE
);
CREATE INDEX search_terms_newest_idx ON search_terms (term, created_at, content_id);
CREATE INDEX search_terms_content_idx ON search_terms (content_id);

-- username_folded: the username as a search compares it, lowercase and without accents, cut to
-- 255 characters (see foldUsername in src/search/keywords.ts). Whatever writes a username writes
-- it too. It is filled here with the username in lowercase, which is all of it for a name in
-- unaccented Latin letters: `npm run reindex` writes it again for every user, as the server
-- folds it. NULL only on a row that something other than the server inserted, which no search
-- finds.
ALTER TABLE users ADD COLUMN username_folded varchar(255);
UPDATE users SET username_folded = lower(username);
CREATE INDEX users_username_folded_idx ON users (username_folded, id);
