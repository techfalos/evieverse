-- 0019_splash
--
-- A profile has a splash image beside its avatar: the picture a profile's page opens with, which
-- is the user's to set and to take away again (PUT and DELETE /users/:userId/splash), and anyone's
-- to read (GET /users/:userId/splash). It is the image the user sent, whatever its size and
-- shape, without its metadata: the server makes nothing else of it, as it does of an avatar.
--
-- splash_id: the id of the user's splash image, which names its file in the content store
--   (splashes/<user id>/<splash id>): another image is another id, and another file, as with
--   avatar_id (0012_profiles). NULL for a user who has none. The row of a closed account is
--   deleted only once this is NULL again, which is once the file is gone (see
--   dropProfileImages in src/accounts.ts).
-- splash_type: the content type of that file, which is the one its bytes are of: image/jpeg,
--   image/png, image/gif or image/webp. A content store that keeps no types (fs) has it from
--   here. NULL with splash_id.
ALTER TABLE users ADD COLUMN splash_id varchar(36);
ALTER TABLE users ADD COLUMN splash_type varchar(64);
