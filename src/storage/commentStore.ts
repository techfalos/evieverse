import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Operator } from 'opendal';
import { mapLimit } from '../util.js';
import type { Comment, CommentMark, CommentPageQuery } from './commentStore.types.js';
import type { HotStore, LexRange } from './hotStore.types.js';
import { createOperator, isNotFound, readObject } from './opendal.js';

/**
 * How many reads of the store one call has under way at once, for what Redis doesn't have: the
 * comments it reads from their objects, and the lists of likes it counts.
 */
const COLD_READS = 32;
/** What an object holds whose name says it all: one byte, since not every backend takes an empty object. */
const MARK = '1';

/** In a post's index once it holds every comment the store has. It sorts after every member, which begin with a hex digit, a dash or a colon. */
const COMPLETE = '~';

/** What `cmtlm:<commentId>` begins with while the comment's likes are being made (see CommentStore.makingLikes). */
const MAKING = 'making:';
/** How many times the likes of a comment are counted with the ones that wait, before a count that was made as they moved is given as it is. */
const LIKE_COUNTS = 3;
/** How long the first of those counts waits for the next, in milliseconds; the second waits twice as long. */
const LIKE_RECOUNT_MS = 25;

/**
 * What matches an id in an object's name, a comment's or a user's: 36 characters, each a lowercase
 * hex digit or a dash, as a UUID is written. The source of a part of the patterns below, which
 * say where in a name the id is.
 */
const ID = '[0-9a-f-]{36}';
/** Matches the name of a published comment's object among a post's, `<commentId>.json`, and captures the id. */
const COMMENT_FILE = new RegExp(`^(${ID})\\.json$`);
/** Matches the name of an object that says a comment is a reply, `<parentId>.<commentId>.reply`, and captures the two ids, in that order. */
const REPLY_FILE = new RegExp(`^(${ID})\\.(${ID})\\.reply$`);
/** Matches the name of a like among the objects under a comment's likes: the id of the user who liked it, and nothing more. */
const LIKE_FILE = new RegExp(`^${ID}$`);
/** Matches the name of a comment that waits in the moderation queue among all the objects under a post's comments, `held/<commentId>.json`, and captures the id. */
const HELD_PATH = new RegExp(`^held/(${ID})\\.json$`);
/** Matches the name of a like among all the objects under a post's comments, `likes/<commentId>/<userId>`, and captures the two ids, in that order. */
const LIKE_PATH = new RegExp(`^likes/(${ID})/(${ID})$`);
/** Matches the name of a post's prefix among the prefixes comments are under, `<postId>/`, and captures the id. */
const POST_DIR = new RegExp(`^(${ID})/$`);

/**
 * How many characters of a comment's id name the part of a user's index its mark is in (see
 * markKey). A comment's id starts with the time it was sent at, in milliseconds, as 12 hex
 * digits: the first 5 are the same for the ids of some three days (2^28 ms). So a part holds
 * what a user wrote, or liked of what was written, in three days, which is never much to list,
 * and a user who has been here for ten years has some 1,200 parts at most.
 */
const SPAN_CHARS = 5;
/** Matches the name of a part of a user's index among the prefixes it is made of, `<the first SPAN_CHARS of an id>/`, and captures the part. */
const SPAN_DIR = new RegExp(`^([0-9a-f-]{${SPAN_CHARS}})/$`);
/** Matches the name of a mark in a part of a user's index, `<commentId>.<postId>`, and captures the two ids, in that order. */
const MARK_FILE = new RegExp(`^(${ID})\\.(${ID})$`);
/** The prefix the comments of every post are under, a prefix for each post that has any. */
const COMMENTS_DIR = 'comments/';
/** In the store once every comment and like that was there before the index was kept has its mark (see CommentStore.indexAuthors). */
const INDEXED_KEY = 'authors/indexed';
/** While those marks are being written: the id of the last post whose comments have theirs, for a process that takes the work up again. */
const INDEXING_KEY = 'authors/indexing';
/** How many posts have their marks written between two writes of INDEXING_KEY. */
const INDEXING_STEP = 100;

/**
 * What stands in the place of a published comment that is gone from it: deleted, or taken back to
 * the moderation queue by an edit. It keeps the comment's place in the tree, so the comments that
 * reply to it stay where they are, and nothing of what the comment was: not its author, its text,
 * or its image or video.
 */
export const placeholder = ({ commentId, contentId, parentId, createdAt }: Pick<Comment, 'commentId' | 'contentId' | 'parentId' | 'createdAt'>, gone: NonNullable<Comment['gone']>): Comment => ({
  commentId,
  contentId,
  ...(parentId !== undefined && { parentId }),
  userId: '',
  text: '',
  createdAt,
  gone,
});

/** A comment that replies to another, as a list of a post's objects has it. */
interface Reply {
  commentId: string;
  /** The comment it replies to. */
  parentId: string;
}

/**
 * The prefix everything of a post's comments is under: the published comments and what says which
 * are replies, right under it, and below it the held ones, the likes, and the images and videos.
 */
const commentDir = (postId: string) => `${COMMENTS_DIR}${postId}/`;
/** A published comment's object, which holds its JSON, or that of the placeholder that stands in its place. */
const commentObjectKey = (postId: string, commentId: string) => `${commentDir(postId)}${commentId}.json`;
/**
 * What says a published comment is a reply, and to which comment: an object beside the two, whose
 * name is all there is to it. So one list of a post's objects gives its comments and which replies
 * to which, without reading any.
 */
const replyObjectKey = (postId: string, parentId: string, commentId: string) => `${commentDir(postId)}${parentId}.${commentId}.reply`;
/** Where a comment is while it waits in the moderation queue: apart, so no list of the post's comments finds it. */
const heldCommentObjectKey = (postId: string, commentId: string) => `${commentDir(postId)}held/${commentId}.json`;
/** The prefix a comment's likes are under, an object for each user who liked it: a list of it counts them, and removing it deletes them all. */
const likeDir = (postId: string, commentId: string) => `${commentDir(postId)}likes/${commentId}/`;
/** A user's like of a comment: an object whose name is all there is to it, so a like is made once however often it is sent. */
const likeObjectKey = (postId: string, commentId: string, userId: string) => `${likeDir(postId, commentId)}${userId}`;
/**
 * The bytes of the image or video a comment came with. In one place whether the comment is
 * published or waits in the moderation queue, so that neither accepting it nor holding an edit of
 * it moves a file. The content store writes and reads them (see ContentStore), as it does a post's.
 */
export const commentMediaKey = (postId: string, commentId: string) => `${commentDir(postId)}media/${commentId}`;

/** The prefix of a user's index of the comments they wrote, published or waiting in the moderation queue. */
const authoredDir = (userId: string) => `authors/${userId}/comments/`;
/** The prefix of a user's index of the comments they liked. */
const likedDir = (userId: string) => `authors/${userId}/likes/`;
/**
 * A mark in a user's index (`dir`: authoredDir, or likedDir), which says the user wrote the
 * comment, or liked it: an object whose name is all there is to it, the comment's id and its
 * post's, in the part of the index that the comment's id belongs to (see SPAN_CHARS). So the
 * marks of an index are in the order of the comments' ids, which is the order they were sent in.
 */
const markKey = (dir: string, postId: string, commentId: string) => `${dir}${commentId.slice(0, SPAN_CHARS)}/${commentId}.${postId}`;

/** A post's published comments, each with the comment it replies to, in order, and COMPLETE once it holds them all. */
export const commentIndexKey = (postId: string) => `cmtidx:${postId}`;
/** A comment's JSON, or its placeholder's; or nothing at all for one of which nothing is left (see remove). */
export const commentKey = (commentId: string) => `cmt:${commentId}`;
/** How many likes a comment has. */
export const commentLikesKey = (commentId: string) => `cmtl:${commentId}`;
/** Which making of a comment's likes was the last, and whether it is still under way (see CommentStore.makingLikes). */
export const commentLikesMadeKey = (commentId: string) => `cmtlm:${commentId}`;

/**
 * A comment in its post's index: the id of the comment it replies to (nothing, for a comment on
 * the post itself), a colon, and its own id. The index is in the order of its members, so the
 * replies to a comment are together in it, in the order they were sent, and so are the comments on
 * the post itself.
 */
const member = (parentId: string | undefined, commentId: string) => `${parentId ?? ''}:${commentId}`;
/** The id of the comment a member of a post's index is of: what follows its colon. */
const idOf = (m: string) => m.slice(m.indexOf(':') + 1);
/** The bounds of the members that reply to a comment, or without one, of those on the post itself: ';' is what follows ':'. */
const under = (parentId: string | undefined): Required<LexRange> => ({ after: `${parentId ?? ''}:`, before: `${parentId ?? ''};` });

/** Whether a member is within the bounds, as HotStore.lexRange reads them: after `after` and before `before`, and a bound left out is no bound. */
const within = (m: string, { after, before }: LexRange) => (after === undefined || m > after) && (before === undefined || m < before);

/** `range` of members that are in order, as HotStore.lexRange gives it of a set. */
function rangeOf(sorted: string[], { limit, reverse, ...range }: LexRange & { limit: number; reverse?: boolean }): string[] {
  const found = sorted.filter((m) => within(m, range));
  return (reverse ? found.reverse() : found).slice(0, limit);
}

function parse(blob: Buffer): Comment | null {
  try {
    return JSON.parse(blob.toString('utf8')) as Comment;
  } catch {
    return null;
  }
}

/**
 * The comments on posts. Each is one object in the content store, `comments/<postId>/<commentId>.json`:
 * the store is the only record of a published comment, and the database holds none but the
 * writes of it that are yet to be applied. The object is written again when its author edits the
 * comment.
 *
 * A comment replies to the post, or to another comment on it, which makes a post's comments a
 * tree. A reply has a second object, `comments/<postId>/<parentId>.<commentId>.reply`, which holds
 * nothing: its name says which comment the reply is to. So one list of the post's objects gives
 * the whole tree.
 *
 * A like of a comment is an object too, `comments/<postId>/likes/<commentId>/<userId>`, which
 * holds nothing either: a comment's likes are the objects under its prefix, and a like that is
 * taken back is an object deleted.
 *
 * A comment that came with an image or a video says so (`media`), and the file's bytes are one
 * more object, `comments/<postId>/media/<commentId>`. The content store writes it, before the
 * comment is stored here, and serves it; this store only deletes it, with the comment.
 *
 * All of that is under the comment's post, which is how comments are read: a post's at a time.
 * What finds them by who wrote them is an index of marks, beside the comments: for each comment
 * a user wrote, published or waiting in the moderation queue, an object
 * `authors/<userId>/comments/<part>/<commentId>.<postId>`, and for each comment they liked,
 * `authors/<userId>/likes/<part>/<commentId>.<postId>`. A mark holds nothing: its name says the
 * comment and its post. `<part>` is the start of the comment's id (see SPAN_CHARS), so an index
 * is read a part at a time, in the order of the ids, and a page of it lists the parts it reads
 * and no others (see authored, likedBy): that is what a user's export reads their comments by
 * (src/export.ts). A mark is written before what it is of, and deleted with it: with the
 * comment, with the post, and a like's with the like that is taken back, after it. So a mark can
 * name a comment or a like that isn't there, for as
 * long as a write of it is under way or after one that stopped half way, and whoever reads the
 * index reads what a mark names before it believes it; what is there always has its mark.
 *
 * Redis is a cache over all of it, and nothing more. `cmtidx:<postId>` is the post's index: a
 * member for each published comment, `<parentId>:<commentId>` (or `:<commentId>` for a comment on
 * the post itself), as a set kept in the order of its members. Ids are UUIDv7, in the order they
 * were sent, so the replies to one comment are a range of the set, in order, and a page is a part
 * of that range. `cmt:<commentId>` is a comment's JSON, and `cmtl:<commentId>` the number of its
 * likes. All expire `hotMs` after they were written, and any can be evicted at any time:
 *
 * - An index that is gone, or was begun by a comment and never held the rest, is built again from
 *   one list of the post's objects. It says so itself: it is complete once it has the COMPLETE
 *   member. Building it only adds members, so a comment sent meanwhile is never lost from it.
 * - An index is never kept past `hotMs`, however often it is read or added to, so one that came to
 *   differ from the store (a Redis that lost writes in a failover) is put right by then.
 * - A comment Redis doesn't have is read from the store, and kept.
 * - A number of likes Redis doesn't have is counted from one list of the comment's likes, and kept.
 *   A like adds one to a number that is there, and a like that is taken back takes one from it;
 *   either leaves a number that isn't there to be counted.
 *
 * `cmtlm:<commentId>` is not a cache: it says when a comment's likes are being made, for the
 * requests that count them with the likes that still wait (see makingLikes). One that is evicted
 * costs such a request its check, and nothing else.
 *
 * A comment that waits in the moderation queue is under `held/` instead, in no index and no cache,
 * until it is published (moved to where the others are) or removed.
 *
 * A comment goes alone: removing it, or taking it back to the queue, touches none of the comments
 * that reply to it. What keeps them where they are is a placeholder: an object in the comment's
 * place, and in the index and the cache as the comment was, that says the comment is gone
 * (`gone`) and nothing else of it. A comment an edit took back to the queue always leaves one,
 * until it is published again; a removed comment leaves one where its caller says so, which is
 * where something replies to it.
 *
 * Only the compactor writes any of it: `put`, `publish`, `hold`, `addLike`, `removeLike`, `remove`
 * and `removeAll` are its own, called as it applies the writes requests committed (`pending_writes`,
 * see applyPending): all the writes of one comment together, a reply after the comment it
 * replies to, and removals one after another. Different comments are written at once. So no two
 * writes of a comment's own objects are ever under way at once (its likes, which are an object
 * each, are), and none is ever made to a post that is being deleted. Requests read.
 */
export class CommentStore {
  private readonly op: Operator;
  /** The lists of posts' comments under way in this process, so readers of a post whose index is gone share one. */
  private readonly listing = new Map<string, Promise<string[]>>();
  /** Whether this process has found INDEXED_KEY in the store, which stays there once it is. */
  private indexedSeen = false;

  constructor(
    private readonly hot: HotStore,
    cfg: { scheme: string; options: Record<string, string> },
    private readonly opts: { hotMs: number },
  ) {
    this.op = createOperator(cfg.scheme, cfg.options);
  }

  private async write(key: string, comment: Comment): Promise<void> {
    await this.op.write(key, JSON.stringify(comment), { contentType: 'application/json' });
  }

  /** The names of the objects right under a prefix, or with `recursive`, of all the objects under it, from the prefix on; none, if nothing is. */
  private async names(dir: string, { recursive = false } = {}): Promise<string[]> {
    let paths: string[];
    try {
      paths = (await this.op.list(dir, { recursive })).map((entry) => entry.path());
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
    return paths.flatMap((path) => (path.startsWith(dir) ? [path.slice(dir.length)] : []));
  }

  /**
   * Writes a published comment's objects. A reply's second object goes first: a list of the post's
   * objects made between the two then finds no comment yet, and never a reply it takes for a
   * comment on the post itself.
   */
  private async store(comment: Comment): Promise<void> {
    const { contentId: postId, commentId, parentId } = comment;
    if (parentId) await this.op.write(replyObjectKey(postId, parentId, commentId), MARK);
    await this.write(commentObjectKey(postId, commentId), comment);
  }

  /**
   * Deletes a published comment's objects, its likes, and the image or video it came with, if it
   * came with one: the comment first, for the same reason `store` writes it last.
   */
  private async erase(postId: string, { commentId, parentId }: { commentId: string; parentId?: string }): Promise<void> {
    await this.op.delete(commentObjectKey(postId, commentId));
    if (parentId) await this.op.delete(replyObjectKey(postId, parentId, commentId));
    await this.strip(postId, commentId);
  }

  /** Deletes what a comment has beside its own objects: its likes, and the image or video it came with. */
  private async strip(postId: string, commentId: string): Promise<void> {
    await this.op.removeAll(likeDir(postId, commentId)).catch((err) => {
      if (!isNotFound(err)) throw err;
    });
    await this.discardMedia(postId, commentId);
  }

  /**
   * Deletes the bytes of the image or video a comment came with; nothing, for a comment that came
   * with none. For a comment that is being removed.
   */
  private async discardMedia(postId: string, commentId: string): Promise<void> {
    await this.op.delete(commentMediaKey(postId, commentId));
  }

  /**
   * Writes the mark that says who wrote a comment, in that user's index. Before the comment is
   * written, wherever it is written, so no comment is ever there without its mark; a placeholder,
   * which has no author, has none.
   */
  private async sign({ userId, contentId: postId, commentId }: Comment): Promise<void> {
    if (userId) await this.op.write(markKey(authoredDir(userId), postId, commentId), MARK);
  }

  /**
   * Deletes the marks of a comment that is being removed: its author's, and those of the users
   * who liked it, who are the names under its likes. `author` is who wrote it, if that is known.
   */
  private async unsign(postId: string, commentId: string, author: string | undefined): Promise<void> {
    if (author) await this.op.delete(markKey(authoredDir(author), postId, commentId));
    const likers = (await this.names(likeDir(postId, commentId))).filter((name) => LIKE_FILE.test(name));
    await mapLimit(likers, COLD_READS, (userId) => this.op.delete(markKey(likedDir(userId), postId, commentId)));
  }

  /**
   * The marks that everything under a post's comments has, or is to have: one for each comment,
   * published or held, in its author's index, and one for each like, in the index of the user
   * whose it is. One list of all the post's objects names the likes and the comments; who wrote
   * a comment is read from it, so this reads every comment of the post. A placeholder has none.
   */
  private async marksOf(postId: string): Promise<string[]> {
    const marks: string[] = [];
    const written: string[] = [];
    for (const name of await this.names(commentDir(postId), { recursive: true })) {
      const published = COMMENT_FILE.exec(name);
      const held = published ? null : HELD_PATH.exec(name);
      const like = published || held ? null : LIKE_PATH.exec(name);
      if (published) written.push(commentObjectKey(postId, published[1]!));
      else if (held) written.push(heldCommentObjectKey(postId, held[1]!));
      else if (like) marks.push(markKey(likedDir(like[2]!), postId, like[1]!));
    }
    await mapLimit(written, COLD_READS, async (key) => {
      const blob = await readObject(this.op, key);
      const comment = blob && parse(blob);
      if (comment?.userId) marks.push(markKey(authoredDir(comment.userId), postId, comment.commentId));
    });
    return marks;
  }

  /** Puts a stored comment in Redis: its JSON, then its place in its post's index. */
  private async index(comment: Comment): Promise<void> {
    await this.hot.set(commentKey(comment.commentId), JSON.stringify(comment), this.opts.hotMs);
    await this.hot.lexAdd(commentIndexKey(comment.contentId), [member(comment.parentId, comment.commentId)], this.opts.hotMs);
  }

  /**
   * Stores a new comment, published, or with `held`, to wait in the moderation queue. A published
   * one that can't be put in its post's index is taken back, and the error thrown: a complete
   * index that lacked it would hide it until the index was next built.
   */
  async put(comment: Comment, { held = false }: { held?: boolean } = {}): Promise<void> {
    const { contentId: postId, commentId } = comment;
    await this.sign(comment);
    if (held) return this.write(heldCommentObjectKey(postId, commentId), comment);
    await this.store(comment);
    try {
      await this.index(comment);
    } catch (err) {
      await this.erase(postId, comment).catch(() => {});
      await this.hot.del([commentKey(commentId)]).catch(() => {});
      throw err;
    }
    // It has no likes yet, which saves its first readers the list that would say so.
    await this.hot.setIfAbsent(commentLikesKey(commentId), Buffer.from('0'), this.opts.hotMs).catch(() => {});
  }

  /**
   * Publishes a comment that waits in the moderation queue, as it is given: it goes where the
   * post's published comments are, over the placeholder an edit left there, and into the index,
   * under the comment it replies to. One that stops half way has published the comment or not,
   * and has lost nothing: calling it again completes it. The replies a comment had when an edit of
   * it was held are still its replies.
   */
  async publish(comment: Comment): Promise<void> {
    // It has its mark already, unless it is older than the index and still waits for its own (see indexAuthors).
    await this.sign(comment);
    await this.store(comment);
    await this.index(comment);
    await this.op.delete(heldCommentObjectKey(comment.contentId, comment.commentId));
  }

  /**
   * Takes a published comment back to where comments wait in the moderation queue, as it is given:
   * an edit of it that the server holds. A placeholder is left in its place, in the store and in
   * Redis, so readers find what it was gone from then on, and its replies where they were. Its
   * likes and its image or video stay too: they are its own again once it is published, and go
   * with it if it is removed.
   *
   * Redis first, so that no reader finds the comment there once the store says it waits. If the
   * store then can't be written, Redis is left nothing of the comment, to be read from the store
   * again, where it still is.
   */
  async hold(comment: Comment): Promise<void> {
    const { contentId: postId, commentId } = comment;
    const left = placeholder(comment, 'held');
    await this.sign(comment);
    await this.write(heldCommentObjectKey(postId, commentId), comment);
    await this.hot.set(commentKey(commentId), JSON.stringify(left), this.opts.hotMs);
    await this.write(commentObjectKey(postId, commentId), left).catch((err) => this.forget(commentId, err));
  }

  /** Takes what Redis has of a comment out of it, after a write to the store that failed, and throws that failure: Redis says nothing the store doesn't. */
  private async forget(commentId: string, err: unknown): Promise<never> {
    await this.hot.del([commentKey(commentId)]).catch(() => {});
    throw err;
  }

  /** A comment that waits in the moderation queue; null if the post has none by that id. */
  async getHeld(postId: string, commentId: string): Promise<Comment | null> {
    const blob = await readObject(this.op, heldCommentObjectKey(postId, commentId));
    return blob && parse(blob);
  }

  /** A published comment of the post; null if it has none by that id, or only the placeholder of one. */
  async get(postId: string, commentId: string): Promise<Comment | null> {
    const found = await this.find(postId, commentId);
    return found?.gone ? null : found;
  }

  /**
   * A comment as the store has it, published or waiting in the moderation queue (`held`); null if
   * the post has none by that id, or only the placeholder of a deleted one. Read from the store,
   * and not kept in Redis: for a reader of many comments that nobody else may be reading, which
   * a user's export of their own is.
   */
  async stored(postId: string, commentId: string): Promise<{ comment: Comment; held: boolean } | null> {
    const blob = await readObject(this.op, commentObjectKey(postId, commentId));
    const published = blob && parse(blob);
    if (published && !published.gone) return { comment: published, held: false };
    if (published?.gone === 'deleted') return null;
    const held = await this.getHeld(postId, commentId);
    return held && { comment: held, held: true };
  }

  /** A published comment of the post, or the placeholder that stands in the place of one; null if it has neither by that id. */
  async find(postId: string, commentId: string): Promise<Comment | null> {
    return (await this.load(postId, [commentId]))[0] ?? null;
  }

  /**
   * The post's published comments by id, placeholders among them, in the order given: from Redis,
   * and from the store those it doesn't have, which are then kept there. Null for one that is gone.
   */
  private async load(postId: string, ids: string[]): Promise<(Comment | null)[]> {
    if (!ids.length) return [];
    const cached = await this.hot.mget(ids.map(commentKey));
    const out: (Comment | null)[] = ids.map(() => null);
    await mapLimit(
      ids.map((_, i) => i),
      COLD_READS,
      async (i) => {
        const id = ids[i]!;
        let blob = cached[i] ?? null;
        if (!blob) {
          blob = await readObject(this.op, commentObjectKey(postId, id));
          // Only where Redis has nothing, so a comment read just before it was deleted never replaces what its deletion left there.
          if (blob) await this.hot.setIfAbsent(commentKey(id), blob, this.opts.hotMs).catch(() => {});
        }
        // Gone: nothing in the store, or what `remove` left in Redis.
        if (!blob || blob.length === 0) return;
        const comment = parse(blob);
        // Redis keeps a comment by its id alone: one of another post isn't this post's.
        if (comment?.contentId === postId) out[i] = comment;
      },
    );
    return out;
  }

  /**
   * The members of the post's index as the store has them, in order: one list of its objects. A
   * comment is a reply if an object says so, and a comment on the post itself otherwise. What says
   * a comment is a reply, with no such comment, says nothing: the comment is being written, or was
   * removed by a removal that stopped there. A placeholder is listed as the comment it stands for.
   */
  private async list(postId: string): Promise<string[]> {
    const ids = new Set<string>();
    const replies: Reply[] = [];
    for (const name of await this.names(commentDir(postId))) {
      const comment = COMMENT_FILE.exec(name);
      const reply = comment ? null : REPLY_FILE.exec(name);
      if (comment) ids.add(comment[1]!);
      else if (reply) replies.push({ parentId: reply[1]!, commentId: reply[2]! });
    }
    const members: string[] = [];
    for (const { parentId, commentId } of replies) {
      // Taken out as it is listed, so what is left are the comments on the post itself.
      if (ids.delete(commentId)) members.push(member(parentId, commentId));
    }
    for (const id of ids) members.push(member(undefined, id));
    return members.sort();
  }

  /**
   * Builds the post's index from the store, and returns the members it listed, in order. The
   * members are added first and COMPLETE last, so an index is never called complete before it is.
   * Should Redis drop the index while it is being filled, it is left out rather than called
   * complete with part of the members: the next reader builds it again.
   */
  private rebuild(postId: string): Promise<string[]> {
    const running = this.listing.get(postId);
    if (running) return running;
    const key = commentIndexKey(postId);
    const run = (async () => {
      const members = await this.list(postId);
      await this.hot.lexAdd(key, members, this.opts.hotMs);
      await this.hot.lexAdd(key, [COMPLETE], this.opts.hotMs);
      if ((await this.hot.lexCount(key, { before: COMPLETE })) < members.length) await this.hot.del([key]);
      return members;
    })().finally(() => this.listing.delete(postId));
    this.listing.set(postId, run);
    return run;
  }

  /**
   * A page of the post's published comments, or of the replies to one of them, oldest or newest
   * first, and the cursor of the page after it (the id of its last comment), or null if there is
   * none. A placeholder is listed where its comment was. Read from the index, or for a post whose
   * index has to be built first, from the list that builds it. A member whose comment is gone is
   * taken out of the index, where a list made as the comment was being deleted may have left it.
   */
  async page(postId: string, { order, limit, cursor, parentId }: CommentPageQuery): Promise<{ comments: Comment[]; nextCursor: string | null }> {
    const key = commentIndexKey(postId);
    const { after, before } = under(parentId);
    const range =
      order === 'newest'
        ? { after, before: cursor === undefined ? before : member(parentId, cursor), limit: limit + 1, reverse: true }
        : { after: cursor === undefined ? after : member(parentId, cursor), before, limit: limit + 1 };
    const [complete, indexed] = await Promise.all([this.hot.lexHas(key, COMPLETE), this.hot.lexRange(key, range)]);
    const members = complete ? indexed : rangeOf(await this.rebuild(postId), range);
    const shown = members.slice(0, limit);
    const loaded = await this.load(postId, shown.map(idOf));
    const gone = shown.filter((_, i) => loaded[i] === null);
    if (gone.length) await this.hot.lexRem(key, gone).catch(() => {});
    return { comments: loaded.filter((comment): comment is Comment => comment !== null), nextCursor: members.length > limit ? idOf(shown.at(-1)!) : null };
  }

  /** How many of the index's members are within each of the bounds. */
  private async counts(postId: string, ranges: LexRange[]): Promise<number[]> {
    const key = commentIndexKey(postId);
    const [complete, counted] = await Promise.all([this.hot.lexHas(key, COMPLETE), Promise.all(ranges.map((range) => this.hot.lexCount(key, range)))]);
    if (complete) return counted;
    const members = await this.rebuild(postId);
    return ranges.map((range) => members.reduce((n, m) => (within(m, range) ? n + 1 : n), 0));
  }

  /** How many published comments the post has, replies and all, placeholders among them; or with `parentId`, how many reply to that comment. */
  async count(postId: string, parentId?: string): Promise<number> {
    return (await this.counts(postId, [parentId === undefined ? { before: COMPLETE } : under(parentId)]))[0]!;
  }

  /** How many comments reply to each of these, in the order given: to it, not to its replies. */
  async replyCounts(postId: string, commentIds: string[]): Promise<number[]> {
    return commentIds.length ? this.counts(postId, commentIds.map(under)) : [];
  }

  /**
   * How many likes each of the post's comments has, in the order given: from Redis, and for those
   * it has no number of, counted from one list of the comment's likes each, and kept.
   */
  async likes(postId: string, commentIds: string[]): Promise<number[]> {
    if (!commentIds.length) return [];
    const out = (await this.hot.mget(commentIds.map(commentLikesKey))).map((blob) => (blob ? Number(blob.toString('utf8')) : null));
    await mapLimit(
      commentIds.map((_, i) => i).filter((i) => out[i] === null),
      COLD_READS,
      async (i) => {
        const id = commentIds[i]!;
        const likes = (await this.names(likeDir(postId, id))).filter((name) => LIKE_FILE.test(name)).length;
        out[i] = likes;
        // Only where Redis has nothing: a number that was put there meanwhile has been added to since.
        await this.hot.setIfAbsent(commentLikesKey(id), Buffer.from(String(likes)), this.opts.hotMs).catch(() => {});
      },
    );
    return out.map((likes) => Math.max(0, likes ?? 0));
  }

  /** Whether the store has the user's like of the comment: one that was applied (see addLike), and not taken back since (see removeLike). */
  async liked(postId: string, commentId: string, userId: string): Promise<boolean> {
    return this.op.exists(likeObjectKey(postId, commentId, userId));
  }

  /**
   * Makes a user's like of a published comment, which is made once: one that is there already is
   * left as it is. The compactor's, which applies a like a request committed (`comment_like`).
   *
   * A number of likes that Redis has is then one more; one it doesn't have is counted when it is
   * next read, from a list that has this like. A like that is found made may be one this made
   * before and stopped short of counting, so the number is then left to be counted again.
   *
   * Its mark in the user's index goes first, as a comment's does, and is written whether or not
   * the like is there: a like older than the index may still wait for its own (see indexAuthors).
   */
  async addLike(postId: string, commentId: string, userId: string): Promise<void> {
    const key = likeObjectKey(postId, commentId, userId);
    await this.op.write(markKey(likedDir(userId), postId, commentId), MARK);
    if (await this.op.exists(key)) {
      await this.hot.del([commentLikesKey(commentId)]);
      return;
    }
    await this.op.write(key, MARK);
    await this.hot.bump(commentLikesKey(commentId));
  }

  /**
   * Takes a user's like of a comment back: the like's object goes, and then its mark in the
   * user's index, which is no longer of anything. One that isn't there is left that way. The
   * compactor's, which applies the taking back that a request committed (a `comment_like` row
   * that says `unlike`).
   *
   * A number of likes that Redis has is then one less; one it doesn't have is counted when it is
   * next read, from a list that lacks this like. A like that is found gone may be one this took
   * away before and stopped short of counting, so the number is then left to be counted again,
   * as addLike leaves it.
   */
  async removeLike(postId: string, commentId: string, userId: string): Promise<void> {
    const key = likeObjectKey(postId, commentId, userId);
    const there = await this.op.exists(key);
    // The like before its mark: what is there always has its mark, and a mark may name what isn't.
    if (there) await this.op.delete(key);
    await this.op.delete(markKey(likedDir(userId), postId, commentId));
    if (there) await this.hot.bump(commentLikesKey(commentId), -1);
    else await this.hot.del([commentLikesKey(commentId)]);
  }

  /**
   * Says that likes of the comment are being made, or taken back (see addLike, removeLike), until
   * the function it returns is called: once the rows of those likes are settled. The compactor's,
   * around the likes of a comment that it applies.
   *
   * Between the two, a like that was made is in the store and is still a row that waits, and a
   * request that adds the one to the other counts it twice; one that was taken back is counted
   * off twice the same way. So such a request reads what this writes before it counts and after
   * (see likesWith): a count is right if no likes were being made when it began, and none have
   * been since.
   */
  async makingLikes(commentId: string): Promise<() => Promise<void>> {
    const key = commentLikesMadeKey(commentId);
    await this.hot.set(key, `${MAKING}${randomUUID()}`, this.opts.hotMs);
    return () => this.hot.set(key, randomUUID(), this.opts.hotMs);
  }

  /**
   * How many likes the comment has, with what waits to be applied: the store's number (see
   * likes) and `waiting`, which says what the rows that requests committed and the compactor
   * hasn't applied come to: one more for each like that is yet to be made, one less for each
   * that is yet to be taken back (see pendingLikes).
   *
   * The two are read one after the other, and a like the compactor makes meanwhile, or has made
   * and not yet deleted the row of, is in both; one it takes back is counted off in both. So
   * the count is made again, a moment later, if likes were being made as it began or have been
   * by its end (see makingLikes). After LIKE_COUNTS of them it is given as it is, which can be
   * off by the likes being made: the compactor is then at the likes of a comment that got very
   * many at once. It is never given as less than none.
   */
  async likesWith(postId: string, commentId: string, waiting: () => Promise<number>): Promise<number> {
    const key = commentLikesMadeKey(commentId);
    const last = async () => (await this.hot.get(key))?.toString('utf8') ?? null;
    for (let count = 1; ; count++) {
      const before = await last();
      const rows = await waiting();
      const [made = 0] = await this.likes(postId, [commentId]);
      if (count === LIKE_COUNTS || (!before?.startsWith(MAKING) && before === (await last()))) return Math.max(0, made + rows);
      await sleep(LIKE_RECOUNT_MS * 2 ** (count - 1));
    }
  }

  /**
   * Removes a comment, published or held, for good, with its likes and the image or video it came
   * with, and nothing else: the comments that reply to it stay as they are. With `keepPlace`, a
   * placeholder is left where the comment was, or put there if nothing is, so its replies stay
   * listed under it; without, nothing of it is left. `comment` is the comment, for a caller that
   * has read it, and for one that puts a placeholder where the comment no longer is.
   *
   * Redis goes first, before the store: it is left the placeholder, or an empty value, in place of
   * the comment's JSON. An empty value says the comment is gone to whoever still finds it in the
   * index. A reader that had just read the comment from the store writes over neither. If the
   * store then can't be written, Redis is left nothing of the comment, to be read from the store
   * again: a removal that failed can be made again.
   */
  async remove(postId: string, commentId: string, { keepPlace = false, comment }: { keepPlace?: boolean; comment?: Comment | null } = {}): Promise<void> {
    const was = comment ?? (await this.find(postId, commentId)) ?? (await this.getHeld(postId, commentId));
    const left = keepPlace && was ? placeholder(was, 'deleted') : null;
    const key = commentIndexKey(postId);
    // Its marks first, while its likes are there to say whose they are. Who wrote a comment that an edit took back to the
    // queue is said where it waits, not by the placeholder in its place. A placeholder of a deleted comment has no marks left.
    if (was?.gone !== 'deleted') await this.unsign(postId, commentId, was?.gone === 'held' ? (await this.getHeld(postId, commentId))?.userId : was?.userId);
    if (left) {
      await this.hot.set(commentKey(commentId), JSON.stringify(left), this.opts.hotMs);
      await this.store(left).catch((err) => this.forget(commentId, err));
      await this.hot.lexAdd(key, [member(left.parentId, commentId)], this.opts.hotMs);
      await this.strip(postId, commentId);
    } else {
      await this.hot.set(commentKey(commentId), '', this.opts.hotMs);
      await this.erase(postId, { commentId, parentId: was?.parentId }).catch((err) => this.forget(commentId, err));
    }
    await this.op.delete(heldCommentObjectKey(postId, commentId));
    if (!left) await this.hot.lexRem(key, [member(was?.parentId, commentId)]);
    await this.hot.del([commentLikesKey(commentId)]);
  }

  /**
   * Removes every comment of a post, published and held, their likes, their images and videos, and its index: the post is being deleted. What Redis has of each expires.
   *
   * Their marks in users' indexes go first, while the comments and likes are there to say whose
   * they are (see marksOf), so a removal that stops is made again from what is left.
   */
  async removeAll(postId: string): Promise<void> {
    await mapLimit(await this.marksOf(postId), COLD_READS, (mark) => this.op.delete(mark));
    await this.op.removeAll(commentDir(postId)).catch((err) => {
      if (!isNotFound(err)) throw err;
    });
    await this.hot.del([commentIndexKey(postId)]);
  }

  /**
   * Up to `limit` of the marks of a user's index (`dir`), in the order of the comments' ids,
   * after the comment `after`, or from the first. The parts of the index are listed, which is
   * one list of their names, and then the parts from the one `after` is in, several at a time,
   * until they have given enough: each is a list of what the user wrote, or liked, of three
   * days' comments. Fewer than `limit`: there are no more.
   */
  private async marks(dir: string, after: string | null, limit: number): Promise<CommentMark[]> {
    const from = after?.slice(0, SPAN_CHARS) ?? '';
    const spans = (await this.names(dir))
      .flatMap((name) => SPAN_DIR.exec(name)?.[1] ?? [])
      .filter((span) => span >= from)
      .sort();
    const found: CommentMark[] = [];
    for (let i = 0; i < spans.length && found.length < limit; i += COLD_READS) {
      const lists = await Promise.all(spans.slice(i, i + COLD_READS).map(async (span) => (await this.names(`${dir}${span}/`)).sort()));
      for (const name of lists.flat()) {
        const mark = MARK_FILE.exec(name);
        if (mark && (after === null || mark[1]! > after)) found.push({ commentId: mark[1]!, postId: mark[2]! });
      }
    }
    return found.slice(0, limit);
  }

  /**
   * The comments a user wrote, as their index has them: up to `limit` marks, oldest first, after
   * the comment `after`, or from the first; fewer than `limit` once there are no more. A mark
   * names a comment that is published, or waits in the moderation queue, or isn't there (see the
   * class): its reader reads the comment.
   */
  authored(userId: string, after: string | null, limit: number): Promise<CommentMark[]> {
    return this.marks(authoredDir(userId), after, limit);
  }

  /**
   * The comments a user liked, as their index has them: up to `limit` marks, in the order the
   * comments were sent in, after the comment `after`, or from the first; fewer than `limit` once
   * there are no more. A mark may name a like that isn't there: its reader asks (see liked).
   */
  likedBy(userId: string, after: string | null, limit: number): Promise<CommentMark[]> {
    return this.marks(likedDir(userId), after, limit);
  }

  /**
   * Whether users' indexes hold everything: every comment and like in the store has its mark.
   * True from the start on a server that has kept the index from its first comment, and on one
   * that had comments before, once indexAuthors has been through them. Until then an index lacks
   * what is older than it, and whoever reads one for all a user wrote can't take it for that.
   */
  async indexed(): Promise<boolean> {
    this.indexedSeen ||= await this.op.exists(INDEXED_KEY);
    return this.indexedSeen;
  }

  /**
   * Writes the marks of the comments and likes that were in the store before the index was kept,
   * a post at a time, in the order of the posts' ids, and says in the store that it has, once it
   * has been through them all: from then on `indexed` is true, and this does nothing. Where it
   * has got to is written every INDEXING_STEP posts, and when `stopped` says to stop, so a
   * process that takes it up again goes on from there. Returns whether it is done.
   *
   * It runs beside the compactor and not as part of a run, as it can take long where there are
   * many comments, and nothing waits for it but the exports of users' comments. It only writes
   * marks, which is safe beside the compactor's own writes: a comment or a like the compactor
   * writes meanwhile gets its mark from the compactor, and a mark written here for a comment the
   * compactor removes at that moment names a comment that isn't there, which a mark may.
   */
  async indexAuthors(stopped: () => boolean = () => false): Promise<boolean> {
    if (await this.indexed()) return true;
    const last = (await readObject(this.op, INDEXING_KEY))?.toString('utf8') ?? '';
    const posts = (await this.names(COMMENTS_DIR))
      .flatMap((name) => POST_DIR.exec(name)?.[1] ?? [])
      .filter((postId) => postId > last)
      .sort();
    for (const [i, postId] of posts.entries()) {
      if (stopped()) {
        if (i > 0) await this.op.write(INDEXING_KEY, posts[i - 1]!);
        return false;
      }
      await mapLimit(await this.marksOf(postId), COLD_READS, async (mark) => {
        await this.op.write(mark, MARK);
      });
      if ((i + 1) % INDEXING_STEP === 0) await this.op.write(INDEXING_KEY, postId);
    }
    await this.op.write(INDEXED_KEY, MARK);
    await this.op.delete(INDEXING_KEY);
    this.indexedSeen = true;
    return true;
  }
}
