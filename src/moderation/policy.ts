import type { AuthUser } from '../auth/apiKey.types.js';
import type { Db } from '../db/index.js';
import type { ModeratorRole } from '../db/schema.js';
import { plainText } from '../format.js';
import { forbidden, unprocessable } from '../http/errors.js';
import { msg } from '../language.js';
import type { Moderated, ModerationDeps } from './policy.types.js';
import type { TrustEngine } from './trust.js';
import type { Moderation, ReadImage, TrustImage, TrustRoute } from './trust.types.js';

/**
 * Whether `user` works through the server's moderation queue: reads it and the content that waits
 * in it, and accepts or rejects that content. And through its report queue: accepts or deletes the
 * content users reported. A server moderator, or an admin. Both moderate every hashtag too (see
 * moderates).
 */
export const moderatesServer = (user: AuthUser): boolean => user.admin || user.moderator;

/**
 * Whether `user` can moderate `tag`: an admin or a server moderator, who moderate every hashtag
 * and need no row for it, or one of the tag's moderators.
 */
export async function moderates(db: Db, user: AuthUser, tag: string): Promise<boolean> {
  if (moderatesServer(user)) return true;
  return (await db.selectFrom('tag_moderators').select('tag').where('tag', '=', tag).where('user_id', '=', user.id).executeTakeFirst()) !== undefined;
}

/**
 * The hashtags among `tags` that `user` moderates (see moderates): all of them for an admin or a
 * server moderator, and for anyone else the ones they are a moderator of. None for no user. They
 * are the hashtags whose moderators the user is told by name, where a post's record says what
 * was decided about it (see tagActionItem).
 */
export async function moderatedAmong(db: Db, user: AuthUser | null, tags: string[]): Promise<Set<string>> {
  if (!user || !tags.length) return new Set();
  if (moderatesServer(user)) return new Set(tags);
  return new Set((await db.selectFrom('tag_moderators').select('tag').where('user_id', '=', user.id).where('tag', 'in', tags).execute()).map((r) => r.tag));
}

/**
 * As what `user` moderates a hashtag, for one who does (see moderates): an admin, a server
 * moderator, or with neither role, one of the hashtag's own moderators. It is what a post's record
 * of a decision says of who made it (`tag_moderation_log`), to those it doesn't name them to.
 */
export const moderatorRole = (user: AuthUser): ModeratorRole => (user.admin ? 'admin' : user.moderator ? 'server_moderator' : 'tag_moderator');

/**
 * Refuses (403) a user who was banned: what writes a post, a comment or a message, likes a post or
 * a comment, or gives a link to upload a post's file with, is not for them. Reading, their inbox,
 * their own posts' deletion and their own account (its settings, its key, its deletion) are.
 */
export function refuseBanned(user: AuthUser): void {
  if (user.banned) throw forbidden(msg('user.banned'));
}

/** Makes a user an admin, or not; null if there's no such user. A userId wins over a username that happens to look like one. */
export async function setAdmin(db: Db, user: string, admin: boolean): Promise<{ userId: string; username: string } | null> {
  const select = db.selectFrom('users').select(['id', 'username']).where('deleted_at', 'is', null);
  const row = (await select.where('id', '=', user).executeTakeFirst()) ?? (await select.where('username', '=', user).executeTakeFirst());
  if (!row) return null;
  await db.updateTable('users').set({ admin: admin ? 1 : 0 }).where('id', '=', row.id).execute();
  return { userId: row.id, username: row.username };
}

/**
 * The images as the trust plugins are given them: each read to a file here, with its hash. None
 * on a server none of whose plugins reads images: nothing of an image is read for them, and one
 * sent with an upload link stays in the content store.
 */
async function read(trust: TrustEngine, images: (TrustImage | undefined)[]): Promise<ReadImage[]> {
  if (!trust.readsImages) return [];
  const read: ReadImage[] = [];
  for (const image of images) {
    if (image) read.push({ mimeType: image.mimeType, filename: image.filename, file: await image.file(), sha256: await image.sha256() });
  }
  return read;
}

/** The texts there are among these: what is neither absent nor empty. */
const said = (texts: (string | null | undefined)[]): string[] => texts.filter((text): text is string => !!text);

/** What moderation answered; throws 422, with what the sender is told, for what it refused: nothing of that is stored. */
function settled<T>(answer: Moderation<T>): T {
  if ('ok' in answer) return answer.ok;
  const { message, removedTags } = answer.refused;
  throw unprocessable(message, removedTags && { removedTags });
}

/**
 * Moderation of a new comment by `userId` on the post `contentId`, or of an edit of one. It goes
 * through the gate a post does: the same trust plugins give it a score, each told it is a comment,
 * and the same thresholds say where the score sends it (`config.trust`). What there
 * is of it to read is its text, the name of the image or video it comes with (`filename`) and
 * what describes that image (`alt`), as a post's caption, filename and alternative texts are;
 * `image` is the image it comes with, if it is one, as a post's
 * are given, and `aiGenerated` whether its author declares that it was created with AI, which
 * the plugins are told. Throws 422 for a comment whose score has it deleted: nothing of it is stored.
 *
 * That is all of it. A comment has no hashtags, so what a hashtag's moderators keep (its blocked
 * words, its mutes) doesn't reach the comments on posts under it: they have no say over comments.
 */
export async function moderateComment(
  { trust, now = Date.now, log, client }: ModerationDeps,
  comment: { userId: string; contentId: string; text: string; filename?: string | null; alt?: string; image?: TrustImage; aiGenerated?: boolean },
): Promise<{ trustScore: number; route: Exclude<TrustRoute, 'delete'> }> {
  const [image] = await read(trust, [comment.image]);
  // Its text as its readers read it: without its formatting, with where its links lead (format.ts).
  const sent = {
    userId: comment.userId,
    contentId: comment.contentId,
    texts: said([plainText(comment.text, true), comment.filename, comment.alt]),
    ...(image && { image }),
    ...(comment.aiGenerated && { aiGenerated: true }),
  };
  return settled(await trust.ask('moderateComment', now(), { client, sent }, log));
}

/**
 * Moderation of what `userId` puts on their profile: a bio, links, an avatar, a splash image, or
 * whichever of them the request sets. It goes through the gate a post does: the same trust
 * plugins give it a score, each told it is a profile. What there is of it to read is the bio, as
 * its readers read it, the links, and the name the avatar or the splash image was sent with
 * (`filename`); `image` is that image, as a post's images are given, and `splash` says that it
 * is the splash image, and not the avatar.
 *
 * A profile has no moderation queue to wait in, so the score has one of two outcomes: it is
 * published, or it is refused. Throws 422 for one whose score doesn't publish it, which is
 * what a post's would have it deleted for, and what a post's would have it held for: nothing
 * of it is stored.
 *
 * That is all of it. A profile has no hashtags, so no hashtag's moderators have a say over it.
 */
export async function moderateProfile(
  { trust, now = Date.now, log, client }: ModerationDeps,
  profile: { userId: string; bio?: string | null; links?: string[] | null; filename?: string | null; image?: TrustImage; splash?: boolean },
): Promise<void> {
  const [image] = await read(trust, [profile.image]);
  // The bio as its readers read it: without its formatting, with where its links lead (format.ts).
  const sent = {
    userId: profile.userId,
    texts: said([profile.bio ? plainText(profile.bio, true) : null, ...(profile.links ?? []), profile.filename]),
    ...(image && { image }),
    ...(profile.splash && { splash: true }),
  };
  settled(await trust.ask<null>('moderateProfile', now(), { client, sent }, log));
}

/**
 * Moderation of a new post, or of an update of `contentId`, by `userId` with `tags`. `texts` is what
 * there is of it to read: its text or caption, link, and filename. `images` is an image post's
 * images, for the plugins that look at pictures (see trustImage). `aiGenerated` is whether the
 * post is declared as created with AI, which the plugins are told.
 *
 * The post is given a trust score by the trust plugins, each of which may lower it,
 * and the score says where the post goes (`config.trust` holds the thresholds). Throws
 * 422 for a post whose score has it deleted: nothing of it is stored.
 *
 * Returns the hashtags the post gets, and those it doesn't with why: one its publisher is muted on,
 * one a moderator removed from this content, and one whose blocked words it has, or whose blocked
 * patterns match it. Hashtags are scanned for blocked words too. Throws 422 if a new post is left
 * with no hashtag, since it needs one to be published under. An update can be: the content is
 * there already, and stays, in no hashtag's feed.
 */
export async function moderatePost(
  { trust, now = Date.now, log, client }: ModerationDeps,
  post: { userId: string; contentId?: string; tags: string[]; texts: (string | null | undefined)[]; images?: TrustImage[]; aiGenerated?: boolean },
): Promise<Moderated> {
  const images = await read(trust, post.images ?? []);
  const sent = {
    userId: post.userId,
    contentId: post.contentId,
    tags: post.tags,
    texts: said(post.texts),
    ...(images.length && { images }),
    ...(post.aiGenerated && { aiGenerated: true }),
  };
  return settled(await trust.ask('moderatePost', now(), { client, sent }, log));
}

/**
 * What a repost's hashtags are held to: what the post's publisher's own are, as far as the
 * hashtags go. Returns the ones the content gets, and those it doesn't with why: one the reposter
 * or the content's publisher is muted on (a mute keeps a user's posts out of the hashtag, whoever
 * would put them there), one a moderator removed from this content, and one whose blocked words
 * the content has. `texts` is what there is of the content to read, as for a post.
 *
 * No trust score is worked out: the content got one when it was written, and a repost changes
 * nothing of what it says.
 */
export async function moderateRepost(
  { trust, now = Date.now, log }: Pick<ModerationDeps, 'trust' | 'now' | 'log'>,
  repost: { userId: string; publisherId: string; contentId: string; tags: string[]; texts: (string | null | undefined)[] },
): Promise<Pick<Moderated, 'tags' | 'removedTags'>> {
  return settled(await trust.ask('moderateRepost', now(), { sent: { ...repost, texts: said(repost.texts) } }, log));
}
