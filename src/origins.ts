import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { FastifyBaseLogger } from 'fastify';
import { ATTESTATION_MAX_AGE_MS, ATTESTATION_SKEW_MS, AttestedGone, AttestedPost, POST_PATH, readAttestation, saysGone, signedBy, signingKeys } from './attestation.js';
import type { PublishedKey } from './attestation.types.js';
import { loadContent, publisherOf, requireMeta } from './content.js';
import type { RouteDeps } from './deps.types.js';
import { plainText } from './format.js';
import { badRequest, conflict, HttpError, notFound } from './http/errors.js';
import { msg } from './language.js';
import { moderatePost } from './moderation/policy.js';
import type { OriginSummary, RefreshedGone, RefreshedNone, RefreshedUpdated } from './origins.types.js';
import { LINK_MIME, mediaType, originMediaUrl, ownAddress, postAddress, previewCutter, previewOf, TEXT_MIME } from './posts.js';
import { repostedTags, repostsOf } from './reposts.js';
import type { ContentMeta, Origin, Preview } from './storage/index.js';
import { MINUTE } from './time.js';
import { requirePostType } from './upload.js';

/** What `originEntries` works with: of what the routes that write posts share, what reads and writes an entry and checks an attestation. */
export type OriginDeps = Pick<RouteDeps, 'db' | 'config' | 'content' | 'writer' | 'trustPlugins' | 'originKeys' | 'now'>;

/** What a later attestation did to the entry it is of (see originEntries' refresh). */
export type Refreshed = RefreshedNone | RefreshedGone | RefreshedUpdated;

/** What the server knows an original on another server by: the SHA-256, in hex, of its address (see `content.origin_hash`). */
export const originHash = (url: string) => createHash('sha256').update(url).digest('hex');

/**
 * The server's entries for posts on other servers (see routes/reposts.ts), as far as an
 * attestation goes: checking one, reading what it says of a post, and bringing the entry of its
 * original up to it. It is what the routes do with an attestation a client brings (POST /repost,
 * POST /repost/refresh), and what the server does with one it asked the original's server for
 * itself (src/originSweep.ts).
 */
export function originEntries({ db, config, content, writer, trustPlugins, originKeys, now = Date.now }: OriginDeps) {
  const cut = previewCutter(config.feed);
  /** This server's own address, as an origin under it is told by. None: no address is known to be its own. */
  const ownBase = ownAddress(config.publicBaseUrl);
  /** The keys this server signs the attestations of its own posts with, as it publishes them: no private key among them. */
  const ownKeys: PublishedKey[] = signingKeys(config.reposts.signingKeys).map(({ id, publicKey }) => ({ id, publicKey }));

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
   *   has (400). `asking` is called before it is asked, which is where a route limits how often
   *   one user has this server ask others, by throwing. A server that gives no keys leaves the
   *   attestation unchecked, and so refused (502); a key that isn't among the server's, or a
   *   signature that isn't that key's, is a forgery as far as anyone can tell (400).
   *
   * An address that is this server's own is checked with this server's own keys, and nobody is
   * asked. A server that signs nothing attested nothing, so there it is refused like any forgery.
   */
  async function attested(attestation: string, asking: () => Promise<void>): Promise<AttestedPost | AttestedGone> {
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
      const found = await originKeys.find(server, post.kid, asking);
      if (found === 'unavailable') throw new HttpError(502, msg('repost.origin_keys_unavailable', { server }));
      if (found !== 'unknown') key = found;
    }
    if (!key || !signedBy(key, read)) throw badRequest(msg('repost.attestation_unsigned'));
    return post;
  }

  /**
   * What the server keeps of a post on another server, from its attestation: its content type,
   * which an image, video or audio has to say and be (400), where it is and who published it
   * there, and its preview, cut to the length of this server's. `texts` is what there is of it to
   * read, as moderation reads a post: the preview's text or link, the original's address and its
   * publisher's name. The type of post must be one the server takes (400).
   */
  function summarised(sent: AttestedPost): OriginSummary {
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
   * Brings the server's entry for a post on another server up to a later attestation of it,
   * which was checked already (see attested). The entry holds the original's summary as it was
   * when it was last attested, and this is how it learns what the original became. The
   * attestation says one of two things:
   *
   * - The post, as it is now. The entry's summary is written over with it: an update of the
   *   entry, in the name of nobody but the original's server. It is held to what an update of a
   *   post is: the type of post stays what it was (400), it is given a trust score and its
   *   hashtags are held to their rules by what it now says, in the name of the entry's owner, so
   *   it can be refused (422, and the entry stays as it was), held in the moderation queue or
   *   lose a hashtag. One that says what the entry says changes nothing. An entry that was
   *   hidden because the post was gone is published again by it, where it was (see
   *   contentWriter's write), whether or not the post says what it said before.
   * - That no post is published there (see AttestedGone). The entry is hidden, and not deleted:
   *   the other server says this of a post that only waits in its moderation queue too (see
   *   contentWriter's withhold). An entry that is hidden already stays hidden from when it first
   *   was, and holds that the post was still gone when this was said.
   *
   * Only an attestation issued after the one the entry is from is taken (409 otherwise, see
   * ContentMeta.originAttestedAt), so nobody brings back what the post was with an attestation
   * they kept. That holds for two that arrive at once: the one that commits second is checked
   * against the first, as it commits (see ContentWrite.recheck, OriginGone.recheck).
   *
   * 404 where the server has no entry for the original, or one that is set for deletion already.
   * `changing` is called before anything is written, and not when nothing is: it is where a
   * route counts the refreshes a user makes, and refuses one too many by throwing.
   */
  async function refresh(said: AttestedPost | AttestedGone, { log, changing = async () => {} }: { log?: FastifyBaseLogger; changing?: () => Promise<void> } = {}): Promise<Refreshed> {
    const entry = await db.selectFrom('content').select('id').where('origin_hash', '=', originHash(said.url)).executeTakeFirst();
    if (!entry) throw notFound(msg('repost.refresh_no_entry'));
    // The row, with the entry's write number, before the meta file: what is read after it is no older than the number says.
    const row = await loadContent(db, entry.id);
    const meta = await requireMeta({ db, content }, row.id);
    const recheck = (current: ContentMeta) => {
      if (said.issuedAt <= (current.originAttestedAt ?? 0)) throw conflict(msg('repost.refresh_not_newer'));
    };
    recheck(meta);

    if ('gone' in said) {
      await changing();
      // Written for an entry that is hidden already too: it stays hidden from when it first was, and holds when this was said, which an attestation of the post from before it is then refused by.
      const goneAt = await writer.withhold({ contentId: row.id, issuedAt: said.issuedAt, recheck });
      return { change: 'gone', contentId: row.id, goneAt, already: row.origin_gone_at !== null };
    }

    const { mimeType, origin, preview, texts } = summarised(said);
    if (mimeType !== meta.mimeType) throw badRequest(msg('repost.refresh_type_changed', { original: meta.mimeType, mimeType }));
    const { aiGenerated } = said;
    // A hidden entry is written whatever the post says: the write is what publishes it again.
    if (row.origin_gone_at === null && aiGenerated === (row.ai_generated === 1) && isDeepStrictEqual(origin, meta.origin) && isDeepStrictEqual(preview, previewOf(meta, config.publicBaseUrl))) {
      return { change: 'none', contentId: row.id, queued: row.queued };
    }

    await changing();
    // What the entry now says is held to the rules of every hashtag it has, those reposts gave it too, as an update of a post is.
    const given = repostedTags(await repostsOf(db, row.id));
    const moderated = await moderatePost(
      { db, config, trustPlugins, now, log },
      { userId: row.user_id, contentId: row.id, tags: [...meta.tags.filter((tag) => !given.includes(tag)), ...given], texts },
    );
    const queued = moderated.route === 'queue';
    const ts = now();
    await writer.write({
      publisher: publisherOf(row),
      previous: meta,
      seenSeq: Number(row.seq),
      recheck,
      summary: { contentId: row.id, createdAt: row.created_at, updatedAt: ts, userId: row.user_id, mimeType, aiGenerated, comments: false, tags: moderated.tags, preview, origin },
      meta: { contentId: row.id, mimeType, size: Buffer.byteLength(origin.url), aiGenerated, comments: false, preview, tags: moderated.tags, updatedAt: ts, origin, originAttestedAt: said.issuedAt },
      queued: queued ? { trustScore: moderated.trustScore } : undefined,
      // The hashtags of reposts that what it now says is refused: they come off the entry for good (see ContentWrite.droppedReposts).
      droppedReposts: moderated.removedTags.filter((r) => given.includes(r.tag) && r.reason !== 'removed').map((r) => r.tag),
    });
    return { change: 'updated', contentId: row.id, queued, tags: moderated.tags, removedTags: moderated.removedTags, preview, aiGenerated, origin };
  }

  return { ownKeys, ownContentId, attested, summarised, refresh };
}

/** What `originEntries` gives: what checks an attestation, and what brings an entry up to one. */
export type OriginEntries = ReturnType<typeof originEntries>;
