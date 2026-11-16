import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/apiKey.js';
import type { AuthUser } from '../auth/apiKey.types.js';
import { commentRemoval, publishComment, removeCommentRows } from '../comments.js';
import { loadContent } from '../content.js';
import { addOnce, ignoreConflicts } from '../db/index.js';
import { setForDeletion } from '../deletion.js';
import type { RouteDeps } from '../deps.types.js';
import { badRequest, conflict, forbidden, notFound } from '../http/errors.js';
import { listPage, listQuery } from '../http/listCursor.js';
import { Credentials, Flag, HASHTAG, ListQuery } from '../http/schemas.js';
import { notify } from '../inbox.js';
import { messageKey, msg } from '../language.js';
import { moderates, moderatesServer } from '../moderation/policy.js';
import { kindColumn, queueItems } from '../moderation/queues.js';
import { approveTag, removeTag } from '../moderation/tagDecisions.js';
import { isPattern, MAX_LIST_PATTERNS, MAX_LIST_WORDS, MAX_PHRASE_WORDS, MAX_WORD_CHARS, normalizeWord, SERVER_LIST } from '../moderation/words.js';
import { normalizeTag } from '../tags.js';
import { iso } from '../time.js';

/** A hashtag in a path, as /feed takes them. */
const Tag = z
  .string()
  .regex(HASHTAG, messageKey('tags.invalid'))
  .transform((t) => normalizeTag(t)!);
/** The hashtag a path names, for the routes under /tags/:tag: its blocked words, its moderators, and the users muted on it. */
const TagParams = z.object({ tag: Tag });
/** A hashtag and a user in a path: the user who is made or unmade a moderator of the hashtag, or muted or unmuted on it. */
const TagUserParams = z.object({ tag: Tag, userId: z.string().uuid() });
/** The user a path names: the one who is made or unmade an admin or a server moderator, or banned or unbanned. */
const UserParams = z.object({ userId: z.string().uuid() });
/** The post a path names in the moderation queue, for the request that accepts or rejects it. */
const ContentParams = z.object({ contentId: z.string().uuid() });
/** The content and the hashtag under it that a path names (/content/:contentId/tags/:tag), for a tag's moderator to approve or remove. */
const ContentTagParams = z.object({ contentId: z.string().uuid(), tag: Tag });
/** The comment a path names in the moderation queue, by its post's id and its own, for the request that accepts or rejects it. */
const CommentParams = z.object({ contentId: z.string().uuid(), commentId: z.string().uuid() });
/** Why a user is banned, which only moderators read. */
const BanBody = Credentials.extend({ reason: z.string().trim().min(1).max(500).optional() });
/**
 * The entries a request adds to a list of blocked words, or removes from it: 1 to 1000 of them,
 * each a word, a phrase or a pattern as it was typed, of 1000 characters at most. What a list keeps
 * of each, and whether it can keep it, is for `normalizeWords` to say.
 */
const WordsBody = Credentials.extend({ words: z.array(z.string().max(1000)).min(1).max(1000) });
/** What a request that removes a hashtag from content says: with `mute`, its publisher is muted on the hashtag too. Left out: they aren't. */
const RemoveTagBody = Credentials.extend({ mute: Flag.default(false) });
/** A page of the moderation queue: smaller than other lists', as each post's meta file, or each comment, is read for it. */
const QueueQuery = ListQuery.extend({ limit: z.coerce.number().int().min(1).max(100).default(50) });

/** Rows per insert of blocked words, well within every dialect's limit on parameters. */
const INSERT_BATCH = 200;

/** 404 for a post that isn't in the moderation queue, which is all a request can accept or reject there. */
const notQueued = () => notFound(msg('moderation.not_queued'));
/** 403 for a caller who isn't an admin, where only an admin may ask. */
const adminOnly = () => forbidden(msg('moderation.admin_only'));

/**
 * Moderation: admins make and revoke admins, appoint server moderators and tag moderators, and keep
 * the server's blocked words; server moderators and admins ban users; server moderators (and admins) accept or reject the posts and the
 * comments their trust score sent to the moderation queue; a tag's moderators (and server moderators
 * and admins, on every tag) keep its blocked words, mute users on it, and approve the content under
 * it or remove it from content.
 * Mutes and blocked words apply to what is written from then on; what a tag's moderator decides
 * about content shows in the tag's feeds at once, and the compactor applies it. A tag's moderators
 * have no say over comments.
 *
 * Whoever it is done to is told: a notice goes to the inbox (src/inbox.ts) of a user who is muted
 * or unmuted, of the publisher of a post that loses a hashtag, or is accepted or rejected in the
 * moderation queue, and of the author of a comment that is accepted or rejected there.
 */
export function moderationRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { db, config, comments, writer, now = Date.now } = deps;

  async function asAdmin(req: FastifyRequest, body: Credentials): Promise<AuthUser> {
    const user = await authenticate(db, req, body);
    if (!user.admin) throw adminOnly();
    return user;
  }

  /** For the moderation queue: a server moderator, or an admin. */
  async function asServerModerator(req: FastifyRequest, body: Credentials): Promise<AuthUser> {
    const user = await authenticate(db, req, body);
    if (!moderatesServer(user)) throw forbidden(msg('moderation.server_moderator_only'));
    return user;
  }

  /** For what a hashtag's moderators do: one of them, or a server moderator or an admin, who moderate every hashtag. */
  async function asModerator(req: FastifyRequest, tag: string, body: Credentials): Promise<AuthUser> {
    const user = await authenticate(db, req, body);
    if (!(await moderates(db, user, tag))) throw forbidden(msg('moderation.tag_moderator_only', { tag }));
    return user;
  }

  /** A user who is there: one whose account was deleted isn't, though its row may be for a while. */
  async function findUser(userId: string) {
    const user = await db.selectFrom('users').select(['id', 'username', 'admin', 'moderator']).where('id', '=', userId).where('deleted_at', 'is', null).executeTakeFirst();
    if (!user) throw notFound(msg('user.not_found'));
    return user;
  }

  // Admins.

  /** The server's admins. Admins only. */
  app.get('/admins', async (req) => {
    await asAdmin(req, Credentials.parse(req.body ?? {}));
    return {
      admins: (await db.selectFrom('users').select(['id', 'username']).where('admin', '=', 1).orderBy('username').execute()).map((a) => ({ userId: a.id, username: a.username })),
    };
  });

  /** Makes a user an admin. Admins only. */
  app.put('/admins/:userId', async (req, reply) => {
    const { userId } = UserParams.parse(req.params);
    await asAdmin(req, Credentials.parse(req.body ?? {}));
    const { username } = await findUser(userId);
    const already = Number((await db.updateTable('users').set({ admin: 1 }).where('id', '=', userId).where('admin', '=', 0).executeTakeFirst()).numUpdatedRows) === 0;
    return reply.status(already ? 200 : 201).send({ userId, username, alreadyAdmin: already });
  });

  /**
   * Revokes a user's admin role. Admins only, and never the last one: the admin left in place is the
   * caller, or for an admin stepping down, any other admin there is.
   */
  app.delete('/admins/:userId', async (req) => {
    const { userId } = UserParams.parse(req.params);
    const caller = await asAdmin(req, Credentials.parse(req.body ?? {}));
    // Looks again, up to 3 times, for an admin to leave in place, when the one it chose stopped being one meanwhile.
    for (let attempt = 0; attempt < 3; attempt++) {
      const other =
        userId === caller.id
          ? await db.selectFrom('users').select('id').where('admin', '=', 1).where('id', '<>', userId).limit(1).executeTakeFirst()
          : caller;
      if (!other) throw conflict(msg('moderation.only_admin'));
      // Revokes `userId`'s admin role, leaving `other` an admin: true if it did, false if `userId`
      // wasn't an admin, null if `other` isn't one any more. The updates that change nothing come
      // first, so both rows are locked (in the order of their ids, so two revocations can't deadlock):
      // every revocation holds the row of an admin it leaves in place, and so the server always has one.
      const wasAdmin = await db.transaction().execute(async (trx) => {
        const ids = [userId, other.id].sort();
        for (const id of ids) await trx.updateTable('users').set((eb) => ({ admin: eb.ref('admin') })).where('id', '=', id).execute();
        const rows = await trx.selectFrom('users').select(['id', 'admin']).where('id', 'in', ids).execute();
        const isAdmin = (id: string) => rows.some((r) => r.id === id && r.admin === 1);
        if (!isAdmin(other.id)) return null;
        if (!isAdmin(userId)) return false;
        await trx.updateTable('users').set({ admin: 0 }).where('id', '=', userId).execute();
        return true;
      });
      if (wasAdmin !== null) return { userId, wasAdmin };
      // The caller was revoked while this request was under way.
      if (other.id === caller.id) throw adminOnly();
    }
    throw conflict(msg('moderation.admins_changed'));
  });

  // Server moderators: who works through the moderation queue, and moderates every hashtag, without being an admin.

  /** The server's moderators. Admins only. */
  app.get('/moderators', async (req) => {
    await asAdmin(req, Credentials.parse(req.body ?? {}));
    return {
      moderators: (await db.selectFrom('users').select(['id', 'username']).where('moderator', '=', 1).orderBy('username').execute()).map((m) => ({
        userId: m.id,
        username: m.username,
      })),
    };
  });

  /** Makes a user a server moderator. Admins only. */
  app.put('/moderators/:userId', async (req, reply) => {
    const { userId } = UserParams.parse(req.params);
    await asAdmin(req, Credentials.parse(req.body ?? {}));
    const { username } = await findUser(userId);
    const already =
      Number((await db.updateTable('users').set({ moderator: 1 }).where('id', '=', userId).where('moderator', '=', 0).executeTakeFirst()).numUpdatedRows) === 0;
    return reply.status(already ? 200 : 201).send({ userId, username, alreadyModerator: already });
  });

  /** Ends a user's time as a server moderator. Admins only. What the user decided in the queue stays decided. */
  app.delete('/moderators/:userId', async (req) => {
    const { userId } = UserParams.parse(req.params);
    await asAdmin(req, Credentials.parse(req.body ?? {}));
    return {
      userId,
      wasModerator: Number((await db.updateTable('users').set({ moderator: 0 }).where('id', '=', userId).where('moderator', '=', 1).executeTakeFirst()).numUpdatedRows) > 0,
    };
  });

  // Bans: who can't post, comment, like or send messages.

  /**
   * Users who are banned, most recently banned first, a page at a time, with who banned each and why.
   * Server moderators and admins.
   */
  app.get('/banned', async (req) => {
    const page = listQuery(req.query);
    await asServerModerator(req, Credentials.parse(req.body ?? {}));
    const { rows, nextCursor } = await listPage(
      db
        .selectFrom('users')
        .leftJoin('users as bans', 'bans.id', 'users.banned_by')
        .select((eb) => [
          'users.id',
          'users.username',
          eb.ref('users.banned_at').$castTo<number>().as('created_at'),
          'users.ban_reason',
          'bans.id as by_id',
          'bans.username as by_username',
        ])
        .where('users.banned_at', 'is not', null)
        .where('users.deleted_at', 'is', null),
      { createdAt: 'users.banned_at', userId: 'users.id' },
      page,
    );
    return {
      banned: rows.map((r) => ({
        userId: r.id,
        username: r.username,
        bannedAt: iso(r.created_at),
        reason: r.ban_reason,
        bannedBy: r.by_id !== null && r.by_username !== null ? { userId: r.by_id, username: r.by_username } : null,
      })),
      nextCursor,
    };
  });

  /**
   * Bans a user: they keep their account and can read, but are refused whatever writes a post, a
   * comment, a like or a message (see refuseBanned). `reason` is kept for moderators. Server moderators and
   * admins, and never of an admin or a server moderator, whose role has to end first, or of
   * oneself. The user is told, once: `201`, or `200` with `alreadyBanned` and the first ban's time
   * and reason for one who already was.
   */
  app.put('/banned/:userId', async (req, reply) => {
    const { userId } = UserParams.parse(req.params);
    const body = BanBody.parse(req.body ?? {});
    const moderator = await asServerModerator(req, body);
    if (userId === moderator.id) throw badRequest(msg('moderation.ban_yourself'));
    const { username, admin, moderator: staff } = await findUser(userId);
    if (admin === 1 || staff === 1) throw forbidden(msg('moderation.ban_staff'));
    const at = now();
    // Only a user who isn't banned and holds no role, so a ban never overwrites the first, nor lands on someone made staff meanwhile.
    if (
      Number(
        (
          await db
            .updateTable('users')
            .set({ banned_at: at, banned_by: moderator.id, ban_reason: body.reason ?? null })
            .where('id', '=', userId)
            .where('banned_at', 'is', null)
            .where('admin', '=', 0)
            .where('moderator', '=', 0)
            .where('deleted_at', 'is', null)
            .executeTakeFirst()
        ).numUpdatedRows,
      ) === 0
    ) {
      const current = await db.selectFrom('users').select(['banned_at', 'ban_reason']).where('id', '=', userId).where('deleted_at', 'is', null).executeTakeFirst();
      if (!current) throw notFound(msg('user.not_found'));
      if (current.banned_at === null) throw forbidden(msg('moderation.ban_staff'));
      return { userId, username, bannedAt: iso(current.banned_at), reason: current.ban_reason, alreadyBanned: true };
    }
    req.log.info({ userId, moderator: moderator.id }, 'banned a user');
    await notify(deps, { userId, kind: 'user_banned', by: moderator.id }, req.log);
    return reply.status(201).send({ userId, username, bannedAt: iso(at), reason: body.reason ?? null, alreadyBanned: false });
  });

  /** Ends a ban, which the user is told of. Server moderators and admins. */
  app.delete('/banned/:userId', async (req) => {
    const { userId } = UserParams.parse(req.params);
    const moderator = await asServerModerator(req, Credentials.parse(req.body ?? {}));
    const wasBanned =
      Number(
        (
          await db
            .updateTable('users')
            .set({ banned_at: null, banned_by: null, ban_reason: null })
            .where('id', '=', userId)
            .where('banned_at', 'is not', null)
            .where('deleted_at', 'is', null)
            .executeTakeFirst()
        ).numUpdatedRows,
      ) > 0;
    if (wasBanned) {
      req.log.info({ userId, moderator: moderator.id }, 'ended a ban');
      await notify(deps, { userId, kind: 'user_unbanned', by: moderator.id }, req.log);
    }
    return { userId, wasBanned };
  });

  // Blocked words: the server's list, and each hashtag's.

  function normalizeWords(inputs: string[]): string[] {
    const words = new Set<string>();
    for (const input of inputs) {
      const word = normalizeWord(input);
      if (!word) {
        throw badRequest(
          msg(isPattern(input) ? 'moderation.pattern_unblockable' : 'moderation.word_unblockable', {
            word: input.slice(0, 100),
            maxWords: MAX_PHRASE_WORDS,
            maxChars: MAX_WORD_CHARS,
          }),
        );
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
    if (have.size + words.length > MAX_LIST_WORDS) throw conflict(msg('moderation.list_full', { max: MAX_LIST_WORDS }));
    // Fewer patterns than words: each is run over every post the list applies to.
    if (words.some(isPattern) && [...have, ...words].filter(isPattern).length > MAX_LIST_PATTERNS) {
      throw conflict(msg('moderation.patterns_full', { max: MAX_LIST_PATTERNS }));
    }
    const ts = now();
    for (let i = 0; i < words.length; i += INSERT_BATCH) {
      // Another request may have added some of them meanwhile.
      await ignoreConflicts(
        db.insertInto('blocked_words').values(words.slice(i, i + INSERT_BATCH).map((word) => ({ tag: list, word, created_at: ts }))),
        config.db.dialect,
      ).execute();
    }
    return listWords(list);
  }

  async function removeWords(list: string, inputs: string[]): Promise<string[]> {
    await db.deleteFrom('blocked_words').where('tag', '=', list).where('word', 'in', normalizeWords(inputs)).execute();
    return listWords(list);
  }

  /**
   * The server's blocked words, which admins keep: a post containing one isn't published. And each
   * hashtag's, which its moderators, server moderators and admins keep: a post containing one doesn't get the hashtag.
   * An entry is a word, a phrase, or a pattern written between slashes (src/moderation/words.ts).
   */
  const wordLists = [
    {
      url: '/moderation/blocked-words',
      open: (req: FastifyRequest) => ({ list: SERVER_LIST, named: {}, allow: (body: Credentials) => asAdmin(req, body) }),
    },
    {
      url: '/tags/:tag/blocked-words',
      open: (req: FastifyRequest) => {
        const { tag } = TagParams.parse(req.params);
        return { list: tag, named: { tag }, allow: (body: Credentials) => asModerator(req, tag, body) };
      },
    },
  ];

  /** One route per list, answering with the list's words as `change` leaves them. */
  function wordsRoutes<B extends Credentials>(method: 'GET' | 'POST' | 'DELETE', Body: z.ZodType<B>, change: (list: string, body: B) => Promise<string[]>) {
    for (const { url, open } of wordLists) {
      app.route({
        method,
        url,
        handler: async (req) => {
          const { list, named, allow } = open(req);
          const body = Body.parse(req.body ?? {});
          await allow(body);
          return { ...named, words: await change(list, body) };
        },
      });
    }
  }

  wordsRoutes('GET', Credentials, (list) => listWords(list));
  wordsRoutes('POST', WordsBody, (list, body) => addWords(list, body.words));
  wordsRoutes('DELETE', WordsBody, (list, body) => removeWords(list, body.words));

  // Tag moderators.

  /** Who moderates a hashtag. Public, like posts. */
  app.get('/tags/:tag/moderators', async (req) => {
    const { tag } = TagParams.parse(req.params);
    return {
      tag,
      moderators: (
        await db
          .selectFrom('tag_moderators')
          .innerJoin('users', 'users.id', 'tag_moderators.user_id')
          .select(['users.id', 'users.username', 'tag_moderators.created_at'])
          .where('tag_moderators.tag', '=', tag)
          .orderBy('tag_moderators.created_at')
          .orderBy('tag_moderators.user_id')
          .execute()
      ).map((r) => ({ userId: r.id, username: r.username, since: iso(r.created_at) })),
    };
  });

  /** Makes a user a moderator of a hashtag. Admins only. */
  app.put('/tags/:tag/moderators/:userId', async (req, reply) => {
    const { tag, userId } = TagUserParams.parse(req.params);
    await asAdmin(req, Credentials.parse(req.body ?? {}));
    await findUser(userId);
    const { at, already } = await addOnce(
      now,
      () => db.selectFrom('tag_moderators').select('created_at').where('tag', '=', tag).where('user_id', '=', userId).executeTakeFirst(),
      (createdAt) => db.insertInto('tag_moderators').values({ tag, user_id: userId, created_at: createdAt }).execute(),
    );
    return reply.status(already ? 200 : 201).send({ tag, userId, since: iso(at), alreadyModerator: already });
  });

  app.delete('/tags/:tag/moderators/:userId', async (req) => {
    const { tag, userId } = TagUserParams.parse(req.params);
    await asAdmin(req, Credentials.parse(req.body ?? {}));
    return {
      tag,
      userId,
      wasModerator: Number((await db.deleteFrom('tag_moderators').where('tag', '=', tag).where('user_id', '=', userId).executeTakeFirst()).numDeletedRows) > 0,
    };
  });

  // Mutes.

  const mute = (tag: string, userId: string) =>
    addOnce(
      now,
      () => db.selectFrom('tag_mutes').select('created_at').where('user_id', '=', userId).where('tag', '=', tag).executeTakeFirst(),
      (createdAt) => db.insertInto('tag_mutes').values({ user_id: userId, tag, created_at: createdAt }).execute(),
    );

  /** Users muted on a hashtag, most recently muted first, a page at a time. Its moderators, server moderators and admins. */
  app.get('/tags/:tag/muted', async (req) => {
    const { tag } = TagParams.parse(req.params);
    const page = listQuery(req.query);
    await asModerator(req, tag, Credentials.parse(req.body ?? {}));
    const { rows, nextCursor } = await listPage(
      db
        .selectFrom('tag_mutes')
        .innerJoin('users', 'users.id', 'tag_mutes.user_id')
        .select(['users.id', 'users.username', 'tag_mutes.created_at'])
        .where('tag_mutes.tag', '=', tag),
      { createdAt: 'tag_mutes.created_at', userId: 'tag_mutes.user_id' },
      page,
    );
    return { tag, muted: rows.map((r) => ({ userId: r.id, username: r.username, mutedAt: iso(r.created_at) })), nextCursor };
  });

  /** Mutes a user on a hashtag: their new posts and updates don't get it. Its moderators, server moderators and admins. The user is told, once. */
  app.put('/tags/:tag/muted/:userId', async (req, reply) => {
    const { tag, userId } = TagUserParams.parse(req.params);
    const moderator = await asModerator(req, tag, Credentials.parse(req.body ?? {}));
    await findUser(userId);
    const { at, already } = await mute(tag, userId);
    if (!already) await notify(deps, { userId, kind: 'tag_muted', tag, by: moderator.id }, req.log);
    return reply.status(already ? 200 : 201).send({ tag, userId, mutedAt: iso(at), alreadyMuted: already });
  });

  /** Ends a mute, which the user is told of too. */
  app.delete('/tags/:tag/muted/:userId', async (req) => {
    const { tag, userId } = TagUserParams.parse(req.params);
    const moderator = await asModerator(req, tag, Credentials.parse(req.body ?? {}));
    const wasMuted = Number((await db.deleteFrom('tag_mutes').where('user_id', '=', userId).where('tag', '=', tag).executeTakeFirst()).numDeletedRows) > 0;
    if (wasMuted) await notify(deps, { userId, kind: 'tag_unmuted', tag, by: moderator.id }, req.log);
    return { tag, userId, wasMuted };
  });

  // A hashtag's moderation queue: every post under the hashtag that none of its moderators has decided on.
  // It is read from the feed (GET /feed?tags=<tag>&moderated=false); these two routes are the decisions.

  /** Approves content under a hashtag (see approveTag), which takes it out of the hashtag's queue. Its moderators, server moderators and admins. */
  app.put('/content/:contentId/tags/:tag', async (req, reply) => {
    const { contentId, tag } = ContentTagParams.parse(req.params);
    const { alreadyApproved } = await approveTag(deps, contentId, tag, (await asModerator(req, tag, Credentials.parse(req.body ?? {}))).id);
    return reply.status(alreadyApproved ? 200 : 201).send({ contentId, tag, moderated: true, alreadyApproved });
  });

  /**
   * Removes a hashtag from content (see removeTag), and with `mute`, mutes its publisher on it too.
   * Its moderators, server moderators and admins. The publisher is told of the removal, which may have left the post
   * with no hashtag and so in no hashtag's feed, and of a mute it brought them.
   */
  app.delete('/content/:contentId/tags/:tag', async (req) => {
    const { contentId, tag } = ContentTagParams.parse(req.params);
    const body = RemoveTagBody.parse(req.body ?? {});
    const moderator = await asModerator(req, tag, body);
    const { userId, tags } = await removeTag(deps, contentId, tag, moderator.id);
    const muted = body.mute ? await mute(tag, userId) : null;
    await notify(deps, { userId, kind: tags.length ? 'tag_removed' : 'last_tag_removed', contentId, tag, by: moderator.id }, req.log);
    if (muted && !muted.already) await notify(deps, { userId, kind: 'tag_muted', tag, by: moderator.id }, req.log);
    return { contentId, tag, tags, muted: body.mute };
  });

  // The moderation queue: the posts, under any hashtag, and the comments, whose trust score neither had them refused nor published.

  /**
   * What waits in the moderation queue, posts and comments in one list, longest waiting first, a
   * page at a time. `kind` says which each is: a post is a feed record with its whole text or
   * caption, a comment is as GET /content/:contentId/comments gives it. Each has the trust score
   * that sent it there and since when it waits. Server moderators and admins.
   */
  app.get('/moderation/queue', async (req) => {
    const page = listQuery(req.query, QueueQuery);
    await asServerModerator(req, Credentials.parse(req.body ?? {}));
    const { rows, nextCursor } = await listPage(
      db
        .selectFrom(
          db
            .selectFrom('moderation_queue')
            .innerJoin('content', 'content.id', 'moderation_queue.content_id')
            .select([kindColumn('post'), 'moderation_queue.content_id as id', 'moderation_queue.content_id', 'moderation_queue.trust_score', 'moderation_queue.created_at'])
            // Content set for deletion (rejected, or deleted by its publisher) is gone, though its row is still there.
            .where('content.delete_requested_at', 'is', null)
            .unionAll(
              db
                .selectFrom('comment_queue')
                .innerJoin('content', 'content.id', 'comment_queue.content_id')
                .select([kindColumn('comment'), 'comment_queue.comment_id as id', 'comment_queue.content_id', 'comment_queue.trust_score', 'comment_queue.created_at'])
                // And so are the comments on it.
                .where('content.delete_requested_at', 'is', null),
            )
            .as('queue'),
        )
        .selectAll('queue'),
      { createdAt: 'queue.created_at', userId: 'queue.id' },
      page,
      'oldest',
    );
    const items = await queueItems(deps, rows, { held: true });
    return {
      queue: rows.flatMap((r, i) => {
        const item = items[i];
        return item ? [{ ...item, trustScore: r.trust_score, queuedAt: iso(r.created_at) }] : [];
      }),
      nextCursor,
    };
  });

  /**
   * Accepts a post from the moderation queue: it is published under its hashtags (see
   * ContentWriter.publish). Server moderators and admins. Its publisher is told.
   */
  app.post('/moderation/queue/:contentId/accept', async (req) => {
    const { contentId } = ContentParams.parse(req.params);
    const moderator = await asServerModerator(req, Credentials.parse(req.body ?? {}));
    const row = await loadContent(db, contentId);
    const tags = row.queued ? await writer.publish(row) : null;
    if (!tags) throw notQueued();
    req.log.info({ contentId, moderator: moderator.id }, 'accepted from the moderation queue');
    await notify(deps, { userId: row.user_id, kind: 'post_accepted', contentId, by: moderator.id }, req.log);
    return { contentId, status: 'published', tags };
  });

  /**
   * Rejects a post in the moderation queue: it is set for deletion (see setForDeletion). Server
   * moderators and admins. Only what waits in the queue: published content is an admin's to delete,
   * unless it was reported (see routes/reports.ts).
   * Its publisher is told.
   */
  app.post('/moderation/queue/:contentId/reject', async (req, reply) => {
    const { contentId } = ContentParams.parse(req.params);
    const moderator = await asServerModerator(req, Credentials.parse(req.body ?? {}));
    const row = await loadContent(db, contentId);
    if (!row.queued) throw notQueued();
    const requestedAt = await setForDeletion(deps, row);
    req.log.info({ contentId, moderator: moderator.id }, 'rejected from the moderation queue');
    await notify(deps, { userId: row.user_id, kind: 'post_rejected', contentId, by: moderator.id }, req.log);
    return reply.status(202).send({ contentId, status: 'pending_deletion', requestedAt: iso(requestedAt) });
  });

  /**
   * Takes a comment's row out of the moderation queue and, having done so, does `decide` to the
   * comment, in one transaction: of two decisions on one comment only the first finds the row, and
   * a decision that fails leaves the row where it was, to be decided again. 404 for a comment that
   * isn't in the queue.
   */
  const decide = <T>(contentId: string, commentId: string, decision: () => Promise<T>): Promise<T> =>
    db.transaction().execute(async (trx) => {
      if (Number((await trx.deleteFrom('comment_queue').where('comment_id', '=', commentId).where('content_id', '=', contentId).executeTakeFirst()).numDeletedRows) === 0) {
        throw notFound(msg('comment.not_queued'));
      }
      return decision();
    });

  /**
   * Accepts a comment from the moderation queue: it is published among its post's comments, or
   * among the replies to the comment it replies to (see CommentStore.publish), where it was sent,
   * not where it was accepted. A comment that an edit took back to the queue is published as
   * edited, with the replies and the likes it had. Server moderators and admins. Its author is told.
   *
   * A reply to a comment that was deleted while the reply waited is published like any other,
   * under the placeholder the comment left. Only a reply whose comment left nothing at all isn't
   * (see publishComment): it is removed, and the request is refused (404).
   */
  app.post('/moderation/queue/:contentId/comments/:commentId/accept', async (req) => {
    const { contentId, commentId } = CommentParams.parse(req.params);
    const moderator = await asServerModerator(req, Credentials.parse(req.body ?? {}));
    await loadContent(db, contentId);
    // Where comments wait, or where published ones are: an accept that published it and then failed to take its row out, or an edit that has put its row in and not yet taken it back.
    const comment = (await comments.getHeld(contentId, commentId)) ?? (await comments.get(contentId, commentId));
    const published = await decide(contentId, commentId, async () => comment !== null && (await publishComment(deps, comment)));
    // A row whose comment the store doesn't have: it is out of the queue, and there is nothing to publish.
    if (!comment) throw notFound(msg('comment.not_found'));
    if (!published) throw notFound(msg('comment.reply_to_gone'));
    req.log.info({ contentId, commentId, moderator: moderator.id }, 'accepted a comment from the moderation queue');
    await notify(deps, { userId: comment.userId, kind: 'comment_accepted', contentId, comment: comment.text, by: moderator.id }, req.log);
    return { contentId, commentId, status: 'published' };
  });

  /**
   * Rejects a comment in the moderation queue: it is deleted, at once and for good, as any comment
   * is (see removeComment): that comment, and none of the comments that reply to it, which a
   * comment that an edit took back to the queue may have. They stay, under a placeholder that
   * says the comment was deleted. Server moderators and admins. Only what waits in the queue: a published comment is its
   * author's, the post's publisher's or an admin's to delete, unless it was reported (see
   * routes/reports.ts). Its author is told.
   */
  app.post('/moderation/queue/:contentId/comments/:commentId/reject', async (req) => {
    const { contentId, commentId } = CommentParams.parse(req.params);
    const moderator = await asServerModerator(req, Credentials.parse(req.body ?? {}));
    await loadContent(db, contentId);
    // Read before it is removed, for the notice that quotes it.
    const comment = await comments.getHeld(contentId, commentId);
    // Planned before the transaction, and finished after it: both read the database on their own.
    const removal = await commentRemoval(deps, contentId, commentId);
    await decide(contentId, commentId, removal.remove);
    // What else the queues had of it: the reports of it, made while it was published.
    await removeCommentRows(db, contentId, commentId);
    await removal.finish();
    req.log.info({ contentId, commentId, moderator: moderator.id }, 'rejected a comment from the moderation queue');
    if (comment) await notify(deps, { userId: comment.userId, kind: 'comment_rejected', contentId, comment: comment.text, by: moderator.id }, req.log);
    return { contentId, commentId, status: 'deleted' };
  });
}
