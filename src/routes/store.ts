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
import { postRules, type RemovedTag } from '../moderation/policy.js';
import { LINK_MIME, LinkUrl, MAX_TEXT_CHARS, mediaType, mediaUrl, POST_TYPES, previewOf, TEXT_MIME, type MediaType } from '../posts.js';
import { spoolToTemp, type ContentMeta, type Preview, type Publisher, type SpooledFile, type Summary } from '../storage/index.js';
import { parseTagList, sameTags } from '../tags.js';
import { MAX_VERSION, toFeedRecord } from '../tagfeed/layout.js';
import { firstWords, versionWriter } from '../versions.js';

const Fields = z.object({
  userId: z.string().optional(),
  apiKey: z.string().optional(),
  contentId: z.string().uuid().optional(),
  /** What the post is: an image, video or audio file, with an optional caption in `text`; text; or a link. */
  type: z.enum(POST_TYPES),
  /** A text post's text, or an image's, video's or audio's caption. */
  text: z.string().max(MAX_TEXT_CHARS).optional(),
  /** A link post's URL. */
  url: LinkUrl.optional(),
  /** The publisher's hashtags: a list, or one string of them separated by commas or spaces. Used only where TAGGING_MODE lets publishers choose. */
  tags: z.union([z.array(z.string().max(100)).max(50), z.string().max(5000)]).optional(),
  /** The publisher's declaration that the content was created with AI. Omitted: false, or on an update the current version's. */
  aiGenerated: z.union([z.boolean(), z.stringbool()]).optional(),
  contentType: z.string().max(255).optional(),
  filename: z.string().max(512).optional(),
  /** An image's, video's or audio's file, inline for JSON requests (or a plain multipart text field). */
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

/** A post, its bytes spooled to a temp file: an image's, video's or audio's file, a text post's text, or a link's URL. */
type Post = { file: SpooledFile; filename: string | null; mimeType: string } & (
  | { type: MediaType; text?: string }
  | { type: 'text'; text: string }
  | { type: 'link'; url: string }
);

/** A text post's text or a caption; a link has none. */
const textOf = (post: Post) => (post.type === 'link' ? undefined : post.text);

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

  const spool = (bytes: Buffer) => spoolToTemp(Readable.from([bytes]), tmp, maxBytes);

  /**
   * The post the request describes. An image, video or audio post needs a file of that type, from the
   * upload or inline in `content`. A text post's text and a link's URL are stored as its bytes.
   */
  async function readPost(fields: Fields, upload: Upload | undefined): Promise<Post> {
    const { type } = fields;
    const text = fields.text?.trim() || undefined;
    if (type !== 'link' && fields.url !== undefined) throw badRequest('url is only for link posts');
    if (type === 'text' || type === 'link') {
      if (upload || fields.content !== undefined) throw badRequest(`a ${type} post has no file`);
      if (type === 'text') {
        if (!text) throw badRequest('text is required');
        return { type, text, file: await spool(Buffer.from(text)), filename: null, mimeType: TEXT_MIME };
      }
      if (fields.text !== undefined) throw badRequest('a link post is just its url');
      if (fields.url === undefined) throw badRequest('url is required');
      return { type, url: fields.url, file: await spool(Buffer.from(fields.url)), filename: null, mimeType: LINK_MIME };
    }

    if (!upload && fields.content === undefined) throw badRequest(`content is required: the ${type} file`);
    const filename = upload?.filename ?? fields.filename ?? null;
    const sent = upload?.mimeType ?? (fields.contentEncoding === 'base64' ? 'application/octet-stream' : 'text/plain');
    const mimeType = resolveMimeType(fields.contentType ?? sent, filename);
    if (mediaType(mimeType) !== type) throw badRequest(`${type} posts take ${type}/* files, got ${mimeType}; post other files as a link`);
    let file = upload?.file;
    if (!file) {
      const bytes = Buffer.from(fields.content!, fields.contentEncoding === 'base64' ? 'base64' : 'utf8');
      if (bytes.length === 0) throw badRequest('content is empty');
      file = await spool(bytes);
    }
    return { type, ...(text ? { text } : {}), file, filename, mimeType };
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
   * Creates or updates content. Moderation first refuses the post or drops some of its hashtags (see
   * postRules). A post soon after the user's previous one is then answered with challenges, more of
   * them the longer the run, before anything is stored. An update then reserves its own
   * version number, and the version is written as versionWriter describes. With federated_servers, the
   * version's feed record is then sent to each of them. An unchanged upload sends the current version's,
   * so storing content again federates it to more servers, or retries.
   */
  app.post('/store', { bodyLimit: 32 * 1024 * 1024 }, async (req, reply) => {
    let raw: Record<string, unknown>;
    let upload: Upload | undefined;
    let post: Post | undefined;
    if (req.isMultipart()) {
      ({ fields: raw, upload } = await readMultipart(req));
    } else {
      raw = (req.body as Record<string, unknown>) ?? {};
    }

    try {
      const fields = Fields.parse(raw);
      if (upload && fields.content !== undefined) throw badRequest('Send content either as a file or as a field, not both');
      post = await readPost(fields, upload);
      const { file, filename, mimeType } = post;

      const user = await authenticate(db, req, fields);
      if (!user.publisherUrl) throw badRequest(`set your publisherUrl first (PATCH /users/${user.id})`);
      const servers = fields.federated_servers;
      if (servers) checkFederation(config);
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
      if (existing && mimeType !== existing.mime_type) {
        throw badRequest(`a new version must have the same content type as the original (${existing.mime_type}), got ${mimeType}`);
      }

      const aiGenerated = fields.aiGenerated ?? (existing?.ai_generated === 1);
      const publisher: Publisher = { userId: user.id, username: user.username, publisherUrl: user.publisherUrl };
      const unchanged = async (row: ContentRow, current: Summary | undefined, removedTags: RemovedTag[] = []) => {
        const federated = current && servers && (await federateTo(servers, current, publisher));
        return reply.send({ contentId: row.id, version: row.version, unchanged: true, ...(removedTags.length > 0 && { removedTags }), ...(federated && { federated }) });
      };
      let current: Summary | undefined;
      if (existing && existing.sha256 === file.sha256 && aiGenerated === (existing.ai_generated === 1)) {
        const meta = await currentMeta(existing);
        // A caption is part of the post, like its bytes: a new one alone makes a new version.
        if ((meta.text ?? '') === (textOf(post) ?? '')) {
          current = summaryOf(existing, meta);
          // The publisher's hashtags make a new version only if they aren't the current version's.
          if (!own.length || sameTags(own, current.tags)) return unchanged(existing, current);
        }
      }

      // Before any challenge, so nobody solves one for a post that isn't published.
      const rules = await postRules(db, { userId: user.id, tags, contentId: existing?.id });
      for (const text of [post.type === 'link' ? post.url : post.text, filename]) if (text) rules.scanner?.scan(text);
      const moderated = rules.apply();
      if (existing && current && sameTags(moderated.tags, current.tags)) return unchanged(existing, current, moderated.removedTags);

      const release = await challenges.admitPost(user.id, fields);
      const s = await store(publisher, post, aiGenerated, existing, moderated.tags).catch(async (err) => {
        await release();
        throw err;
      });
      const federated = servers && (await federateTo(servers, s, publisher));
      return reply.status(existing ? 200 : 201).send({
        contentId: s.contentId,
        version: s.version,
        tags: s.tags,
        ...(moderated.removedTags.length > 0 && { removedTags: moderated.removedTags }),
        preview: s.preview,
        aiGenerated: s.aiGenerated,
        ...(federated && { federated }),
      });
    } finally {
      await upload?.file.cleanup();
      await post?.file.cleanup();
    }
  });

  async function store(
    publisher: Publisher,
    post: Post,
    aiGenerated: boolean,
    existing: { id: string; version: number; created_at: number } | undefined,
    tags: string[],
  ): Promise<Summary> {
    const contentId = existing?.id ?? randomUUID();
    const version = existing ? await versions.reserveVersion(contentId, existing.version) : 1;

    const ts = now();
    const createdAt = existing?.created_at ?? ts;
    const { file, filename, mimeType } = post;
    const cut = (text: string) => firstWords(text, config.feed.previewWords, config.feed.previewChars);
    const preview: Preview =
      post.type === 'text'
        ? { kind: 'text', text: cut(post.text) }
        : post.type === 'link'
          ? { kind: 'link', url: post.url }
          : { kind: post.type, url: mediaUrl(config.publicBaseUrl, contentId, version), ...(post.text ? { text: cut(post.text) } : {}) };
    const text = textOf(post);

    const summary: Summary = { contentId, version, createdAt, updatedAt: ts, userId: publisher.userId, mimeType, aiGenerated, tags, preview };
    const meta: ContentMeta = {
      contentId,
      version,
      mimeType,
      filename,
      size: file.size,
      sha256: file.sha256,
      aiGenerated,
      preview,
      ...(text !== undefined && { text }),
      tags,
      createdAt: new Date(ts).toISOString(),
    };
    await versions.write({
      publisher,
      existing,
      summary,
      meta,
      columns: { filename, size: file.size, sha256: file.sha256 },
      putBytes: () => content.putFile(contentId, version, file.path, mimeType),
    });
    return summary;
  }

  async function currentMeta(row: ContentRow): Promise<ContentMeta> {
    const meta = await content.getMeta(row.id, row.version);
    if (!meta) throw new HttpError(500, `the meta file of version ${row.version} is missing`);
    return meta;
  }

  /** The current version's summary, rebuilt from the database and its meta file, which outlives the summary store's retention. */
  const summaryOf = (row: ContentRow, meta: ContentMeta): Summary => ({
    contentId: row.id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    userId: row.user_id,
    mimeType: row.mime_type,
    aiGenerated: row.ai_generated === 1,
    tags: meta.tags,
    preview: previewOf(meta, config.publicBaseUrl),
  });

  /** Likes stay on each server, so the record goes out with none. */
  const federateTo = (servers: FederatedServer[], summary: Summary, publisher: Publisher) =>
    federate(toFeedRecord(summary, 0, publisher), serverBase(config.publicBaseUrl), servers, { timeoutMs: config.federation.timeoutMs, log: app.log });
}
