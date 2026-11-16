import { randomInt } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { attest, signingKeys } from '../attestation.js';
import { authenticate } from '../auth/apiKey.js';
import { contentNotFound, loadPublished, loadReadable, PENDING_REVIEW, publisherOf, requireMeta, takesComments } from '../content.js';
import { setForDeletion } from '../deletion.js';
import type { AppDeps } from '../deps.types.js';
import { badRequest, forbidden, HttpError } from '../http/errors.js';
import { say } from '../http/language.js';
import { Credentials } from '../http/schemas.js';
import { notify } from '../inbox.js';
import { msg } from '../language.js';
import { adRecord, eligibleAds } from '../monetization.js';
import type { PublishedAd } from '../monetization.types.js';
import { payloadBytes, pendingPost } from '../pending.js';
import { originMediaUrl, ownAddress, postAddress, previewOf } from '../posts.js';
import type { BytesOwner, ContentStore, Publisher } from '../storage/index.js';
import { indexAuthor } from '../tagfeed/layout.js';
import { iso } from '../time.js';

/** The path of a piece of content: its id. */
const Params = z.object({ contentId: z.string().uuid() });

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
 * if they are gone: they are then where the post's, or the comment's, are kept.
 */
export async function sendBytes(reply: FastifyReply, content: ContentStore, of: BytesOwner, typeOf: () => Promise<string> | string, { staged = false } = {}): Promise<boolean> {
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
  reply.headers(rawHeaders(type));
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
   * retrieve_content: the publisher's credit (their userId and username) first, then the preview, the
   * whole text or caption, and hashtags. `status: "pending_review"` on content that waits in the
   * moderation queue. Who may read it is in loadReadable. `ad`, last, is the ad to show at the
   * end of the post (see postAd); content that waits in the moderation queue has none.
   *
   * `reposts`, on a post that was reposted (src/reposts.ts): each repost, oldest first, with who
   * made it, the hashtags it gave the post that the post still has from it, and when. `likes` is
   * the post's one count, all of them, whichever feed a like came from.
   *
   * `origin`, on a repost of a post on another server: the original's address and who published
   * it there, with `publisher` the one who reposted it here. The preview is the original's, and so
   * are the bytes, which this server doesn't hold: `contentUrl` leads to them, and there is no
   * `size` or whole `text` to give.
   */
  app.get('/content/:contentId', async (req) => {
    const { contentId } = Params.parse(req.params);
    const row = await loadReadable(db, req, contentId);
    // The row says whose the content is and how liked; what it is, is in the meta file beside its bytes.
    const [meta, reposts] = await Promise.all([requireMeta({ db, content }, contentId), repostsMade(contentId)]);
    const ad = row.queued ? undefined : await postAd(req, meta.tags);
    return {
      publisher: publisherOf(row),
      contentId: row.id,
      ...(row.queued && PENDING_REVIEW),
      preview: previewOf(meta, config.publicBaseUrl),
      ...(meta.text !== undefined && { text: meta.text }),
      tags: meta.tags,
      likes: row.like_count,
      mimeType: meta.mimeType,
      aiGenerated: row.ai_generated === 1,
      comments: takesComments(meta),
      ...(!meta.origin && { size: meta.size }),
      contentUrl: `/content/${row.id}/raw`,
      createdAt: iso(row.created_at),
      updatedAt: iso(meta.updatedAt),
      ...(reposts.length > 0 && { reposts }),
      ...(meta.origin && { origin: meta.origin }),
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
   * post's address here, its publisher, its content type, its AI declaration and its preview, as
   * of now. For anyone, with no key: a post anyone can repost is one anyone can read. It is good
   * for a few minutes, so it is asked for when it is used, and nothing in between keeps it.
   *
   * Only of a published post: one that waits in the moderation queue, or is set for deletion, is
   * 404 here even to its publisher, since nobody else is to be told what it says. And only of a
   * post that is this server's to speak for. A repost of a post on another server isn't: it is
   * 409, with the original's address in `origin`, which is where its attestation is had.
   *
   * 400 on a server that signs nothing (it has no REPOSTS_SIGNING_KEYS, or no PUBLIC_BASE_URL to
   * say where its posts are).
   */
  app.get('/content/:contentId/attestation', async (req, reply) => {
    const { contentId } = Params.parse(req.params);
    const row = await loadPublished(db, contentId);
    const meta = await requireMeta({ db, content }, contentId);
    if (meta.origin) throw new HttpError(409, msg('attestation.is_repost', { url: meta.origin.url }), undefined, { origin: { url: meta.origin.url } });
    if (!signingKey || ownBase === null) throw badRequest(msg('attestation.off'));
    const { preview } = meta;
    reply.header('cache-control', 'no-store');
    return {
      attestation: attest(
        signingKey,
        {
          url: postAddress(ownBase, row.id),
          publisher: publisherOf(row),
          mimeType: meta.mimeType,
          aiGenerated: row.ai_generated === 1,
          preview: preview.kind === 'text' ? { kind: 'text', text: preview.text } : preview.kind === 'link' ? { kind: 'link', url: preview.url } : { kind: preview.kind, ...(preview.text && { text: preview.text }) },
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
   */
  app.get('/content/:contentId/raw', { compress: false }, async (req, reply) => {
    const { contentId } = Params.parse(req.params);
    const row = await loadReadable(db, req, contentId);
    const pending = await pendingPost(db, contentId);
    if (row.origin_hash !== null) {
      const { origin } = pending?.meta ?? (await requireMeta({ db, content }, contentId));
      if (origin) return reply.redirect(originMediaUrl(origin), 302);
    }

    if (pending?.stagedKey) {
      if (await sendBytes(reply, content, { staged: pending.stagedKey }, () => pending.meta.mimeType, { staged: true })) return reply;
    } else if (pending) {
      const { bytes, mimeType } = payloadBytes(pending.meta);
      reply.headers(rawHeaders(mimeType));
      reply.header('content-type', mimeType);
      reply.header('content-length', String(bytes.length));
      return reply.send(bytes);
    }
    // Applied, if it was pending a moment ago: the meta file in the store is the one to go by.
    await sendBytes(reply, content, contentId, async () => (await requireMeta({ db, content }, contentId)).mimeType);
    return reply;
  });
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
