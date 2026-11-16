import { sql } from 'kysely';
import { toCommentRecords } from '../comments.js';
import type { CommentRecord } from '../comments.types.js';
import { publisherOf, summaryOf } from '../content.js';
import type { AppDeps } from '../deps.types.js';
import { toFeedRecord } from '../tagfeed/layout.js';
import type { FeedRecord } from '../tagfeed/layout.types.js';
import type { QueueKind, QueueRow } from './queues.types.js';

/**
 * The kind of a branch of a queue's union, as a column. Written into the SQL, not sent as a
 * parameter: a parameter has no type for PostgreSQL to give the column.
 */
export const kindColumn = (kind: QueueKind) => (kind === 'post' ? sql<QueueKind>`'post'` : sql<QueueKind>`'comment'`).as('kind');

/** A post in a queue: its feed record, with its whole text or caption. */
type QueuedPost = { kind: 'post' } & FeedRecord & { text?: string };
/** A comment in a queue: as GET /content/:contentId/comments gives it. */
type QueuedComment = { kind: 'comment' } & CommentRecord;

/**
 * What each row of a page of a queue is, in the rows' order: a post as a feed record with its
 * whole text or caption, read from its meta file as for GET /content/:contentId, and a comment as
 * the comment store has it. Null for one that is gone though its row is still there.
 *
 * `held`: the comments wait in the moderation queue, so they are read from where held comments
 * are; one that isn't there any more (an accept that published it and then failed to take its row
 * out) is read from where published ones are, so it can be accepted again.
 */
export async function queueItems(
  deps: Pick<AppDeps, 'db' | 'config' | 'content' | 'comments' | 'publishers'>,
  rows: QueueRow[],
  { held }: { held: boolean },
): Promise<(QueuedPost | QueuedComment | null)[]> {
  const { db, config, content, comments } = deps;
  const postIds = rows.filter((r) => r.kind === 'post').map((r) => r.id);
  const [posts, found] = await Promise.all([
    postIds.length
      ? db
          .selectFrom('content')
          .innerJoin('users', 'users.id', 'content.user_id')
          .select(['content.id', 'content.user_id', 'users.username', 'content.ai_generated', 'content.like_count', 'content.created_at'])
          .where('content.id', 'in', postIds)
          .execute()
      : [],
    Promise.all(
      rows.map(async (r) => {
        if (r.kind === 'post') return { meta: await content.getMeta(r.id), comment: null };
        return { meta: null, comment: (held ? await comments.getHeld(r.content_id, r.id) : null) ?? (await comments.get(r.content_id, r.id)) };
      }),
    ),
  ]);
  const postsById = new Map(posts.map((p) => [p.id, p]));
  const records = new Map((await toCommentRecords(deps, found.flatMap(({ comment }) => (comment ? [comment] : [])))).map((record) => [record.commentId, record]));
  return rows.map((r, i) => {
    if (r.kind === 'comment') {
      const record = records.get(r.id);
      return record ? { kind: 'comment' as const, ...record } : null;
    }
    const post = postsById.get(r.id);
    const meta = found[i]!.meta;
    if (!post || !meta) return null;
    return {
      kind: 'post' as const,
      ...toFeedRecord(summaryOf(post, meta, config.publicBaseUrl), post.like_count, publisherOf(post)),
      ...(meta.text !== undefined && { text: meta.text }),
    };
  });
}
