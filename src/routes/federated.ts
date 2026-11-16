import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, verifyUserApiKey, type AuthUser } from '../auth/apiKey.js';
import { ChallengeFields, Challenges } from '../challenge/challenges.js';
import { isUniqueViolation } from '../db/index.js';
import type { ContentRow } from '../db/schema.js';
import type { AppDeps } from '../deps.js';
import { ServerUrl } from '../federation.js';
import { badRequest, conflict } from '../http/errors.js';
import type { ContentMeta, Origin, Preview, Summary } from '../storage/index.js';
import { postRules } from '../moderation/policy.js';
import { LinkUrl, mediaUrl, readPreview } from '../posts.js';
import { normalizeTags } from '../tags.js';
import { MAX_VERSION } from '../tagfeed/layout.js';
import { changedConcurrently, firstWords, versionWriter } from '../versions.js';

const PreviewText = z.string().max(10_000);

/** A feed record as the origin server renders it. Its publisher and likes are the origin's, and aren't used. */
const Entry = z.object({
  contentId: z.string().uuid(),
  version: z.number().int().min(1).max(MAX_VERSION),
  mimeType: z.string().min(1).max(255),
  aiGenerated: z.boolean().default(false),
  // An image's, video's or audio's URL is built from the origin instead.
  preview: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('text'), text: PreviewText }),
    z.object({ kind: z.enum(['image', 'video', 'audio']), text: PreviewText.optional() }),
    z.object({ kind: z.literal('link'), url: LinkUrl }),
    // From servers older than post types: a file, read as readPreview says.
    z.object({ kind: z.literal('media') }),
  ]),
  tags: z.array(z.string().max(100)).min(1).max(50),
  createdAt: z.iso.datetime({ offset: true }),
});

const Body = z.object({
  /** The user's username here, or their userId. */
  username: z.string().optional(),
  userId: z.string().optional(),
  apiKey: z.string().optional(),
  /** Base URL of the server that stored the content, which keeps its bytes. */
  origin: ServerUrl.refine((s) => s.length <= 255, 'origin must be at most 255 characters'),
  entry: Entry,
  ...ChallengeFields,
});
type Body = z.infer<typeof Body>;

export function federatedRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, config, now = Date.now } = deps;
  const versions = versionWriter(deps, app.log);
  const challenges = new Challenges(deps);

  /**
   * Indexes content stored on another server under the user's account here, from its feed record alone:
   * no bytes. It's credited to the user's profile here, links back to the origin, and
   * collects its own likes. A later version from the origin updates it like /store updates content; the
   * same version again changes nothing, and an older one is refused. It's a post like /store, so one soon
   * after the user's previous post is answered with challenges, which the origin passes back to its client.
   * Its hashtags are the record's, except in server tagging mode, where they're this server's.
   * Moderation is this server's own, as for /store, and checks the record's preview text or link.
   */
  app.post('/federated', async (req, reply) => {
    const body = Body.parse(req.body ?? {});
    const user = body.username !== undefined ? await verifyUserApiKey(db, body.username, body.apiKey ?? '') : await authenticate(db, req, body);
    if (!user.publisherUrl) throw badRequest(`set your publisherUrl first (PATCH /users/${user.id})`);
    const { entry } = body;
    const tags = config.tagging.mode === 'server' ? config.tagging.serverTags : normalizeTags(entry.tags);
    if (!tags.length) throw badRequest('the entry has no usable hashtags');

    const existing = await db
      .selectFrom('content')
      .selectAll()
      .where('user_id', '=', user.id)
      .where('origin_server', '=', body.origin)
      .where('origin_content_id', '=', entry.contentId)
      .executeTakeFirst();
    if (existing) {
      if (existing.delete_requested_at !== null) throw conflict('content is set for deletion');
      if (entry.version === existing.origin_version) return reply.send({ contentId: existing.id, version: existing.version, unchanged: true });
      if (entry.version < existing.origin_version!) throw conflict(`version ${existing.origin_version} of this content is already federated`);
      if (entry.mimeType !== existing.mime_type) {
        throw badRequest(`a new version must have the same content type as the original (${existing.mime_type}), got ${entry.mimeType}`);
      }
      if (Math.max(existing.version, existing.reserved_version) >= MAX_VERSION) throw conflict(`content can have at most ${MAX_VERSION} versions`);
    }

    const preview = previewOfEntry(body.origin, entry);
    // The content is on the origin, so its preview is all the text there is to check.
    const rules = await postRules(db, { userId: user.id, tags, contentId: existing?.id });
    const words = preview.kind === 'link' ? preview.url : preview.text;
    if (words) rules.scanner?.scan(words);
    const { tags: kept, removedTags } = rules.apply();

    const release = await challenges.admitPost(user.id, body);
    try {
      const copy = await writeCopy(user, body, preview, kept, existing);
      return reply.status(existing ? 200 : 201).send({ ...copy, ...(removedTags.length > 0 && { removedTags }) });
    } catch (err) {
      await release();
      throw err;
    }
  });

  /** The record's preview as stored here: its text cut to this server's preview length, and a file's URL at the origin. */
  function previewOfEntry(server: string, entry: Body['entry']): Preview {
    const preview = readPreview(entry.preview, entry.mimeType, mediaUrl(server, entry.contentId, entry.version));
    if (preview.kind === 'link' || preview.text === undefined) return preview;
    return { ...preview, text: firstWords(preview.text, config.feed.previewWords, config.feed.previewChars) };
  }

  /** Writes the record as a version of the user's copy: a new one, or the next version of `existing`. */
  async function writeCopy(user: AuthUser, body: Body, preview: Preview, tags: string[], existing: ContentRow | undefined) {
    const { entry } = body;
    const contentId = existing?.id ?? randomUUID();
    const version = existing ? await versions.reserveVersion(contentId, existing.version) : 1;
    const ts = now();
    // A clock ahead of this one can't date the content in the future.
    const createdAt = existing?.created_at ?? Math.min(Date.parse(entry.createdAt), ts);
    const origin: Origin = { server: body.origin, contentId: entry.contentId, version: entry.version };
    const { mimeType, aiGenerated } = entry;

    const summary: Summary = { contentId, version, createdAt, updatedAt: ts, userId: user.id, mimeType, aiGenerated, tags, preview, origin };
    const meta: ContentMeta = {
      contentId,
      version,
      mimeType,
      filename: null,
      size: 0,
      sha256: '',
      aiGenerated,
      preview,
      tags,
      createdAt: new Date(ts).toISOString(),
      origin,
    };
    try {
      await versions.write({
        publisher: { userId: user.id, username: user.username, publisherUrl: user.publisherUrl },
        existing,
        summary,
        meta,
        columns: { filename: null, size: 0, sha256: '', origin_server: origin.server, origin_content_id: origin.contentId, origin_version: origin.version },
      });
    } catch (err) {
      // Another request federated the same content first.
      if (isUniqueViolation(err)) throw changedConcurrently();
      throw err;
    }
    return { contentId, version, origin, tags, aiGenerated };
  }
}
