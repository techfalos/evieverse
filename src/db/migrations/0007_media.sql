-- 0007_media
--
-- Videos are processed before they are published, and images are described for those who can't
-- see them.
--
-- A video is no longer stored as it was sent. The request stages the file, as before, and its
-- write waits: the video worker (src/video), which runs beside the compactor, makes of the file
-- what is published (an MP4 that plays anywhere, without the metadata the file came with, and
-- for a post a poster image and an adaptive stream), and only then does the compactor apply the
-- write. What says a write waits is in its row of pending_writes (`process` in its payload), so
-- the compactor reads it with the row. This table is the worker's own: what there is to process.
--
-- media_jobs: one row for each write whose video is yet to be processed. The write's commit adds
-- it, the worker deletes it in the commit that puts the processed file in the write's row, and it
-- goes with the post.
--
-- id: the job. For a post's video it is also the id of the version of the video it makes, which
--   the poster and the stream are kept under in the content store (media/<content_id>/<id>/), so
--   a job that is run again writes over what it wrote before.
-- content_id, seq, write_key: the row of pending_writes that names the staged file: a post's
--   own write, or the write that made a comment.
-- comment_id: the comment the video came with. NULL on a post's.
-- attempts: how many times a worker took the job. One that is taken more often than a video is
--   tried is given up: a worker died of it each time.
-- claimed_until: until when the worker that took the job has it. 0 on one nobody took. A worker
--   takes a job whose time has passed, and keeps the time ahead for as long as it works on it,
--   so a job whose worker died is taken by another, or by the same once it is back.
-- created_at: when the write was made. The oldest job is taken first.
CREATE TABLE media_jobs (
  id             varchar(36) NOT NULL,
  content_id     varchar(36) NOT NULL,
  seq            bigint      NOT NULL,
  write_key      varchar(80) NOT NULL DEFAULT '',
  comment_id     varchar(36),
  attempts       integer     NOT NULL DEFAULT 0,
  claimed_until  bigint      NOT NULL DEFAULT 0,
  created_at     bigint      NOT NULL,
  CONSTRAINT media_jobs_pk PRIMARY KEY (id),
  CONSTRAINT media_jobs_content_fk FOREIGN KEY (content_id) REFERENCES content (id) ON DELETE CASCADE
);
CREATE INDEX media_jobs_due_idx ON media_jobs (claimed_until, created_at);
CREATE INDEX media_jobs_content_idx ON media_jobs (content_id);

-- image_alt: the alternative text of an image ad's image, which describes it to those who can't
--   see it. NULL on a text ad, and on an image ad that has none. The alternative texts of posts'
--   and comments' images are in their meta files and in the comments, not in the database.
ALTER TABLE monetization ADD COLUMN image_alt varchar(1500);
