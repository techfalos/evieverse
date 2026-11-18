import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/apiKey.js';
import type { AuthUser } from '../auth/apiKey.types.js';
import { blocksBetween } from '../blocks.js';
import { lockUser } from '../db/index.js';
import type { AppDeps } from '../deps.types.js';
import { syncFollowing } from '../follows.js';
import { badRequest, forbidden, HttpError, notFound, tooManyRequests } from '../http/errors.js';
import { say } from '../http/language.js';
import { listPage, listQuery } from '../http/listCursor.js';
import { Credentials, Flag, ListQuery } from '../http/schemas.js';
import { inboxItem, MAX_MESSAGE_CHARS, MESSAGE } from '../inbox.js';
import { msg } from '../language.js';
import type { Message } from '../language.types.js';
import { refuseBanned } from '../moderation/policy.js';
import { iso, MINUTE } from '../time.js';

/** The path of a user's inbox, and of the list of whom they block: the user's id. */
const Params = z.object({ userId: z.string().uuid() });
/** The path of one message or notice in a user's inbox: the user's id, and its own. */
const MessageParams = z.object({ userId: z.string().uuid(), messageId: z.string().uuid() });
/** The path of a block: the user who blocks, and the user they block. */
const BlockParams = z.object({ userId: z.string().uuid(), blockedId: z.string().uuid() });

/** The body of POST /messages: who's sending, whom to, and the text, which is 1 to MAX_MESSAGE_CHARS characters without the spaces around it. */
const SendBody = Credentials.extend({
  /** Whom the message is for. */
  to: z.string().uuid(),
  text: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
});
/** The messages to mark as read; left out, every one in the inbox. */
const ReadBody = Credentials.extend({ messageIds: z.array(z.string().uuid()).min(1).max(1000).optional() });
/** A page of an inbox: smaller than a list of users', as each row carries a text. */
const InboxQuery = ListQuery.extend({ limit: z.coerce.number().int().min(1).max(100).default(50) });
/** Only what is unread (true), or only what was read (false); left out, both. */
const UnreadQuery = z.object({ unread: Flag.optional() });

/**
 * Each user's inbox, the messages users send each other, and whom a user blocks.
 *
 * An inbox holds two things, newest first: the messages other users wrote its owner, and the
 * server's notices (src/inbox.ts) of what moderation did to their posts and of their mutes on
 * hashtags, which the moderation routes leave there. Only its owner reads it.
 *
 * Messages between users are a setting of each user's (`users.messages`, PATCH /users/:userId),
 * on unless they turn it off: a user with it off is sent none, and sends none. A user also blocks
 * whom they choose (`user_blocks`), and no message then goes between the two, either way. Neither
 * touches notices, which every user gets. A banned user sends no messages (see refuseBanned), but is
 * sent them, and reads their inbox.
 *
 * Messages are one of the things a block stops: what else it does is in src/blocks.ts.
 */
export function inboxRoutes(app: FastifyInstance, { db, config, hot, follows, now = Date.now }: AppDeps) {
  /** The caller, who must be the user named in the path: `refusal` is what anyone else is told. */
  async function owner(req: FastifyRequest, userId: string, refusal: Message, body: Credentials = Credentials.parse(req.body ?? {})): Promise<AuthUser> {
    const user = await authenticate(db, req, body);
    if (user.id !== userId) throw forbidden(refusal);
    return user;
  }
  const inboxOwner = (req: FastifyRequest, userId: string, body?: Credentials) => owner(req, userId, msg('inbox.own_only'), body);
  const blocker = (req: FastifyRequest, userId: string) => owner(req, userId, msg('block.own_only'));

  const unreadIn = async (userId: string) =>
    Number(
      (
        await db
          .selectFrom('inbox')
          .select((eb) => eb.fn.countAll().as('n'))
          .where('user_id', '=', userId)
          .where('read_at', 'is', null)
          .executeTakeFirstOrThrow()
      ).n,
    );

  // Messages.

  /**
   * Sends another user a message, which lands in their inbox. Refused (403) if the sender turned
   * messages off or blocked the recipient, and, in the same words whichever it is, if the recipient
   * turned messages off or blocked the sender: the sender isn't told they were blocked.
   *
   * A user sends at most `inbox.messagesPerMinute` a minute, counted in Redis as upload links are,
   * and only once the message is known to be one the recipient takes.
   *
   * A block or a setting changed while a message is being sent may not stop it: they apply to the
   * messages sent after them.
   */
  app.post('/messages', async (req, reply) => {
    const body = SendBody.parse(req.body ?? {});
    const sender = await authenticate(db, req, body);
    refuseBanned(sender);
    if (body.to === sender.id) throw badRequest(msg('message.yourself'));
    if (!sender.messages) throw forbidden(msg('message.turned_off'));
    const [recipient, blocked] = await Promise.all([
      db.selectFrom('users').select(['id', 'username', 'messages']).where('id', '=', body.to).where('deleted_at', 'is', null).executeTakeFirst(),
      // Either way round.
      blocksBetween(db, sender.id, body.to),
    ]);
    if (!recipient) throw notFound(msg('user.not_found'));
    if (blocked.mine) throw forbidden(msg('message.you_blocked'));
    if (recipient.messages !== 1 || blocked.theirs) throw forbidden(msg('message.not_taken'));

    const { messagesPerMinute } = config.inbox;
    if (messagesPerMinute > 0) {
      const { count, ttlMs } = await hot.incr(`messages:${sender.id}`, MINUTE);
      const seconds = Math.max(1, Math.ceil(ttlMs / 1000));
      if (count > messagesPerMinute) throw tooManyRequests(msg('message.rate_limited', { count: seconds }), seconds);
    }
    const messageId = randomUUID();
    const sentAt = now();
    await db
      .insertInto('inbox')
      .values({ id: messageId, user_id: recipient.id, kind: MESSAGE, sender_id: sender.id, content_id: null, tag: null, body: body.text, created_at: sentAt, read_at: null })
      .execute();
    return reply.status(201).send({ messageId, to: { userId: recipient.id, username: recipient.username }, sentAt: iso(sentAt) });
  });

  // The inbox.

  /**
   * The caller's inbox, newest first, a page at a time, with how many of all of it are unread. A
   * message has who wrote it and its text. A notice has its kind, the post and hashtag it is about,
   * the start of that post, and what it says in the reader's language. The notice of a mention
   * has who mentioned the user too, the comment it is in if it is in one, and the start of the
   * text that mentions them (see inboxItem). Reading the list marks nothing as read:
   * POST /users/:userId/inbox/read does.
   */
  app.get('/users/:userId/inbox', async (req) => {
    const { userId } = Params.parse(req.params);
    const page = listQuery(req.query, InboxQuery);
    const { unread } = UnreadQuery.parse(req.query);
    await inboxOwner(req, userId);
    let query = db
      .selectFrom('inbox')
      .leftJoin('users', 'users.id', 'inbox.sender_id')
      .select(['inbox.id', 'inbox.kind', 'inbox.sender_id', 'users.username', 'inbox.content_id', 'inbox.comment_id', 'inbox.tag', 'inbox.body', 'inbox.created_at', 'inbox.read_at'])
      .where('inbox.user_id', '=', userId);
    if (unread !== undefined) query = query.where('inbox.read_at', unread ? 'is' : 'is not', null);
    const [{ rows, nextCursor }, unreadCount] = await Promise.all([
      listPage(query, { createdAt: 'inbox.created_at', userId: 'inbox.id' }, page),
      unreadIn(userId),
    ]);
    return {
      userId,
      unread: unreadCount,
      inbox: rows.map((r) => inboxItem(r, (text) => say(req, text))),
      nextCursor,
    };
  });

  /** Marks the caller's messages and notices as read: the ones named, or all of them. Those already read stay as they are. */
  app.post('/users/:userId/inbox/read', async (req) => {
    const { userId } = Params.parse(req.params);
    const body = ReadBody.parse(req.body ?? {});
    await inboxOwner(req, userId, body);
    let update = db.updateTable('inbox').set({ read_at: now() }).where('user_id', '=', userId).where('read_at', 'is', null);
    if (body.messageIds) update = update.where('id', 'in', body.messageIds);
    return { userId, read: Number((await update.executeTakeFirst()).numUpdatedRows), unread: await unreadIn(userId) };
  });

  /** Deletes a message or a notice from the caller's inbox. One that isn't there changes nothing. */
  app.delete('/users/:userId/inbox/:messageId', async (req) => {
    const { userId, messageId } = MessageParams.parse(req.params);
    await inboxOwner(req, userId);
    return { userId, messageId, wasThere: Number((await db.deleteFrom('inbox').where('id', '=', messageId).where('user_id', '=', userId).executeTakeFirst()).numDeletedRows) > 0 };
  });

  // Blocks.

  /**
   * Blocks a user (see src/blocks.ts for all a block does). From then on no message goes between
   * the two, either way; the blocked user comments on none of the blocker's posts; and what they
   * wrote is left out of what the blocker is listed. What they already sent stays in the inbox,
   * and the comments they already made stay on the posts, for the publisher to delete.
   *
   * And neither follows the other. The follows there are between the two end with the block, in
   * its transaction, and none is made while it stands. Both users' rows are locked first, in the
   * order of their ids, so two blocks can't deadlock. A follow locks its follower's row, and looks
   * for a block with the lock held (routes/follow.ts): it commits before the block, which then
   * ends it, or after, and is refused.
   *
   * Following feeds read whom a user follows from Redis, so both users' lists are then written
   * again, as an unfollow writes its user's. Blocking a user again leaves the block as it was,
   * ends any follow still there between the two, and writes the lists again: that is what repairs
   * a write that failed, which is answered 503 though the block is made, as an unfollow's is.
   */
  app.put('/users/:userId/blocked/:blockedId', async (req, reply) => {
    const { userId, blockedId } = BlockParams.parse(req.params);
    await blocker(req, userId);
    if (blockedId === userId) throw badRequest(msg('block.yourself'));
    if (!(await db.selectFrom('users').select('id').where('id', '=', blockedId).where('deleted_at', 'is', null).executeTakeFirst())) throw notFound(msg('user.not_found'));
    const { at, already } = await db.transaction().execute(async (trx) => {
      for (const id of [userId, blockedId].sort()) await lockUser(trx, config.db.dialect, id);
      // Also for a block that is there already: one made when a block ended no follow may have left some.
      await trx
        .deleteFrom('follows')
        .where((eb) =>
          eb.or([
            eb.and([eb('follower_id', '=', userId), eb('followee_id', '=', blockedId)]),
            eb.and([eb('follower_id', '=', blockedId), eb('followee_id', '=', userId)]),
          ]),
        )
        .execute();
      const found = await trx.selectFrom('user_blocks').select('created_at').where('user_id', '=', userId).where('blocked_id', '=', blockedId).executeTakeFirst();
      if (found) return { at: found.created_at, already: true };
      const createdAt = now();
      await trx.insertInto('user_blocks').values({ user_id: userId, blocked_id: blockedId, created_at: createdAt }).execute();
      return { at: createdAt, already: false };
    });
    await syncFollowing(db, follows, [userId, blockedId]).catch((err) => {
      req.log.warn({ err, userId, blockedId }, 'could not write the follows to Redis after a block');
      throw new HttpError(503, msg('block.feeds_not_updated'));
    });
    return reply.status(already ? 200 : 201).send({ userId, blockedId, blockedAt: iso(at), alreadyBlocked: already });
  });

  /** Ends a block, and all it did, from then on. It brings back no follow that the block ended. Unblocking someone who isn't blocked changes nothing. */
  app.delete('/users/:userId/blocked/:blockedId', async (req) => {
    const { userId, blockedId } = BlockParams.parse(req.params);
    await blocker(req, userId);
    return {
      userId,
      blockedId,
      wasBlocked: Number((await db.deleteFrom('user_blocks').where('user_id', '=', userId).where('blocked_id', '=', blockedId).executeTakeFirst()).numDeletedRows) > 0,
    };
  });

  /** Whom the caller blocks, most recently blocked first, a page at a time. Unlike follows, only theirs to read. */
  app.get('/users/:userId/blocked', async (req) => {
    const { userId } = Params.parse(req.params);
    const page = listQuery(req.query);
    await blocker(req, userId);
    const { rows, nextCursor } = await listPage(
      db
        .selectFrom('user_blocks')
        .innerJoin('users', 'users.id', 'user_blocks.blocked_id')
        .select(['users.id', 'users.username', 'user_blocks.created_at'])
        .where('user_blocks.user_id', '=', userId),
      { createdAt: 'user_blocks.created_at', userId: 'user_blocks.blocked_id' },
      page,
    );
    return { userId, blocked: rows.map((r) => ({ userId: r.id, username: r.username, blockedAt: iso(r.created_at) })), nextCursor };
  });
}
