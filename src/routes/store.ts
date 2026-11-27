import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/apiKey.js';
import { contentNotFound, PENDING_REVIEW, PROCESSING, requireMeta, takesComments } from '../content.js';
import type { ContentRow } from '../db/schema.js';
import type { RouteDeps } from '../deps.types.js';
import { badRequest, forbidden } from '../http/errors.js';
import { plainText } from '../format.js';
import { Credentials, Flag } from '../http/schemas.js';
import { excerptOf } from '../inbox.js';
import { messageKey, msg } from '../language.js';
import { notifyMentions, resolveMentions } from '../mentions.js';
import type { Mention } from '../mentions.types.js';
import { moderatePost, refuseBanned } from '../moderation/policy.js';
import type { RemovedTag } from '../moderation/policy.types.js';
import type { TrustClient } from '../moderation/trust.types.js';
import { altsOf, LinkUrl, MAX_ALT_CHARS, MAX_POST_IMAGES, MAX_TEXT_CHARS, MAX_TITLE_CHARS, mediaUrl, POST_TYPES, previewCutter, shownTitle, titleLine } from '../posts.js';
import { MAX_REPOSTED_TAGS, repostedTags, repostsOf, type Repost } from '../reposts.js';
import { admitting } from '../sendLimit.js';
import type { ContentMeta, Preview, Publisher, Summary } from '../storage/index.js';
import { allowedTags, MAX_TAGS, parseTagList, sameTags } from '../tags.js';
import { filesOf, oneFile, readMultipart, readPost, readUploaded, requirePostType, textOf, trustImage, type Post } from '../upload.js';
import type { SentFile, Upload } from '../upload.types.js';
import { allDone } from '../util.js';
import { jobClient } from '../video/jobs.js';
import { assertUpdatable } from '../write.js';

/**
 * An image's alternative text, as a request sends it: what describes the image to those who
 * can't see it, which a screen reader reads out in its place. Without the spaces around it,
 * MAX_ALT_CHARS at most. One that is empty says the image has none.
 */
const Alt = z.string().trim().max(MAX_ALT_CHARS);

/**
 * One image of an image post, as a JSON request lists them in `images`: inline in `content`,
 * encoded as the request's `contentEncoding` says, or already sent to the link POST /uploads
 * gave, by the `uploadId` it came with. One or the other. With its alternative text, if it
 * has one.
 */
const ImageField = z
  .object({
    content: z.string().optional(),
    uploadId: z.string().uuid().optional(),
    contentType: z.string().max(255).optional(),
    filename: z.string().max(512).optional(),
    /** What describes the image to those who can't see it. */
    alt: Alt.optional(),
  })
  .refine((image) => (image.content === undefined) !== (image.uploadId === undefined), { message: messageKey('post.image_source') });

/**
 * What POST /store says of a post, as JSON or as the fields of a multipart form: what it is, its
 * text, its URL or its file, its hashtags and its flags, with `contentId` when it is an update.
 * An image post of several images sends them as that many file parts of a multipart form, or
 * in `images` of a JSON request.
 */
const Fields = Credentials.extend({
  contentId: z.string().uuid().optional(),
  /** What the post is: an image (or several: an album), video or audio file, with an optional caption in `text`; text; or a link. */
  type: z.enum(POST_TYPES),
  /**
   * The post's title: one line of plain text, MAX_TITLE_CHARS at most as it is kept (see
   * titleLine). Whether a post has one, and whether it has to, is the server's setting
   * (POST_TITLES, which GET /rules gives as `postTitles`): the route holds it to that.
   */
  title: z.string().optional(),
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
  /**
   * The images of an image post, in the order they are shown, where the request doesn't send
   * them as file parts: up to MAX_POST_IMAGES, which the route holds it to. In place of
   * `content` and `uploadId`, which send one. Each can say its own `contentType` and `filename`.
   */
  images: z.array(ImageField).min(1).optional(),
  /**
   * The alternative text of an image post's image: what describes it to those who can't see it.
   * Of the one image sent in `content`, as a file part or by `uploadId`. Each image of `images`
   * says its own, and a multipart form with several file parts sends this field once for each,
   * in their order (see the route).
   */
  alt: Alt.optional(),
  contentEncoding: z.enum(['utf8', 'base64']).default('utf8'),
});
type Fields = z.infer<typeof Fields>;

/** `queued`: it waits in the moderation queue. `reposts`: the places reposts gave it. */
type Existing = { row: ContentRow; meta: ContentMeta; queued: boolean; reposts: Repost[] };

/** What a publisher says of a post beside what it is: that it was created with AI, and that it takes comments. */
type PostFlags = { aiGenerated: boolean; comments: boolean };

/**
 * Whether the post is what the content holds: a text post's text, a link post's URL, or an image's,
 * video's or audio's caption and file. A file is the content's if its hash is the one the meta file
 * keeps (see ContentMeta.sha256). Where either has none, it isn't taken to be, and is stored again.
 * An image post of several images is the content if it has the same images in the same order,
 * and an image post if its images are described as the content's are (their alternative texts).
 *
 * The hash is the meta file's word for the bytes, and it is to be taken at it: the bytes and the
 * meta file are one write's, written by the compactor alone, the meta file once the bytes are there.
 */
async function sameBody(post: Post, meta: ContentMeta): Promise<boolean> {
  if (post.type === 'text') return meta.preview.kind === 'text' && meta.text === post.text;
  if (post.type === 'link') return meta.preview.kind === 'link' && meta.preview.url === post.url;
  if (meta.text !== post.text) return false;
  const files = filesOf(post);
  const had = meta.images ?? [meta];
  if (files.length !== had.length) return false;
  // What describes each image, which is the post's as its images are: one that says another, or none where there was one, is an update.
  const alts = altsOf(meta.preview) ?? [];
  if (files.some(({ alt }, i) => (alt ?? '') !== (alts[i] ?? ''))) return false;
  // The hashes last: each can take reading the file (see PostBytes.hash).
  for (const [i, { file }] of files.entries()) {
    const { sha256 } = had[i]!;
    if (sha256 === undefined || (await file.hash()) !== sha256) return false;
  }
  return true;
}

/** Writing posts (POST /store): a new post, or with `contentId`, an update of one of the publisher's own. */
export function storeRoutes(app: FastifyInstance, { db, config, content, hot, writer, trust, now = Date.now }: RouteDeps) {
  const cut = previewCutter(config.feed);

  // In server tagging mode, the only hashtags a post can have.
  const serverTags = allowedTags(config.tagging);
  const allowed = serverTags && new Set(serverTags);

  /**
   * The publisher's hashtags, which every new post must have. In server tagging mode each must be one of
   * the server's: one that isn't is refused, not dropped, so nobody's hashtag silently goes missing.
   * Checked before the limit on posts a minute, so a post that can't go through doesn't count.
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
   * The title the post is sent with, as it is kept (see titleLine), held to what the server does
   * with titles (POST_TITLES): where they are required, a post without one is refused; where they
   * are off, a post with one is; and one longer than MAX_TITLE_CHARS is refused wherever titles
   * are on. Undefined for a post that is sent with none, or with one that is only white space.
   * New or an update: an update says the post's title again, as it says all of the post.
   */
  function sentTitle(fields: Fields): string | undefined {
    const title = titleLine(fields.title);
    if (config.postTitles === 'off') {
      if (title !== undefined) throw badRequest(msg('post.titles_off'));
      return undefined;
    }
    if (title === undefined) {
      if (config.postTitles === 'on_required') throw badRequest(msg('post.title_required'));
      return undefined;
    }
    if (title.length > MAX_TITLE_CHARS) throw badRequest(msg('post.title_too_long', { max: MAX_TITLE_CHARS }));
    return title;
  }

  /** Whether the post's file is one the server processes before it is published: a video's, where it processes videos (`video.processing`). */
  const processes = (post: Post) => post.type === 'video' && config.video.processing;

  /**
   * Creates or updates content. Moderation first gives the post a trust score, which says where it
   * goes: refused (422), held in the moderation queue for a server moderator or an admin, or published. It also drops
   * some of its hashtags (see moderatePost). A post past the most a user sends in a minute
   * (`postRateLimitPerMinute`) is then refused (429), before anything is stored. The post is
   * then written as contentWriter describes: committed to the database, for the compactor's next
   * run to write to the stores. An update writes over the content, which has one version, and the
   * last write wins. An update that would change nothing writes nothing: the same
   * text or URL, or the same caption and file, with the same flags and hashtags. A file is told by
   * the hash of its bytes as stored, which the meta file keeps. A video or audio file sent with an
   * upload link has none, since the content store copies it itself, and is stored whenever it is sent.
   *
   * `comments` says whether the post takes comments (routes/comments.ts): off unless the publisher
   * turns it on, and kept by an update that doesn't say. It is in the meta file and the summary, and
   * nowhere in the database. An update that turns it off closes the post's comments and hides them,
   * and deletes none: turning it on again shows them.
   *
   * A text or a caption mentions users, by `@` and their name (src/mentions.ts). Whom it mentions
   * is found here and kept in the meta file, and the answer gives them as `mentions`: what the
   * text and its preview are read with, to show each as a link to the user's profile. Each of
   * them is told, by a notice in their inbox, once the post is published: now, or when it is
   * accepted from the moderation queue. An update tells those it newly mentions.
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
   * A post has a title where the server's titles are on (POST_TITLES, `postTitles` of GET /rules):
   * one line of plain text, MAX_TITLE_CHARS at most, kept in the meta file and the summary and
   * shown wherever the post is. With `on_required` a post without one is refused (400), new or an
   * update; with `on_optional` it is stored without; with `off` a post that sends one is refused
   * (400), and the answer has none. An update says the title again, as it says all of the post:
   * one that leaves it out takes the title off, where titles are optional. Where they are off, a
   * post that was given a title before keeps it through an update, though nobody is shown it.
   * The title is read by moderation as the text is.
   *
   * A banned user is refused (403), before anything else of the post is looked at: whatever it is,
   * a new post or an update, it is theirs no more to write.
   *
   * A post held in the queue is answered 202 with `status: "pending_review"`: it is stored, and its
   * publisher can read and update it, but it is in no feed until a server moderator or an admin accepts it.
   *
   * A file comes as a multipart part, inline in `content`, or as an `uploadId`: the file is then
   * already in the content store (see POST /uploads), which is how files reach a server whose requests
   * can't carry them (functions), and it stays there until a request stores it, so one the limit
   * refused is sent again with the same uploadId.
   *
   * A video is not published as it was sent, where the server processes videos (`video.processing`,
   * compactor/src/video): it is staged as it came, and the answer says `processing: true`. The video
   * worker then makes of it an MP4 that plays anywhere, without its metadata, with a poster and
   * an adaptive stream, and the post is published, in feeds and with its bytes, once that is
   * done: until then it is read by its id as written, with `processing`, and its bytes are not
   * served (an update's are the ones the post had). A video that can't be processed is told to
   * its publisher by a notice: a new post is deleted, and an update keeps the video it had. An
   * update takes a video of any type, since each is made the same MP4, and one with the file
   * the post was last sent is no update of it (the meta file keeps that file's hash).
   *
   * An image can come with its alternative text (`alt`), which describes it to those who can't
   * see it: of the one image of a post in `alt`, of each of `images` in its own `alt`, and of
   * several file parts in as many `alt` fields, in the order of the parts (an empty one for an
   * image that has none). It is kept in the post's preview, one for each image, shown wherever
   * the post is, and read by moderation as the caption is. Only an image post has any (400),
   * and an update says them again, as it says all of the post.
   *
   * An image post can have several images, up to MAX_POST_IMAGES: an album, shown in the order
   * they were sent. They come as that many file parts named "content", or in a JSON request's
   * `images`, each inline or as an uploadId of its own. Each is held to what the one image of a
   * post is, and the post is refused if any of them is. An update says all of the post's images,
   * as it says all of anything: the ones it leaves out are the post's no more. The content's type
   * is its first image's, which an update keeps, as any update keeps the content's type.
   */
  app.post('/store', { bodyLimit: 32 * 1024 * 1024 }, async (req, reply) => {
    let raw: Record<string, unknown>;
    // The files of the request: its file parts, and then the ones it names by an uploadId, as they are read.
    let uploads: Upload[] = [];
    // Every `alt` field of a multipart form, in the order they were sent: one for each file part, where there are several.
    let sentAlts: string[] = [];
    let post: Post | undefined;
    if (req.isMultipart()) {
      ({ fields: raw, alts: sentAlts, uploads } = await readMultipart(req, config.storage, MAX_POST_IMAGES));
    } else {
      raw = (req.body as Record<string, unknown>) ?? {};
    }

    // Whether the server holds the post once the request is over: written now, or as it already did.
    let stored = false;
    try {
      const fields = Fields.parse(raw);
      requirePostType(config.postTypes, fields.type);
      // Before anything of the post is read: one whose title the server doesn't take is refused for nothing.
      const givenTitle = sentTitle(fields);
      const parts = [...uploads];
      if (parts.length && fields.content !== undefined) throw badRequest(msg('post.file_or_field'));
      const { uploadId, images } = fields;
      if (uploadId && (parts.length || fields.content !== undefined)) throw badRequest(msg('post.one_source'));
      if (images) {
        if (fields.type !== 'image') throw badRequest(msg('post.images_only_for_images'));
        if (parts.length || fields.content !== undefined || uploadId) throw badRequest(msg('post.images_alone'));
        if (images.length > MAX_POST_IMAGES) throw badRequest(msg('post.too_many_images', { max: MAX_POST_IMAGES }));
        if (fields.alt) throw badRequest(msg('post.alt_in_images'));
      }
      // A form of several file parts describes each with an `alt` field of its own, in their order: no more of them than files.
      const alts = parts.length > 1 ? z.array(Alt).parse(sentAlts) : [];
      if (alts.length > parts.length) throw badRequest(msg('post.alt_count', { alts: alts.length, files: parts.length }));
      // The uploads the request names, each once.
      const uploadIds = [...new Set(images ? images.flatMap((image) => image.uploadId ?? []) : uploadId ? [uploadId] : [])];
      /**
       * The post's files as the request sends them, in their order: the images of `images`, the
       * file parts, or the one file in `content` or named by `uploadId`. `uploaded` is the
       * uploads the request names. What the request says of a file beside it (`contentType`,
       * `filename`, `alt`) is said of its one file: each of several says its own. One of `images` that
       * is inline and says neither is taken for an image, which its place says it is: its bytes
       * say which.
       */
      const sentFiles = (uploaded: Map<string, Upload>): SentFile[] =>
        images
          ? images.map(({ uploadId: id, ...image }) => ({
              ...image,
              ...(id === undefined && image.contentType === undefined && image.filename === undefined && { contentType: 'image/*' }),
              contentEncoding: fields.contentEncoding,
              upload: id === undefined ? undefined : uploaded.get(id),
            }))
          : parts.length > 1
            ? parts.map((upload, i) => ({ upload, contentEncoding: fields.contentEncoding, ...(alts[i] && { alt: alts[i] }) }))
            : oneFile(fields, uploadId === undefined ? parts[0] : uploaded.get(uploadId));
      // An upload is kept under its user's id, so it is only looked for once the request is known to be theirs.
      if (!uploadIds.length) post = await readPost(fields, sentFiles(new Map()), config.storage);

      const user = await authenticate(db, req, fields);
      refuseBanned(user);
      if (!post) {
        const uploaded = new Map<string, Upload>();
        for (const id of uploadIds) {
          const upload = await readUploaded(content, user.id, id, config.storage);
          uploads.push(upload);
          uploaded.set(id, upload);
        }
        post = await readPost(fields, sentFiles(uploaded), config.storage);
      }
      const { mimeType } = post;
      const sent = publisherTags(fields);

      const row = fields.contentId
        ? await db.selectFrom('content').selectAll().where('id', '=', fields.contentId).executeTakeFirst()
        : undefined;
      if (fields.contentId && !row) throw contentNotFound();
      // The content an update writes over: its row, then its meta file, which says what it is now (as its
      // newest write made it, applied or not), and where reposts put it.
      let existing: Existing | undefined;
      if (row) {
        if (row.user_id !== user.id) throw forbidden(msg('content.update_own_only'));
        // A repost of a post on another server is a link to it with its summary: there is nothing of it to write here.
        if (row.origin_hash !== null) throw badRequest(msg('content.is_repost'));
        const [meta, held, reposts] = await Promise.all([
          requireMeta({ db, content }, row.id),
          db.selectFrom('moderation_queue').select('content_id').where('content_id', '=', row.id).executeTakeFirst(),
          repostsOf(db, row.id),
        ]);
        existing = { row, meta, queued: held !== undefined, reposts };
        assertUpdatable(row, existing.meta, mimeType, { videos: config.video.processing });
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
      // The post's title: the one it is sent with, or where titles are off, the one the content was given before, which an update keeps.
      const title = config.postTitles === 'off' ? existing?.meta.title : givenTitle;
      const unchanged = ({ row, queued }: Existing, removedTags: RemovedTag[] = []) => {
        stored = true;
        return { contentId: row.id, unchanged: true, ...(queued && PENDING_REVIEW), ...(removedTags.length > 0 && { removedTags }) };
      };
      // With its title, which is the post's as its flags are: said beside what the post is.
      const sameFlags = existing !== undefined && aiGenerated === (existing.row.ai_generated === 1) && flags.comments === takesComments(existing.meta) && title === existing.meta.title;
      // The post is the content as it is: its flags and title, its hashtags (the publisher's own make it an update only if
      // they aren't the content's own), and its body, compared last, since a file's can take reading it.
      if (existing && sameFlags && sameTags(own(sent), own(existing.meta.tags)) && (await sameBody(post, existing.meta))) return unchanged(existing);

      // Before the limit on posts a minute, so a post that isn't stored doesn't count. A text or caption is read as
      // its readers read it, without its formatting ("sp**am**" says spam), with where its links lead.
      // What the content says now is held to the rules of every hashtag it has, those reposts gave it too.
      const moderated = await moderatePost(
        { trust, now, log: req.log, client: { ip: req.ip, userAgent: req.headers['user-agent'] ?? null } },
        {
          userId: user.id,
          contentId: existing?.row.id,
          tags: [...own(sent), ...given],
          // Its title first. With what describes its images: text of the post's as its caption is, to those it is read out to.
          texts: [title, post.type === 'link' ? post.url : post.text && plainText(post.text, true), ...filesOf(post).flatMap(({ filename, alt }) => [filename, alt])],
          // An image post's images, which a trust plugin that looks at pictures reads (see trustImage).
          ...(post.type === 'image' && { images: filesOf(post).map(trustImage) }),
          // The declaration the post will have: the one it is sent with, or the content's own.
          aiGenerated,
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
        (await sameBody(post, existing.meta))
      ) {
        return unchanged(existing, removedTags);
      }

      const admitted = post;
      // Whom its text or caption mentions: an update's goes on mentioning whom the text it replaces did (see resolveMentions).
      const mentions = await resolveMentions(db, textOf(admitted), existing?.meta.mentions);
      const s = await admitting({ hot, config, now }, 'post', user.id, () =>
        store(
          { userId: user.id, username: user.username },
          admitted,
          flags,
          title,
          existing,
          moderated.tags,
          queued ? { trustScore: moderated.trustScore } : undefined,
          given,
          droppedReposts,
          mentions,
          { ip: req.ip, userAgent: req.headers['user-agent'] ?? null },
        ),
      );
      stored = true;
      // They are told once the post is published: one that is held tells nobody until it is accepted
      // (routes/moderation.ts). Not those the post mentioned already, as it was last published.
      if (!queued) {
        const before = existing && !existing.queued ? existing.meta.mentions : undefined;
        await notifyMentions({ db, now }, { by: user.id, contentId: s.contentId, mentions, before, excerpt: excerptOf(s) }, req.log);
      }
      reply.status(queued ? 202 : existing ? 200 : 201);
      return {
        contentId: s.contentId,
        ...(queued && PENDING_REVIEW),
        tags: s.tags,
        ...(removedTags.length > 0 && { removedTags }),
        ...shownTitle(s, config.postTitles),
        preview: s.preview,
        ...(mentions.length > 0 && { mentions }),
        aiGenerated: s.aiGenerated,
        comments: s.comments,
        ...(processes(admitted) && PROCESSING),
      };
    } finally {
      // Before the response goes out (it is what this returns): a function may be frozen straight after it.
      await allDone(uploads.map(({ file }) => file.release(stored)));
      await allDone((post ? filesOf(post) : []).map(({ file }) => file.release(stored)));
    }
  });

  async function store(
    publisher: Publisher,
    post: Post,
    { aiGenerated, comments }: PostFlags,
    title: string | undefined,
    existing: Existing | undefined,
    tags: string[],
    queued: { trustScore: number } | undefined,
    given: string[],
    droppedReposts: string[],
    mentions: Mention[],
    client: TrustClient,
  ): Promise<Summary> {
    const contentId = existing?.row.id ?? randomUUID();
    const ts = now();
    const { file, mimeType } = post;
    // Its one file, or for an image post, its images in their order: more than one is an album.
    const files = filesOf(post);
    const album = files.length > 1;
    // What describes each image, in their order, '' for one that isn't described: kept where any is.
    const alt = files.some((image) => image.alt) ? files.map((image) => image.alt ?? '') : undefined;
    const preview: Preview =
      post.type === 'text'
        ? { kind: 'text', text: cut(post.text, mentions) }
        : post.type === 'link'
          ? { kind: 'link', url: post.url }
          : {
              kind: post.type,
              url: mediaUrl(config.publicBaseUrl, contentId),
              ...(post.text ? { text: cut(post.text, mentions) } : {}),
              ...(album && { imageCount: files.length }),
              ...(post.type === 'image' && alt && { alt }),
            };
    const text = textOf(post);

    // A file's hash, of the bytes that are then stored, for a later update's file to be compared by (see sameBody).
    // One file after another: the hash of an image sent with an upload link brings the image here (see readUploaded).
    const hashes: (string | null)[] = [];
    if (post.type !== 'text' && post.type !== 'link') for (const sent of files) hashes.push(await sent.file.hash());
    const sha256 = hashes[0] ?? null;

    // What the write makes of the content. The compactor writes its summary, under the day of each repost too (see applyPending).
    const summary: Summary = {
      contentId,
      createdAt: existing?.row.created_at ?? ts,
      updatedAt: ts,
      userId: publisher.userId,
      mimeType,
      aiGenerated,
      comments,
      tags,
      ...(title !== undefined && { title }),
      preview,
    };
    const written = await writer.write({
      publisher,
      previous: existing?.meta,
      seenSeq: existing && Number(existing.row.seq),
      summary,
      // The size recorded is that of the bytes as stored, which staging a file returns.
      meta: {
        contentId,
        mimeType,
        size: file.size,
        ...(sha256 !== null && { sha256 }),
        // Every image of an album, the first too, which is the one the three fields above are of.
        ...(album && { images: files.map((image, i) => ({ mimeType: image.mimeType, size: image.file.size, ...(hashes[i] != null && { sha256: hashes[i]! }) })) }),
        aiGenerated,
        comments,
        ...(title !== undefined && { title }),
        preview,
        ...(text !== undefined && { text }),
        ...(mentions.length > 0 && { mentions }),
        tags,
        updatedAt: ts,
      },
      // A text's and a link's bytes are in the meta file, which is all the compactor needs to write them.
      ...(post.type !== 'text' && post.type !== 'link' && { stageBytes: files.map((sent) => (writeId: string) => sent.file.stage(content, writeId, sent.mimeType)) }),
      processVideo: processes(post),
      // Who sent it goes with the video's job, where the server checks videos against a list, for the notice of a match.
      ...(processes(post) && { client: jobClient(config, client) }),
      queued,
      given,
      droppedReposts,
    });
    // As the write gave them: without the hashtags of a repost that was removed while the request was made.
    return { ...summary, tags: written };
  }
}
