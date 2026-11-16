import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/apiKey.js';
import type { AppDeps } from '../deps.js';
import { forbidden, notFound } from '../http/errors.js';
import { mediaUrl } from '../storage/summaryStore.js';
import { touchTags } from '../tags.js';

const Params = z.object({ contentId: z.string().uuid() });
const RawQuery = z.object({ version: z.coerce.number().int().positive().optional() });
const DeleteBody = z.object({ userId: z.string().optional(), apiKey: z.string().optional() });

export function contentRoutes(app: FastifyInstance, { db, config, content, appender, now = Date.now }: AppDeps) {
  /** Content set for deletion is already gone as far as readers are concerned. */
  async function load(contentId: string) {
    const row = await db
      .selectFrom('content')
      .innerJoin('users', 'users.id', 'content.user_id')
      .selectAll('content')
      .select(['users.username', 'users.publisher_url'])
      .where('content.id', '=', contentId)
      .where('content.delete_requested_at', 'is', null)
      .executeTakeFirst();
    if (!row) throw notFound('content not found');
    return row;
  }

  /** retrieve_content: publisher credit first, then the preview and hashtags. */
  app.get('/content/:contentId', async (req) => {
    const { contentId } = Params.parse(req.params);
    const row = await load(contentId);
    const meta = await content.getMeta(contentId, row.version);
    return {
      publisher: { userId: row.user_id, username: row.username, publisherUrl: row.publisher_url },
      contentId: row.id,
      version: row.version,
      ...(row.origin_server !== null && { origin: { server: row.origin_server, contentId: row.origin_content_id, version: row.origin_version } }),
      preview: meta?.preview ?? null,
      tags: meta?.tags ?? [],
      likes: row.like_count,
      mimeType: row.mime_type,
      aiGenerated: row.ai_generated === 1,
      filename: row.filename,
      size: row.size,
      contentUrl: `/content/${row.id}/raw`,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  });

  /**
   * The original bytes of the current version. Replaced versions are never served, even before the
   * compactor erases them. Federated content's bytes are on its origin server, which this redirects to.
   */
  app.get('/content/:contentId/raw', async (req, reply) => {
    const { contentId } = Params.parse(req.params);
    const { version = undefined } = RawQuery.parse(req.query);
    const row = await load(contentId);
    if (version !== undefined && version !== row.version) throw notFound('version not found');
    if (row.origin_server !== null) return reply.redirect(mediaUrl(row.origin_server, row.origin_content_id!, row.origin_version!), 302);

    const signed = await content.signedUrl(contentId, row.version);
    if (signed) return reply.redirect(signed, 302);
    reply.header('content-type', row.mime_type);
    reply.header('content-length', String(row.size));
    if (row.publisher_url) reply.header('x-publisher-url', row.publisher_url);
    if (row.filename) reply.header('content-disposition', `inline; filename="${row.filename.replace(/["\r\n]/g, '')}"`);
    return reply.send(await content.stream(contentId, row.version));
  });

  /**
   * Sets the caller's content for deletion. /content stops serving it and tombstones hide it from
   * feeds at once, but nothing is removed yet: the compactor removes it from every day index, then
   * deletes its row, bytes and summaries in the same run. Repeating the request appends the tombstones again.
   */
  app.delete('/content/:contentId', async (req, reply) => {
    const { contentId } = Params.parse(req.params);
    const user = await authenticate(db, req, DeleteBody.parse(req.body ?? {}));
    const row = await db.selectFrom('content').select(['user_id', 'delete_requested_at']).where('id', '=', contentId).executeTakeFirst();
    if (!row) throw notFound('content not found');
    if (row.user_id !== user.id) throw forbidden('only the original publisher can delete this content');

    if (row.delete_requested_at === null) {
      await db.updateTable('content').set({ delete_requested_at: now() }).where('id', '=', contentId).where('delete_requested_at', 'is', null).execute();
    }
    // Once the deletion is set no version can commit, so these versions are final; no row means the compactor already finished.
    const marked = await db.selectFrom('content').select(['version', 'created_at', 'delete_requested_at']).where('id', '=', contentId).executeTakeFirst();
    if (marked) {
      const metas = await Promise.all(Array.from({ length: marked.version }, (_, i) => content.getMeta(contentId, i + 1)));
      const tags = [...new Set(metas.flatMap((m) => m?.tags ?? []))];
      await touchTags(db, config.db.dialect, tags, now());
      const failed = await appender.tombstone(tags, { tombstone: true, contentId, below: null, createdAt: marked.created_at });
      if (failed.length) req.log.warn({ contentId, tags: failed }, 'tombstone append failed; feeds show the content until the compactor deletes it');
    }
    const requestedAt = marked?.delete_requested_at ?? row.delete_requested_at ?? now();
    return reply.status(202).send({ contentId, status: 'pending_deletion', requestedAt: new Date(requestedAt).toISOString() });
  });
}
