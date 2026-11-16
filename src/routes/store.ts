import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/apiKey.js';
import { ChallengeFields } from '../challenge/challenges.js';
import { contentNotFound, requireMeta, takesComments } from '../content.js';
import type { ContentRow } from '../db/schema.js';
import type { RouteDeps } from '../deps.types.js';
import { badRequest, forbidden } from '../http/errors.js';
import { plainText } from '../format.js';
import { Credentials, Flag } from '../http/schemas.js';
import { msg } from '../language.js';
import { moderatePost, refuseBanned } from '../moderation/policy.js';
import type { RemovedTag } from '../moderation/policy.types.js';
import { LinkUrl, MAX_TEXT_CHARS, mediaUrl, POST_TYPES, previewCutter } from '../posts.js';
import { MAX_REPOSTED_TAGS, repostedTags, repostsOf, repostTimes, type Repost } from '../reposts.js';
import type { ContentMeta, ContentStore, Preview, Publisher, Summary } from '../storage/index.js';
import { allowedTags, MAX_TAGS, parseTagList, sameTags } from '../tags.js';
import { readMultipart, readPost, readUploaded, requirePostType, textOf, type Post } from '../upload.js';
import type { Upload } from '../upload.types.js';
import { assertUpdatable } from '../write.js';

/**
 * What POST /store says of a post, as JSON or as the fields of a multipart form: what it is, its
 * text, its URL or its file, its hashtags and its flags, with `contentId` when it is an update,
 * and the solution of a challenge when the request answers one.
 */
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

/** `queued`: it waits in the moderation queue. `reposts`: the places reposts gave it. */
type Existing = { row: ContentRow; meta: ContentMeta; queued: boolean; reposts: Repost[] };

/** What a publisher says of a post beside what it is: that it was created with AI, and that it takes comments. */
type PostFlags = { aiGenerated: boolean; comments: boolean };

/** What /store answers about content that waits in the moderation queue, beside 202 for a write of it. */
const PENDING_REVIEW = { status: 'pending_review' } as const;

/**
 * Whether the post is what the content holds: a text post's text, a link post's URL, or an image's,
 * video's or audio's caption and file. A file is the content's if its hash is the one the meta file
 * keeps (see ContentMeta.sha256). Where either has none, it isn't taken to be, and is stored again.
 *
 * The hash is the meta file's word for the bytes, and two updates sent at once can leave the bytes
 * of one with the meta file of the other (see contentWriter). So the bytes are looked at as well,
 * as far as that is cheap: they must be of the size the meta file says.
 */
async function sameBody(post: Post, meta: ContentMeta, content: ContentStore): Promise<boolean> {
  if (post.type === 'text') return meta.preview.kind === 'text' && meta.text === post.text;
  if (post.type === 'link') return meta.preview.kind === 'link' && meta.preview.url === post.url;
  // The hash last: it can take reading the file (see PostBytes.hash).
  if (meta.text !== post.text || meta.sha256 === undefined || (await post.file.hash()) !== meta.sha256) return false;
  return content.stat(meta.contentId).then(
    ({ size }) => size === meta.size,
    () => false,
  );
}

/** Writing posts (POST /store): a new post, or with `contentId`, an update of one of the publisher's own. */
export function storeRoutes(app: FastifyInstance, { db, config, content, challenges, writer, trustPlugins, now = Date.now }: RouteDeps) {
  const cut = previewCutter(config.feed);

  // In server tagging mode, the only hashtags a post can have.
  const serverTags = allowedTags(config.tagging);
  const allowed = serverTags && new Set(serverTags);

  /**
   * The publisher's hashtags, which every new post must have. In server tagging mode each must be one of
   * the server's: one that isn't is refused, not dropped, so nobody's hashtag silently goes missing.
   * Checked before any challenge, so nobody solves one for a post that can't go through.
   *
   * An update says its hashtags too, so no client drops a post's hashtags by not sending them. That
   * is checked once the content is read (see `tagsRequired`), since one post's update may say it
   * has none: a post that has none of its own, after moderators took the last off it. It is still
   * its publisher's to edit, and stays in no hashtag's feed until an update gives it one.
   *
   * These are the publisher's own hashtags. The ones reposts gave the content (src/reposts.ts) are
   * the content's too, and not the publisher's to drop: an update keeps them whether it sends them
   * or not (see the route).
   */
  function publisherTags(fields: Fields): string[] {
    // An update may send back the hashtags reposts gave the content with its own: how many are its own is counted once those are known.
    const parsed = fields.tags === undefined ? { tags: [] } : parseTagList(fields.tags, fields.contentId === undefined ? MAX_TAGS : MAX_TAGS + MAX_REPOSTED_TAGS);
    if ('error' in parsed) throw badRequest(parsed.error);
    if (!parsed.tags.length && fields.contentId === undefined) throw tagsRequired();
    const refused = allowed ? parsed.tags.find((tag) => !allowed.has(tag)) : undefined;
    if (refused !== undefined) throw badRequest(msg('post.tag_not_allowed', { tag: refused }));
    return parsed.tags;
  }
  const tagsRequired = () => badRequest(msg(allowed ? 'post.tags_required_allowed' : 'post.tags_required'));

  /**
   * Creates or updates content. Moderation first gives the post a trust score, which says where it
   * goes: refused (422), held in the moderation queue for an admin, or published. It also drops
   * some of its hashtags (see moderatePost). A post soon after the user's previous one is then
   * answered with a challenge, or two once the run is a few posts long, before anything is stored. The post is
   * then written as contentWriter describes: an update writes over the content, which has one
   * version, and the last write wins. An update that would change nothing writes nothing: the same
   * text or URL, or the same caption and file, with the same flags and hashtags. A file is told by
   * the hash of its bytes as stored, which the meta file keeps. A video or audio file sent with an
   * upload link has none, since the content store copies it itself, and is stored whenever it is sent.
   *
   * `comments` says whether the post takes comments (routes/comments.ts): off unless the publisher
   * turns it on, and kept by an update that doesn't say. It is in the meta file and the summary, and
   * nowhere in the database. An update that turns it off closes the post's comments and hides them,
   * and deletes none: turning it on again shows them.
   *
   * An update of a post that was reposted (src/reposts.ts) keeps the hashtags the reposts gave it,
   * whether it sends them or not: `tags` says the publisher's own, and those can be changed and
   * dropped as ever. What the post now says is held to the rules of all its hashtags, so an update
   * can cost it one a repost gave it: one the publisher is muted on, or whose blocked words the
   * post now has. That hashtag is then removed from the post as a moderator's removal removes it,
   * and is in `removedTags`. A repost of a post on another server has no update (400): it is a
   * link to the original with its summary, and nothing of it is written here.
   *
   * A post of a type the server has turned off (POST_TYPE_TEXT and the like) is refused (400), new
   * or an update, before its file, text or link is read.
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
      requirePostType(config.postTypes, fields.type);
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
      const sent = publisherTags(fields);

      const row = fields.contentId
        ? await db.selectFrom('content').selectAll().where('id', '=', fields.contentId).executeTakeFirst()
        : undefined;
      if (fields.contentId && !row) throw contentNotFound();
      // The content an update writes over: its row, its meta file, which says what it is now, and where reposts put it.
      let existing: Existing | undefined;
      if (row) {
        if (row.user_id !== user.id) throw forbidden(msg('content.update_own_only'));
        // A repost of a post on another server is a link to it with its summary: there is nothing of it to write here.
        if (row.origin_hash !== null) throw badRequest(msg('content.is_repost'));
        const [meta, held, reposts] = await Promise.all([
          requireMeta(content, row.id),
          db.selectFrom('moderation_queue').select('content_id').where('content_id', '=', row.id).executeTakeFirst(),
          repostsOf(db, row.id),
        ]);
        existing = { row, meta, queued: held !== undefined, reposts };
        assertUpdatable(row, existing.meta, mimeType);
      }
      // The hashtags reposts gave the content, which an update keeps, and the publisher's own: the rest.
      const given = repostedTags(existing?.reposts ?? []);
      const own = (tags: string[]) => tags.filter((tag) => !given.includes(tag));
      if (own(sent).length > MAX_TAGS) throw badRequest(msg('tags.too_many', { max: MAX_TAGS, got: own(sent).length }));
      // An update has to say the publisher's hashtags, unless the content has none of its own to lose.
      if (existing && !own(sent).length && own(existing.meta.tags).length) throw tagsRequired();

      const aiGenerated = fields.aiGenerated ?? (row?.ai_generated === 1);
      // The post's own two flags: the declaration that it was created with AI, and whether it takes comments.
      const flags: PostFlags = { aiGenerated, comments: fields.comments ?? (existing !== undefined && takesComments(existing.meta)) };
      const unchanged = ({ row, queued }: Existing, removedTags: RemovedTag[] = []) => {
        stored = true;
        return { contentId: row.id, unchanged: true, ...(queued && PENDING_REVIEW), ...(removedTags.length > 0 && { removedTags }) };
      };
      const sameFlags = existing !== undefined && aiGenerated === (existing.row.ai_generated === 1) && flags.comments === takesComments(existing.meta);
      // The post is the content as it is: its flags, its hashtags (the publisher's own make it an update only if
      // they aren't the content's own), and its body, compared last, since a file's can take reading it.
      if (existing && sameFlags && sameTags(own(sent), own(existing.meta.tags)) && (await sameBody(post, existing.meta, content))) return unchanged(existing);

      // Before any challenge, so nobody solves one for a post that isn't stored. A text or caption is read as
      // its readers read it, without its formatting ("sp**am**" says spam), with where its links lead.
      // What the content says now is held to the rules of every hashtag it has, those reposts gave it too.
      const moderated = await moderatePost(
        { db, config, trustPlugins, now, log: req.log },
        {
          userId: user.id,
          contentId: existing?.row.id,
          tags: [...own(sent), ...given],
          texts: [post.type === 'link' ? post.url : post.text && plainText(post.text, true), filename],
        },
      );
      const queued = moderated.route === 'queue';
      // The hashtags of reposts that the update is refused, by a mute or a blocked word: they come off the content
      // for good (see ContentWrite.droppedReposts). One a moderator removed is coming off it already.
      const droppedReposts = moderated.removedTags.filter((r) => given.includes(r.tag) && r.reason !== 'removed').map((r) => r.tag);
      // What the publisher is told: of the hashtags they sent, and of the reposts' ones this update costs the content.
      const removedTags = moderated.removedTags.filter((r) => sent.includes(r.tag) || droppedReposts.includes(r.tag));
      // The same content with the same hashtags, going where it already is.
      if (
        existing &&
        sameFlags &&
        queued === existing.queued &&
        !droppedReposts.length &&
        sameTags(own(moderated.tags), own(existing.meta.tags)) &&
        (await sameBody(post, existing.meta, content))
      ) {
        return unchanged(existing, removedTags);
      }

      const admitted = post;
      const s = await challenges.admitting('post', user.id, fields, req.language, () =>
        store(
          { userId: user.id, username: user.username },
          admitted,
          flags,
          existing,
          moderated.tags,
          queued ? { trustScore: moderated.trustScore } : undefined,
          droppedReposts,
        ),
      );
      stored = true;
      reply.status(queued ? 202 : existing ? 200 : 201);
      return {
        contentId: s.contentId,
        ...(queued && PENDING_REVIEW),
        tags: s.tags,
        ...(removedTags.length > 0 && { removedTags }),
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
    droppedReposts: string[],
  ): Promise<Summary> {
    const contentId = existing?.row.id ?? randomUUID();
    const ts = now();
    const { file, mimeType } = post;
    const preview: Preview =
      post.type === 'text'
        ? { kind: 'text', text: cut(post.text) }
        : post.type === 'link'
          ? { kind: 'link', url: post.url }
          : { kind: post.type, url: mediaUrl(config.publicBaseUrl, contentId), ...(post.text ? { text: cut(post.text) } : {}) };
    const text = textOf(post);

    // A file's hash, of the bytes that are then stored, for a later update's file to be compared by (see sameBody).
    const sha256 = post.type === 'text' || post.type === 'link' ? null : await file.hash();

    const reposts = existing?.reposts ?? [];
    // Reposted content has its summary under the day of each repost too, which is where those entries look for it.
    const repostedAt = repostTimes(reposts);
    const summary: Summary = {
      contentId,
      createdAt: existing?.row.created_at ?? ts,
      updatedAt: ts,
      userId: publisher.userId,
      mimeType,
      aiGenerated,
      comments,
      tags,
      preview,
      ...(repostedAt.length > 0 && { repostedAt }),
    };
    await writer.write({
      publisher,
      previous: existing?.meta,
      summary,
      // The size recorded is that of the bytes as stored, which putBytes returns.
      meta: {
        contentId,
        mimeType,
        size: file.size,
        ...(sha256 !== null && { sha256 }),
        aiGenerated,
        comments,
        preview,
        ...(text !== undefined && { text }),
        tags,
        updatedAt: ts,
      },
      putBytes: () => file.place(content, contentId, mimeType),
      queued,
      reposts,
      droppedReposts,
    });
    return summary;
  }
}
