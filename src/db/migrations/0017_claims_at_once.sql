-- 0017_claims_at_once
--
-- A claim to a hashtag is granted at once (src/moderation/claims.ts): the user who claims a
-- hashtag that has no moderator is its moderator as the request is answered. A claim used to
-- wait TAG_CLAIM_REVIEW_HOURS in tag_claims, for an admin or a server moderator to refuse it,
-- and the compactor granted it after. Nothing waits now: what a claim gave, an admin or a server
-- moderator takes back whenever they see fit (DELETE /tags/:tag/moderators/:userId), and they
-- can keep a user from claiming at all (PUT /claim-barred/:userId).
--
-- claimed: 1 on the row of a moderator who claimed the hashtag, NULL on one who was appointed.
--   The unique index is what gives a hashtag one of them, whichever of two claims made at once
--   commits first, as the primary key of tag_claims did: any number of rows hold NULL.
ALTER TABLE tag_moderators ADD COLUMN claimed smallint;
CREATE UNIQUE INDEX tag_moderators_claimed_uq ON tag_moderators (tag, claimed);

-- The claims that waited are granted: each was made under the promise that it would be, unless
-- it was refused. Not to a user who is banned, as the compactor granted them none, and not to a
-- hashtag that was given a moderator meanwhile. acted_at is left NULL, which the compactor's
-- next run sets to its own time (0015_moderator_activity): they are counted from then.
INSERT INTO tag_moderators (tag, user_id, created_at, claimed)
SELECT c.tag, c.user_id, c.created_at, 1
FROM tag_claims c
INNER JOIN users u ON u.id = c.user_id
LEFT JOIN tag_moderators m ON m.tag = c.tag
WHERE u.banned_at IS NULL AND u.deleted_at IS NULL AND m.tag IS NULL;

DROP TABLE tag_claims;

-- A user can be barred from claiming hashtags, by a server moderator or an admin: three columns
-- of their row, as a ban is.
--
-- claims_barred_at: when they were barred (PUT /claim-barred/:userId). NULL for a user who
--   isn't, which is every user until then. It keeps them from claiming, and from nothing else:
--   the hashtags they moderate stay theirs, and they can still be appointed to one.
-- claims_barred_by: who barred them. No foreign key, which a column added to a table can't be
--   given in every database: once that user is gone, it names nobody.
-- claims_bar_reason: what the moderator said was the reason, if anything. Only moderators read
--   the last two.
ALTER TABLE users ADD COLUMN claims_barred_at bigint;
ALTER TABLE users ADD COLUMN claims_barred_by varchar(36);
ALTER TABLE users ADD COLUMN claims_bar_reason varchar(500);
CREATE INDEX users_claims_barred_idx ON users (claims_barred_at);
