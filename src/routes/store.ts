import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/apiKey.js';
import { ChallengeFields, Challenges } from '../challenge/challenges.js';
import type { ContentRow } from '../db/schema.js';
import type { AppDeps } from '../deps.js';
import { checkFederation, federate, FederatedServers, serverBase, type FederatedServer } from '../federation.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../http/errors.js';
import { resolveMimeType } from '../http/mime.js';
import { documentText, isDocument } from '../media.js';
import { spoolToTemp, type ContentMeta, type Preview, type Publisher, type SpooledFile, type Summary } from '../storage/index.js';
import { mediaUrl } from '../storage/summaryStore.js';
import { parseTagList, sameTags } from '../tags.js';
import { MAX_VERSION, toFeedRecord } from '../tagfeed/layout.js';
import { firstWords, versionWriter } from '../versions.js';

const Fields = z.object({
  userId: z.string().optional(),
  apiKey: z.string().optional(),
  contentId: z.string().uuid().optional(),
  /** The publisher's hashtags: a list, or one string of them separated by commas or spaces. Used only where TAGGING_MODE lets publishers choose. */
  tags: z.union([z.array(z.string().max(100)).max(50), z.string().max(5000)]).optional(),
  /** The publisher's declaration that the content was created with AI. Omitted: false, or on an update the current version's. */
  aiGenerated: z.union([z.boolean(), z.stringbool()]).optional(),
  contentType: z.string().max(255).optional(),
  filename: z.string().max(512).optional(),
  /** Inline content for JSON requests (or a plain multipart text field). */
  content: z.string().optional(),
  contentEncoding: z.enum(['utf8', 'base64']).default('utf8'),
  /** Servers to send the version's feed record to once it's stored: { serverAddress, serverUser, serverKey }, or a list. */
  federated_servers: FederatedServers.optional(),
  ...ChallengeFields,
});
type Fields = z.infer<typeof Fields>;

interface Upload {
  file: SpooledFile;
  filename: string | null;
  mimeType: string;
}

export function storeRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, config, content, now = Date.now } = deps;
  const versions = versionWriter(deps, app.log);
  const challenges = new Challenges(deps);
  const tmp = config.storage.tmpPath;
  const maxBytes = config.storage.maxUploadBytes;

  async function readMultipart(req: FastifyRequest) {
    const fields: Record<string, string> = {};
    let upload: Upload | undefined;
    try {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          if (part.fieldname !== 'content' || upload) {
            part.file.resume();
            throw badRequest('Exactly one file part named "content" is allowed');
          }
          upload = { file: await spoolToTemp(part.file, tmp, maxBytes), filename: part.filename || null, mimeType: part.mimetype };
        } else {
          fields[part.fieldname] = String(part.value);
        }
      }
    } catch (err) {
      await upload?.file.cleanup();
      throw err;
    }
    return { fields, upload };
  }

  async function inlineUpload(fields: Fields): Promise<Upload | undefined> {
    if (fields.content === undefined) return undefined;
    const bytes = Buffer.from(fields.content, fields.contentEncoding === 'base64' ? 'base64' : 'utf8');
    if (bytes.length === 0) throw badRequest('content is empty');
    return {
      file: await spoolToTemp(Readable.from([bytes]), tmp, maxBytes),
      filename: fields.filename ?? null,
      mimeType: fields.contentType ?? (fields.contentEncoding === 'base64' ? 'application/octet-stream' : 'text/plain'),
    };
  }

  /**
   * The publisher's hashtags in user tagging mode, where every post must have them; none in server mode.
   * Checked before any challenge, so nobody solves one for a post that can't go through.
   */
  function publisherTags(fields: Fields): string[] {
    if (config.tagging.mode !== 'user') return [];
    const parsed = fields.tags === undefined ? { tags: [] } : parseTagList(fields.tags);
    if ('error' in parsed) throw badRequest(parsed.error);
    if (!parsed.tags.length) throw badRequest('tags is required: on this server, publishers choose the hashtags of their posts');
    return parsed.tags;
  }

  /**
   * Creates or updates content. A post soon after the user's previous one is answered with challenges
   * first, more of them the longer the run, before anything is stored. An update then reserves its own
   * version number, and the version is written as versionWriter describes. With federated_servers, the
   * version's feed record is then sent to each of them. An unchanged upload sends the current version's,
   * so storing content again federates it to more servers, or retries.
   */
  app.post('/store', { bodyLimit: 32 * 1024 * 1024 }, async (req, reply) => {
    let raw: Record<string, unknown>;
    let upload: Upload | undefined;
    if (req.isMultipart()) {
      ({ fields: raw, upload } = await readMultipart(req));
    } else {
      raw = (req.body as Record<string, unknown>) ?? {};
    }

    try {
      const fields = Fields.parse(raw);
      if (upload && fields.content !== undefined) throw badRequest('Send content either as a file or as a field, not both');
      upload ??= await inlineUpload(fields);
      if (!upload) throw badRequest('content is required');

      const user = await authenticate(db, req, fields);
      if (!user.publisherUrl) throw badRequest(`set your publisherUrl first (PATCH /users/${user.id})`);
      const servers = fields.federated_servers;
      if (servers) checkFederation(config, servers);
      const own = publisherTags(fields);
      const tags = config.tagging.mode === 'server' ? config.tagging.serverTags : own;

      const existing = fields.contentId
        ? await db.selectFrom('content').selectAll().where('id', '=', fields.contentId).executeTakeFirst()
        : undefined;
      if (fields.contentId && !existing) throw notFound('content not found');
      if (existing && existing.user_id !== user.id) throw forbidden('only the original publisher can update this content');
      if (existing?.delete_requested_at != null) throw conflict('content is set for deletion');
      if (existing?.origin_server != null) throw conflict('federated content is updated on its origin server, which federates the new version');
      if (existing && Math.max(existing.version, existing.reserved_version) >= MAX_VERSION) {
        throw conflict(`content can have at most ${MAX_VERSION} versions`);
      }

      const filename = upload.filename ?? fields.filename ?? null;
      const mimeType = resolveMimeType(fields.contentType ?? upload.mimeType, filename);
      if (existing && mimeType !== existing.mime_type) {
        throw badRequest(`a new version must have the same content type as the original (${existing.mime_type}), got ${mimeType}`);
      }
      const aiGenerated = fields.aiGenerated ?? (existing?.ai_generated === 1);
      const publisher: Publisher = { userId: user.id, username: user.username, publisherUrl: user.publisherUrl };
      if (existing && existing.sha256 === upload.file.sha256 && aiGenerated === (existing.ai_generated === 1)) {
        // The publisher's hashtags make a new version only if they aren't the current version's.
        const current = servers || own.length ? await currentSummary(existing) : undefined;
        if (!current || !own.length || sameTags(own, current.tags)) {
          const federated = current && servers && (await federateTo(servers, current, publisher));
          return reply.send({ contentId: existing.id, version: existing.version, unchanged: true, ...(federated && { federated }) });
        }
      }

      const release = await challenges.admitPost(user.id, fields);
      const s = await store(publisher, upload, filename, mimeType, aiGenerated, existing, tags).catch(async (err) => {
        await release();
        throw err;
      });
      const federated = servers && (await federateTo(servers, s, publisher));
      return reply.status(existing ? 200 : 201).send({
        contentId: s.contentId,
        version: s.version,
        tags: s.tags,
        preview: s.preview,
        aiGenerated: s.aiGenerated,
        ...(federated && { federated }),
      });
    } finally {
      await upload?.file.cleanup();
    }
  });

  async function store(
    publisher: Publisher,
    upload: Upload,
    filename: string | null,
    mimeType: string,
    aiGenerated: boolean,
    existing: { id: string; version: number; created_at: number } | undefined,
    tags: string[],
  ): Promise<Summary> {
    const contentId = existing?.id ?? randomUUID();
    const text = isDocument(mimeType) ? await previewText(upload, mimeType) : undefined;
    const version = existing ? await versions.reserveVersion(contentId, existing.version) : 1;

    const ts = now();
    const createdAt = existing?.created_at ?? ts;
    const preview: Preview = text?.trim()
      ? { kind: 'text', text: firstWords(text, config.feed.previewWords) }
      : { kind: 'media', url: mediaUrl(config.publicBaseUrl, contentId, version) };

    const summary: Summary = { contentId, version, createdAt, updatedAt: ts, userId: publisher.userId, mimeType, aiGenerated, tags, preview };
    const meta: ContentMeta = {
      contentId,
      version,
      mimeType,
      filename,
      size: upload.file.size,
      sha256: upload.file.sha256,
      aiGenerated,
      preview,
      tags,
      createdAt: new Date(ts).toISOString(),
    };
    await versions.write({
      publisher,
      existing,
      summary,
      meta,
      columns: { filename, size: upload.file.size, sha256: upload.file.sha256 },
      putBytes: () => content.putFile(contentId, version, upload.file.path, mimeType),
    });
    return summary;
  }

  /** The text a document's preview is cut from. One that can't be read gets a media preview. */
  async function previewText(upload: Upload, mimeType: string): Promise<string | undefined> {
    try {
      return await documentText(upload.file.path, mimeType, upload.file.size);
    } catch (err) {
      app.log.warn({ err }, 'could not extract the text for a preview');
      return undefined;
    }
  }

  /** The current version's summary, rebuilt from the database and its meta file, which outlives the summary store's retention. */
  async function currentSummary(row: ContentRow): Promise<Summary> {
    const meta = await content.getMeta(row.id, row.version);
    if (!meta) throw new HttpError(500, `the meta file of version ${row.version} is missing`);
    return {
      contentId: row.id,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      userId: row.user_id,
      mimeType: row.mime_type,
      aiGenerated: row.ai_generated === 1,
      tags: meta.tags,
      preview: meta.preview.kind === 'media' ? { kind: 'media', url: mediaUrl(config.publicBaseUrl, row.id, row.version) } : meta.preview,
    };
  }

  /** Likes stay on each server, so the record goes out with none. */
  const federateTo = (servers: FederatedServer[], summary: Summary, publisher: Publisher) =>
    federate(toFeedRecord(summary, 0, publisher), serverBase(config.publicBaseUrl), servers, { timeoutMs: config.federation.timeoutMs, log: app.log });
}
