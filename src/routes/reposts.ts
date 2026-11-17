import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ATTESTATION_MAX_AGE_MS, ATTESTATION_SKEW_MS, AttestedGone, AttestedPost, MAX_ATTESTATION_CHARS, POST_PATH, readAttestation, saysGone, signedBy, signingKeys } from '../attestation.js';
import type { PublishedKey } from '../attestation.types.js';
import { authenticate } from '../auth/apiKey.js';
import type { AuthUser } from '../auth/apiKey.types.js';
import { ChallengeFields } from '../challenge/challenges.js';
import { loadContent, loadPublished, PENDING_REVIEW, publisherOf, requireMeta } from '../content.js';
import { isUniqueViolation } from '../db/index.js';
import type { RouteDeps } from '../deps.types.js';
import { plainText } from '../format.js';
import { badRequest, conflict, HttpError, notFound, tooManyRequests, unprocessable } from '../http/errors.js';
import { Credentials } from '../http/schemas.js';
import { msg } from '../language.js';
import { moderatePost, moderateRepost, refuseBanned } from '../moderation/policy.js';
import type { RemovedTag } from '../moderation/policy.types.js';
import { LINK_MIME, mediaType, originMediaUrl, ownAddress, postAddress, previewCutter, previewOf, TEXT_MIME } from '../posts.js';
import { MAX_REPOSTED_TAGS, readableOf, repostedTags, repostsOf } from '../reposts.js';
import type { Origin, Preview } from '../storage/index.js';
import { authorIndex } from '../tagfeed/layout.js';
import { allowedTags, parseTagList } from '../tags.js';
import { iso, MINUTE } from '../time.js';
import { requirePostType } from '../upload.js';
import { alreadyReposted, tooManyReposted } from '../write.js';

/**
 * How many times in a minute one user's reposts can have this server ask another for its keys. A
 * server is asked once for many reposts from it (see OriginKeys), so this is reached only by
 * reposts from many servers, or from ones that aren't there, which is how someone would have this
 * server send requests for them.
 */
const ORIGIN_ASKS_PER_MINUTE = 10;

/**
 * How many times in a minute one user's refreshes (POST /repost/refresh) can change an entry: its
 * summary, or that it is there. Each is a write the compactor applies, and the user is nobody the
 * entry belongs to, so it is counted on its own, and not as a post of theirs. One that changes
 * nothing isn't counted.
 */
const REFRESHES_PER_MINUTE = 10;

/**
 * What a repost says of a post on another server (`origin` in POST /repost): the post's
 * attestation, as its own server gave it to the reposter's client (GET /content/:id/attestation
 * there). Its address, who published it and its summary are read from that, once it is found to
 * be signed by the server at the address it names (see attestedOrigin), and from nothing else:
 * what the client says of the post itself is not asked for.
 */
const OriginFields = z.object({ attestation: z.string().min(1).max(MAX_ATTESTATION_CHARS) });

/**
 * What POST /repost says: the post to repost, as `contentId` or as `origin` (the route refuses a
 * request with both, or neither), the hashtags the repost gives it, and the solution of a
 * challenge when the request answers one.
 */
const Body = Credentials.extend({
  /** The post to repost, on this server. */
  contentId: z.string().uuid().optional(),
  /** Or the post to repost, on another server, as that server attests it. */
  origin: OriginFields.optional(),
  /** The hashtags the repost gives the post: a list, or one string of them separated by commas or spaces. */
  tags: z.union([z.array(z.string().max(100)).max(50), z.string().max(5000)]).optional(),
  ...ChallengeFields,
});
type Body = z.infer<typeof Body>;

/** What POST /repost/refresh says: a later attestation of a post on another server that this server has an entry for. */
const RefreshBody = Credentials.extend({ origin: OriginFields });

/**
 * Reposts (POST /repost, see src/reposts.ts): a user gives someone else's post more hashtags, a
 * post on this server or one on another, which the server then keeps an entry of its own for.
 * And what keeps such an entry to what its original is (POST /repost/refresh).
 */
export function repostRoutes(app: FastifyInstance, { db, config, content, hot, challenges, writer, trustPlugins, originKeys, now = Date.now }: RouteDeps) {
  const cut = previewCutter(config.feed);
  const serverTags = allowedTags(config.tagging);
  const allowed = serverTags && new Set(serverTags);
  /** This server's own address, as an origin under it is told by. None: no address is known to be its own. */
  const ownBase = ownAddress(config.publicBaseUrl);
  /** The keys this server signs the attestations of its own posts with, as it publishes them: no private key among them. */
  const ownKeys: PublishedKey[] = signingKeys(config.reposts.signingKeys).map(({ id, publicKey }) => ({ id, publicKey }));

  /**
   * The keys this server signs the attestations of its posts with, for the servers its posts are
   * reposted on, which check an attestation against them (see OriginKeys): each with its id, as
   * an attestation names it. For anyone. A server that signs nothing has none.
   */
  app.get('/repost/keys', async () => ({ keys: ownKeys.map((key) => ({ ...key, algorithm: 'ed25519' })) }));

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
    const id = POST_PATH.exec(url)?.[1];
    return id !== undefined && url === postAddress(ownBase, id) ? id : null;
  }

  /**
   * What an attestation says, once it is found to be what the post's own server said, a short
   * while ago: the post, or that there is none at its address (see AttestedGone). Until then
   * nothing in it is believed, and a request that fails here has changed nothing.
   *
   * - It is written as an attestation, and says what one says (400).
   * - It was issued within ATTESTATION_MAX_AGE_MS, by a clock no more than ATTESTATION_SKEW_MS
   *   ahead of this one (400): an old one says what the post was, and may no longer be.
   * - It is signed with a key of the server at the address it names. That server is asked for its
   *   keys, where Redis doesn't hold them (see OriginKeys): over https only, on the port https
   *   has (400), and no more than ORIGIN_ASKS_PER_MINUTE times a minute on one user's account
   *   (429). A server that gives no keys leaves the attestation unchecked, and so refused (502);
   *   a key that isn't among the server's, or a signature that isn't that key's, is a forgery as
   *   far as anyone can tell (400).
   *
   * An address that is this server's own is checked with this server's own keys, and nobody is
   * asked. A server that signs nothing attested nothing, so there it is refused like any forgery.
   */
  async function attestedOrigin(user: AuthUser, attestation: string): Promise<AttestedPost | AttestedGone> {
    const read = readAttestation(attestation);
    if (!read) throw badRequest(msg('repost.attestation_invalid'));
    const said = saysGone(read.payload) ? AttestedGone.safeParse(read.payload) : AttestedPost.safeParse(read.payload);
    if (!said.success) throw badRequest(msg('repost.attestation_invalid'), said.error.issues);
    const post = said.data;
    const age = now() - post.issuedAt;
    if (age > ATTESTATION_MAX_AGE_MS || age < -ATTESTATION_SKEW_MS) throw badRequest(msg('repost.attestation_expired', { minutes: ATTESTATION_MAX_AGE_MS / MINUTE }));

    let key: PublishedKey | undefined;
    if (ownContentId(post.url) !== null) key = ownKeys.find(({ id }) => id === post.kid);
    else {
      const server = post.url.replace(POST_PATH, '');
      // The URL parser leaves out the port that is https's own, so one that is there is another.
      if (!server.startsWith('https://') || new URL(post.url).port !== '') throw badRequest(msg('repost.origin_not_https'));
      const found = await originKeys.find(server, post.kid, async () => {
        const { count, ttlMs } = await hot.incr(`originasks:${user.id}`, MINUTE);
        const seconds = Math.max(1, Math.ceil(ttlMs / 1000));
        if (count > ORIGIN_ASKS_PER_MINUTE) throw tooManyRequests(msg('repost.origin_rate_limited', { count: seconds }), seconds);
      });
      if (found === 'unavailable') throw new HttpError(502, msg('repost.origin_keys_unavailable', { server }));
      if (found !== 'unknown') key = found;
    }
    if (!key || !signedBy(key, read)) throw badRequest(msg('repost.attestation_unsigned'));
    return post;
  }

  /**
   * Reposts a post: gives it more hashtags, under which it then shows as a new post, as it does
   * in the following feeds of those who follow the reposter. Nothing is copied. It is one of two
   * requests:
   *
   * With `contentId`, a post on this server. The post gets the hashtags; it stays one piece of
   * content, with one like count, credited to its publisher (see repostHere).
   *
   * With `origin`, a post on another server: its attestation, which that server signed and the
   * reposter's client carries here. It says the post's address there, who published it, and its
   * summary, and it is checked before any of that is used (see attestedOrigin), whether or not the
   * server has the original already: this server asks the other for its keys, and for nothing
   * else. The server keeps one entry for an original: new content that is a link to it, with its
   * summary (see repostFrom). An original it has an entry of already is reposted as that entry
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
    // Checked whatever the server already holds of the original: nothing is reposted on a client's word.
    const origin = await attestedOrigin(user, body.origin!.attestation);
    if ('gone' in origin) throw badRequest(msg('repost.origin_gone'));
    const local = ownContentId(origin.url);
    if (local !== null) return repostHere(req, reply, user, local, tags, body);

    const hash = createHash('sha256').update(origin.url).digest('hex');
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
   * Brings the server's entry for a post on another server up to what the post is now: the entry
   * holds the original's summary as it was when it was last attested, and this server reads
   * nothing of the original itself, so it learns what the original became from a later
   * attestation of it, which anyone with an account can bring. It is checked as a repost's is
   * (see attestedOrigin), and says one of two things:
   *
   * - The post, as it is now. The entry's summary is written over with it: an update of the
   *   entry, in the name of nobody but the original's server. It is held to what an update of a
   *   post is: the type of post stays what it was (400), it is given a trust score and its
   *   hashtags are held to their rules by what it now says, in the name of the entry's owner, so
   *   it can be refused (422, and the entry stays as it was), held in the moderation queue (202)
   *   or lose a hashtag. One that says what the entry says changes nothing (`unchanged`).
   * - That no post is published there (see AttestedGone). The entry is set for deletion, as its
   *   owner would set it: 202, and the compactor's next run deletes it, with the places reposts
   *   gave it.
   *
   * Only an attestation issued after the one the entry is from is taken (409 otherwise, see
   * ContentMeta.originAttestedAt), so nobody brings back what the post was with an attestation
   * they kept. That holds for two that arrive at once: the one that commits second is checked
   * against the first (see ContentWrite.recheck), and a deletion is set only on the entry as
   * it was read (409: sent again, it is checked against what was written meanwhile).
   *
   * 404 where the server has no entry for the original, or one that is set for deletion already.
   * An address that is this server's own has nothing to refresh (400). A banned user is refused
   * (403), and one user's refreshes change at most REFRESHES_PER_MINUTE entries a minute (429).
   * The route is off where reposts of posts on other servers are (400).
   */
  app.post('/repost/refresh', async (req, reply) => {
    const body = RefreshBody.parse(req.body ?? {});
    if (!config.reposts.enabled) throw badRequest(msg('repost.off'));
    if (!config.reposts.remote) throw badRequest(msg('repost.remote_off'));
    const user = await authenticate(db, req, body);
    refuseBanned(user);
    const said = await attestedOrigin(user, body.origin.attestation);
    if (ownContentId(said.url) !== null) throw badRequest(msg('repost.refresh_own'));

    const hash = createHash('sha256').update(said.url).digest('hex');
    const entry = await db.selectFrom('content').select('id').where('origin_hash', '=', hash).executeTakeFirst();
    if (!entry) throw notFound(msg('repost.refresh_no_entry'));
    // The row, with the entry's write number, before the meta file: what is read after it is no older than the number says.
    const row = await loadContent(db, entry.id);
    const meta = await requireMeta({ db, content }, row.id);
    const notNewer = () => conflict(msg('repost.refresh_not_newer'));
    if (said.issuedAt <= (meta.originAttestedAt ?? 0)) throw notNewer();

    if ('gone' in said) {
      await countRefresh(user);
      const at = now();
      const set = await db.updateTable('content').set({ delete_requested_at: at }).where('id', '=', row.id).where('delete_requested_at', 'is', null).where('seq', '=', row.seq).executeTakeFirst();
      if (Number(set.numUpdatedRows) !== 1) throw conflict(msg('repost.refresh_raced'));
      return reply.status(202).send({ contentId: row.id, status: 'pending_deletion', requestedAt: iso(at) });
    }

    const { mimeType, origin, preview, texts } = summarised(said);
    if (mimeType !== meta.mimeType) throw badRequest(msg('repost.refresh_type_changed', { original: meta.mimeType, mimeType }));
    const { aiGenerated } = said;
    if (aiGenerated === (row.ai_generated === 1) && isDeepStrictEqual(origin, meta.origin) && isDeepStrictEqual(preview, previewOf(meta, config.publicBaseUrl))) {
      return { contentId: row.id, unchanged: true, ...(row.queued && PENDING_REVIEW) };
    }

    await countRefresh(user);
    // What the entry now says is held to the rules of every hashtag it has, those reposts gave it too, as an update of a post is.
    const given = repostedTags(await repostsOf(db, row.id));
    const moderated = await moderatePost(
      { db, config, trustPlugins, now, log: req.log },
      { userId: row.user_id, contentId: row.id, tags: [...meta.tags.filter((tag) => !given.includes(tag)), ...given], texts },
    );
    const queued = moderated.route === 'queue';
    const ts = now();
    await writer.write({
      publisher: publisherOf(row),
      previous: meta,
      seenSeq: Number(row.seq),
      recheck: (current) => {
        if (said.issuedAt <= (current.originAttestedAt ?? 0)) throw notNewer();
      },
      summary: { contentId: row.id, createdAt: row.created_at, updatedAt: ts, userId: row.user_id, mimeType, aiGenerated, comments: false, tags: moderated.tags, preview, origin },
      meta: { contentId: row.id, mimeType, size: Buffer.byteLength(origin.url), aiGenerated, comments: false, preview, tags: moderated.tags, updatedAt: ts, origin, originAttestedAt: said.issuedAt },
      queued: queued ? { trustScore: moderated.trustScore } : undefined,
      // The hashtags of reposts that what it now says is refused: they come off the entry for good (see ContentWrite.droppedReposts).
      droppedReposts: moderated.removedTags.filter((r) => given.includes(r.tag) && r.reason !== 'removed').map((r) => r.tag),
    });
    reply.status(queued ? 202 : 200);
    return {
      contentId: row.id,
      ...(queued && PENDING_REVIEW),
      tags: moderated.tags,
      ...(moderated.removedTags.length > 0 && { removedTags: moderated.removedTags }),
      preview,
      aiGenerated,
      origin,
    };
  });

  /** Counts a refresh that changes an entry among the user's of this minute: 429 past REFRESHES_PER_MINUTE. */
  async function countRefresh(user: AuthUser): Promise<void> {
    const { count, ttlMs } = await hot.incr(`originrefreshes:${user.id}`, MINUTE);
    const seconds = Math.max(1, Math.ceil(ttlMs / 1000));
    if (count > REFRESHES_PER_MINUTE) throw tooManyRequests(msg('repost.refresh_rate_limited', { count: seconds }), seconds);
  }

  /**
   * What the server keeps of a post on another server, from its attestation: its content type,
   * which an image, video or audio has to say and be (400), where it is and who published it
   * there, and its preview, cut to the length of this server's. `texts` is what there is of it to
   * read, as moderation reads a post: the preview's text or link, the original's address and its
   * publisher's name. The type of post must be one the server takes (400).
   */
  function summarised(sent: AttestedPost): { mimeType: string; origin: Origin; preview: Preview; texts: (string | undefined)[] } {
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
    return { mimeType, origin, preview, texts: [sent.preview.kind === 'link' ? sent.preview.url : caption && plainText(caption, true), origin.url, origin.publisher.username] };
  }

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
    const [meta, places] = await Promise.all([requireMeta({ db, content }, contentId), repostsOf(db, contentId)]);
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
   * the one the original's server attested, cut to the length of this server's.
   *
   * It is a post in every other way, and passes what a new post does: its type must be one the
   * server takes, it is given a trust score and held to its hashtags' rules by what there is of it
   * to read (the preview, the original's address and its publisher's name), which can refuse it
   * (422) or hold it in the moderation queue (202), and it is admitted as a post is. It takes no
   * comments, which are the original's to take, and has no update: its owner deletes it like any
   * post.
   *
   * The summary is the original's server's word, as it signed it when the repost was made (see
   * attestedOrigin): this server doesn't read the original, then or later. What the original
   * becomes afterwards is seen here once somebody brings a later attestation of it (POST
   * /repost/refresh), which is told from an earlier one by when this one was signed (see
   * ContentMeta.originAttestedAt).
   */
  async function repostFrom(req: FastifyRequest, reply: FastifyReply, user: AuthUser, sent: AttestedPost, hash: string, tags: string[], solution: Body) {
    const { mimeType, origin, preview, texts } = summarised(sent);
    const moderated = await moderatePost({ db, config, trustPlugins, now, log: req.log }, { userId: user.id, tags, texts });
    const queued = moderated.route === 'queue';

    const contentId = randomUUID();
    const ts = now();
    const { aiGenerated } = sent;
    await challenges.admitting('post', user.id, solution, req.language, () =>
      writer.write({
        publisher: { userId: user.id, username: user.username },
        summary: { contentId, createdAt: ts, updatedAt: ts, userId: user.id, mimeType, aiGenerated, comments: false, tags: moderated.tags, preview, origin },
        // The bytes are an address, whatever the original is: the compactor writes them from the meta file, as it does a link's (see payloadBytes).
        meta: { contentId, mimeType, size: Buffer.byteLength(origin.url), aiGenerated, comments: false, preview, tags: moderated.tags, updatedAt: ts, origin, originAttestedAt: sent.issuedAt },
        queued: queued ? { trustScore: moderated.trustScore } : undefined,
        originHash: hash,
      }),
    );
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
