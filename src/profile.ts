import type { Db } from './db/index.js';
import type { UsersTable } from './db/schema.js';

/**
 * A user's profile: what they say of themselves beside their name, which is theirs to set and to
 * take away again, and which anyone reads with the profile (GET /users/:userId).
 *
 *   bio      a text of up to MAX_BIO_CHARS, in the format a post's text is in (src/format.ts), and
 *            stored as it was sent. It mentions nobody: an `@name` in it is the characters;
 *   links    up to MAX_PROFILE_LINKS addresses of where else the user is found, http or https,
 *            in the order they gave them;
 *   avatar   one image, which the server makes of the one the user sends: a square of
 *            AVATAR_SIZE pixels a side, whatever was sent (see standardAvatar), in the content
 *            store (`avatars/<userId>/<avatarId>`).
 *
 * The bio and the links are columns of the user's row, written by PATCH /users/:userId with the
 * rest of it (routes/register.ts). The avatar is a file, so it has routes of its own
 * (routes/profile.ts), and the row names it by an id: an avatar that takes another's place is
 * another file under another id, so two requests that set one at once leave the row naming one
 * whole image, and the file of the one that lost is deleted.
 *
 * All three go through the trust plugins before they are stored, as a post does (see
 * moderateProfile): a bio with a blocked word, a link that spreads malware and an avatar that
 * matches the list of known abuse material are refused. A profile has no moderation queue, so
 * what isn't published is refused. A banned user sets none of them, and can still take them away.
 *
 * Nothing of a banned user's profile is shown to anyone while they are banned (see
 * shownProfile): the profile says that they are banned, and gives no bio, no links, no avatar,
 * no pinned post and none of their posts. That is what a moderator does about a profile that
 * shouldn't be read. It is all in the user's row still, and is shown again once the ban ends.
 *
 * A profile also names the posts its user pinned to it (`pinned_posts`, MAX_PINNED_POSTS at
 * most), and lists the user's posts (GET /users/:userId/posts): both are in routes/profile.ts.
 * The avatar goes out with the profile, and with the user's credit on their posts where a post
 * is read from the database: by its id (GET /content/:contentId) and in the profile's list.
 * Not in feeds, whose credits are read from Redis.
 */

/** The longest bio, in UTF-16 code units. */
export const MAX_BIO_CHARS = 500;
/** The most links a profile gives. */
export const MAX_PROFILE_LINKS = 10;
/** The most posts a user has pinned to their profile at once. */
export const MAX_PINNED_POSTS = 5;
/** The largest image an avatar can be made of, in bytes. What is kept of it is far smaller (see standardAvatar). */
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
/** The side of every avatar, in pixels: enough for a profile's header on a dense screen, and little to send beside a post. */
export const AVATAR_SIZE = 400;
/** The content type every avatar is stored and served as: WebP, which is small at this size and keeps what was transparent. */
export const AVATAR_TYPE = 'image/webp';
/** The quality an avatar is encoded at, of 100. */
const AVATAR_QUALITY = 82;
/** The longest making an avatar of an image may take, in seconds, after which the image is given up as unreadable. */
const AVATAR_SECONDS = 30;

/** Thrown for an image no avatar can be made of: its pixels can't be read, though it is laid out as its format says. */
export class UnreadableAvatar extends Error {
  constructor(cause: unknown) {
    super(`no avatar can be made of the image: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

/**
 * The avatar made of the image in the file at `path`, as the bytes of the file that is stored:
 * a square of AVATAR_SIZE pixels a side, in AVATAR_TYPE, whatever the image's size, shape and
 * format were. So every avatar is the same to lay out and to send, however large a picture its
 * user chose.
 *
 * The image is turned the way it shows (its EXIF Orientation), then cut to the largest square
 * about its middle, and that is brought to the size: down for a large image, up for a small
 * one. What was transparent stays so. Of an animated GIF or WebP it is the first frame: an
 * avatar doesn't move. Its colours are sRGB, and it carries no metadata, as it is encoded anew.
 *
 * Throws UnreadableAvatar for a file whose pixels can't be read, or are damaged.
 */
export async function standardAvatar(path: string): Promise<Buffer> {
  // Loaded when the first avatar is set: a process that sets none never loads libvips, and starts without it.
  const { default: sharp } = await import('sharp');
  // libvips keeps what it read of a file by the file's path, and would give it again for another file written there since. Each file is read once here.
  sharp.cache(false);
  try {
    return await sharp(path, { failOn: 'error' })
      .timeout({ seconds: AVATAR_SECONDS })
      .autoOrient()
      .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: 'centre' })
      .webp({ quality: AVATAR_QUALITY })
      .toBuffer();
  } catch (err) {
    throw new UnreadableAvatar(err);
  }
}

/** The links a user's row holds (`users.links`), in their order. None for a row that holds none, or holds what isn't a list of them. */
export function profileLinks(links: string | null): string[] {
  if (links === null) return [];
  try {
    const parsed: unknown = JSON.parse(links);
    return Array.isArray(parsed) ? parsed.filter((link): link is string => typeof link === 'string') : [];
  } catch {
    return [];
  }
}

/** The links of a profile as the user's row holds them: null for none. */
export const storedLinks = (links: string[]): string | null => (links.length > 0 ? JSON.stringify(links) : null);

/**
 * Where a user's avatar is read (GET /users/:userId/avatar). The address without its query is
 * always the avatar the user has now. `v` names the one it was when the address was given: a
 * reader may keep what that address gave them, as another avatar has another address.
 */
export const avatarUrl = (publicBaseUrl: string, userId: string, avatarId: string) => `${publicBaseUrl}/users/${userId}/avatar?v=${avatarId}`;

/**
 * What a user's row says of their profile beside their name, as the user themselves is given it
 * (the answer to PATCH /users/:userId, and their export): the bio, null for a user who has none,
 * their links, and where their avatar is read, null for one who has none. Whether or not they
 * are banned: what anyone else is shown is `shownProfile`.
 */
export const profileOf = (row: Pick<UsersTable, 'id' | 'bio' | 'links' | 'avatar_id'>, publicBaseUrl: string) => ({
  bio: row.bio,
  links: profileLinks(row.links),
  avatarUrl: row.avatar_id === null ? null : avatarUrl(publicBaseUrl, row.id, row.avatar_id),
});

/**
 * What anyone is shown of a user's profile (GET /users/:userId): whether they are banned
 * (`banned`), and what their row says of them (see profileOf). Of a banned user it is that they
 * are banned and nothing else: no bio, no links and no avatar, whatever the row holds.
 */
export const shownProfile = (row: Pick<UsersTable, 'id' | 'bio' | 'links' | 'avatar_id' | 'banned_at'>, publicBaseUrl: string) =>
  row.banned_at === null ? { banned: false, ...profileOf(row, publicBaseUrl) } : { banned: true, bio: null, links: [], avatarUrl: null };

/**
 * Where anyone reads the avatar of the user of `row`, for a response that credits them: null
 * for a user who has none, and for one who is banned, whose avatar nobody is shown.
 */
export const shownAvatarUrl = (row: Pick<UsersTable, 'id' | 'avatar_id' | 'banned_at'>, publicBaseUrl: string): string | null =>
  row.avatar_id === null || row.banned_at !== null ? null : avatarUrl(publicBaseUrl, row.id, row.avatar_id);

/**
 * The posts a user pinned to their profile, the one pinned last first, each as its row says what
 * a feed's record of it needs, and when it was pinned; none for a user who pinned none. Nor is
 * one here that isn't anyone's to read: one set for deletion, one that waits in the moderation
 * queue, and an entry whose original is gone from its own server (see `withheld`). Its pin is
 * still there, and the post is one of the profile's pinned posts again once it is published
 * again.
 */
export function pinnedPosts(db: Db, userId: string) {
  return db
    .selectFrom('pinned_posts')
    .innerJoin('content', 'content.id', 'pinned_posts.content_id')
    .leftJoin('moderation_queue', 'moderation_queue.content_id', 'content.id')
    .select(['content.id', 'content.user_id', 'content.created_at', 'content.ai_generated', 'content.like_count', 'content.view_count', 'content.dislike_count', 'pinned_posts.created_at as pinned_at'])
    .where('pinned_posts.user_id', '=', userId)
    .where('content.delete_requested_at', 'is', null)
    .where('content.origin_gone_at', 'is', null)
    .where('moderation_queue.content_id', 'is', null)
    .orderBy('pinned_posts.created_at', 'desc')
    .orderBy('pinned_posts.content_id', 'desc')
    .execute();
}
