import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/apiKey.js';
import { ChallengeFields } from '../challenge/challenges.js';
import { contentNotFound, requireMeta, takesComments } from '../content.js';
import type { ContentRow } from '../db/schema.js';
import type { RouteDeps } from '../deps.js';
import { badRequest, forbidden } from '../http/errors.js';
import { Credentials, Flag } from '../http/schemas.js';
import { msg } from '../language.js';
import { moderatePost, refuseBanned, type RemovedTag } from '../moderation/policy.js';
import { LinkUrl, MAX_TEXT_CHARS, mediaUrl, POST_TYPES, previewCutter } from '../posts.js';
import type { ContentMeta, Preview, Publisher, Summary } from '../storage/index.js';
import { allowedTags, parseTagList, sameTags } from '../tags.js';
import { readMultipart, readPost, readUploaded, textOf, type Post, type Upload } from '../upload.js';
import { assertUpdatable } from '../write.js';

const Fields = Credentials.extend({
  contentId: z.string().uuid().optional(),
  /** What the post is: an image, video or audio file, with an optional caption in `text`; text; or a link. */
  type: z.enum(POST_TYPES),
  /** A text post's text, or an image's, video's or audio's caption. */
  text: z.string().max(MAX_TEXT_CHARS).optional(),
  /** A link post's URL. */
  url: LinkUrl.optional(),
  /** The publisher's hashtags: a list, or one string of them separated by commas or spaces. Where TAGGING_MODE is server, each must be one of the server's. */
  tags: z.union([z.array(z.string().max(100)).max(50), z.string().max(5000)]).optional(),
  /** The publisher's declaration that the content was created with AI. Omitted: false, or on an update what it was. */
  aiGenerated: Flag.optional(),
  /** Whether the post takes comments. Omitted: it doesn't, or on an update it does if it did. */
  comments: Flag.optional(),
  contentType: z.string().max(255).optional(),
  filename: z.string().max(512).optional(),
  /** An image's, video's or audio's file, inline for JSON requests (or a plain multipart text field). */
  content: z.string().optional(),
  /** An image's, video's or audio's file, already sent to the link POST /uploads gave: the id it came with. */
  uploadId: z.string().uuid().optional(),
  contentEncoding: z.enum(['utf8', 'base64']).default('utf8'),
  ...ChallengeFields,
});
type Fields = z.infer<typeof Fields>;

/** `queued`: it waits in the moderation queue. */
type Existing = { row: ContentRow; meta: ContentMeta; queued: boolean };

/** What a publisher says of a post beside what it is: that it was created with AI, and that it takes comments. */
type PostFlags = { aiGenerated: boolean; comments: boolean };

/** What /store answers about content that waits in the moderation queue, beside 202 for a write of it. */
const PENDING_REVIEW = { status: 'pending_review' } as const;

/** Whether a text post's text, or a link post's URL, is what the content holds. A file is never taken to be. */
function sameBody(post: Post, meta: ContentMeta): boolean {
  if (post.type === 'text') return meta.preview.kind === 'text' && meta.text === post.text;
  if (post.type === 'link') return meta.preview.kind === 'link' && meta.preview.url === post.url;
  return false;
}

export function storeRoutes(app: FastifyInstance, { db, config, content, challenges, writer, trustPlugins, now = Date.now }: RouteDeps) {
  const cut = previewCutter(config.feed);

  // In server tagging mode, the only hashtags a post can have.
  const serverTags = allowedTags(config.tagging);
  const allowed = serverTags && new Set(serverTags);

  /**
   * The publisher's hashtags, which every post must have. In server tagging mode each must be one of
   * the server's: one that isn't is refused, not dropped, so nobody's hashtag silently goes missing.
   * Checked before any challenge, so nobody solves one for a post that can't go through.
   */
  function publisherTags(fields: Fields): string[] {
    const parsed = fields.tags === undefined ? { tags: [] } : parseTagList(fields.tags);
    if ('error' in parsed) throw badRequest(parsed.error);
    if (!parsed.tags.length) throw badRequest(msg(allowed ? 'post.tags_required_allowed' : 'post.tags_required'));
    const refused = allowed ? parsed.tags.find((tag) => !allowed.has(tag)) : undefined;
    if (refused !== undefined) throw badRequest(msg('post.tag_not_allowed', { tag: refused }));
    return parsed.tags;
  }

  /**
   * Creates or updates content. Moderation first gives the post a trust score, which says where it
   * goes: refused (422), held in the moderation queue for an admin, or published. It also drops
   * some of its hashtags (see moderatePost). A post soon after the user's previous one is then
   * answered with a challenge, or two once the run is a few posts long, before anything is stored. The post is
   * then written as contentWriter describes: an update writes over the content, which has one
   * version, and the last write wins. An update that would change nothing writes nothing, which only
   * a text or a link post can show: a file is stored again whenever it is sent.
   *
   * `comments` says whether the post takes comments (routes/comments.ts): off unless the publisher
   * turns it on, and kept by an update that doesn't say. It is in the meta file and the summary, and
   * nowhere in the database. An update that turns it off closes the post's comments and hides them,
   * and deletes none: turning it on again shows them.
   *
   * A banned user is refused (403), before anything else of the post is looked at: whatever it is,
   * a new post or an update, it is theirs no more to write.
   *
   * A post held in the queue is answered 202 with `status: "pending_review"`: it is stored, and its
   * publisher can read and update it, but it is in no feed until an admin accepts it.
   *
   * A file comes as a multipart part, inline in `content`, or as an `uploadId`: the file is then
   * already in the content store (see POST /uploads), which is how files reach a server whose requests
   * can't carry them (functions), and it stays there until a request stores it, so one answered with a
   * challenge is sent again with the same uploadId.
   */
  app.post('/store', { bodyLimit: 32 * 1024 * 1024 }, async (req, reply) => {
    let raw: Record<string, unknown>;
    let upload: Upload | undefined;
    let post: Post | undefined;
    if (req.isMultipart()) {
      ({ fields: raw, upload } = await readMultipart(req, config.storage));
    } else {
      raw = (req.body as Record<string, unknown>) ?? {};
    }

    // Whether the server holds the post once the request is over: written now, or as it already did.
    let stored = false;
    try {
      const fields = Fields.parse(raw);
      if (upload && fields.content !== undefined) throw badRequest(msg('post.file_or_field'));
      const { uploadId } = fields;
      if (uploadId && (upload || fields.content !== undefined)) throw badRequest(msg('post.one_source'));
      // An upload is kept under its user's id, so it is only looked for once the request is known to be theirs.
      if (!uploadId) post = await readPost(fields, upload, config.storage);

      const user = await authenticate(db, req, fields);
      refuseBanned(user);
      if (uploadId) upload = await readUploaded(content, user.id, uploadId, config.storage);
      post ??= await readPost(fields, upload, config.storage);
      const { filename, mimeType } = post;
      const publisher: Publisher = { userId: user.id, username: user.username };
      const tags = publisherTags(fields);

      const row = fields.contentId
        ? await db.selectFrom('content').selectAll().where('id', '=', fields.contentId).executeTakeFirst()
        : undefined;
      if (fields.contentId && !row) throw contentNotFound();
      // The content an update writes over: its row, and its meta file, which says what it is now.
      let existing: Existing | undefined;
      if (row) {
        if (row.user_id !== user.id) throw forbidden(msg('content.update_own_only'));
        const [meta, held] = await Promise.all([
          requireMeta(content, row.id),
          db.selectFrom('moderation_queue').select('content_id').where('content_id', '=', row.id).executeTakeFirst(),
        ]);
        existing = { row, meta, queued: held !== undefined };
        assertUpdatable(row, existing.meta, mimeType);
      }

      const aiGenerated = fields.aiGenerated ?? (row?.ai_generated === 1);
      // The post's own two flags: the declaration that it was created with AI, and whether it takes comments.
      const flags: PostFlags = { aiGenerated, comments: fields.comments ?? (existing !== undefined && takesComments(existing.meta)) };
      const unchanged = ({ row, queued }: Existing, removedTags: RemovedTag[] = []) => {
        stored = true;
        return { contentId: row.id, unchanged: true, ...(queued && PENDING_REVIEW), ...(removedTags.length > 0 && { removedTags }) };
      };
      // The post is the content as it is, hashtags aside. A file isn't compared: it is stored again.
      const same =
        existing !== undefined &&
        aiGenerated === (existing.row.ai_generated === 1) &&
        flags.comments === takesComments(existing.meta) &&
        sameBody(post, existing.meta);
      // The publisher's hashtags make it an update only if they aren't the content's.
      if (existing && same && sameTags(tags, existing.meta.tags)) return unchanged(existing);

      // Before any challenge, so nobody solves one for a post that isn't stored.
      const texts = [post.type === 'link' ? post.url : post.text, filename];
      const moderated = await moderatePost({ db, config, trustPlugins, now }, { userId: user.id, contentId: existing?.row.id, tags, texts });
      const queued = moderated.route === 'queue';
      // The same content with the same hashtags, going where it already is.
      if (existing && same && queued === existing.queued && sameTags(moderated.tags, existing.meta.tags)) return unchanged(existing, moderated.removedTags);

      const admitted = post;
      const s = await challenges.admitting(user.id, fields, () =>
        store(publisher, admitted, flags, existing, moderated.tags, queued ? { trustScore: moderated.trustScore } : undefined),
      );
      stored = true;
      reply.status(queued ? 202 : existing ? 200 : 201);
      return {
        contentId: s.contentId,
        ...(queued && PENDING_REVIEW),
        tags: s.tags,
        ...(moderated.removedTags.length > 0 && { removedTags: moderated.removedTags }),
        preview: s.preview,
        aiGenerated: s.aiGenerated,
        comments: s.comments,
      };
    } finally {
      // Before the response goes out (it is what this returns): a function may be frozen straight after it.
      await upload?.file.release(stored);
      await post?.file.release(stored);
    }
  });

  async function store(
    publisher: Publisher,
    post: Post,
    { aiGenerated, comments }: PostFlags,
    existing: Existing | undefined,
    tags: string[],
    queued: { trustScore: number } | undefined,
  ): Promise<Summary> {
    const contentId = existing?.row.id ?? randomUUID();
    const ts = now();
    const createdAt = existing?.row.created_at ?? ts;
    const { file, mimeType } = post;
    const preview: Preview =
      post.type === 'text'
        ? { kind: 'text', text: cut(post.text) }
        : post.type === 'link'
          ? { kind: 'link', url: post.url }
          : { kind: post.type, url: mediaUrl(config.publicBaseUrl, contentId), ...(post.text ? { text: cut(post.text) } : {}) };
    const text = textOf(post);

    const summary: Summary = { contentId, createdAt, updatedAt: ts, userId: publisher.userId, mimeType, aiGenerated, comments, tags, preview };
    // The size recorded is that of the bytes as stored, which putBytes returns.
    const meta: ContentMeta = { contentId, mimeType, size: file.size, aiGenerated, comments, preview, ...(text !== undefined && { text }), tags, updatedAt: ts };
    await writer.write({ publisher, previous: existing?.meta, summary, meta, putBytes: () => file.place(content, contentId, mimeType), queued });
    return summary;
  }
}
