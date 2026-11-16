-- 0009_last_post_at
--
-- When the user last posted, through /store or /federated. A post less than
-- CHALLENGE_POST_WINDOW_SECONDS after it must solve a challenge first. A post claims the window with
-- a conditional update, so of several concurrent posts only one passes without a challenge, and a
-- post that fails sets it back to null. Null: no post that counts.
ALTER TABLE users ADD COLUMN last_post_at bigint;
