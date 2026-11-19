import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MAX_ATTESTATION_CHARS, type AttestedPost } from '../attestation.js';
import { authenticate } from '../auth/apiKey.js';
import type { AuthUser } from '../auth/apiKey.types.js';
import { blocks } from '../blocks.js';
import { loadPublished, ORIGIN_GONE, PENDING_REVIEW, requireMeta } from '../content.js';
import { isUniqueViolation } from '../db/index.js';
import type { RouteDeps } from '../deps.types.js';
import { badRequest, conflict, forbidden, tooManyRequests, unprocessable } from '../http/errors.js';
import { Credentials } from '../http/schemas.js';
import { msg } from '../language.js';
import { moderatePost, moderateRepost, refuseBanned } from '../moderation/policy.js';
import type { RemovedTag } from '../moderation/policy.types.js';
import { originEntries, originHash } from '../origins.js';
import { MAX_REPOSTED_TAGS, readableOf, repostedTags, repostsOf } from '../reposts.js';
import { admitting } from '../sendLimit.js';
import { authorIndex } from '../tagfeed/layout.js';
import { allowedTags, parseTagList } from '../tags.js';
import { DAY, iso, MINUTE } from '../time.js';
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
 * summary, or whether it is hidden. Each is a write the compactor applies, and the user is nobody the
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
 * request with both, or neither), and the hashtags the repost gives it.
 */
const Body = Credentials.extend({
  /** The post to repost, on this server. */
  contentId: z.string().uuid().optional(),
  /** Or the post to repost, on another server, as that server attests it. */
  origin: OriginFields.optional(),
  /** The hashtags the repost gives the post: a list, or one string of them separated by commas or spaces. */
  tags: z.union([z.array(z.string().max(100)).max(50), z.string().max(5000)]).optional(),
});
type Body = z.infer<typeof Body>;

/** What POST /repost/refresh says: a later attestation of a post on another server that this server has an entry for. */
const RefreshBody = Credentials.extend({ origin: OriginFields });

/**
 * Reposts (POST /repost, see src/reposts.ts): a user gives someone else's post more hashtags, a
 * post on this server or one on another, which the server then keeps an entry of its own for.
 * And what keeps such an entry to what its original is (POST /repost/refresh).
 */
export function repostRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { db, config, content, hot, writer, trustPlugins, now = Date.now } = deps;
  const serverTags = allowedTags(config.tagging);
  const allowed = serverTags && new Set(serverTags);
  /** What checks an attestation, reads a post from it, and brings an entry up to it: the same as the server's own asking does (src/originSweep.ts). */
  const origins = originEntries(deps);
  const { ownKeys, ownContentId, summarised } = origins;

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

  /**
   * What an attestation a user sent says, once it is found to be what the post's own server
   * said, a short while ago (see originEntries' attested): the post, or that there is none at
   * its address. Where that has this server ask another for its keys, it is counted among the
   * user's of this minute: 429 past ORIGIN_ASKS_PER_MINUTE.
   */
  const attestedOrigin = (user: AuthUser, attestation: string) =>
    origins.attested(attestation, async () => {
      const { count, ttlMs } = await hot.incr(`originasks:${user.id}`, MINUTE);
      const seconds = Math.max(1, Math.ceil(ttlMs / 1000));
      if (count > ORIGIN_ASKS_PER_MINUTE) throw tooManyRequests(msg('repost.origin_rate_limited', { count: seconds }), seconds);
    });

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
   * own, and is reposted as one. An entry that is hidden, because the original's server said the
   * post was gone, is first brought back by the attestation the repost carries, as a refresh
   * brings it back (POST /repost/refresh), and counted as one: it says the post is there again.
   *
   * Either way the repost has to name the hashtags it gives (400), in server tagging mode from the
   * server's own. It is a post as far as the posts-a-minute limit goes. A banned user
   * is refused (403), and so is one the post's publisher blocks (see repostHere). REPOSTS=false
   * turns the route off (400), and REPOSTS_REMOTE=false the second kind.
   */
  app.post('/repost', async (req, reply) => {
    const body = Body.parse(req.body ?? {});
    if (!config.reposts.enabled) throw badRequest(msg('repost.off'));
    if ((body.contentId === undefined) === (body.origin === undefined)) throw badRequest(msg('repost.one_source'));
    if (body.origin && !config.reposts.remote) throw badRequest(msg('repost.remote_off'));
    const user = await authenticate(db, req, body);
    refuseBanned(user);
    const tags = repostTags(body);

    if (body.contentId !== undefined) return repostHere(req, reply, user, body.contentId, tags);
    // Checked whatever the server already holds of the original: nothing is reposted on a client's word.
    const origin = await attestedOrigin(user, body.origin!.attestation);
    if ('gone' in origin) throw badRequest(msg('repost.origin_gone'));
    const local = ownContentId(origin.url);
    if (local !== null) return repostHere(req, reply, user, local, tags);

    const hash = originHash(origin.url);
    const entry = await entryOf(hash);
    if (entry !== null) {
      if (entry.gone) {
        const back = await origins.refresh(origin, { log: req.log, changing: () => countRefresh(user) });
        // What the post now says was held for a moderator: nobody reposts the entry until it is accepted.
        if (back.change !== 'updated' || back.queued) throw conflict(msg('repost.origin_unavailable'));
      }
      return repostHere(req, reply, user, entry.id, tags);
    }
    try {
      return await repostFrom(req, reply, user, origin, hash, tags);
    } catch (err) {
      // Someone else's repost of the same original committed first: theirs is the server's entry for it.
      if (!isUniqueViolation(err)) throw err;
      const first = await entryOf(hash);
      if (first === null) throw err;
      return repostHere(req, reply, user, first.id, tags);
    }
  });

  /**
   * Brings the server's entry for a post on another server up to what the post is now: the entry
   * holds the original's summary as it was when it was last attested, and learns what the
   * original became from a later attestation of it. The server asks the original's server for
   * one itself, now and then (src/originSweep.ts); this is for one that anyone with an account
   * brings, which is sooner. It is checked as a repost's is (see attestedOrigin), and then does
   * what the server's own does (see originEntries' refresh). It says one of two things:
   *
   * - The post, as it is now. The entry's summary is written over with it, held to what an
   *   update of a post is: it can be refused (400 for a post of another type, 422 by its trust
   *   score, and the entry stays as it was), held in the moderation queue (202) or lose a
   *   hashtag. One that says what the entry says changes nothing (`unchanged`). An entry that
   *   was hidden is published again, where it was, with what reposts gave it.
   * - That no post is published there (see AttestedGone). The entry is hidden, not deleted:
   *   `status: "origin_gone"`, with `goneAt`, when it was hidden, and `deleteAfter`, when the
   *   compactor deletes it if the post isn't attested again by then (REPOSTS_GONE_DAYS). The
   *   other server signs this for whatever it doesn't publish, a post that waits in its
   *   moderation queue among them, so it is no proof that the post was deleted. Sent again for
   *   an entry that is hidden already, it leaves the entry hidden from when it first was
   *   (`unchanged`).
   *
   * Only an attestation issued after the one the entry is from is taken (409 otherwise).
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

    const done = await origins.refresh(said, { log: req.log, changing: () => countRefresh(user) });
    const { contentId } = done;
    // Hidden: since when, and when it is deleted unless the post is attested again.
    if (done.change === 'gone') {
      return { contentId, ...ORIGIN_GONE, ...(done.already && { unchanged: true }), goneAt: iso(done.goneAt), deleteAfter: iso(done.goneAt + config.reposts.goneDays * DAY) };
    }
    if (done.change === 'none') return { contentId, unchanged: true, ...(done.queued && PENDING_REVIEW) };
    reply.status(done.queued ? 202 : 200);
    return {
      contentId,
      ...(done.queued && PENDING_REVIEW),
      tags: done.tags,
      ...(done.removedTags.length > 0 && { removedTags: done.removedTags }),
      preview: done.preview,
      aiGenerated: done.aiGenerated,
      origin: done.origin,
    };
  });

  /** Counts a refresh that changes an entry among the user's of this minute: 429 past REFRESHES_PER_MINUTE. */
  async function countRefresh(user: AuthUser): Promise<void> {
    const { count, ttlMs } = await hot.incr(`originrefreshes:${user.id}`, MINUTE);
    const seconds = Math.max(1, Math.ceil(ttlMs / 1000));
    if (count > REFRESHES_PER_MINUTE) throw tooManyRequests(msg('repost.refresh_rate_limited', { count: seconds }), seconds);
  }

  /**
   * The server's entry for the original whose address hashes to `hash`, or null if it has none:
   * its id, and whether it is hidden because the original's server said the post was gone
   * (`gone`), which a repost's attestation may bring back. 409 for one nobody can repost now: it
   * waits in the moderation queue, or is set for deletion, after which the original can be
   * reposted anew.
   */
  async function entryOf(hash: string): Promise<{ id: string; gone: boolean } | null> {
    const entry = await db
      .selectFrom('content')
      .leftJoin('moderation_queue', 'moderation_queue.content_id', 'content.id')
      .select(['content.id', 'content.delete_requested_at', 'content.origin_gone_at', 'moderation_queue.content_id as queued_id'])
      .where('content.origin_hash', '=', hash)
      .executeTakeFirst();
    if (!entry) return null;
    if (entry.delete_requested_at !== null || entry.queued_id !== null) throw conflict(msg('repost.origin_unavailable'));
    return { id: entry.id, gone: entry.origin_gone_at !== null };
  }

  /**
   * Reposts a post that is on this server. Refused: content that isn't published (404: it waits in
   * the moderation queue, is set for deletion, or isn't there); the user's own post (400), whose
   * hashtags are theirs to change with an update; and a post the user reposted before (409), which
   * the first to repost a post from another server has, by making the server's entry for it.
   *
   * Refused too (403): a post whose publisher blocks the user (src/blocks.ts), which a repost
   * would show to the reposter's followers, under hashtags of the reposter's choosing. It is one
   * lookup, and goes by who wrote the post: the server's entry for a post on another server is
   * its first reposter's content, but not their post, and whom they block reposts the original
   * like anyone. What the user reposted before the block stays, as their comments do. A block
   * made while a repost is being sent may not stop it: it applies to the ones sent after it.
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
  async function repostHere(req: FastifyRequest, reply: FastifyReply, user: AuthUser, contentId: string, tags: string[]) {
    const row = await loadPublished(db, contentId);
    if (row.user_id === user.id) throw row.origin_hash !== null ? alreadyReposted() : badRequest(msg('repost.own'));
    if (row.origin_hash === null && (await blocks(db, row.user_id, user.id))) throw forbidden(msg('repost.not_taken'));
    const [meta, places] = await Promise.all([requireMeta({ db, content }, contentId), repostsOf(db, contentId)]);
    if (places.some((r) => r.tag === authorIndex(user.id))) throw alreadyReposted();

    const moderated = await moderateRepost({ db, log: req.log }, { userId: user.id, publisherId: row.user_id, contentId, tags, texts: readableOf(meta) });
    const given = repostedTags(places);
    const has = new Set([...meta.tags, ...given]);
    const removedTags: RemovedTag[] = [...moderated.removedTags, ...moderated.tags.filter((tag) => has.has(tag)).map((tag) => ({ tag, reason: 'already_tagged' as const }))];
    const fresh = moderated.tags.filter((tag) => !has.has(tag));
    if (!fresh.length) throw unprocessable(msg('repost.no_tags_left'), { removedTags });
    if (given.length + fresh.length > MAX_REPOSTED_TAGS) throw tooManyReposted();

    const reposted = await admitting(deps, 'post', user.id, () =>
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
   * becomes afterwards is seen here from a later attestation of it, which the server asks the
   * original's server for now and then (src/originSweep.ts) and anybody can bring sooner (POST
   * /repost/refresh), and which is told from an earlier one by when this one was signed (see
   * ContentMeta.originAttestedAt).
   */
  async function repostFrom(req: FastifyRequest, reply: FastifyReply, user: AuthUser, sent: AttestedPost, hash: string, tags: string[]) {
    const { mimeType, origin, preview, texts } = summarised(sent);
    const moderated = await moderatePost({ db, config, trustPlugins, now, log: req.log }, { userId: user.id, tags, texts });
    const queued = moderated.route === 'queue';

    const contentId = randomUUID();
    const ts = now();
    const { aiGenerated } = sent;
    await admitting(deps, 'post', user.id, () =>
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
