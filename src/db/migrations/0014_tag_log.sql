-- 0014_tag_log
--
-- A hashtag's log (GET /tags/:tag/log, src/moderation/tagDecisions.ts): what moderators did to the
-- posts under the hashtag, newest first, a page at a time. It is the rows of tag_moderation_log
-- that name the hashtag, which were read by their post alone until now (GET /content/:contentId).
--
-- A hashtag's rows by when they were written, which is the order a page is read in, so each page
-- reads the rows it returns. tag_moderation_log_content_idx holds them by post.
CREATE INDEX tag_moderation_log_tag_idx ON tag_moderation_log (tag, created_at);
