import type { Operator } from 'opendal';
import { mapLimit } from '../util.js';
import type { Comment, CommentPageQuery } from './commentStore.types.js';
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
const commentDir = (postId: string) => `comments/${postId}/`;
/** A published comment's object, which holds its JSON, or that of the placeholder that stands in its place. */
export const commentObjectKey = (postId: string, commentId: string) => `${commentDir(postId)}${commentId}.json`;
/**
 * What says a published comment is a reply, and to which comment: an object beside the two, whose
 * name is all there is to it. So one list of a post's objects gives its comments and which replies
 * to which, without reading any.
 */
export const replyObjectKey = (postId: string, parentId: string, commentId: string) => `${commentDir(postId)}${parentId}.${commentId}.reply`;
/** Where a comment is while it waits in the moderation queue: apart, so no list of the post's comments finds it. */
export const heldCommentObjectKey = (postId: string, commentId: string) => `${commentDir(postId)}held/${commentId}.json`;
/** The prefix a comment's likes are under, an object for each user who liked it: a list of it counts them, and removing it deletes them all. */
const likeDir = (postId: string, commentId: string) => `${commentDir(postId)}likes/${commentId}/`;
/** A user's like of a comment: an object whose name is all there is to it, so a like is made once however often it is sent. */
export const likeObjectKey = (postId: string, commentId: string, userId: string) => `${likeDir(postId, commentId)}${userId}`;
/**
 * The bytes of the image or video a comment came with. In one place whether the comment is
 * published or waits in the moderation queue, so that neither accepting it nor holding an edit of
 * it moves a file. The content store writes and reads them (see ContentStore), as it does a post's.
 */
export const commentMediaKey = (postId: string, commentId: string) => `${commentDir(postId)}media/${commentId}`;

/** A post's published comments, each with the comment it replies to, in order, and COMPLETE once it holds them all. */
export const commentIndexKey = (postId: string) => `cmtidx:${postId}`;
/** A comment's JSON, or its placeholder's; or nothing at all for one of which nothing is left (see remove). */
export const commentKey = (commentId: string) => `cmt:${commentId}`;
/** How many likes a comment has. */
export const commentLikesKey = (commentId: string) => `cmtl:${commentId}`;
/** Says, for a moment, that a user's like of a comment is being made (see like). */
export const commentLikingKey = (commentId: string, userId: string) => `cmtlk:${commentId}:${userId}`;

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
 * the store is the only record of a published comment, and the database holds none. The object is
 * written again when its author edits the comment.
 *
 * A comment replies to the post, or to another comment on it, which makes a post's comments a
 * tree. A reply has a second object, `comments/<postId>/<parentId>.<commentId>.reply`, which holds
 * nothing: its name says which comment the reply is to. So one list of the post's objects gives
 * the whole tree.
 *
 * A like of a comment is an object too, `comments/<postId>/likes/<commentId>/<userId>`, which
 * holds nothing either: a comment's likes are the objects under its prefix.
 *
 * A comment that came with an image or a video says so (`media`), and the file's bytes are one
 * more object, `comments/<postId>/media/<commentId>`. The content store writes it, before the
 * comment is stored here, and serves it; this store only deletes it, with the comment.
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
 *   A like adds one to a number that is there, and leaves one that isn't to be counted.
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

  private async write(key: string, comment: Comment): Promise<void> {
    await this.op.write(key, JSON.stringify(comment), { contentType: 'application/json' });
  }

  /** The names of the objects right under a prefix; none, if nothing is. */
  private async names(dir: string): Promise<string[]> {
    let paths: string[];
    try {
      paths = (await this.op.list(dir)).map((entry) => entry.path());
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
   * with none. For a comment that is being removed, and for a file whose comment was never stored.
   */
  async discardMedia(postId: string, commentId: string): Promise<void> {
    await this.op.delete(commentMediaKey(postId, commentId));
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
   * Redis first: an edit that is writing the comment at the same moment finds the placeholder
   * there, and puts it back over what it wrote (see update). If the store then can't be written,
   * Redis is left nothing of the comment, to be read from the store again, where it still is.
   */
  async hold(comment: Comment): Promise<void> {
    const { contentId: postId, commentId } = comment;
    const left = placeholder(comment, 'held');
    await this.write(heldCommentObjectKey(postId, commentId), comment);
    await this.hot.set(commentKey(commentId), JSON.stringify(left), this.opts.hotMs);
    await this.write(commentObjectKey(postId, commentId), left).catch((err) => this.forget(commentId, err));
  }

  /** Takes what Redis has of a comment out of it, after a write to the store that failed, and throws that failure: Redis says nothing the store doesn't. */
  private async forget(commentId: string, err: unknown): Promise<never> {
    await this.hot.del([commentKey(commentId)]).catch(() => {});
    throw err;
  }

  /**
   * Writes a published comment again, as an edit made it. Returns false for a comment that was
   * deleted meanwhile, or taken back to the moderation queue: what that left in Redis, an empty
   * value or a placeholder, is never written over, and what this wrote to the store is undone, so
   * the edit doesn't bring the comment back.
   */
  async update(comment: Comment): Promise<boolean> {
    const { contentId: postId, commentId } = comment;
    const key = commentKey(commentId);
    await this.write(commentObjectKey(postId, commentId), comment);
    const json = JSON.stringify(comment);
    // An edit tries this many times to put its comment in Redis over what is there, before it leaves that to the next reader.
    for (let attempt = 0; attempt < 3; attempt++) {
      const blob = await this.hot.get(key);
      const cached = blob?.toString('utf8') ?? null;
      if (cached === '') {
        await this.op.delete(commentObjectKey(postId, commentId)).catch(() => {});
        return false;
      }
      const there = blob ? parse(blob) : null;
      if (there?.gone) {
        await this.write(commentObjectKey(postId, commentId), there).catch(() => {});
        return false;
      }
      // Only over what was just read: a deletion or a hold that comes between the two keeps what it left.
      if (await this.hot.swap(key, cached, json, this.opts.hotMs)) return true;
    }
    // Other edits kept getting there first. The next reader reads the store.
    await this.hot.del([key]);
    return true;
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
    return out.map((likes) => likes ?? 0);
  }

  /**
   * A user's like of a published comment, which is made once: liking again changes nothing.
   * Returns how many likes the comment has, and whether the user had liked it already.
   *
   * Of two of the same like sent at once, the first to say so in Redis makes it and the other
   * finds it made, so the two count once.
   */
  async like(postId: string, commentId: string, userId: string): Promise<{ likes: number; already: boolean }> {
    const key = likeObjectKey(postId, commentId, userId);
    const liking = commentLikingKey(commentId, userId);
    // For 10 seconds, a user's like of a comment keeps another of theirs, sent at the same moment, from counting too.
    const already = !(await this.hot.swap(liking, null, MARK, 10_000)) || (await this.op.exists(key));
    if (!already) {
      try {
        await this.op.write(key, MARK);
      } catch (err) {
        // Not made: the user's next attempt is the first again.
        await this.hot.del([liking]).catch(() => {});
        throw err;
      }
      // A number Redis has is one more; one it doesn't have is counted below, from a list that has this like.
      const likes = await this.hot.bump(commentLikesKey(commentId));
      if (likes !== null) return { likes, already };
    }
    return { likes: (await this.likes(postId, [commentId]))[0]!, already };
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
   * index. A reader that had just read the comment from the store writes over neither, and nor
   * does an edit (see update). If the store then can't be written, Redis is left nothing of the
   * comment, to be read from the store again: a removal that failed can be made again.
   */
  async remove(postId: string, commentId: string, { keepPlace = false, comment }: { keepPlace?: boolean; comment?: Comment | null } = {}): Promise<void> {
    const was = comment ?? (await this.find(postId, commentId)) ?? (await this.getHeld(postId, commentId));
    const left = keepPlace && was ? placeholder(was, 'deleted') : null;
    const key = commentIndexKey(postId);
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

  /** Removes every comment of a post, published and held, their likes, their images and videos, and its index: the post is being deleted. What Redis has of each expires. */
  async removeAll(postId: string): Promise<void> {
    await this.op.removeAll(commentDir(postId)).catch((err) => {
      if (!isNotFound(err)) throw err;
    });
    await this.hot.del([commentIndexKey(postId)]);
  }
}
