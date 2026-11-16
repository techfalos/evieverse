import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/apiKey.js';
import type { AppDeps } from '../deps.js';
import { HttpError, tooManyRequests } from '../http/errors.js';
import { resolveMimeType } from '../http/mime.js';
import { Credentials } from '../http/schemas.js';
import { msg } from '../language.js';
import { refuseBanned } from '../moderation/policy.js';
import { mediaType } from '../posts.js';
import { UploadTooLargeError } from '../storage/index.js';
import { iso } from '../time.js';
import { requirePostType, wrongFileType } from '../upload.js';

const Body = Credentials.extend({
  /** What the file will be posted as. */
  type: z.enum(['image', 'video', 'audio']),
  contentType: z.string().max(255).optional(),
  filename: z.string().max(512).optional(),
  /** The file's size in bytes. */
  size: z.coerce.number().int().positive(),
});

export function uploadRoutes(app: FastifyInstance, { db, config, content, hot, now = Date.now }: AppDeps) {
  /**
   * Gives a link to send a file straight to the content store with, and the uploadId to then post it
   * by (POST /store with `uploadId` in place of the file). For files a request to this server can't
   * carry: functions take requests of a few megabytes at most. The link lasts `signedUrlSeconds`, and
   * the upload until a request stores it, or the content store expires it.
   *
   * The link itself can't hold the client to the type or size given here, so they are checked now, to
   * refuse what would never be stored before it is sent, and again by /store on what was sent.
   */
  app.post('/uploads', async (req, reply) => {
    const body = Body.parse(req.body ?? {});
    const user = await authenticate(db, req, body);
    // A link is for posting the file, which a banned user can't.
    refuseBanned(user);
    // Nor can anyone post it where the server has turned its type off.
    requirePostType(config.postTypes, body.type);
    const mimeType = resolveMimeType(body.contentType, body.filename);
    if (mediaType(mimeType) !== body.type) throw wrongFileType(body.type, mimeType);
    const { maxUploadBytes, uploadLinksPerMinute } = config.storage;
    if (body.size > maxUploadBytes) throw new UploadTooLargeError(maxUploadBytes);

    if (uploadLinksPerMinute > 0) {
      const { count, ttlMs } = await hot.incr(`uploads:${user.id}`, 60_000);
      const seconds = Math.max(1, Math.ceil(ttlMs / 1000));
      if (count > uploadLinksPerMinute) throw tooManyRequests(msg('upload.rate_limited', { count: seconds }), seconds);
    }
    const uploadId = randomUUID();
    const upload = await content.presignUpload(user.id, uploadId, mimeType);
    if (!upload) throw new HttpError(501, msg('upload.no_links'));
    return reply.status(201).send({
      uploadId,
      upload,
      expiresAt: iso(now() + config.storage.content.signedUrlSeconds * 1000),
      maxBytes: maxUploadBytes,
    });
  });
}
