-- 0011_tag_moderation
--
-- Three things a hashtag's moderators had no table for: a user's claim to moderate a hashtag, the
-- rules its moderators set for it, and what they did to each post under it, kept with the post.
--
-- tag_claims: the claims to moderate a hashtag that wait (src/moderation/claims.ts). Where
-- publishers choose their posts' hashtags (TAGGING_MODE=user), a user claims a hashtag that has no
-- moderator (POST /tags/:tag/claim). The server's admins and server moderators are told, each by a
-- notice in their inbox, and any of them can refuse the claim while it waits. The compactor makes
-- the user a moderator of the hashtag (a row of tag_moderators) once review_until has passed, and
-- deletes the row: a claim that is here is one that waits, and nothing else is kept of one.
--
-- tag: the hashtag, which has one claim at a time: the primary key is what makes a second one fail.
-- user_id: who claims it. The rows go with the user's account.
-- created_at: when the claim was made.
-- review_until: until when it can be refused: TAG_CLAIM_REVIEW_HOURS after it was made. The
--   compactor's first run after it grants the claim.
CREATE TABLE tag_claims (
  tag           varchar(64) NOT NULL,
  user_id       varchar(36) NOT NULL,
  created_at    bigint      NOT NULL,
  review_until  bigint      NOT NULL,
  CONSTRAINT tag_claims_pk PRIMARY KEY (tag),
  CONSTRAINT tag_claims_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX tag_claims_user_idx ON tag_claims (user_id);
CREATE INDEX tag_claims_due_idx ON tag_claims (review_until);

-- tag_rules: a hashtag's rules, one row each, which its moderators keep and anyone reads
-- (GET /tags/:tag/rules). They are to a hashtag what server_rules are to the server, and are kept
-- the same way: the server gives them, and checks no post against one.
--
-- tag: the hashtag the rule is one of.
-- sort_order: where the rule comes among the hashtag's others, lowest first. A response gives its
--   place in the list instead, counted from 1.
-- body: the rule's text, as its moderator wrote it.
-- updated_at: when the text or the place was last changed by a request about this rule; created_at
--   until then.
CREATE TABLE tag_rules (
  id          varchar(36)   NOT NULL,
  tag         varchar(64)   NOT NULL,
  sort_order  integer       NOT NULL,
  body        varchar(2000) NOT NULL,
  created_at  bigint        NOT NULL,
  updated_at  bigint        NOT NULL,
  CONSTRAINT tag_rules_pk PRIMARY KEY (id)
);
CREATE INDEX tag_rules_tag_idx ON tag_rules (tag, sort_order);

-- tag_moderation_log: what moderators did to a post under a hashtag, one row for each time: the
-- post's own record of it, which GET /content/:contentId gives with the post, for a client to
-- show beside it. tag_moderation holds what stands now, one row for a post and a hashtag, which a
-- later decision writes over and an update of the post deletes: these rows are never changed.
--
-- decision: 'approved' (the post was approved under the hashtag) or 'removed' (the hashtag was
--   taken off the post), as in tag_moderation.
-- moderator_id: who did it, which no response gives; NULL once that user is gone.
-- moderator_role: as what they did it, which is what a response says of them: 'tag_moderator',
--   'server_moderator' or 'admin'. Kept here, since it is what they were then.
-- reason: why, as the moderator said it, for a removal that came with a reason; NULL otherwise.
-- created_at: when it was done.
--
-- The rows go with the post.
CREATE TABLE tag_moderation_log (
  id              varchar(36)  NOT NULL,
  content_id      varchar(36)  NOT NULL,
  tag             varchar(64)  NOT NULL,
  decision        varchar(16)  NOT NULL,
  moderator_id    varchar(36),
  moderator_role  varchar(16)  NOT NULL,
  reason          varchar(500),
  created_at      bigint       NOT NULL,
  CONSTRAINT tag_moderation_log_pk PRIMARY KEY (id),
  CONSTRAINT tag_moderation_log_content_fk FOREIGN KEY (content_id) REFERENCES content (id) ON DELETE CASCADE,
  CONSTRAINT tag_moderation_log_moderator_fk FOREIGN KEY (moderator_id) REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX tag_moderation_log_content_idx ON tag_moderation_log (content_id, created_at);
CREATE INDEX tag_moderation_log_moderator_idx ON tag_moderation_log (moderator_id);
