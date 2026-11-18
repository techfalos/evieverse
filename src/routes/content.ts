import { randomInt } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { attest, signingKeys } from '../attestation.js';
import { authenticate } from '../auth/apiKey.js';
import { contentNotFound, creditOf, imageNotFound, imagesOf, loadPublished, loadReadable, ORIGIN_GONE, PENDING_REVIEW, PROCESSING, publisherOf, requireMeta, requirePost, takesComments, videoProcessing } from '../content.js';
import { setForDeletion } from '../deletion.js';
import type { AppDeps } from '../deps.types.js';
import { badRequest, forbidden, HttpError, notFound } from '../http/errors.js';
import { say } from '../http/language.js';
import { perMinute } from '../http/rateLimitStore.js';
import { Credentials } from '../http/schemas.js';
import { notify } from '../inbox.js';
import { msg } from '../language.js';
import { tagActionItem, tagActions } from '../moderation/tagDecisions.js';
import { adRecord, eligibleAds } from '../monetization.js';
import type { PublishedAd } from '../monetization.types.js';
import { payloadBytes, pendingImage, pendingPost } from '../pending.js';
import { altsOf, imageCount, imageUrl, originMediaUrl, ownAddress, postAddress, previewOf, videoFileUrl } from '../posts.js';
import { MEDIA_FILE, type BytesOwner, type ContentStore, type Publisher } from '../storage/index.js';
import { indexAuthor } from '../tagfeed/layout.js';
import { DAY, iso } from '../time.js';
import { videoFileType } from '../video/files.js';

/** The path of a piece of content: its id. */
const Params = z.object({ contentId: z.string().uuid() });

/** The path of one image of an image post: the post's id, and the image's place among its images, counted from 1. */
const ImageParams = Params.extend({ image: z.coerce.number().int().min(1) });

/** The path of a file of a post's processed video: the post's id, the id of the version of its video, and the file's name (see MEDIA_FILE). */
const VideoParams = Params.extend({ videoId: z.string().uuid(), file: z.string().regex(MEDIA_FILE) });

/**
 * How long a reader may keep a file of a processed video, as `cache-control` says it: a day.
 * The file never changes (a new video has a new address), but its post may be deleted, or
 * taken back to the moderation queue, and a day is how long a copy somebody kept outlasts that.
 */
const VIDEO_FILE_CACHE = 'public, max-age=86400';

/** 404 for a file a post's processed video doesn't have, and for any of a post that has no such video. */
const videoFileNotFound = () => notFound(msg('content.video_file_not_found'));

/**
 * Sent with a post's bytes, which are a user's, when this server streams them, and with those of
 * the image or video of a comment (routes/comments.ts). A browser takes them for the content type
 * they are sent with and never guesses another from the bytes (a video or audio file's type is
 * its sender's word), and a page opened on them runs no script, sends no form, and loads nothing
 * but the file itself.
 *
 * The page is also put in an origin of its own, not the API's, except a video's or audio's: the
 * player a browser builds around one fetches the file again, which Chrome refuses a page that
 * isn't in the file's origin. It runs no script there either.
 */
export function rawHeaders(contentType: string) {
  return {
    'x-content-type-options': 'nosniff',
    'content-security-policy':
      `default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; ${/^(video|audio)\//.test(contentType) ? 'sandbox allow-same-origin' : 'sandbox'}`,
  };
}

/**
 * Answers with the bytes of `of`: a redirect to the store where it can sign links, else streamed
 * from here, with the size the store gives for them, and the content type it keeps or, where it
 * keeps none, the one `typeOf` gives. A user's file streamed from here goes out as something to
 * show and nothing more (see rawHeaders).
 *
 * `staged`: the bytes are a staged file, which the compactor deletes once it has made it its
 * post's or its comment's. They are looked for first, and false is returned, with nothing sent,
 * if they are gone: they are then where the post's, or the comment's, are kept. So are the
 * bytes of an image after the first of an image post, which an update with fewer images
 * deletes: false is returned for one that is gone. `headers` go out with bytes that are
 * streamed from here, and not with a redirect.
 */
export async function sendBytes(
  reply: FastifyReply,
  content: ContentStore,
  of: BytesOwner,
  typeOf: () => Promise<string> | string,
  { staged = false, headers = {} }: { staged?: boolean; headers?: Record<string, string> } = {},
): Promise<boolean> {
  const found = staged ? await content.statIfThere(of) : undefined;
  if (found === null) return false;
  const signed = await content.signedUrl(of);
  if (signed) {
    reply.redirect(signed, 302);
    return true;
  }
  const { size, contentType } = found ?? (await content.stat(of));
  const bytes = staged ? await content.streamIfThere(of) : await content.stream(of);
  if (!bytes) return false;
  const type = contentType ?? (await typeOf());
  reply.headers({ ...rawHeaders(type), ...headers });
  reply.header('content-type', type);
  reply.header('content-length', String(size));
  reply.send(bytes);
  return true;
}

/** Reading content. Its deletion is a route of its own (deletionRoutes), so the two can be served apart. */
export function contentRoutes(app: FastifyInstance, { db, config, content, ads, now = Date.now }: AppDeps) {
  /** The key this server signs attestations with: the first of its keys. None: it attests nothing. */
  const [signingKey] = signingKeys(config.reposts.signingKeys);
  /** This server's own address, which the address an attestation gives a post starts with. */
  const ownBase = ownAddress(config.publicBaseUrl);

  /**
   * The ad to show at the end of a post that carries `tags`, where the server shows ads there
   * (MONETIZATION_POST_ADS): any one of the ads the compactor published to Redis (AdStore) that
   * are being shown now and that appear all the time or are targeted at one of the post's
   * hashtags. None where there is none, and none if they can't be read: the post is still read.
   */
  async function postAd(req: FastifyRequest, tags: string[]): Promise<PublishedAd | undefined> {
    if (!config.monetization.postAds) return undefined;
    try {
      const eligible = eligibleAds(await ads.get(), tags, now());
      return eligible.length ? eligible[randomInt(eligible.length)] : undefined;
    } catch (err) {
      req.log.error({ err }, 'could not read the ads; the post goes out without one');
      return undefined;
    }
  }

  /**
   * retrieve_content: the publisher's credit first (their userId and username, and where their
   * avatar is read, `avatarUrl`, if they have one: see creditOf), then the preview, the
   * whole text or caption, and hashtags. `status: "pending_review"` on content that waits in the
   * moderation queue. Who may read it is in loadReadable. `ad`, last, is the ad to show at the
   * end of the post (see postAd); content that waits in the moderation queue has none.
   *
   * `mentions`, on a post whose text or caption mentions users (src/mentions.ts): each with the
   * name the text has them by. The text and the preview are read with them, to show each
   * `@name` of theirs as a link to the user's profile (see parseFormatted).
   *
   * `reposts`, on a post that was reposted (src/reposts.ts): each repost, oldest first, with who
   * made it, the hashtags it gave the post that the post still has from it, and when. `likes` is
   * the post's one count, all of them, whichever feed a like came from.
   *
   * `moderation`, on a post a hashtag's moderator decided about (src/moderation/tagDecisions.ts):
   * the post's record of it, oldest first. Each says what was done (`tag_removed`, or
   * `tag_approved`) under which hashtag, as what the moderator did it (`by`: `tag_moderator`,
   * `server_moderator` or `admin`, and never who), when, the `reason` a removal was given, and
   * the words to show a reader (`text`), in the language the request is answered in: "#cars was
   * removed from this post by a moderator of the hashtag: it has no cars in it".
   *
   * `images`, on an image post: its images in their order, each with where it is read
   * (`contentUrl` for the first, and `contentUrl`/2, /3 and so on for the ones after it), its
   * content type and its size. One for a post of one image, several for an album, whose preview
   * says how many (`imageCount`). `mimeType` and `size` are the first's. An image its publisher
   * described has that as its `alt`, the text to give it for those who can't see it, and the
   * preview has them all, in the images' order (`alt`).
   *
   * `preview.video`, on a video post whose video the server processed (src/video): its size
   * and length, a poster to show before it plays (`poster`), and its adaptive stream (`hls`,
   * see GET /content/:contentId/video/:videoId/:file). `contentUrl` is then an MP4 that plays
   * anywhere. `processing: true` on a post whose video is still being processed: it is read as
   * it was written, but is in no feed yet, and its video isn't there to play (see /raw).
   *
   * `origin`, on a repost of a post on another server: the original's address and who published
   * it there, with `publisher` the one who reposted it here, and `attestedAt`, when the original's
   * server signed what is shown of it here (see POST /repost/refresh). The preview is the
   * original's, and so are the bytes, which this server doesn't hold: `contentUrl` leads to them, and there is no
   * `size` or whole `text` to give.
   *
   * `status: "origin_gone"` on such a repost whose original's server says it publishes no post
   * there any more: it is hidden, and read only by who may read what waits in the moderation
   * queue (see loadReadable). `origin` then says since when (`goneAt`), and when the entry is
   * deleted unless the post is attested again before (`deleteAfter`). It has no ad either.
   *
   * One address gets `contentRateLimitPerMinute` requests a minute, and is refused past that
   * (429) before anything is read for it (see app.ts): it needs no key.
   */
  app.get('/content/:contentId', { config: perMinute(config.contentRateLimitPerMinute) }, async (req) => {
    const { contentId } = Params.parse(req.params);
    const row = await loadReadable(db, req, contentId);
    // The row says whose the content is and how liked; what it is, is in the meta file beside its bytes.
    const [{ meta, processing }, reposts, actions] = await Promise.all([requirePost({ db, content }, contentId), repostsMade(contentId), tagActions(db, contentId)]);
    const ad = row.queued || row.gone ? undefined : await postAd(req, meta.tags);
    return {
      publisher: creditOf(row, config.publicBaseUrl),
      contentId: row.id,
      ...(row.queued && PENDING_REVIEW),
      ...(row.gone && ORIGIN_GONE),
      ...(processing && PROCESSING),
      preview: previewOf(meta, config.publicBaseUrl),
      ...(meta.text !== undefined && { text: meta.text }),
      ...(meta.mentions?.length && { mentions: meta.mentions }),
      tags: meta.tags,
      likes: row.like_count,
      mimeType: meta.mimeType,
      aiGenerated: row.ai_generated === 1,
      comments: takesComments(meta),
      ...(!meta.origin && { size: meta.size }),
      contentUrl: `/content/${row.id}/raw`,
      ...(imagesOf(meta) && { images: imagesOf(meta) }),
      createdAt: iso(row.created_at),
      updatedAt: iso(meta.updatedAt),
      ...(reposts.length > 0 && { reposts }),
      ...(actions.length > 0 && { moderation: actions.map((action) => tagActionItem(action, (text) => say(req, text))) }),
      ...(meta.origin && {
        origin: {
          ...meta.origin,
          ...(meta.originAttestedAt !== undefined && { attestedAt: iso(meta.originAttestedAt) }),
          ...(row.origin_gone_at !== null && { goneAt: iso(Number(row.origin_gone_at)), deleteAfter: iso(Number(row.origin_gone_at) + config.reposts.goneDays * DAY) }),
        },
      }),
      ...(ad && { ad: adRecord(ad, say(req, msg('ad.sponsored')), config.publicBaseUrl) }),
    };
  });

  /**
   * The reposts of a piece of content, oldest first: one for each user and time in `reposts`,
   * with the hashtags it gave. `by` is left out of one whose user's account is gone, or closed.
   */
  async function repostsMade(contentId: string): Promise<{ by?: Publisher; tags: string[]; at: string }[]> {
    const made = new Map<string, { by?: Publisher; tags: string[]; at: string }>();
    for (const r of await db
      .selectFrom('reposts')
      .leftJoin('users', (join) => join.onRef('users.id', '=', 'reposts.user_id').on('users.deleted_at', 'is', null))
      .select(['reposts.tag', 'reposts.created_at', 'users.id as user_id', 'users.username'])
      .where('reposts.content_id', '=', contentId)
      .orderBy('reposts.created_at')
      .orderBy('reposts.tag')
      .execute()) {
      const key = `${r.created_at} ${r.user_id ?? ''}`;
      let repost = made.get(key);
      if (!repost) made.set(key, (repost = { ...(r.user_id !== null && r.username !== null && { by: { userId: r.user_id, username: r.username } }), tags: [], at: iso(r.created_at) }));
      // The row of the reposter's own index says the repost was made, and names no hashtag.
      if (indexAuthor(r.tag) === null) repost.tags.push(r.tag);
    }
    return [...made.values()];
  }

  /**
   * The attestation of a post: what this server says the post is, signed with its key, for
   * whoever reposts the post on another server to carry there (src/attestation.ts). It says the
   * post's address here, its publisher, its content type, its AI declaration and its preview
   * (with how many images it has, for an image post of several, the alternative texts of its
   * images, and what a processed video is: see StoredVideo), as of now. For anyone, with no key: a post anyone can repost is one anyone can read. It is good
   * for a few minutes, so it is asked for when it is used, and nothing in between keeps it.
   *
   * Only of a published post: one that waits in the moderation queue, or is set for deletion, is
   * 404 here even to its publisher, since nobody else is to be told what it says. And only of a
   * post that is this server's to speak for. A repost of a post on another server isn't: it is
   * 409, with the original's address in `origin`, which is where its attestation is had.
   *
   * A 404 here is signed too: beside its `error` it carries `gone`, an attestation that says no
   * post is published at the address (see AttestedGone). It is what tells a server that holds a
   * repost of the post to hide it (POST /repost/refresh there, or that server's own asking, see
   * src/originSweep.ts), and to delete it if the post stays gone. It is given
   * for whatever isn't published, which is all a 404 says of it: a post that was deleted, one that
   * waits in the moderation queue, and an id that was never a post's. A new post whose video is
   * still being processed isn't published yet either; an update that is, is attested as the
   * post was before it.
   *
   * 400 on a server that signs nothing (it has no REPOSTS_SIGNING_KEYS, or no PUBLIC_BASE_URL to
   * say where its posts are). Its 404 is a bare one.
   *
   * One address gets `reposts.attestationRateLimitPerMinute` requests a minute, and is refused
   * past that (429) before anything is read or signed for it (see app.ts): it needs no key, and
   * signs an answer for any id at all.
   */
  app.get('/content/:contentId/attestation', { config: perMinute(config.reposts.attestationRateLimitPerMinute) }, async (req, reply) => {
    const { contentId } = Params.parse(req.params);
    /** The 404 of a post that isn't published, signed where this server signs (see above). */
    const unpublished = (err: unknown) => {
      if (!(err instanceof HttpError) || err.statusCode !== 404 || !signingKey || ownBase === null) return err;
      const gone = attest(signingKey, { url: postAddress(ownBase, contentId.toLowerCase()), gone: true }, now());
      return new HttpError(404, err.text, undefined, { gone }, { 'cache-control': 'no-store' });
    };
    const row = await loadPublished(db, contentId).catch((err) => {
      throw unpublished(err);
    });
    const post = await requirePost({ db, content }, contentId);
    // A write whose video is still being processed isn't published yet: what is, is the post as it was before, or nothing.
    const meta = post.processing ? await content.getMeta(contentId) : post.meta;
    if (!meta) throw unpublished(contentNotFound());
    if (meta.origin) throw new HttpError(409, msg('attestation.is_repost', { url: meta.origin.url }), undefined, { origin: { url: meta.origin.url } });
    if (!signingKey || ownBase === null) throw badRequest(msg('attestation.off'));
    const { preview } = meta;
    const text = preview.kind !== 'text' && preview.kind !== 'link' && preview.text ? { text: preview.text } : {};
    const alt = altsOf(preview);
    const video = preview.kind === 'video' ? preview.video : undefined;
    reply.header('cache-control', 'no-store');
    return {
      attestation: attest(
        signingKey,
        {
          url: postAddress(ownBase, row.id),
          publisher: publisherOf(row),
          mimeType: meta.mimeType,
          aiGenerated: row.ai_generated === 1,
          preview:
            preview.kind === 'text'
              ? { kind: 'text', text: preview.text }
              : preview.kind === 'link'
                ? { kind: 'link', url: preview.url }
                : preview.kind === 'image'
                  ? { kind: 'image', ...text, ...(imageCount(preview) > 1 && { imageCount: imageCount(preview) }), ...(alt && { alt }) }
                  : preview.kind === 'video'
                    ? { kind: 'video', ...text, ...(video && { video: { id: video.id, width: video.width, height: video.height, duration: video.duration } }) }
                    : { kind: 'audio', ...text },
        },
        now(),
      ),
    };
  });

  /**
   * The content's bytes as they are now: an update writes over them. A redirect to the store where
   * it can sign links; else streamed from here, with the size the store gives for them, and the
   * content type it keeps or, where it keeps none, the meta file's. Who may read them is who may
   * read the content (see loadReadable).
   *
   * Streamed from here, a user's file is served from the API's own origin, so it goes out as
   * something to show and nothing more (see rawHeaders), and never compressed: they are the
   * bytes as stored, with their size.
   *
   * A repost of a post on another server has no bytes of its own here: it is a link to the
   * original, and this is a redirect to the original's bytes, on its own server.
   *
   * A write the compactor hasn't applied yet is served as written, like the content itself (see
   * requireMeta): a file from where it is staged, and a text or a link's URL from the write's
   * row, which holds it.
   *
   * Not a video the server is still processing (src/video): the file as it was sent is never
   * served, since it says what the processed one doesn't (where it was filmed, and when). Until
   * it is ready, an update's bytes are the ones the post had, and a new post has none: 404,
   * which says so. Once it is, these are an MP4 that plays anywhere.
   *
   * Of an image post of several images, these are the first's: each of the others is at
   * /raw/:image.
   */
  app.get('/content/:contentId/raw', { compress: false }, async (req, reply) => {
    const { contentId } = Params.parse(req.params);
    return sendRaw(req, reply, contentId, 1);
  });

  /**
   * The bytes of one image of an image post, by its place among the post's images, counted from
   * 1: /raw/2 is the second image of an album, and /raw/1 is /raw. They are read as /raw reads
   * the post's bytes, by whoever may read those, from wherever the image is by now: staged,
   * for a write the compactor hasn't applied, or with the post's bytes. 404 past the last of
   * the post's images, which for a post that isn't an album is any after the first.
   *
   * On a repost of a post on another server, a redirect to that image of the original, on its
   * own server.
   */
  app.get('/content/:contentId/raw/:image', { compress: false }, async (req, reply) => {
    const { contentId, image } = ImageParams.parse(req.params);
    return sendRaw(req, reply, contentId, image);
  });

  /**
   * A file of a post's processed video (src/video), by the id of that version of the video
   * (`preview.video.id`) and the file's name: its poster (`poster.jpg`), the master playlist
   * of its adaptive stream (`master.m3u8`), and what that leads to, a playlist for each size
   * (`720p.m3u8`) and the segments each of those lists (`720p_00000.ts`). A post's preview
   * gives the first two (`preview.video.poster`, `preview.video.hls`), and a player finds the
   * rest from the playlists, which name them by their names alone, beside themselves. Read by
   * whoever may read the post (see loadReadable).
   *
   * A playlist is always sent from here, as text, so that what it names is asked for here
   * too, whoever may read it then. A segment and the poster are a redirect to the store where
   * it can sign links, else streamed from here. They never change: an update with another
   * video has another id. So they can be kept for as long as a reader likes.
   *
   * 404 for a file the video doesn't have, for a version of the video the post no longer has,
   * and for a post that has no processed video. On a repost of a post on another server, a
   * redirect to that file of the original, on its own server.
   */
  app.get('/content/:contentId/video/:videoId/:file', { compress: false }, async (req, reply) => {
    const { contentId, videoId, file } = VideoParams.parse(req.params);
    const row = await loadReadable(db, req, contentId);
    if (row.origin_hash !== null) {
      const { origin } = await requireMeta({ db, content }, contentId);
      if (origin) return reply.redirect(videoFileUrl(originMediaUrl(origin), videoId, file), 302);
    }
    const of = { contentId, video: videoId, file };
    const type = videoFileType(file);
    if (file.endsWith('.m3u8')) {
      const playlist = await content.streamIfThere(of);
      if (!playlist) throw videoFileNotFound();
      reply.header('content-type', type);
      reply.header('x-content-type-options', 'nosniff');
      reply.header('cache-control', row.queued || row.gone ? 'private, no-store' : VIDEO_FILE_CACHE);
      return reply.send(playlist);
    }
    // Whoever may read the post may keep the file, where it is sent from here; a link to the store is good for a while only, and isn't kept.
    const headers = { 'cache-control': row.queued || row.gone ? 'private, no-store' : VIDEO_FILE_CACHE };
    if (!(await sendBytes(reply, content, of, () => type, { staged: true, headers }))) throw videoFileNotFound();
    return reply;
  });

  /** Answers with the content's bytes (GET /content/:contentId/raw), or for an image post, with those of its image number `image` (/raw/:image). */
  async function sendRaw(req: FastifyRequest, reply: FastifyReply, contentId: string, image: number): Promise<FastifyReply> {
    const row = await loadReadable(db, req, contentId);
    const pending = await pendingPost(db, contentId);
    if (row.origin_hash !== null) {
      const { origin, preview } = pending?.meta ?? (await requireMeta({ db, content }, contentId));
      if (origin) {
        if (image > imageCount(preview)) throw imageNotFound();
        return reply.redirect(imageUrl(originMediaUrl(origin), image), 302);
      }
    }

    if (pending?.processing) {
      // Nothing of a video as it was sent: what the post had before, for an update, and for a new post, nothing yet.
      if (image > 1) throw imageNotFound();
      if (!(await content.statIfThere(contentId))) throw videoProcessing();
      await sendBytes(reply, content, contentId, async () => (await content.getMeta(contentId))?.mimeType ?? 'application/octet-stream');
      return reply;
    }
    if (pending) {
      if (image > imageCount(pending.meta.preview)) throw imageNotFound();
      // The first waits where the write's row says, and each of the others where a row of its own does.
      const staged = image === 1 ? pending.stagedKey : await pendingImage(db, contentId, pending.seq, image);
      if (staged) {
        if (await sendBytes(reply, content, { staged }, () => pending.meta.images?.[image - 1]?.mimeType ?? pending.meta.mimeType, { staged: true })) return reply;
      } else if (image === 1) {
        const { bytes, mimeType } = payloadBytes(pending.meta);
        reply.headers(rawHeaders(mimeType));
        reply.header('content-type', mimeType);
        reply.header('content-length', String(bytes.length));
        return reply.send(bytes);
      }
    }
    // Applied, if it was pending a moment ago: the meta file in the store is the one to go by.
    if (image === 1) {
      await sendBytes(reply, content, contentId, async () => (await requireMeta({ db, content }, contentId)).mimeType);
      return reply;
    }
    const meta = await requireMeta({ db, content }, contentId);
    // Looked for first, as a staged file is: an update with fewer images may have been applied since the meta file was read.
    if (image > imageCount(meta.preview) || !(await sendBytes(reply, content, { contentId, image }, () => meta.images?.[image - 1]?.mimeType ?? meta.mimeType, { staged: true }))) {
      throw imageNotFound();
    }
    return reply;
  }
}

/**
 * Deleting content: DELETE /content/:contentId, and nothing else. It is apart from the routes that
 * read content (contentRoutes), so the two can be served apart (see functions/groups.ts).
 */
export function deletionRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;
  /**
   * Sets content for deletion (see setForDeletion): the caller's own, or any content for an admin,
   * whose deletion of someone else's post its publisher is told of (src/inbox.ts): once, by the
   * request that set the deletion, not by one that repeats it.
   */
  app.delete('/content/:contentId', async (req, reply) => {
    const { contentId } = Params.parse(req.params);
    const user = await authenticate(db, req, Credentials.parse(req.body ?? {}));
    const row = await db.selectFrom('content').select(['id', 'user_id', 'delete_requested_at']).where('id', '=', contentId).executeTakeFirst();
    if (!row) throw contentNotFound();
    if (row.user_id !== user.id && !user.admin) throw forbidden(msg('content.delete_own_only'));
    const requestedAt = await setForDeletion(deps, row);
    if (row.delete_requested_at === null) await notify(deps, { userId: row.user_id, kind: 'post_deleted', contentId, by: user.id }, req.log);
    return reply.status(202).send({ contentId, status: 'pending_deletion', requestedAt: iso(requestedAt) });
  });
}
