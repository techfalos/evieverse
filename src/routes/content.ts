import { randomInt } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/apiKey.js';
import { contentNotFound, loadReadable, publisherOf, requireMeta, takesComments } from '../content.js';
import { setForDeletion } from '../deletion.js';
import type { AppDeps } from '../deps.js';
import { forbidden } from '../http/errors.js';
import { say } from '../http/language.js';
import { Credentials } from '../http/schemas.js';
import { notify } from '../inbox.js';
import { msg } from '../language.js';
import { adRecord, eligibleAds, type PublishedAd } from '../monetization.js';
import { previewOf } from '../posts.js';
import { iso } from '../time.js';

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
  const sandbox = /^(video|audio)\//.test(contentType) ? 'sandbox allow-same-origin' : 'sandbox';
  return {
    'x-content-type-options': 'nosniff',
    'content-security-policy': `default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; ${sandbox}`,
  };
}

/** Reading content. Its deletion is a route of its own (deletionRoutes), so the two can be served apart. */
export function contentRoutes(app: FastifyInstance, { db, config, content, ads, now = Date.now }: AppDeps) {
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
   */
  app.get('/content/:contentId', async (req) => {
    const { contentId } = Params.parse(req.params);
    const row = await loadReadable(db, req, contentId);
    // The row says whose the content is and how liked; what it is, is in the meta file beside its bytes.
    const meta = await requireMeta(content, contentId);
    const ad = row.queued ? undefined : await postAd(req, meta.tags);
    return {
      publisher: publisherOf(row),
      contentId: row.id,
      ...(row.queued && { status: 'pending_review' }),
      preview: previewOf(meta, config.publicBaseUrl),
      ...(meta.text !== undefined && { text: meta.text }),
      tags: meta.tags,
      likes: row.like_count,
      mimeType: meta.mimeType,
      aiGenerated: row.ai_generated === 1,
      comments: takesComments(meta),
      size: meta.size,
      contentUrl: `/content/${row.id}/raw`,
      createdAt: iso(row.created_at),
      updatedAt: iso(meta.updatedAt),
      ...(ad && { ad: adRecord(ad, say(req, msg('ad.sponsored')), config.publicBaseUrl) }),
    };
  });

  /**
   * The content's bytes as they are now: an update writes over them. A redirect to the store where
   * it can sign links; else streamed from here, with the size the store gives for them, and the
   * content type it keeps or, where it keeps none, the meta file's. Who may read them is who may
   * read the content (see loadReadable).
   *
   * Streamed from here, a user's file is served from the API's own origin, so it goes out as
   * something to show and nothing more (see rawHeaders).
   */
  app.get('/content/:contentId/raw', async (req, reply) => {
    const { contentId } = Params.parse(req.params);
    await loadReadable(db, req, contentId);

    const signed = await content.signedUrl(contentId);
    if (signed) return reply.redirect(signed, 302);
    const { size, contentType } = await content.stat(contentId);
    const type = contentType ?? (await requireMeta(content, contentId)).mimeType;
    reply.headers(rawHeaders(type));
    reply.header('content-type', type);
    reply.header('content-length', String(size));
    return reply.send(await content.stream(contentId));
  });
}

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
