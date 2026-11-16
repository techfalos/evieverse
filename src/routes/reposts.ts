import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, type AuthUser } from '../auth/apiKey.js';
import { ChallengeFields } from '../challenge/challenges.js';
import { loadPublished, requireMeta } from '../content.js';
import { isUniqueViolation } from '../db/index.js';
import type { RouteDeps } from '../deps.js';
import { plainText } from '../format.js';
import { badRequest, conflict, unprocessable } from '../http/errors.js';
import { Credentials, Flag } from '../http/schemas.js';
import { messageKey, msg } from '../language.js';
import { moderatePost, moderateRepost, refuseBanned, type RemovedTag } from '../moderation/policy.js';
import { LINK_MIME, LinkUrl, MAX_TEXT_CHARS, mediaType, originMediaUrl, previewCutter, TEXT_MIME } from '../posts.js';
import { MAX_REPOSTED_TAGS, readableOf, repostedTags, repostsOf } from '../reposts.js';
import type { ContentMeta, Origin, Preview, Publisher, Summary } from '../storage/index.js';
import { authorIndex } from '../tagfeed/layout.js';
import { allowedTags, parseTagList } from '../tags.js';
import { iso } from '../time.js';
import { requirePostType, spoolBytes } from '../upload.js';
import { alreadyReposted, tooManyReposted } from '../write.js';

/** A post's address on its own server ends with its id, as GET /content/:id reads it. */
const ORIGIN_PATH = /\/content\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * The address of the original of a repost: https://other.example/content/<id>, with nothing after
 * the id and nobody's credentials in it. Its id is read in lower case, so that an original has one
 * address here however it was sent (see `content.origin_hash`).
 */
const OriginUrl = LinkUrl.refine(
  (href) => {
    const url = new URL(href);
    return ORIGIN_PATH.test(url.pathname) && !url.search && !url.hash && !url.username && !url.password;
  },
  { message: messageKey('repost.origin_url') },
).transform((href) => href.replace(ORIGIN_PATH, (path) => path.toLowerCase()));

/** A content type, as one line of a summary holds it. */
const MimeType = z
  .string()
  .trim()
  .max(255)
  .regex(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/)
  .transform((type) => type.toLowerCase());

/**
 * The original's summary, as the reposter's client read it on the original's server (its feed
 * record, or GET /content/:id there) and sends it on: this server never asks another. An image's,
 * video's or audio's `url` isn't taken from it: the bytes are read at the original's address.
 */
const OriginPreview = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().trim().min(1).max(MAX_TEXT_CHARS) }),
  z.object({ kind: z.enum(['image', 'video', 'audio']), text: z.string().trim().max(MAX_TEXT_CHARS).optional() }),
  z.object({ kind: z.literal('link'), url: LinkUrl }),
]);

const OriginFields = z.object({
  url: OriginUrl,
  /** Who published the original there. The name is one line: it is kept on a line of the summary. */
  publisher: z.object({
    userId: z.string().uuid(),
    username: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .refine((name) => !/[\u0000-\u001f\u007f\u0085\u2028\u2029]/.test(name), { message: messageKey('repost.origin_username') }),
  }),
  /** The original's content type. Needed of an image, video or audio; a text's and a link's are their own. */
  mimeType: MimeType.optional(),
  aiGenerated: Flag.default(false),
  preview: OriginPreview,
});
type OriginFields = z.infer<typeof OriginFields>;

const Body = Credentials.extend({
  /** The post to repost, on this server. */
  contentId: z.string().uuid().optional(),
  /** Or the post to repost, on another server, with its summary. */
  origin: OriginFields.optional(),
  /** The hashtags the repost gives the post: a list, or one string of them separated by commas or spaces. */
  tags: z.union([z.array(z.string().max(100)).max(50), z.string().max(5000)]).optional(),
  ...ChallengeFields,
});
type Body = z.infer<typeof Body>;

/** How /store answers about content that waits in the moderation queue, and so does a repost that is held there. */
const PENDING_REVIEW = { status: 'pending_review' } as const;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export function repostRoutes(app: FastifyInstance, { db, config, content, challenges, writer, trustPlugins, now = Date.now }: RouteDeps) {
  const cut = previewCutter(config.feed);
  const serverTags = allowedTags(config.tagging);
  const allowed = serverTags && new Set(serverTags);
  /** This server's own address, as an origin under it is told by. None: no address is known to be its own. */
  const ownBase = config.publicBaseUrl ? config.publicBaseUrl.replace(/\/+$/, '') : null;

  /** The hashtags a repost gives, which it must name: held to the server's own in server tagging mode, as a post's are. */
  function repostTags(body: Body): string[] {
    const parsed = body.tags === undefined ? { tags: [] } : parseTagList(body.tags);
    if ('error' in parsed) throw badRequest(parsed.error);
    if (!parsed.tags.length) throw badRequest(msg('repost.tags_required'));
    const refused = allowed ? parsed.tags.find((tag) => !allowed.has(tag)) : undefined;
    if (refused !== undefined) throw badRequest(msg('post.tag_not_allowed', { tag: refused }));
    return parsed.tags;
  }

  /** The id of the post an address names, if the address is one of this server's. */
  function ownContentId(url: string): string | null {
    if (ownBase === null) return null;
    let base: string;
    try {
      base = new URL(ownBase).href.replace(/\/+$/, '');
    } catch {
      return null;
    }
    const id = ORIGIN_PATH.exec(url)?.[1];
    return id !== undefined && url === `${base}/content/${id}` ? id : null;
  }

  /**
   * Reposts a post: gives it more hashtags, under which it then shows as a new post, as it does
   * in the following feeds of those who follow the reposter. Nothing is copied. It is one of two
   * requests:
   *
   * With `contentId`, a post on this server. The post gets the hashtags; it stays one piece of
   * content, with one like count, credited to its publisher (see repostHere).
   *
   * With `origin`, a post on another server: its address there, who published it, and its summary,
   * all of which the reposter's client read on that server and sends on, since no server asks
   * another. The server keeps one entry for an original: new content that is a link to it, with
   * its summary (see repostFrom). An original it has an entry of already is reposted as that entry
   * is, like a post written here; and an address that is this server's own names a post of its
   * own, and is reposted as one.
   *
   * Either way the repost has to name the hashtags it gives (400), in server tagging mode from the
   * server's own. It is a post as far as challenges and the posts-a-minute limit go. A banned user
   * is refused (403). REPOSTS=false turns the route off (400), and REPOSTS_REMOTE=false the second
   * kind.
   */
  app.post('/repost', async (req, reply) => {
    const body = Body.parse(req.body ?? {});
    if (!config.reposts.enabled) throw badRequest(msg('repost.off'));
    if ((body.contentId === undefined) === (body.origin === undefined)) throw badRequest(msg('repost.one_source'));
    if (body.origin && !config.reposts.remote) throw badRequest(msg('repost.remote_off'));
    const user = await authenticate(db, req, body);
    refuseBanned(user);
    const tags = repostTags(body);

    if (body.contentId !== undefined) return repostHere(req, reply, user, body.contentId, tags, body);
    const origin = body.origin!;
    const local = ownContentId(origin.url);
    if (local !== null) return repostHere(req, reply, user, local, tags, body);

    const hash = sha256(origin.url);
    const entry = await entryOf(hash);
    if (entry !== null) return repostHere(req, reply, user, entry, tags, body);
    try {
      return await repostFrom(req, reply, user, origin, hash, tags, body);
    } catch (err) {
      // Someone else's repost of the same original committed first: theirs is the server's entry for it.
      if (!isUniqueViolation(err)) throw err;
      const first = await entryOf(hash);
      if (first === null) throw err;
      return repostHere(req, reply, user, first, tags, body);
    }
  });

  /**
   * The id of the server's entry for the original whose address hashes to `hash`, or null if it
   * has none. 409 for one nobody can repost now: it waits in the moderation queue, or is set for
   * deletion, after which the original can be reposted anew.
   */
  async function entryOf(hash: string): Promise<string | null> {
    const entry = await db
      .selectFrom('content')
      .leftJoin('moderation_queue', 'moderation_queue.content_id', 'content.id')
      .select(['content.id', 'content.delete_requested_at', 'moderation_queue.content_id as queued_id'])
      .where('content.origin_hash', '=', hash)
      .executeTakeFirst();
    if (!entry) return null;
    if (entry.delete_requested_at !== null || entry.queued_id !== null) throw conflict(msg('repost.origin_unavailable'));
    return entry.id;
  }

  /**
   * Reposts a post that is on this server. Refused: content that isn't published (404: it waits in
   * the moderation queue, is set for deletion, or isn't there); the user's own post (400), whose
   * hashtags are theirs to change with an update; and a post the user reposted before (409), which
   * the first to repost a post from another server has, by making the server's entry for it.
   *
   * The repost's hashtags are held to what the hashtags' moderators keep, as a post's are (see
   * moderateRepost), and one the post has already isn't given again. What it doesn't get is
   * answered in `removedTags`, with why. A repost left with no hashtag is refused (422): it would
   * show the post as new to the reposter's followers and nowhere else. Reposts give a post at most
   * MAX_REPOSTED_TAGS hashtags between them (409).
   *
   * No trust score is worked out: the post got one when it was written, and a repost changes
   * nothing of what it says. The repost is then admitted as a post is, and written (see
   * contentWriter's repost): 201 with the hashtags it gave and when. Feeds show it once the
   * compactor has run.
   */
  async function repostHere(req: FastifyRequest, reply: FastifyReply, user: AuthUser, contentId: string, tags: string[], solution: Body) {
    const row = await loadPublished(db, contentId);
    if (row.user_id === user.id) throw row.origin_hash !== null ? alreadyReposted() : badRequest(msg('repost.own'));
    const [meta, places] = await Promise.all([requireMeta(content, contentId), repostsOf(db, contentId)]);
    if (places.some((r) => r.tag === authorIndex(user.id))) throw alreadyReposted();

    const moderated = await moderateRepost({ db, log: req.log }, { userId: user.id, publisherId: row.user_id, contentId, tags, texts: readableOf(meta) });
    const given = repostedTags(places);
    const has = new Set([...meta.tags, ...given]);
    const removedTags: RemovedTag[] = [...moderated.removedTags, ...moderated.tags.filter((tag) => has.has(tag)).map((tag) => ({ tag, reason: 'already_tagged' as const }))];
    const fresh = moderated.tags.filter((tag) => !has.has(tag));
    if (!fresh.length) throw unprocessable(msg('repost.no_tags_left'), { removedTags });
    if (given.length + fresh.length > MAX_REPOSTED_TAGS) throw tooManyReposted();

    const reposted = await challenges.admitting('post', user.id, solution, req.language, () =>
      writer.repost({ contentId, userId: user.id, tags: fresh, carried: meta.tags }),
    );
    // A hashtag another repost gave the post in the meantime.
    for (const tag of fresh) if (!reposted.tags.includes(tag)) removedTags.push({ tag, reason: 'already_tagged' });
    reply.status(201);
    return { contentId, tags: reposted.tags, ...(removedTags.length > 0 && { removedTags }), repostedAt: iso(reposted.at) };
  }

  /**
   * Makes the server's entry for a post on another server: new content, the reposter's, which is a
   * link to the original with the original's summary. Nothing of the original is copied but the
   * summary: the content's bytes are the original's address, as a link post's are its URL, and an
   * image, video or audio is read where the original is (see ContentMeta.origin). The preview is
   * the one the client sent, cut to the length of this server's.
   *
   * It is a post in every other way, and passes what a new post does: its type must be one the
   * server takes, it is given a trust score and held to its hashtags' rules by what there is of it
   * to read (the preview, the original's address and its publisher's name), which can refuse it
   * (422) or hold it in the moderation queue (202), and it is admitted as a post is. It takes no
   * comments, which are the original's to take, and has no update: its owner deletes it like any
   * post.
   *
   * The summary is the client's word: the server doesn't read the original to check it.
   */
  async function repostFrom(req: FastifyRequest, reply: FastifyReply, user: AuthUser, sent: OriginFields, hash: string, tags: string[], solution: Body) {
    const { kind } = sent.preview;
    requirePostType(config.postTypes, kind);
    const mimeType = kind === 'text' ? TEXT_MIME : kind === 'link' ? LINK_MIME : sent.mimeType;
    if (mimeType === undefined || (kind !== 'text' && kind !== 'link' && mediaType(mimeType) !== kind)) throw badRequest(msg('repost.origin_mime_type', { kind }));

    const origin: Origin = { url: sent.url, publisher: sent.publisher };
    const caption = sent.preview.kind === 'link' ? undefined : sent.preview.text || undefined;
    const preview: Preview =
      sent.preview.kind === 'text'
        ? { kind: 'text', text: cut(sent.preview.text) }
        : sent.preview.kind === 'link'
          ? { kind: 'link', url: sent.preview.url }
          : { kind: sent.preview.kind, url: originMediaUrl(origin), ...(caption ? { text: cut(caption) } : {}) };

    const texts = [sent.preview.kind === 'link' ? sent.preview.url : caption && plainText(caption, true), origin.url, origin.publisher.username];
    const moderated = await moderatePost({ db, config, trustPlugins, now, log: req.log }, { userId: user.id, tags, texts });
    const queued = moderated.route === 'queue';

    const contentId = randomUUID();
    const ts = now();
    const publisher: Publisher = { userId: user.id, username: user.username };
    const { aiGenerated } = sent;
    const file = await spoolBytes(Buffer.from(origin.url), config.storage);
    try {
      const summary: Summary = { contentId, createdAt: ts, updatedAt: ts, userId: user.id, mimeType, aiGenerated, comments: false, tags: moderated.tags, preview, origin };
      const meta: ContentMeta = { contentId, mimeType, size: file.size, aiGenerated, comments: false, preview, tags: moderated.tags, updatedAt: ts, origin };
      await challenges.admitting('post', user.id, solution, req.language, () =>
        writer.write({
          publisher,
          summary,
          meta,
          // The bytes are an address, whatever the original is: they are stored as a link's are.
          putBytes: () => file.place(content, contentId, LINK_MIME),
          queued: queued ? { trustScore: moderated.trustScore } : undefined,
          originHash: hash,
        }),
      );
    } finally {
      await file.release(true);
    }
    reply.status(queued ? 202 : 201);
    return {
      contentId,
      ...(queued && PENDING_REVIEW),
      tags: moderated.tags,
      ...(moderated.removedTags.length > 0 && { removedTags: moderated.removedTags }),
      preview,
      aiGenerated,
      origin,
    };
  }
}
