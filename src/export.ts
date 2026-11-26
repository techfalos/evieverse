import { sql, type SelectQueryBuilder } from 'kysely';
import { toCommentRecord } from './comments.js';
import { imagesOf, ORIGIN_GONE, PENDING_REVIEW, rowCounts, takesComments } from './content.js';
import type { AppDeps } from './deps.types.js';
import type { ExportPage, ExportPageQuery, ExportPosition, ExportRead, ExportRecord } from './export.types.js';
import { busy } from './http/errors.js';
import { decodeCursorJson, encodeCursorJson, invalidCursor } from './http/listCursor.js';
import { inboxItem, MESSAGE } from './inbox.js';
import { msg } from './language.js';
import type { Message } from './language.types.js';
import { pendingComments, pendingMetas } from './pending.js';
import { previewOf } from './posts.js';
import { profileOf } from './profile.js';
import type { ContentMeta } from './storage/index.js';
import { indexAuthor } from './tagfeed/layout.js';
import { iso } from './time.js';
import { mapLimit } from './util.js';

/**
 * A user's export of their own data (GET /users/:userId/export, routes/export.ts): what the
 * server holds of them, for them to keep or to take elsewhere.
 *
 * An account can hold any amount: every post a user wrote, every like they gave, everyone who
 * follows them. So an export is never made whole, in memory or in a file, and no request reads
 * more than a page of it. It is a walk: a page of records, and the cursor of the page after it,
 * until there is none. Nothing is kept between two pages, on the server or in Redis: the cursor
 * says where the walk is, so any node or function answers any page, and a walk that stopped is
 * taken up again where it was. A page is bounded twice, by its records and by its bytes
 * (PAGE_BYTES), as records are of very different sizes: a like is a hundred bytes, and a text
 * post up to 40,000 characters.
 *
 * The export is its sections, one after another, in the order of `sectionsOf`. Each is read in
 * the order of a key of its rows, starting after the last record of the page before. For what a
 * user can have a great many of (posts, likes, reposts, follows, messages), that is an order an
 * index holds, so a page costs what it returns and not what came before it. Every record says
 * what it is (`type`), and a page takes up the next section where one ends, so a page can hold
 * several.
 *
 * Comments aren't rows: a comment and a like of one are objects in the content store, under the
 * post they are on. What finds a user's is the index the comment store keeps of them, by who
 * wrote or liked them (storage/commentStore.ts), which is read in the order of the comments'
 * ids, a page at a time, as the rows are. On a server that had comments before it kept that
 * index, the index lacks them until the compactor's process has been through them
 * (compactor/src/author_index.rs). An export would then lack them too, and nothing in it would say so: so
 * until the index holds everything, no page of an export is given (503).
 *
 * It is not a snapshot: it is read while the account is used. What is there throughout the walk
 * is in it once. What is written or deleted meanwhile is in it or not, by where the walk was.
 *
 * Files aren't in it: a post's record says where its bytes are read (`contentUrl`), as GET
 * /content/:contentId does, and whoever keeps the export fetches them from there.
 *
 * What it leaves out, of comments: one the compactor hasn't written yet, and a like of one it
 * hasn't made. Those are in the index once it has, which is seconds, and in an export read then.
 */

/**
 * The most a page's records come to, as JSON, in bytes, before it ends: a page ends with the
 * record that takes it there, so it is at most this and one record. Well within what a function
 * can answer with (Lambda refuses a response over 6 MB, see functions/lambdaRuntime.ts).
 */
const PAGE_BYTES = 1024 * 1024;

/**
 * Posts read at a time. Each takes a read of the content store, for its meta file, and a page
 * that its bytes end leaves the rest of what it read unused: few at a time keeps that small.
 */
const POSTS_PER_READ = 25;

/** Objects read from the content store at once, for a read of posts (their meta files), of comments or of likes of comments. */
const STORE_READS = 16;

/** Comments read at a time: each takes a read of the content store, as a post does, and is two thousand characters at most. */
const COMMENTS_PER_READ = 100;

/** Likes of comments read at a time: each is asked of the content store, to find whether it is there. */
const COMMENT_LIKES_PER_READ = 200;

/** How long a client is told to wait, in seconds, where an export isn't given yet: the index of comments is being made (see `exporter`). */
const INDEXING_RETRY_SECONDS = 60;

/** The longest string a cursor's position holds: an id is 36 characters, and a hashtag 64 at most. */
const MAX_KEY_CHARS = 64;

/** What puts a notice in its reader's language. */
type Say = (text: Message) => string;

/** What reading an export needs. */
type ExportDeps = Pick<AppDeps, 'db' | 'content' | 'comments' | 'config'>;

/** A part of an export: the records of one kind, in a set order. */
interface Section {
  /** What a cursor names it by. */
  name: string;
  /** The values a position in it holds (see ExportPosition), by type: what a cursor's is held to. */
  keys: readonly ('number' | 'string')[];
  /** The most it reads at a time; any number, where it doesn't say. */
  chunk?: number;
  /** Up to `limit` of the user's records, in order, after `after`, or from the first. Fewer: the section ends with them. */
  read(userId: string, after: ExportPosition | null, limit: number, say: Say): Promise<ExportRead[]>;
}

/**
 * The first `limit` rows of `query` after `after`, in the order of `columns`, ascending: one
 * column that is unique among the rows, or two, of which the second tells apart the rows that
 * share the first (when something happened, then an id).
 *
 * With two, the rows after a position are those whose first column is past its first value, or
 * the same with the second past its second. That is said with a bound on the first column
 * alone in front of it, which is what an index on the two is read from: without it, a database
 * can take the rows from the start of the index and drop the ones before the position, and a
 * page would cost what came before it.
 */
function walk<DB, TB extends keyof DB, O>(
  query: SelectQueryBuilder<DB, TB, O>,
  [first, second]: readonly [string] | readonly [string, string],
  after: ExportPosition | null,
  limit: number,
) {
  const a = sql.ref(first);
  let ordered = query.orderBy(a, 'asc');
  if (second === undefined) {
    if (after) ordered = ordered.where(sql<boolean>`${a} > ${after[0]}`);
  } else {
    const b = sql.ref(second);
    ordered = ordered.orderBy(b, 'asc');
    if (after) ordered = ordered.where(sql<boolean>`(${a} >= ${after[0]} and (${a} > ${after[0]} or ${b} > ${after[1]}))`);
  }
  return ordered.limit(limit).execute();
}

/** The comment a position in a user's index of comments names: the one a read of it starts after. Null: from the first. */
const commentAfter = (after: ExportPosition | null) => (after ? String(after[0]) : null);

/**
 * The sections of an export, in the order it gives them. Each finds the user's rows by an index
 * that starts with their id, and their comments and likes of comments by the comment store's
 * index of them. Those a user can have any number of are read in that index's own
 * order, which each says below (three of the indexes are 0006_export_indexes'). The others
 * (the account, its keys, the hashtags the user moderates, their reports) are a few rows, which
 * the database sorts: keys are made one at a time, and reports are limited by the hour.
 *
 *   account         the user's row: their name, profile, settings and roles, and since when they are banned, or barred from claiming hashtags, if they are
 *   keys            their API keys, as far as the server has them: when each was made and revoked, and never the key
 *   posts           their posts, oldest first, as GET /content/:contentId gives each to its publisher
 *   comments        their comments, oldest first, with the ones that wait in the moderation queue
 *   likes           the posts they liked
 *   dislikes        the posts they disliked
 *   commentLikes    the comments they liked
 *   reposts         the posts they reposted, with the hashtags each repost gave
 *   following       whom they follow
 *   followers       who follows them
 *   blocks          whom they block
 *   mutes           the hashtags they are muted on
 *   moderates       the hashtags they moderate
 *   reports         the posts they reported
 *   commentReports  the comments they reported
 *   inbox           their inbox: the messages they were sent, and the server's notices
 *   sent            the messages they sent, as far as their recipients still have them
 */
function sectionsOf({ db, content, comments, config }: ExportDeps): Section[] {
  /**
   * The meta files of posts, by id, as GET /content/:contentId reads one (see effectiveMeta): a
   * write that waits first, in one query for all of them, and the content store for the rest.
   * None for a post that has neither: one the compactor deleted since its row was read.
   */
  async function metasOf(contentIds: string[]): Promise<Map<string, ContentMeta>> {
    const metas = await pendingMetas(db, contentIds);
    await mapLimit(
      contentIds.filter((id) => !metas.has(id)),
      STORE_READS,
      async (id) => {
        const meta = await content.getMeta(id);
        if (meta) metas.set(id, meta);
      },
    );
    return metas;
  }

  return [
    {
      name: 'account',
      keys: ['string'],
      async read(userId, after, limit) {
        const rows = await walk(
          db
            .selectFrom('users')
            .select(['id', 'username', 'created_at', 'updated_at', 'admin', 'moderator', 'language', 'messages', 'show_following', 'show_followers', 'banned_at', 'claims_barred_at'])
            .select(['bio', 'links', 'avatar_id'])
            .where('id', '=', userId)
            .where('deleted_at', 'is', null),
          ['id'],
          after,
          limit,
        );
        // A handful at most (MAX_PINNED_POSTS), so they are part of the account's one record.
        const pinned = rows.length
          ? await db.selectFrom('pinned_posts').select('content_id').where('user_id', '=', userId).orderBy('created_at', 'desc').orderBy('content_id', 'desc').execute()
          : [];
        return rows.map((r) => ({
          at: [r.id],
          record: {
            type: 'account',
            userId: r.id,
            username: r.username,
            createdAt: iso(r.created_at),
            // When they registered; or, on an account renamed while a user could change their name, when it last was.
            usernameSetAt: iso(r.updated_at),
            // Their profile, whether or not they are banned and nobody else is shown it: their bio as they wrote it, their links, and where their avatar is read, which is a file, and so not in the export.
            ...profileOf(r, config.publicBaseUrl),
            // The posts they pinned to it, the one pinned last first, whether or not anyone else can read them now.
            pinnedContentIds: pinned.map((pin) => pin.content_id),
            // The language the server answers them in. Null: the server's default.
            language: r.language,
            admin: r.admin === 1,
            moderator: r.moderator === 1,
            messages: r.messages === 1,
            showFollowing: r.show_following === 1,
            showFollowers: r.show_followers === 1,
            // Not who banned them, nor why: only moderators read those.
            bannedAt: r.banned_at === null ? null : iso(r.banned_at),
            // Since when they are barred from claiming hashtags, if they are: again, not by whom, nor why.
            claimsBarredAt: r.claims_barred_at === null ? null : iso(r.claims_barred_at),
          },
        }));
      },
    },
    {
      name: 'keys',
      keys: ['number', 'string'],
      async read(userId, after, limit) {
        const rows = await walk(db.selectFrom('api_keys').select(['id', 'created_at', 'revoked_at']).where('user_id', '=', userId), ['created_at', 'id'], after, limit);
        return rows.map((r) => ({
          at: [r.created_at, r.id],
          record: { type: 'apiKey', keyId: r.id, createdAt: iso(r.created_at), revokedAt: r.revoked_at === null ? null : iso(r.revoked_at) },
        }));
      },
    },
    {
      name: 'posts',
      keys: ['number', 'string'],
      chunk: POSTS_PER_READ,
      // By content_user_created_idx, (user_id, created_at, id). Content set for deletion is gone, as it is to whoever asks for it.
      async read(userId, after, limit) {
        const rows = await walk(
          db
            .selectFrom('content')
            .leftJoin('moderation_queue', 'moderation_queue.content_id', 'content.id')
            .select(['content.id', 'content.ai_generated', 'content.like_count', 'content.view_count', 'content.dislike_count', 'content.created_at', 'content.origin_gone_at', 'moderation_queue.content_id as queued_id'])
            .where('content.user_id', '=', userId)
            .where('content.delete_requested_at', 'is', null),
          ['content.created_at', 'content.id'],
          after,
          limit,
        );
        const metas = await metasOf(rows.map((r) => r.id));
        return rows.map((r) => {
          const meta = metas.get(r.id);
          return {
            at: [r.created_at, r.id],
            record: {
              type: 'post',
              contentId: r.id,
              // Theirs to read while it is kept from everyone else (see `withheld`).
              ...(r.queued_id !== null && PENDING_REVIEW),
              ...(r.origin_gone_at !== null && ORIGIN_GONE),
              // What the meta file says of the post. Without one, what the row says is all there is.
              ...(meta && {
                preview: previewOf(meta, config.publicBaseUrl),
                ...(meta.text !== undefined && { text: meta.text }),
                ...(meta.mentions?.length && { mentions: meta.mentions }),
                tags: meta.tags,
                mimeType: meta.mimeType,
                comments: takesComments(meta),
                ...(!meta.origin && { size: meta.size }),
                ...(imagesOf(meta) && { images: imagesOf(meta) }),
              }),
              ...rowCounts(r, config.dislikes),
              aiGenerated: r.ai_generated === 1,
              contentUrl: `/content/${r.id}/raw`,
              createdAt: iso(r.created_at),
              ...(meta && { updatedAt: iso(meta.updatedAt), ...(meta.origin && { origin: meta.origin }) }),
            },
          };
        });
      },
    },
    {
      name: 'comments',
      keys: ['string'],
      chunk: COMMENTS_PER_READ,
      // By the user's index of the comments they wrote, in the order of the comments' ids, which is the order they were sent in.
      async read(userId, after, limit) {
        const marks = await comments.authored(userId, commentAfter(after), limit);
        // Each as its author reads it (see effectiveComment): a write that waits first, in one query for all of them, then the store.
        const pending = await pendingComments(db, marks);
        const records: (ExportRecord | null)[] = marks.map(() => null);
        await mapLimit([...marks.keys()], STORE_READS, async (i) => {
          const { postId, commentId } = marks[i]!;
          const waiting = pending.get(commentId);
          const found = waiting ? waiting.put : await comments.stored(postId, commentId);
          // A mark can name a comment that isn't there (see CommentStore): one that is being removed, or was as it was written.
          if (!found || found.comment.userId !== userId) return;
          const { parentId, text, mentions, aiGenerated, media, createdAt, editedAt } = toCommentRecord(found.comment, { userId, username: '' }, config.publicBaseUrl);
          // Not how many like it or reply to it, which is what others did.
          records[i] = { type: 'comment', commentId, contentId: postId, parentId, ...(found.held && PENDING_REVIEW), text, ...(mentions && { mentions }), aiGenerated, media, createdAt, editedAt };
        });
        return marks.map(({ commentId }, i) => ({ at: [commentId], record: records[i]! }));
      },
    },
    {
      name: 'likes',
      keys: ['string'],
      // By the primary key, (user_id, content_id).
      async read(userId, after, limit) {
        const rows = await walk(db.selectFrom('likes').select(['content_id', 'created_at']).where('user_id', '=', userId), ['content_id'], after, limit);
        return rows.map((r) => ({ at: [r.content_id], record: { type: 'like', contentId: r.content_id, likedAt: iso(r.created_at) } }));
      },
    },
    {
      name: 'dislikes',
      keys: ['string'],
      // By the primary key, (user_id, content_id). Theirs whether the server has dislikes on now or not: the rows are kept either way.
      async read(userId, after, limit) {
        const rows = await walk(db.selectFrom('dislikes').select(['content_id', 'created_at']).where('user_id', '=', userId), ['content_id'], after, limit);
        return rows.map((r) => ({ at: [r.content_id], record: { type: 'dislike', contentId: r.content_id, dislikedAt: iso(r.created_at) } }));
      },
    },
    {
      name: 'commentLikes',
      keys: ['string'],
      chunk: COMMENT_LIKES_PER_READ,
      // By the user's index of the comments they liked, in the order of the comments' ids. When a comment was liked isn't kept.
      async read(userId, after, limit) {
        const marks = await comments.likedBy(userId, commentAfter(after), limit);
        const there: boolean[] = marks.map(() => false);
        // A mark can name a like that isn't there, as one can a comment.
        await mapLimit([...marks.keys()], STORE_READS, async (i) => {
          there[i] = await comments.liked(marks[i]!.postId, marks[i]!.commentId, userId);
        });
        return marks.map(({ postId, commentId }, i) => ({ at: [commentId], record: there[i] ? { type: 'commentLike', contentId: postId, commentId } : null }));
      },
    },
    {
      name: 'reposts',
      keys: ['string'],
      // By reposts_user_content_idx, (user_id, content_id). A repost is its rows of `reposts`, which share its user, its content and its time: one for each hashtag it gave, and one for the reposter's own index.
      async read(userId, after, limit) {
        const made = await walk(
          db
            .selectFrom('reposts')
            .select((eb) => ['content_id', eb.fn.min('created_at').as('created_at')])
            .where('user_id', '=', userId)
            .groupBy('content_id'),
          ['content_id'],
          after,
          limit,
        );
        if (!made.length) return [];
        const places = await db
          .selectFrom('reposts')
          .select(['content_id', 'tag'])
          .where('user_id', '=', userId)
          .where('content_id', 'in', made.map((r) => r.content_id))
          .orderBy('tag')
          .execute();
        return made.map((r) => ({
          at: [r.content_id],
          record: {
            type: 'repost',
            contentId: r.content_id,
            tags: places.filter((place) => place.content_id === r.content_id && indexAuthor(place.tag) === null).map((place) => place.tag),
            repostedAt: iso(Number(r.created_at)),
          },
        }));
      },
    },
    {
      name: 'following',
      keys: ['string'],
      // By the primary key, (follower_id, followee_id).
      async read(userId, after, limit) {
        const rows = await walk(
          db.selectFrom('follows').innerJoin('users', 'users.id', 'follows.followee_id').select(['users.id', 'users.username', 'follows.created_at']).where('follows.follower_id', '=', userId),
          ['follows.followee_id'],
          after,
          limit,
        );
        return rows.map((r) => ({ at: [r.id], record: { type: 'following', userId: r.id, username: r.username, followedAt: iso(r.created_at) } }));
      },
    },
    {
      name: 'followers',
      keys: ['number', 'string'],
      // By follows_followee_idx, (followee_id, created_at).
      async read(userId, after, limit) {
        const rows = await walk(
          db.selectFrom('follows').innerJoin('users', 'users.id', 'follows.follower_id').select(['users.id', 'users.username', 'follows.created_at']).where('follows.followee_id', '=', userId),
          ['follows.created_at', 'follows.follower_id'],
          after,
          limit,
        );
        return rows.map((r) => ({ at: [r.created_at, r.id], record: { type: 'follower', userId: r.id, username: r.username, followedAt: iso(r.created_at) } }));
      },
    },
    {
      name: 'blocks',
      keys: ['number', 'string'],
      // By user_blocks_user_idx, (user_id, created_at).
      async read(userId, after, limit) {
        const rows = await walk(
          db
            .selectFrom('user_blocks')
            .innerJoin('users', 'users.id', 'user_blocks.blocked_id')
            .select(['users.id', 'users.username', 'user_blocks.created_at'])
            .where('user_blocks.user_id', '=', userId),
          ['user_blocks.created_at', 'user_blocks.blocked_id'],
          after,
          limit,
        );
        return rows.map((r) => ({ at: [r.created_at, r.id], record: { type: 'block', userId: r.id, username: r.username, blockedAt: iso(r.created_at) } }));
      },
    },
    {
      name: 'mutes',
      keys: ['string'],
      // By the primary key, (user_id, tag).
      async read(userId, after, limit) {
        const rows = await walk(db.selectFrom('tag_mutes').select(['tag', 'created_at']).where('user_id', '=', userId), ['tag'], after, limit);
        return rows.map((r) => ({ at: [r.tag], record: { type: 'mute', tag: r.tag, mutedAt: iso(r.created_at) } }));
      },
    },
    {
      name: 'moderates',
      keys: ['string'],
      async read(userId, after, limit) {
        const rows = await walk(db.selectFrom('tag_moderators').select(['tag', 'created_at']).where('user_id', '=', userId), ['tag'], after, limit);
        return rows.map((r) => ({ at: [r.tag], record: { type: 'moderatedTag', tag: r.tag, since: iso(r.created_at) } }));
      },
    },
    {
      name: 'reports',
      keys: ['string'],
      // What the user said, and not what the moderators decided, which the server tells nobody who reports.
      async read(userId, after, limit) {
        const rows = await walk(db.selectFrom('reports').select(['content_id', 'reason', 'created_at']).where('user_id', '=', userId), ['content_id'], after, limit);
        return rows.map((r) => ({ at: [r.content_id], record: { type: 'report', contentId: r.content_id, reason: r.reason, reportedAt: iso(r.created_at) } }));
      },
    },
    {
      name: 'commentReports',
      keys: ['string'],
      async read(userId, after, limit) {
        const rows = await walk(
          db.selectFrom('comment_reports').select(['comment_id', 'content_id', 'reason', 'created_at']).where('user_id', '=', userId),
          ['comment_id'],
          after,
          limit,
        );
        return rows.map((r) => ({
          at: [r.comment_id],
          record: { type: 'report', contentId: r.content_id, commentId: r.comment_id, reason: r.reason, reportedAt: iso(r.created_at) },
        }));
      },
    },
    {
      name: 'inbox',
      keys: ['number', 'string'],
      // By inbox_user_idx, (user_id, created_at). Each as the inbox's own list gives it, oldest first.
      async read(userId, after, limit, say) {
        const rows = await walk(
          db
            .selectFrom('inbox')
            .leftJoin('users', 'users.id', 'inbox.sender_id')
            .select(['inbox.id', 'inbox.kind', 'inbox.sender_id', 'users.username', 'inbox.content_id', 'inbox.comment_id', 'inbox.tag', 'inbox.body', 'inbox.created_at', 'inbox.read_at'])
            .where('inbox.user_id', '=', userId),
          ['inbox.created_at', 'inbox.id'],
          after,
          limit,
        );
        return rows.map((r) => ({ at: [r.created_at, r.id], record: { type: 'inbox', ...inboxItem(r, say) } }));
      },
    },
    {
      name: 'sent',
      keys: ['number', 'string'],
      // By inbox_sender_created_idx, (sender_id, created_at, id). The user's messages are rows of their recipients' inboxes: one that a recipient deleted, or that was there longer than an inbox keeps it, is gone.
      async read(userId, after, limit) {
        const rows = await walk(
          db
            .selectFrom('inbox')
            // Not a recipient whose account is closed: they are nobody, to whoever looks them up.
            .leftJoin('users', (join) => join.onRef('users.id', '=', 'inbox.user_id').on('users.deleted_at', 'is', null))
            .select(['inbox.id', 'users.id as recipient_id', 'users.username', 'inbox.body', 'inbox.created_at'])
            .where('inbox.sender_id', '=', userId)
            .where('inbox.kind', '=', MESSAGE),
          ['inbox.created_at', 'inbox.id'],
          after,
          limit,
        );
        return rows.map((r) => ({
          at: [r.created_at, r.id],
          record: {
            type: 'sentMessage',
            messageId: r.id,
            to: r.recipient_id !== null && r.username !== null ? { userId: r.recipient_id, username: r.username } : null,
            text: r.body ?? '',
            sentAt: iso(r.created_at),
          },
        }));
      },
    },
  ];
}

/**
 * What reads a user's export, a page at a time: the page a cursor names, or the first, of the
 * records of `userId`, with notices in the language `say` speaks.
 *
 * A page holds up to `limit` records, and ends sooner once they come to PAGE_BYTES: at least one,
 * so the walk always moves on. It goes on into the next section where one ends. Its cursor names
 * the section it stopped in and the last record it gave, and is null after the last section. The
 * page before the end can be full with nothing after it, so the last page may be empty.
 *
 * 400 for a cursor that isn't one of these. 503 while the index of users' comments lacks the
 * comments that are older than it (see the top of this file): for every page, and not only
 * those of comments, so no client takes what it has read by then for the whole.
 */
export function exporter(deps: ExportDeps): (userId: string, query: ExportPageQuery, say: Say) => Promise<ExportPage> {
  const sections = sectionsOf(deps);

  /** Where a cursor says a page starts: in which section, and after which record of it (null: at its first). */
  function decode(cursor: string): { index: number; after: ExportPosition | null } {
    const raw = decodeCursorJson(cursor);
    if (!Array.isArray(raw)) throw invalidCursor();
    const [name, ...position] = raw as unknown[];
    const index = sections.findIndex((section) => section.name === name);
    if (index < 0) throw invalidCursor();
    if (!position.length) return { index, after: null };
    const { keys } = sections[index]!;
    // What the section's queries are given to compare its columns with: a time for a time, an id for an id.
    const fits = (value: unknown, i: number) => (keys[i] === 'number' ? Number.isSafeInteger(value) : typeof value === 'string' && value.length <= MAX_KEY_CHARS);
    if (position.length !== keys.length || !position.every(fits)) throw invalidCursor();
    return { index, after: position as ExportPosition };
  }

  return async (userId, { limit, cursor }, say) => {
    if (!(await deps.comments.indexed())) throw busy(msg('export.comments_indexing'), INDEXING_RETRY_SECONDS);
    let { index, after } = cursor === undefined ? { index: 0, after: null } : decode(cursor);
    const records: ExportPage['records'] = [];
    let bytes = 0;
    for (; index < sections.length; index++, after = null) {
      const section = sections[index]!;
      for (let ended = false; !ended; ) {
        const want = Math.min(limit - records.length, section.chunk ?? limit);
        const read = await section.read(userId, after, want, say);
        ended = read.length < want;
        for (const [i, { record, at }] of read.entries()) {
          after = at;
          // A place that holds nothing: past it.
          if (!record) continue;
          records.push(record);
          bytes += Buffer.byteLength(JSON.stringify(record));
          if (records.length < limit && bytes < PAGE_BYTES) continue;
          // Full. Where the section is known to end with this record, the next page starts at the section after it.
          if (!ended || i < read.length - 1) return { records, nextCursor: encodeCursorJson([section.name, ...at]) };
          const next = sections[index + 1];
          return { records, nextCursor: next ? encodeCursorJson([next.name]) : null };
        }
      }
    }
    return { records, nextCursor: null };
  };
}
