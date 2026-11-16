import type { Operator } from 'opendal';
import { mapLimit } from '../util.js';
import type { HotStore, LexRange } from './hotStore.js';
import { createOperator, isNotFound } from './opendal.js';

/** A comment on a post, as it is stored: written once, and never changed. */
export interface Comment {
  /** A UUIDv7 (see newCommentId): the order of a post's comment ids is the order they were sent in. */
  commentId: string;
  /** The post it is on. */
  contentId: string;
  /** Who wrote it. */
  userId: string;
  text: string;
  /** When it was sent. UTC epoch milliseconds. */
  createdAt: number;
}

/** Which of a post's comments a page holds: so many, from the first or from the last, after the one the page before ended on. */
export interface CommentPageQuery {
  order: 'oldest' | 'newest';
  limit: number;
  /** The id of the last comment of the page before. */
  cursor?: string;
}

const COLD_READS = 32;

const commentDir = (postId: string) => `comments/${postId}/`;
export const commentObjectKey = (postId: string, commentId: string) => `${commentDir(postId)}${commentId}.json`;
/** Where a comment is while it waits in the moderation queue: apart, so no list of the post's comments finds it. */
export const heldCommentObjectKey = (postId: string, commentId: string) => `${commentDir(postId)}held/${commentId}.json`;
/** The ids of a post's published comments, in order, and COMPLETE once it holds them all. */
export const commentIndexKey = (postId: string) => `cmts:${postId}`;
/** A comment's JSON, or nothing at all for one that was deleted (see remove). */
export const commentKey = (commentId: string) => `cmt:${commentId}`;

/** In a post's index once it holds every comment the store has. It sorts after every id, which are hex digits and dashes. */
const COMPLETE = '~';

const FILE = /^([0-9a-f-]{36})\.json$/;

/** `range` of ids that are in order, as HotStore.lexRange gives it of a set. */
function rangeOf(sorted: string[], { after, before, limit, reverse }: LexRange & { limit: number; reverse?: boolean }): string[] {
  const within = sorted.filter((id) => (after === undefined || id > after) && (before === undefined || id < before));
  return (reverse ? within.reverse() : within).slice(0, limit);
}

function parse(blob: Buffer): Comment | null {
  try {
    return JSON.parse(blob.toString('utf8')) as Comment;
  } catch {
    return null;
  }
}

/**
 * The comments on posts. Each is one object in the content store, `comments/<postId>/<commentId>.json`,
 * written once: the store is the only record of a published comment, and the database holds none.
 *
 * Redis is a cache over it, and nothing more. `cmts:<postId>` is the post's index: its comments'
 * ids, which are UUIDv7 and so in the order they were sent, as an ordered set a page is a range of.
 * `cmt:<commentId>` is a comment's JSON. Both expire `hotMs` after they were written, and either
 * can be evicted at any time:
 *
 * - An index that is gone, or was begun by a comment and never held the rest, is built again from
 *   one list of the post's objects. It says so itself: it is complete once it has the COMPLETE
 *   member. Building it only adds members, so a comment sent meanwhile is never lost from it.
 * - An index is never kept past `hotMs`, however often it is read or added to, so one that came to
 *   differ from the store (a Redis that lost writes in a failover) is put right by then.
 * - A comment Redis doesn't have is read from the store, and kept.
 *
 * A comment that waits in the moderation queue is under `held/` instead, in no index and no cache,
 * until it is published (moved to where the others are) or removed.
 */
export class CommentStore {
  private readonly op: Operator;
  /** The lists of posts' comments under way in this process, so readers of a post whose index is gone share one. */
  private readonly listing = new Map<string, Promise<string[]>>();

  constructor(
    private readonly hot: HotStore,
    cfg: { scheme: string; options: Record<string, string> },
    private readonly opts: { hotMs: number },
  ) {
    this.op = createOperator(cfg.scheme, cfg.options);
  }

  private async readObject(key: string): Promise<Buffer | null> {
    try {
      return await this.op.read(key);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  private async write(key: string, comment: Comment): Promise<void> {
    await this.op.write(key, JSON.stringify(comment), { contentType: 'application/json' });
  }

  /** Puts a stored comment in Redis: its JSON, then its id in its post's index. */
  private async index(comment: Comment): Promise<void> {
    await this.hot.set(commentKey(comment.commentId), JSON.stringify(comment), this.opts.hotMs);
    await this.hot.lexAdd(commentIndexKey(comment.contentId), [comment.commentId], this.opts.hotMs);
  }

  /**
   * Stores a new comment, published, or with `held`, to wait in the moderation queue. A published
   * one that can't be put in its post's index is taken back, and the error thrown: a complete
   * index that lacked it would hide it until the index was next built.
   */
  async put(comment: Comment, { held = false }: { held?: boolean } = {}): Promise<void> {
    const { contentId: postId, commentId } = comment;
    if (held) return this.write(heldCommentObjectKey(postId, commentId), comment);
    await this.write(commentObjectKey(postId, commentId), comment);
    try {
      await this.index(comment);
    } catch (err) {
      await this.op.delete(commentObjectKey(postId, commentId)).catch(() => {});
      await this.hot.del([commentKey(commentId)]).catch(() => {});
      throw err;
    }
  }

  /**
   * Publishes a held comment: it goes where the post's published comments are, and into the index.
   * Returns it, or null if the store holds no such comment. One that stops half way has published
   * the comment or not, and has lost nothing: calling it again completes it.
   */
  async publish(postId: string, commentId: string): Promise<Comment | null> {
    const held = heldCommentObjectKey(postId, commentId);
    // Not held any more: a call that stopped after it had written the published one.
    const blob = (await this.readObject(held)) ?? (await this.readObject(commentObjectKey(postId, commentId)));
    const comment = blob && parse(blob);
    if (!comment) return null;
    await this.write(commentObjectKey(postId, commentId), comment);
    await this.index(comment);
    await this.op.delete(held);
    return comment;
  }

  /** A comment that waits in the moderation queue; null if the post has none by that id. */
  async getHeld(postId: string, commentId: string): Promise<Comment | null> {
    const blob = await this.readObject(heldCommentObjectKey(postId, commentId));
    return blob && parse(blob);
  }

  /** A published comment of the post; null if it has none by that id. */
  async get(postId: string, commentId: string): Promise<Comment | null> {
    return (await this.load(postId, [commentId]))[0] ?? null;
  }

  /**
   * The post's published comments by id, in the order given: from Redis, and from the store those
   * it doesn't have, which are then kept there. Null for one that is gone, whose id is taken out of
   * the index, where a list made as it was being deleted may have left it.
   */
  private async load(postId: string, ids: string[]): Promise<(Comment | null)[]> {
    if (!ids.length) return [];
    const cached = await this.hot.mget(ids.map(commentKey));
    const out: (Comment | null)[] = ids.map(() => null);
    const gone: string[] = [];
    await mapLimit(
      ids.map((_, i) => i),
      COLD_READS,
      async (i) => {
        const id = ids[i]!;
        let blob = cached[i] ?? null;
        if (!blob) {
          blob = await this.readObject(commentObjectKey(postId, id));
          // Only where Redis has nothing, so a comment read just before it was deleted never replaces what its deletion left there.
          if (blob) await this.hot.setIfAbsent(commentKey(id), blob, this.opts.hotMs).catch(() => {});
        }
        // Deleted: nothing in the store, or what `remove` left in Redis.
        if (!blob || blob.length === 0) {
          gone.push(id);
          return;
        }
        const comment = parse(blob);
        // Redis keeps a comment by its id alone: one of another post isn't this post's.
        if (comment?.contentId === postId) out[i] = comment;
      },
    );
    if (gone.length) await this.hot.lexRem(commentIndexKey(postId), gone).catch(() => {});
    return out;
  }

  /** The ids of every published comment the store holds of the post, in order: one list of its objects. */
  private async list(postId: string): Promise<string[]> {
    const dir = commentDir(postId);
    let paths: string[];
    try {
      paths = (await this.op.list(dir)).map((entry) => entry.path());
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
    return paths
      .map((path) => (path.startsWith(dir) ? FILE.exec(path.slice(dir.length))?.[1] : undefined))
      .filter((id): id is string => id !== undefined)
      .sort();
  }

  /**
   * Builds the post's index from the store, and returns the ids it listed, in order. The ids are
   * added first and COMPLETE last, so an index is never called complete before it is. Should Redis
   * drop the index while it is being filled, it is left out rather than called complete with part
   * of the ids: the next reader builds it again.
   */
  private rebuild(postId: string): Promise<string[]> {
    const under = this.listing.get(postId);
    if (under) return under;
    const key = commentIndexKey(postId);
    const run = (async () => {
      const ids = await this.list(postId);
      await this.hot.lexAdd(key, ids, this.opts.hotMs);
      await this.hot.lexAdd(key, [COMPLETE], this.opts.hotMs);
      if ((await this.hot.lexCount(key, { before: COMPLETE })) < ids.length) await this.hot.del([key]);
      return ids;
    })().finally(() => this.listing.delete(postId));
    this.listing.set(postId, run);
    return run;
  }

  /**
   * A page of the post's published comments, oldest or newest first, and the cursor of the page
   * after it (the id of its last comment), or null if there is none. Read from the index, or for a
   * post whose index has to be built first, from the list that builds it.
   */
  async page(postId: string, { order, limit, cursor }: CommentPageQuery): Promise<{ comments: Comment[]; nextCursor: string | null }> {
    const key = commentIndexKey(postId);
    const range =
      order === 'newest' ? { before: cursor ?? COMPLETE, limit: limit + 1, reverse: true } : { after: cursor, before: COMPLETE, limit: limit + 1 };
    const [complete, indexed] = await Promise.all([this.hot.lexHas(key, COMPLETE), this.hot.lexRange(key, range)]);
    const ids = complete ? indexed : rangeOf(await this.rebuild(postId), range);
    const shown = ids.slice(0, limit);
    const comments = (await this.load(postId, shown)).filter((comment): comment is Comment => comment !== null);
    return { comments, nextCursor: ids.length > limit ? shown.at(-1)! : null };
  }

  /** How many published comments the post has. */
  async count(postId: string): Promise<number> {
    const key = commentIndexKey(postId);
    const [complete, count] = await Promise.all([this.hot.lexHas(key, COMPLETE), this.hot.lexCount(key, { before: COMPLETE })]);
    return complete ? count : (await this.rebuild(postId)).length;
  }

  /**
   * Removes a comment, published or held, for good. Redis is first left an empty value in place of
   * the comment's JSON, which says it is gone to whoever still finds its id in the index, and which
   * a reader that had just read the comment from the store doesn't write over.
   */
  async remove(postId: string, commentId: string): Promise<void> {
    await this.hot.set(commentKey(commentId), '', this.opts.hotMs);
    await Promise.all([this.op.delete(commentObjectKey(postId, commentId)), this.op.delete(heldCommentObjectKey(postId, commentId))]);
    await this.hot.lexRem(commentIndexKey(postId), [commentId]);
  }

  /** Removes every comment of a post, published and held, and its index: the post is being deleted. What Redis has of each expires. */
  async removeAll(postId: string): Promise<void> {
    await this.op.removeAll(commentDir(postId)).catch((err) => {
      if (!isNotFound(err)) throw err;
    });
    await this.hot.del([commentIndexKey(postId)]);
  }
}
