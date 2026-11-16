import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, type AuthUser } from '../auth/apiKey.js';
import { isUniqueViolation } from '../db/index.js';
import type { ContentRow } from '../db/schema.js';
import { setForDeletion } from '../deletion.js';
import type { AppDeps } from '../deps.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../http/errors.js';
import { decodeListCursor, encodeListCursor } from '../http/listCursor.js';
import { moderates } from '../moderation/policy.js';
import { MAX_LIST_WORDS, MAX_PHRASE_WORDS, MAX_WORD_CHARS, normalizeWord, SERVER_LIST } from '../moderation/words.js';
import { previewOf } from '../posts.js';
import type { ContentMeta, Summary } from '../storage/index.js';
import { normalizeTag } from '../tags.js';
import { versionWriter } from '../versions.js';

/** A hashtag in a path, as /feed takes them: letters, digits and _, with or without #, in any case. */
const Tag = z
  .string()
  .regex(/^#?[A-Za-z0-9_]{1,64}$/, 'a hashtag is letters, digits and _')
  .transform((t) => normalizeTag(t)!);
const Credentials = z.object({ userId: z.string().optional(), apiKey: z.string().optional() });
type Credentials = z.infer<typeof Credentials>;
const TagParams = z.object({ tag: Tag });
const TagUserParams = z.object({ tag: Tag, userId: z.string().uuid() });
const ContentTagParams = z.object({ contentId: z.string().uuid(), tag: Tag });
const WordsBody = Credentials.extend({ words: z.array(z.string().max(1000)).min(1).max(1000) });
const RemoveTagBody = Credentials.extend({ mute: z.union([z.boolean(), z.stringbool()]).default(false) });
const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  cursor: z.string().optional(),
});

/** How many times removing a hashtag tries, while its publisher's new versions keep winning the race. */
const REMOVE_ATTEMPTS = 3;
/** Rows per insert of blocked words, well within every dialect's limit on parameters. */
const INSERT_BATCH = 200;

const iso = (ms: number) => new Date(ms).toISOString();

type Current = { row: ContentRow & { username: string; publisher_url: string | null }; meta: ContentMeta };

interface Removal {
  /** The content's publisher. */
  userId: string;
  /** The current version, without the hashtag; absent once the content is set for deletion. */
  version?: number;
  tags: string[];
  alreadyRemoved: boolean;
  /** No hashtag was left, so the content is set for deletion. */
  status?: 'pending_deletion';
  requestedAt?: string;
}

/**
 * Moderation: admins appoint tag moderators and keep the server's blocked words; a tag's moderators
 * (and admins) keep its blocked words, mute users on it and remove it from content. All of it applies
 * to versions written from then on; removing a hashtag from content also writes one.
 */
export function moderationRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, config, content, now = Date.now } = deps;
  const versions = versionWriter(deps, app.log);

  async function asAdmin(req: FastifyRequest, body: Credentials): Promise<AuthUser> {
    const user = await authenticate(db, req, body);
    if (!user.admin) throw forbidden('only an admin can do this');
    return user;
  }

  async function asModerator(req: FastifyRequest, tag: string, body: Credentials): Promise<AuthUser> {
    const user = await authenticate(db, req, body);
    if (!(await moderates(db, user, tag))) throw forbidden(`only an admin or a moderator of #${tag} can do this`);
    return user;
  }

  async function findUser(userId: string) {
    const user = await db.selectFrom('users').select('id').where('id', '=', userId).executeTakeFirst();
    if (!user) throw notFound('user not found');
  }

  /** Inserts a row unless it's there; a concurrent request that inserted it first counts as there. */
  async function addOnce(find: () => Promise<{ created_at: number } | undefined>, insert: (createdAt: number) => Promise<unknown>) {
    const found = await find();
    if (found) return { at: found.created_at, already: true };
    const at = now();
    try {
      await insert(at);
      return { at, already: false };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      return { at: (await find())?.created_at ?? at, already: true };
    }
  }

  // Blocked words: the server's list, and each hashtag's.

  function normalizeWords(inputs: string[]): string[] {
    const words = new Set<string>();
    for (const input of inputs) {
      const word = normalizeWord(input);
      if (!word) {
        throw badRequest(`"${input.slice(0, 100)}" can't be blocked: block words or phrases of letters and digits, of at most ${MAX_PHRASE_WORDS} words and ${MAX_WORD_CHARS} characters`);
      }
      words.add(word);
    }
    return [...words];
  }

  const listWords = async (list: string) =>
    (await db.selectFrom('blocked_words').select('word').where('tag', '=', list).execute()).map((r) => r.word).sort();

  async function addWords(list: string, inputs: string[]): Promise<string[]> {
    const have = new Set(await listWords(list));
    const words = normalizeWords(inputs).filter((w) => !have.has(w));
    if (have.size + words.length > MAX_LIST_WORDS) throw conflict(`a list can hold at most ${MAX_LIST_WORDS} words and phrases`);
    const ts = now();
    for (let i = 0; i < words.length; i += INSERT_BATCH) {
      const insert = db.insertInto('blocked_words').values(words.slice(i, i + INSERT_BATCH).map((word) => ({ tag: list, word, created_at: ts })));
      // Another request may have added some of them meanwhile.
      await (config.db.dialect === 'mysql' ? insert.ignore() : insert.onConflict((oc) => oc.doNothing())).execute();
    }
    return listWords(list);
  }

  async function removeWords(list: string, inputs: string[]): Promise<string[]> {
    await db.deleteFrom('blocked_words').where('tag', '=', list).where('word', 'in', normalizeWords(inputs)).execute();
    return listWords(list);
  }

  /** The server's blocked words: a post containing one isn't published. Admins only. */
  app.get('/moderation/blocked-words', async (req) => {
    await asAdmin(req, Credentials.parse(req.body ?? {}));
    return { words: await listWords(SERVER_LIST) };
  });

  app.post('/moderation/blocked-words', async (req) => {
    const body = WordsBody.parse(req.body ?? {});
    await asAdmin(req, body);
    return { words: await addWords(SERVER_LIST, body.words) };
  });

  app.delete('/moderation/blocked-words', async (req) => {
    const body = WordsBody.parse(req.body ?? {});
    await asAdmin(req, body);
    return { words: await removeWords(SERVER_LIST, body.words) };
  });

  /** A hashtag's blocked words: a post containing one doesn't get the hashtag. Its moderators and admins. */
  app.get('/tags/:tag/blocked-words', async (req) => {
    const { tag } = TagParams.parse(req.params);
    await asModerator(req, tag, Credentials.parse(req.body ?? {}));
    return { tag, words: await listWords(tag) };
  });

  app.post('/tags/:tag/blocked-words', async (req) => {
    const { tag } = TagParams.parse(req.params);
    const body = WordsBody.parse(req.body ?? {});
    await asModerator(req, tag, body);
    return { tag, words: await addWords(tag, body.words) };
  });

  app.delete('/tags/:tag/blocked-words', async (req) => {
    const { tag } = TagParams.parse(req.params);
    const body = WordsBody.parse(req.body ?? {});
    await asModerator(req, tag, body);
    return { tag, words: await removeWords(tag, body.words) };
  });

  // Tag moderators.

  /** Who moderates a hashtag. Public, like posts. */
  app.get('/tags/:tag/moderators', async (req) => {
    const { tag } = TagParams.parse(req.params);
    const rows = await db
      .selectFrom('tag_moderators')
      .innerJoin('users', 'users.id', 'tag_moderators.user_id')
      .select(['users.id', 'users.username', 'tag_moderators.created_at'])
      .where('tag_moderators.tag', '=', tag)
      .orderBy('tag_moderators.created_at')
      .orderBy('tag_moderators.user_id')
      .execute();
    return { tag, moderators: rows.map((r) => ({ userId: r.id, username: r.username, since: iso(r.created_at) })) };
  });

  /** Makes a user a moderator of a hashtag. Admins only. */
  app.put('/tags/:tag/moderators/:userId', async (req, reply) => {
    const { tag, userId } = TagUserParams.parse(req.params);
    await asAdmin(req, Credentials.parse(req.body ?? {}));
    await findUser(userId);
    const { at, already } = await addOnce(
      () => db.selectFrom('tag_moderators').select('created_at').where('tag', '=', tag).where('user_id', '=', userId).executeTakeFirst(),
      (createdAt) => db.insertInto('tag_moderators').values({ tag, user_id: userId, created_at: createdAt }).execute(),
    );
    return reply.status(already ? 200 : 201).send({ tag, userId, since: iso(at), alreadyModerator: already });
  });

  app.delete('/tags/:tag/moderators/:userId', async (req) => {
    const { tag, userId } = TagUserParams.parse(req.params);
    await asAdmin(req, Credentials.parse(req.body ?? {}));
    const res = await db.deleteFrom('tag_moderators').where('tag', '=', tag).where('user_id', '=', userId).executeTakeFirst();
    return { tag, userId, wasModerator: Number(res.numDeletedRows) > 0 };
  });

  // Mutes.

  const mute = (tag: string, userId: string) =>
    addOnce(
      () => db.selectFrom('tag_mutes').select('created_at').where('user_id', '=', userId).where('tag', '=', tag).executeTakeFirst(),
      (createdAt) => db.insertInto('tag_mutes').values({ user_id: userId, tag, created_at: createdAt }).execute(),
    );

  /** Users muted on a hashtag, most recently muted first, a page at a time. Its moderators and admins. */
  app.get('/tags/:tag/muted', async (req) => {
    const { tag } = TagParams.parse(req.params);
    const q = ListQuery.parse(req.query);
    const after = q.cursor ? decodeListCursor(q.cursor) : undefined;
    await asModerator(req, tag, Credentials.parse(req.body ?? {}));
    let query = db
      .selectFrom('tag_mutes')
      .innerJoin('users', 'users.id', 'tag_mutes.user_id')
      .select(['users.id', 'users.username', 'tag_mutes.created_at'])
      .where('tag_mutes.tag', '=', tag)
      .orderBy('tag_mutes.created_at', 'desc')
      .orderBy('tag_mutes.user_id', 'asc')
      .limit(q.limit + 1);
    if (after) {
      query = query.where((eb) =>
        eb.or([eb('tag_mutes.created_at', '<', after.createdAt), eb.and([eb('tag_mutes.created_at', '=', after.createdAt), eb('tag_mutes.user_id', '>', after.userId)])]),
      );
    }
    const rows = await query.execute();
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      tag,
      muted: page.map((r) => ({ userId: r.id, username: r.username, mutedAt: iso(r.created_at) })),
      nextCursor: rows.length > q.limit && last ? encodeListCursor(last.created_at, last.id) : null,
    };
  });

  /** Mutes a user on a hashtag: their new posts and versions don't get it. Its moderators and admins. */
  app.put('/tags/:tag/muted/:userId', async (req, reply) => {
    const { tag, userId } = TagUserParams.parse(req.params);
    await asModerator(req, tag, Credentials.parse(req.body ?? {}));
    await findUser(userId);
    const { at, already } = await mute(tag, userId);
    return reply.status(already ? 200 : 201).send({ tag, userId, mutedAt: iso(at), alreadyMuted: already });
  });

  app.delete('/tags/:tag/muted/:userId', async (req) => {
    const { tag, userId } = TagUserParams.parse(req.params);
    await asModerator(req, tag, Credentials.parse(req.body ?? {}));
    const res = await db.deleteFrom('tag_mutes').where('user_id', '=', userId).where('tag', '=', tag).executeTakeFirst();
    return { tag, userId, wasMuted: Number(res.numDeletedRows) > 0 };
  });

  // Removing a hashtag from content.

  /**
   * Removes a hashtag from content (see removeTag), and with `mute`, mutes its publisher on it too.
   * Its moderators and admins.
   */
  app.delete('/content/:contentId/tags/:tag', async (req, reply) => {
    const { contentId, tag } = ContentTagParams.parse(req.params);
    const body = RemoveTagBody.parse(req.body ?? {});
    await asModerator(req, tag, body);
    const { userId, ...removal } = await removeTag(contentId, tag, req.log);
    if (body.mute) await mute(tag, userId);
    return reply.status(removal.status ? 202 : 200).send({ contentId, tag, ...removal, muted: body.mute });
  });

  /** The content's current version and its meta file; 404 once it's set for deletion. */
  async function current(contentId: string): Promise<Current> {
    const row = await db
      .selectFrom('content')
      .innerJoin('users', 'users.id', 'content.user_id')
      .selectAll('content')
      .select(['users.username', 'users.publisher_url'])
      .where('content.id', '=', contentId)
      .where('content.delete_requested_at', 'is', null)
      .executeTakeFirst();
    if (!row) throw notFound('content not found');
    const meta = await content.getMeta(row.id, row.version);
    if (!meta) throw new HttpError(500, `the meta file of version ${row.version} is missing`);
    return { row, meta };
  }

  /**
   * Removes `tag` from content: records it in removed_tags, so later versions don't get it back, then
   * writes a new version without it, which hides the content from the hashtag's feeds at once, as a
   * publisher's update does. Content left with no hashtag is set for deletion instead, since a post needs one.
   */
  async function removeTag(contentId: string, tag: string, log: FastifyBaseLogger): Promise<Removal> {
    let c = await current(contentId);
    const unchanged = (alreadyRemoved: boolean): Removal => ({ userId: c.row.user_id, version: c.row.version, tags: c.meta.tags, alreadyRemoved });
    if (!c.meta.tags.includes(tag)) {
      const removed = await db.selectFrom('removed_tags').select('tag').where('content_id', '=', contentId).where('tag', '=', tag).executeTakeFirst();
      if (!removed) throw notFound(`the content isn't tagged #${tag}`);
      return unchanged(true);
    }
    // Recorded first: a version its publisher writes meanwhile then reads it, or fails to commit, or is read below.
    await addOnce(
      () => db.selectFrom('removed_tags').select('created_at').where('content_id', '=', contentId).where('tag', '=', tag).executeTakeFirst(),
      (createdAt) => db.insertInto('removed_tags').values({ content_id: contentId, tag, created_at: createdAt }).execute(),
    );
    for (let attempt = 1; ; attempt++) {
      const tags = c.meta.tags.filter((t) => t !== tag);
      if (!tags.length) {
        const requestedAt = await setForDeletion(deps, c.row, log);
        return { userId: c.row.user_id, tags, alreadyRemoved: false, status: 'pending_deletion', requestedAt: iso(requestedAt) };
      }
      try {
        return { userId: c.row.user_id, version: await writeWithTags(c, tags), tags, alreadyRemoved: false };
      } catch (err) {
        // Another version committed first, or the content was set for deletion.
        if (!(err instanceof HttpError && err.statusCode === 409) || attempt === REMOVE_ATTEMPTS) throw err;
      }
      c = await current(contentId);
      if (!c.meta.tags.includes(tag)) return unchanged(false);
    }
  }

  /** A new version of the current one with other hashtags: the same bytes (copied), preview, text and AI flag. */
  async function writeWithTags({ row, meta }: Current, tags: string[]): Promise<number> {
    const version = await versions.reserveVersion(row.id, row.version);
    const ts = now();
    const aiGenerated = row.ai_generated === 1;
    // A file links to this version's bytes here, or federated content's at its origin.
    const preview = previewOf({ ...meta, version }, config.publicBaseUrl);
    const summary: Summary = {
      contentId: row.id,
      version,
      createdAt: row.created_at,
      updatedAt: ts,
      userId: row.user_id,
      mimeType: row.mime_type,
      aiGenerated,
      tags,
      preview,
      ...(meta.origin && { origin: meta.origin }),
    };
    await versions.write({
      publisher: { userId: row.user_id, username: row.username, publisherUrl: row.publisher_url },
      existing: row,
      summary,
      meta: { ...meta, version, aiGenerated, preview, tags, createdAt: iso(ts) },
      columns: {
        filename: row.filename,
        size: row.size,
        sha256: row.sha256,
        origin_server: row.origin_server,
        origin_content_id: row.origin_content_id,
        origin_version: row.origin_version,
      },
      putBytes: row.origin_server === null ? () => content.copy(row.id, row.version, version, row.mime_type) : undefined,
    });
    return version;
  }
}
