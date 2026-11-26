import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { authenticate } from '../auth/apiKey.js';
import type { AuthUser } from '../auth/apiKey.types.js';
import { creditOf, summaryOf, type Credit } from '../content.js';
import { lockUser } from '../db/index.js';
import type { RouteDeps } from '../deps.types.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../http/errors.js';
import { decodeCursorJson, encodeCursorJson, invalidCursor } from '../http/listCursor.js';
import { perMinute } from '../http/rateLimitStore.js';
import { Credentials } from '../http/schemas.js';
import { msg } from '../language.js';
import type { Message } from '../language.types.js';
import { moderateProfile } from '../moderation/policy.js';
import { AVATAR_TYPE, avatarUrl, MAX_AVATAR_BYTES, MAX_PINNED_POSTS, pinnedPosts, standardAvatar, UnreadableAvatar } from '../profile.js';
import type { Summary } from '../storage/index.js';
import { toFeedRecord } from '../tagfeed/layout.js';
import type { FeedRecord } from '../tagfeed/layout.types.js';
import { iso } from '../time.js';
import { oneFile, readMultipart, readPost, trustImage } from '../upload.js';
import type { PostFile, Upload } from '../upload.types.js';
import { mapLimit } from '../util.js';
import { sendBytes } from './content.js';

/** The user a path names (/users/:userId/...): whose avatar, whose posts, whose pinned posts. */
const Params = z.object({ userId: z.string().uuid() });
/** The path of a pin: the user whose profile it is, and the post. */
const PinParams = z.object({ userId: z.string().uuid(), contentId: z.string().uuid() });

/** A request with an image in it is the size of the image, in base64 where it is inline. */
const BODY_LIMIT = 16 * 1024 * 1024;

/** The most posts one page of a user's posts holds. */
const MAX_PAGE = 50;

/** Meta files read at once, for the posts of a page that have no summary to be shown with. */
const META_READS = 8;

/**
 * How long a reader may keep an avatar read by the address its profile gave (`avatarUrl`, which
 * names the avatar by its id), as `cache-control` says it: a day. The image at that address
 * never changes, as another avatar has another, but its user may take it away, or delete their
 * account, and a day is how long a copy somebody kept outlasts that.
 */
const AVATAR_CACHE = 'public, max-age=86400';
/**
 * How long a reader may keep an avatar read by any other address: the one with no `v`, which is
 * whatever avatar the user has, or with the id of one they had before. Five minutes, after which
 * it is asked for again, and is the one they have by then.
 */
const AVATAR_CACHE_LATEST = 'public, max-age=300';

/** What PUT /users/:userId/avatar says of the avatar, beside its file part: the image inline, for a JSON request, in base64. */
const AvatarBody = Credentials.extend({
  content: z.string().optional(),
  contentEncoding: z.literal('base64').optional(),
  /** The image's name, where it isn't a file part with one of its own. */
  filename: z.string().max(512).optional(),
});

/** The query of GET /users/:userId/avatar: the id of the avatar the address was given for (see avatarUrl), which says how long it may be kept. */
const AvatarQuery = z.object({ v: z.string().max(64).optional() });

/**
 * The query of GET /users/:userId/posts: the page asked for (`limit`, 20 unless the request says
 * and MAX_PAGE at most, and the `cursor` the page before came with).
 */
const PostsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(20),
  cursor: z.string().optional(),
});

/** Where a page of posts ended, as its cursor says: when the last post was created, and its id. 400 for a cursor that isn't a page of posts'. */
function decodePostCursor(cursor: string): { createdAt: number; id: string } {
  const raw = decodeCursorJson(cursor);
  if (Array.isArray(raw) && raw.length === 2 && Number.isSafeInteger(raw[0]) && typeof raw[1] === 'string' && !raw[1].includes('\0')) return { createdAt: raw[0], id: raw[1] };
  throw invalidCursor();
}

/**
 * What a profile has beside the user's row (src/profile.ts): their avatar, which they set and
 * take away and anyone reads; the list of their posts, for anyone; and the posts they pinned to
 * it. The bio and the links are fields of PATCH /users/:userId, and the profile itself is
 * GET /users/:userId (routes/register.ts). Nothing of it is shown of a user who is banned.
 */
export function profileRoutes(app: FastifyInstance, { db, config, content, summaries, trust, now = Date.now }: RouteDeps) {
  const { dialect } = config.db;
  /** The image an avatar is made of is held to what an image post's image is (see readPost), and to a size of its own. */
  const limits = { tmpPath: config.storage.tmpPath, maxUploadBytes: Math.min(config.storage.maxUploadBytes, MAX_AVATAR_BYTES) };

  /** The caller, who must be the user named in the path: 403, with `refusal`, for anyone else. */
  async function caller(req: FastifyRequest, userId: string, credentials: Credentials, refusal: Message): Promise<AuthUser> {
    const user = await authenticate(db, req, credentials);
    if (user.id !== userId) throw forbidden(refusal);
    return user;
  }

  /** The user `userId` is, with what their credit on a post is made of and whether they are banned (`banned_at`). 404 unless their account is there, and isn't closed. */
  async function requireUser(userId: string) {
    const user = await db.selectFrom('users').select(['id', 'username', 'avatar_id', 'banned_at']).where('id', '=', userId).where('deleted_at', 'is', null).executeTakeFirst();
    if (!user) throw notFound(msg('user.not_found'));
    return user;
  }

  /** Deletes an avatar's file that no row names any more, or never did. One the store keeps is logged: it goes with the account, at the latest. */
  const discard = (req: FastifyRequest, userId: string, avatarId: string) =>
    content.removeAvatar(userId, avatarId).catch((err) => req.log.warn({ err, userId, avatarId }, 'could not delete an avatar that is no longer shown'));

  /**
   * Sets the caller's avatar: one made of the image the request sends, in place of the one they
   * had. JSON with the image inline in `content`, in base64, or multipart with it as the file
   * part, as /store takes a file. A JPEG, PNG, GIF or WebP image of up to MAX_AVATAR_BYTES,
   * checked by its bytes and read without its metadata, as an image post's is.
   *
   * The image goes through the trust plugins first, as a post's images do (see moderateProfile),
   * as it was sent: one that isn't trusted is refused (422), and nothing of it is stored. A
   * banned user sets none (403).
   *
   * What is stored is not the image but the avatar made of it (see standardAvatar): a square of
   * AVATAR_SIZE pixels a side, in AVATAR_TYPE, whatever was sent. 400 for an image whose pixels
   * can't be read.
   *
   * The file is written before the row names it, under an id of its own, so the avatar a profile
   * names is always there to read, and two requests at once leave one whole image. The file of
   * the avatar it replaces is deleted once the row no longer names it.
   */
  app.put('/users/:userId/avatar', { bodyLimit: BODY_LIMIT }, async (req) => {
    const { userId } = Params.parse(req.params);
    let upload: Upload | undefined;
    let image: PostFile | undefined;
    try {
      let raw = (req.body as Record<string, unknown>) ?? {};
      if (req.isMultipart()) {
        const sent = await readMultipart(req, limits);
        raw = sent.fields;
        [upload] = sent.uploads;
      }
      const fields = AvatarBody.parse(raw);
      const user = await caller(req, userId, fields, msg('user.avatar_own_only'));
      if (user.banned) throw forbidden(msg('user.banned_profile'));
      if (!upload && fields.content === undefined) throw badRequest(msg('user.avatar_required'));
      if (upload && fields.content !== undefined) throw badRequest(msg('post.file_or_field'));
      try {
        // Whatever type the file was sent as, its bytes say which image it is.
        image = await readPost({ type: 'image' }, oneFile({ content: fields.content, contentEncoding: 'base64', contentType: 'image/*', filename: fields.filename }, upload), limits);
      } catch (err) {
        if (err instanceof HttpError && err.message === 'post.image_unsupported') throw badRequest(msg('user.avatar_unsupported'));
        throw err;
      }
      await moderateProfile(
        { trust, now, log: req.log, client: { ip: req.ip, userAgent: req.headers['user-agent'] ?? null } },
        { userId, filename: image.filename, image: trustImage(image) },
      );

      // Made of the image the plugins were shown, which waits in a file here.
      const path = await image.file.local();
      if (path === null) throw new Error("the image's bytes aren't in a file here, so no avatar can be made of them");
      const avatar = await standardAvatar(path).catch((err) => {
        if (!(err instanceof UnreadableAvatar)) throw err;
        req.log.info({ err, userId }, 'no avatar could be made of an image');
        throw badRequest(msg('user.avatar_damaged'));
      });
      const avatarId = randomUUID();
      await content.putBytes({ userId, avatar: avatarId }, avatar, AVATAR_TYPE);
      let previous: string | null | undefined;
      try {
        previous = await db.transaction().execute(async (trx) => {
          // First: two avatars set at once take turns, and each knows which one it replaces.
          await lockUser(trx, dialect, userId);
          const row = await trx.selectFrom('users').select('avatar_id').where('id', '=', userId).where('deleted_at', 'is', null).executeTakeFirst();
          if (!row) return undefined;
          await trx.updateTable('users').set({ avatar_id: avatarId, avatar_type: AVATAR_TYPE }).where('id', '=', userId).execute();
          return row.avatar_id;
        });
      } catch (err) {
        await discard(req, userId, avatarId);
        throw err;
      }
      if (previous === undefined) {
        // The account was deleted while this request was under way: its avatars are gone, and this one goes too.
        await discard(req, userId, avatarId);
        throw notFound(msg('user.not_found'));
      }
      if (previous !== null) await discard(req, userId, previous);
      return { userId, avatarUrl: avatarUrl(config.publicBaseUrl, userId, avatarId) };
    } finally {
      // Before the response goes out: a function may be frozen straight after it.
      await upload?.file.release();
      await image?.file.release();
    }
  });

  /** Takes the caller's avatar away, and deletes its file. Taking away an avatar that isn't there changes nothing. A banned user can. */
  app.delete('/users/:userId/avatar', async (req) => {
    const { userId } = Params.parse(req.params);
    await caller(req, userId, Credentials.parse(req.body ?? {}), msg('user.avatar_own_only'));
    const previous = await db.transaction().execute(async (trx) => {
      await lockUser(trx, dialect, userId);
      const row = await trx.selectFrom('users').select('avatar_id').where('id', '=', userId).where('deleted_at', 'is', null).executeTakeFirst();
      if (!row?.avatar_id) return null;
      await trx.updateTable('users').set({ avatar_id: null, avatar_type: null }).where('id', '=', userId).execute();
      return row.avatar_id;
    });
    if (previous !== null) await discard(req, userId, previous);
    return { userId, avatarUrl: null, hadAvatar: previous !== null };
  });

  /**
   * A user's avatar, for anyone: it is what `avatarUrl` names wherever a profile is given. A
   * redirect to the store where it can sign links; else streamed from here, as a post's bytes are
   * (see sendBytes). 404 for a user who has none, for one whose account is closed, and for one
   * who is banned, whose avatar nobody is shown: the answer says which.
   *
   * The address a profile gives names the avatar by its id (`v`), and what it answers may be kept
   * for a day (AVATAR_CACHE). Any other address answers with the avatar the user has now, and is
   * kept a few minutes (AVATAR_CACHE_LATEST): with no `v`, a client that knows only the user
   * shows their avatar.
   *
   * One address gets `avatarRateLimitPerMinute` requests a minute, and is refused past that
   * (429) before anything is read for it (see app.ts): it needs no key.
   */
  app.get('/users/:userId/avatar', { compress: false, config: perMinute(config.avatarRateLimitPerMinute) }, async (req, reply) => {
    const { userId } = Params.parse(req.params);
    const { v } = AvatarQuery.parse(req.query);
    const row = await db.selectFrom('users').select(['avatar_id', 'avatar_type', 'banned_at']).where('id', '=', userId).where('deleted_at', 'is', null).executeTakeFirst();
    if (!row) throw notFound(msg('user.not_found'));
    if (row.banned_at !== null) throw notFound(msg('user.avatar_hidden'));
    if (row.avatar_id === null) throw notFound(msg('user.avatar_not_found'));
    const headers = { 'cache-control': v === row.avatar_id ? AVATAR_CACHE : AVATAR_CACHE_LATEST };
    // Looked for first: another avatar may have taken its place, and its file gone, since the row was read.
    if (!(await sendBytes(reply, content, { userId, avatar: row.avatar_id }, () => row.avatar_type ?? 'application/octet-stream', { staged: true, headers }))) {
      throw notFound(msg('user.avatar_not_found'));
    }
    return reply;
  });

  /**
   * The feed records of `rows`, which are posts of `publisher`'s, in their order: each as a feed
   * gives a post (see toFeedRecord), with all of its likes, and with `publisher` as its credit,
   * which says where their avatar is read (see creditOf). Each is shown with its summary, as in
   * a feed. A post older than summaries are kept (`feed.tagRetentionDays`) has none, and is shown
   * with the one its meta file makes. One with neither is left out: the compactor hasn't written
   * it yet, or has deleted it since the rows were read.
   */
  async function records(rows: { id: string; user_id: string; created_at: number; ai_generated: number; like_count: number }[], publisher: Credit): Promise<FeedRecord[]> {
    const shown: (Summary | null)[] = await summaries.getMany(rows.map((row) => ({ contentId: row.id, createdAt: Number(row.created_at) })));
    await mapLimit(
      [...rows.keys()].filter((i) => !shown[i]),
      META_READS,
      async (i) => {
        const row = rows[i]!;
        const meta = await content.getMeta(row.id);
        if (meta) shown[i] = summaryOf(row, meta, config.publicBaseUrl);
      },
    );
    return rows.flatMap((row, i) => {
      const summary = shown[i];
      return summary ? [toFeedRecord(summary, row.like_count, publisher)] : [];
    });
  }

  /**
   * A user's posts, for their profile: all of them, newest first, a page at a time. `posts` is
   * the page, each post as a feed gives one, with where its publisher's avatar is read (see
   * `records`), and `nextCursor` is what the next page is asked for with, null on the last. The
   * first page also has `pinned`: the posts the user pinned to their profile, the one pinned
   * last first, as records like the others, and none if they pinned none (see pinnedPosts). A
   * pinned post keeps its place among the others too. 404 for a user who isn't there, and for
   * one whose account is closed.
   *
   * It is for anyone, with no key, as a post is, and lists only what anyone can read: no post
   * set for deletion, none that waits in the moderation queue, and no entry whose original is
   * gone from its own server. And only as the compactor last wrote them: a post is listed once
   * it is in feeds. What the user reposted is other users' posts, and isn't listed.
   *
   * `banned` says whether the user is banned. A banned user's profile lists nothing: the answer
   * says that they are banned, and has no post and no pinned post, on any page. Their posts are
   * where they were otherwise, in feeds and by their ids: a ban is on what a user adds, and on
   * what their profile shows.
   *
   * The posts are read from the database, by the index of a user's content in the order they
   * were created (`content_user_created_idx`): the publisher's own index in the feed index
   * (`@<userId>`) only goes back as far as feeds do, and a profile lists every post. So it is in
   * the group of routes that open a database (see functions/groups.ts), and one address gets
   * `profilePostsRateLimitPerMinute` requests a minute, and is refused past that (429) before
   * anything is read for it (see app.ts).
   */
  app.get('/users/:userId/posts', { config: perMinute(config.profilePostsRateLimitPerMinute) }, async (req) => {
    const { userId } = Params.parse(req.params);
    const { limit, cursor } = PostsQuery.parse(req.query);
    const after = cursor === undefined ? undefined : decodePostCursor(cursor);
    const user = await requireUser(userId);
    if (user.banned_at !== null) return { userId, banned: true, ...(after === undefined && { pinned: [] }), posts: [], nextCursor: null };

    const createdAt = sql.ref<number>('content.created_at');
    const id = sql.ref<string>('content.id');
    let query = db
      .selectFrom('content')
      .leftJoin('moderation_queue', 'moderation_queue.content_id', 'content.id')
      .select(['content.id', 'content.user_id', 'content.created_at', 'content.ai_generated', 'content.like_count'])
      .where('content.user_id', '=', userId)
      .where('content.delete_requested_at', 'is', null)
      .where('content.origin_gone_at', 'is', null)
      .where('moderation_queue.content_id', 'is', null)
      // Both the same way, which is the order the index has a user's posts in, read from its end.
      .orderBy('content.created_at', 'desc')
      .orderBy('content.id', 'desc')
      .limit(limit + 1);
    if (after) query = query.where(sql<boolean>`(${createdAt} < ${after.createdAt} or (${createdAt} = ${after.createdAt} and ${id} < ${after.id}))`);
    const found = await query.execute();
    const rows = found.slice(0, limit);
    const last = rows.at(-1);

    const credit = creditOf({ user_id: user.id, ...user }, config.publicBaseUrl);
    // With the first page alone, which is where a profile shows them: above the others.
    const pins = after === undefined ? await pinnedPosts(db, userId) : undefined;
    return {
      userId,
      banned: false,
      ...(pins && { pinned: await records(pins, credit) }),
      posts: await records(rows, credit),
      nextCursor: found.length > limit && last ? encodeCursorJson([Number(last.created_at), last.id]) : null,
    };
  });

  /**
   * Pins a post to the caller's profile: one of their own, which the profile then names (among
   * its `pinnedContentIds`) and the list of their posts gives ahead of the others (`pinned`). A
   * profile has MAX_PINNED_POSTS pinned posts at most: one more is refused (409) until another
   * is unpinned. Pinning a post that is pinned changes nothing, and it keeps its place among
   * the pinned posts.
   *
   * 404 for a post that isn't there, or is set for deletion; 403 for another user's. A post of
   * the caller's that waits in the moderation queue can be pinned, and is shown as a pinned
   * post once it is published (see pinnedPosts): it counts as one of the profile's pinned posts
   * meanwhile. One that is set for deletion doesn't: its pin goes with it. A banned user's
   * profile keeps its pins, which nobody is shown while they are banned, and they can change
   * them: a pin shows nothing that isn't already theirs and published.
   */
  app.put('/users/:userId/pinned/:contentId', async (req, reply) => {
    const { userId, contentId } = PinParams.parse(req.params);
    await caller(req, userId, Credentials.parse(req.body ?? {}), msg('user.pin_own_only'));
    const ts = now();
    const pinned = await db.transaction().execute(async (trx) => {
      // First: a user's pins take turns, so each counts the ones before it.
      await lockUser(trx, dialect, userId);
      const post = await trx.selectFrom('content').select('user_id').where('id', '=', contentId).where('delete_requested_at', 'is', null).executeTakeFirst();
      if (!post) throw notFound(msg('content.not_found'));
      if (post.user_id !== userId) throw forbidden(msg('user.pin_own_posts_only'));
      const pins = await trx
        .selectFrom('pinned_posts')
        .innerJoin('content', 'content.id', 'pinned_posts.content_id')
        .select(['pinned_posts.content_id', 'pinned_posts.created_at'])
        .where('pinned_posts.user_id', '=', userId)
        .where('content.delete_requested_at', 'is', null)
        .execute();
      const before = pins.find((pin) => pin.content_id === contentId);
      if (before) return { at: Number(before.created_at), already: true };
      if (pins.length >= MAX_PINNED_POSTS) throw conflict(msg('user.pin_limit', { max: MAX_PINNED_POSTS }));
      await trx.insertInto('pinned_posts').values({ user_id: userId, content_id: contentId, created_at: ts }).execute();
      return { at: ts, already: false };
    });
    return reply.status(pinned.already ? 200 : 201).send({ userId, contentId, pinnedAt: iso(pinned.at), alreadyPinned: pinned.already });
  });

  /** Takes a post off the caller's profile, where it was pinned. Unpinning a post that isn't pinned changes nothing. */
  app.delete('/users/:userId/pinned/:contentId', async (req) => {
    const { userId, contentId } = PinParams.parse(req.params);
    await caller(req, userId, Credentials.parse(req.body ?? {}), msg('user.pin_own_only'));
    const removed = await db.deleteFrom('pinned_posts').where('user_id', '=', userId).where('content_id', '=', contentId).executeTakeFirst();
    return { userId, contentId, wasPinned: Number(removed.numDeletedRows) === 1 };
  });
}
