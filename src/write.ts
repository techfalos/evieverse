import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { contentNotFound, withheld } from './content.js';
import { updateOnConflict } from './db/index.js';
import type { AppDeps } from './deps.types.js';
import { badRequest, conflict, unprocessable } from './http/errors.js';
import { msg } from './language.js';
import { effectiveMeta, insertPending, nextSeq } from './pending.js';
import { mediaType } from './posts.js';
import { MAX_REPOSTED_TAGS, repostedTags, repostsOf, type Repost } from './reposts.js';
import type { ContentMeta, Publisher, StagedBytes } from './storage/index.js';
import { countTagPairs, touchTags } from './tags.js';
import { authorIndex } from './tagfeed/layout.js';
import { HOUR, wholeSeconds } from './time.js';
import { allDone } from './util.js';
import { addVideoJob } from './video/jobs.js';
import type { ContentWrite, OriginGone, RepostRemoval, RepostWrite } from './write.types.js';

/**
 * How long after the server's entry for a post on another server was hidden, on that server's
 * word that the post is gone, the server asks it about the post again (src/originSweep.ts), and
 * how long after each such answer: sooner than it asks about an entry that is published
 * (REPOSTS_REFRESH_HOURS), since a post that only waited in a moderation queue there may be back.
 */
export const GONE_RECHECK_MS = 6 * HOUR;

/** 409: the content is set for deletion, and takes no update. */
const pendingDeletion = () => conflict(msg('content.pending_deletion'));

/**
 * Refuses an update, of content type `mimeType`, that the content can't take. `meta` is its meta
 * file as it is.
 *
 * `videos`: the server processes videos (`video.processing`). A video's content type is then
 * the one the server makes of it, not the one it was sent as, so an update of a video post
 * takes a video of any type: it is made the same thing.
 */
export function assertUpdatable(existing: { delete_requested_at: number | null }, meta: { mimeType: string }, mimeType: string, { videos = false } = {}) {
  if (existing.delete_requested_at !== null) throw pendingDeletion();
  if (mimeType !== meta.mimeType && !(videos && mediaType(mimeType) === 'video' && mediaType(meta.mimeType) === 'video')) {
    throw badRequest(msg('content.type_changed', { original: meta.mimeType, mimeType }));
  }
}

/** 409: a user reposts a post once. */
export const alreadyReposted = () => conflict(msg('repost.already'));
/** 409: reposts have given the post all the hashtags they can. */
export const tooManyReposted = () => conflict(msg('repost.too_many_tags', { max: MAX_REPOSTED_TAGS }));

/**
 * Writes content for /store and reposts for /repost, publishes what an admin accepts from the
 * moderation queue, hides the entry of a post on another server that is gone from there, and
 * removes a repost a moderator took down. All five commit to the database and write nothing to
 * a post's bytes, meta file or summary: the compactor does, from what they committed (see
 * applyPending).
 */
export function contentWriter({ db, config, content, publishers, now = Date.now }: Pick<AppDeps, 'db' | 'config' | 'content' | 'publishers' | 'now'>, log: Pick<FastifyBaseLogger, 'warn'>) {
  const { dialect } = config.db;
  /** How long after an attestation of its original an entry for a post on another server is asked about again: 0 where the server doesn't ask. */
  const refreshMs = config.reposts.refreshHours * HOUR;

  /**
   * Queues the content's entry in each of these indexes (see `feed_queue`): the compactor rebuilds it
   * there on its next run. The rows are stamped as one write's, over what an earlier write queued.
   * In the transaction of the write that queues them, so a row is there if and only if its write committed.
   */
  const enqueue = (trx: Pick<typeof db, 'insertInto'>, contentId: string, tags: string[]) => {
    const stamp = { token: randomUUID(), created_at: now() };
    return updateOnConflict(
      trx.insertInto('feed_queue').values(tags.map((tag) => ({ content_id: contentId, tag, ...stamp }))),
      dialect,
      ['content_id', 'tag'],
      stamp,
    ).execute();
  };

  /**
   * Writes new content, or over content that is there: content has one version, and the last write
   * wins. A write is one commit to the database, and nothing else: the content's row, a row of
   * `pending_writes` that holds the meta file the write makes (see PostPayload), and a row in the
   * feed queue for every hashtag of the content and for the publisher's own index. The file of an
   * image, video or audio post is staged first, under an id of the write's own, where nothing
   * else writes or reads it until the commit names it (see ContentWrite.stageBytes); a write that
   * doesn't commit deletes what it staged. An image post of several images stages each, under an
   * id of its own, and the commit names the ones after the first in rows of their own
   * (`post_file`), which have the write's number.
   *
   * The compactor's next run applies the write: it is what writes the content's bytes, summary and
   * meta file (see applyPending), and then rebuilds the content's entries from the queue's rows.
   * So nothing but the compactor writes those, a write that didn't commit wrote nothing, and
   * the stores never hold content the database rejected. Until that run, the content is read as
   * written where it is read by its id (see requireMeta), and feeds show what they showed: a new
   * post is in feeds once the run has published its indexes, and so is what an update changed.
   *
   * An update takes the content's next write number as its transaction starts (see nextSeq), which
   * locks the content's row: updates of one piece of content commit one at a time, and the
   * compactor applies the newest. Content set for deletion gives no number (409), so no update of
   * it commits once the deletion is set, and none that committed before is applied after.
   *
   * A write sent to the moderation queue (`queued`) is stored the same way, and its commit puts the
   * content in `moderation_queue` with its trust score, but it gets no entry anywhere: new content
   * queues nothing, and an update queues every index that may hold the content, which the compactor
   * then takes it out of. The run that applies such an update also erases the content's summary,
   * in place of writing it, which is what takes the content out of the feeds that read an index
   * built before. Accepting the content has its summary written again (see publish). A write that
   * isn't queued takes the content out of the queue, if it was there. Either way, an update makes
   * the content unmoderated again under its hashtags: the approvals of their moderators were of
   * what it was.
   *
   * The hashtags an update dropped are queued with the ones it has, which is what takes its
   * entries out of their indexes. They are told from the hashtags the content had (`previous`),
   * which the request read before it began: if anything was written to the content, or under it,
   * since then (`seenSeq`), they are read again here, with the row locked, so an update that
   * committed in between is counted for what it gave the content. That is also when an update
   * that holds only for the content as it was read is asked again (`recheck`), and can refuse.
   *
   * Content that was reposted is also in the indexes its reposts put it in (`reposts`): an update
   * queues those too, the reposters' own among them, as its commit reads them, with the row locked
   * as a repost locks it. The hashtags a repost gave it are the content's, and an update keeps
   * them: they aren't its publisher's to drop, and the compactor writes them into the meta file
   * whatever the update said (see applyPending). One the update is refused, by the hashtag's own
   * rules, is recorded as removed from the content (see ContentWrite.droppedReposts). And one
   * whose repost was removed between the request's reading the content and this commit (see
   * unrepost) is left out of what is written: the request held it as a repost's
   * (ContentWrite.given), and with the row locked no repost gives it any more.
   *
   * An update of the server's entry for a post on another server is that post attested again
   * (POST /repost/refresh), so it is also what brings back an entry that was hidden because the
   * post was gone from its own server (see withhold): the row says so no more, and the entry is
   * queued under every index it has a place in, like any update. And the entry isn't asked about
   * again until REPOSTS_REFRESH_HOURS from now (`content.origin_check_at`).
   *
   * A video post's write waits longer where the server processes videos (`processVideo`): its
   * row says its file is yet to be processed, and the commit adds the job the video worker
   * takes (src/video). The compactor leaves the write, and the rows it queued, until the worker
   * has put the processed file in the row; until then the post is read by its id as written,
   * with `processing`, and nothing of the file that was sent is served.
   *
   * Last, the write's hashtags are counted in `tag_pairs`, from which related hashtags are worked
   * out: all of new content's, and those an update added. It is counted once the write is
   * committed, queued or not, and outside its transaction, which then holds no lock on rows every
   * post of a busy hashtag counts on. A count that fails is lost, and the write stands.
   *
   * Returns the hashtags the write gives the content: the ones it came with (`summary.tags`),
   * but for those of a repost that was removed meanwhile.
   */
  async function write({ publisher, previous, seenSeq, recheck, summary, meta, stageBytes, processVideo, client, queued, given = [], droppedReposts = [], originHash }: ContentWrite): Promise<string[]> {
    const { contentId, createdAt, updatedAt: ts, aiGenerated } = summary;
    const own = authorIndex(publisher.userId);

    // The files first, where only this write knows of them: the commit below is what makes them the content's.
    const staged: StagedBytes[] = [];
    /** Deletes what the write staged, which is then nobody's. */
    const unstage = () =>
      allDone(staged.map(({ key }) => content.removeStaged(key).catch((cause) => log.warn({ err: cause, contentId, staged: key }, 'could not delete the staged file of a write that did not commit'))));
    try {
      // One after another, an image post's in their order: each is as large as a file may be, and comes from a temp file here.
      for (const stage of stageBytes ?? []) staged.push(await stage(randomUUID()));
    } catch (err) {
      await unstage();
      throw err;
    }
    const [first] = staged;
    // The sizes recorded are those of the bytes as stored.
    const stored: ContentMeta = first
      ? { ...meta, size: first.size, ...(meta.images && { images: meta.images.map((image, i) => ({ ...image, size: staged[i]?.size ?? image.size })) }) }
      : meta;

    let seq: number | undefined;
    // The hashtags the content had, and the places reposts gave it, as the commit read them.
    let had: string[] = previous?.tags ?? [];
    let places: Repost[] = [];
    // The hashtags the write gives the content, and its meta file with them: as it came, unless a repost was removed meanwhile.
    let tags = summary.tags;
    let written = stored;
    try {
      await db.transaction().execute(async (trx) => {
        if (previous) {
          const next = await nextSeq(trx, contentId, { ai_generated: aiGenerated ? 1 : 0, ...(stored.origin && { origin_gone_at: null, origin_check_at: ts + refreshMs }) });
          if (next === null) throw pendingDeletion();
          seq = next;
          // Something was written to it, or under it, since the request read it: its hashtags may be others by now.
          if (seenSeq === undefined || next !== seenSeq + 1) {
            const current = await effectiveMeta(trx, content, contentId);
            if (current) recheck?.(current);
            had = [...new Set([...previous.tags, ...(current?.tags ?? [])])];
          }
          // Where reposts put it: the row is locked, so there are no more to come, and none to go, before this commits.
          places = await repostsOf(trx, contentId);
          // What the request read as a repost's and no repost gives any more: the repost was removed, and its hashtags with it.
          const lost = given.filter((tag) => !places.some((r) => r.tag === tag));
          if (lost.length) {
            tags = tags.filter((tag) => !lost.includes(tag));
            written = { ...stored, tags: stored.tags.filter((tag) => !lost.includes(tag)) };
          }
        } else {
          seq = 1;
          await trx
            .insertInto('content')
            .values({
              id: contentId,
              user_id: publisher.userId,
              ai_generated: aiGenerated ? 1 : 0,
              created_at: createdAt,
              delete_requested_at: null,
              origin_hash: originHash ?? null,
              origin_check_at: originHash === undefined ? null : createdAt + refreshMs,
              seq,
            })
            .execute();
        }
        if (queued) {
          // Content that was waiting keeps its place in the queue.
          await updateOnConflict(
            trx.insertInto('moderation_queue').values({ content_id: contentId, trust_score: queued.trustScore, created_at: ts }),
            dialect,
            'content_id',
            { trust_score: queued.trustScore },
          ).execute();
        } else if (previous) {
          await trx.deleteFrom('moderation_queue').where('content_id', '=', contentId).execute();
        }
        if (previous) await trx.deleteFrom('tag_moderation').where('content_id', '=', contentId).where('decision', '=', 'approved').execute();
        // The hashtags it is published under, not the ones it dropped: this is what /tags lists them by.
        if (!queued) await touchTags(trx, dialect, [...tags, own], ts);
        if (previous) {
          // Recorded as removals, with no moderator: the compactor takes them off the content as it does any (see applyDecisions).
          const removal = { decision: 'removed', moderator_id: null, decided_at: ts, applied_at: null } as const;
          for (const tag of droppedReposts) {
            await updateOnConflict(trx.insertInto('tag_moderation').values({ content_id: contentId, tag, ...removal }), dialect, ['content_id', 'tag'], removal).execute();
          }
        }
        const placed = places.map((r) => r.tag);
        const touched = [
          ...new Set([
            // The indexes the content is published in: its hashtags', its publisher's own, and those reposts put it in.
            ...(queued ? [] : [...tags, own, ...placed]),
            // The ones an update dropped. Queued: also the hashtags it has now, should an admin accept what it was before this is applied.
            ...(!previous ? [] : queued ? [...had, ...tags, own, ...placed, ...droppedReposts] : [...had.filter((tag) => !tags.includes(tag)), ...droppedReposts]),
          ]),
        ];
        // A video the server processes waits as it was sent: the row says so, and the job is what the video worker finds it by.
        const process = processVideo === true && first !== undefined;
        await insertPending(trx, { contentId, seq, kind: 'post', payload: { meta: written, ...(process && { process: true }) }, stagedKey: first?.key, at: ts });
        if (process) await addVideoJob(trx, { contentId, seq, at: ts, client });
        // The images after the first, of an image post of several: a row each, under the write's number, which names where the image waits.
        for (const [i, { key }] of staged.entries()) {
          if (i > 0) await insertPending(trx, { contentId, seq, kind: 'post_file', image: i + 1, stagedKey: key, at: ts });
        }
        if (touched.length) await enqueue(trx, contentId, touched);
      });
    } catch (err) {
      // A COMMIT can fail yet still be applied, e.g. if the connection dropped mid-commit.
      const held = seq === undefined ? false : await committed(contentId, seq, ts, first?.key);
      // What was staged is nobody's, unless the write may be there after all: then the files are its own, and stay.
      if (held === false) await unstage();
      if (held !== true) throw err;
    }

    await publishers.put(publisher).catch((err) => log.warn({ err, userId: publisher.userId }, 'could not refresh the publisher credit in Redis'));
    // Not the hashtags a repost gave it, which the repost counted, whether the meta file had them yet or not.
    const reposted = new Set(repostedTags(places));
    // Stamped now, not when the write began: the compactor goes by it, and must find the rows written by then.
    await countTagPairs(
      db,
      dialect,
      tags,
      previous ? tags.filter((tag) => !had.includes(tag) && !reposted.has(tag)) : tags,
      now(),
    ).catch((err) => log.warn({ err, contentId }, 'could not count the hashtags of the write; related hashtags go without it'));
    return tags;
  }

  /**
   * Publishes content that waits in the moderation queue, as an admin accepting it does: takes it
   * out of the queue, and queues its entry in the index of each of its hashtags, in its publisher's
   * own and in each that a repost put it in, as the write that was held back would have. Returns
   * the content's meta file as it is published, which has its hashtags and whom it mentions, or
   * null if it isn't in the queue (any more).
   *
   * Content that waits has no summary. The compactor writes it: with the write that was held, if
   * it has yet to apply that (see applyPending), else as it rebuilds the content's entries.
   *
   * The content's row is locked first, as an update of it does, so the two take turns: whichever
   * commits last decides whether the content is in the queue.
   */
  async function publish(row: { id: string; user_id: string; username: string; created_at: number; ai_generated: number }): Promise<ContentMeta | null> {
    const contentId = row.id;
    const meta = await db.transaction().execute(async (trx) => {
      await trx.updateTable('content').set((eb) => ({ ai_generated: eb.ref('ai_generated') })).where('id', '=', contentId).execute();
      if (
        !(await isLive(trx, contentId)) ||
        Number((await trx.deleteFrom('moderation_queue').where('content_id', '=', contentId).executeTakeFirst()).numDeletedRows) === 0
      ) {
        return null;
      }
      // Read with the row locked: a write that commits after this one has it as its `previous`, or wrote it.
      const meta = await effectiveMeta(trx, content, contentId);
      if (!meta) throw new Error(`the meta file of ${contentId} is missing`);
      const tags = [...meta.tags, authorIndex(row.user_id)];
      // Content that was reposted before an update of it was held is back where the reposts put it.
      const reposts = await repostsOf(trx, contentId);
      await touchTags(trx, dialect, tags, now());
      await enqueue(trx, contentId, [...new Set([...tags, ...reposts.map((r) => r.tag)])]);
      return meta;
    });
    if (!meta) return null;

    const publisher: Publisher = { userId: row.user_id, username: row.username };
    await publishers.put(publisher).catch((err) => log.warn({ err, userId: publisher.userId }, 'could not refresh the publisher credit in Redis'));
    return meta;
  }

  /**
   * Reposts content that is there: gives it `tags`, which it doesn't have, in the name of `userId`,
   * who isn't its publisher. All of it is one commit, and nothing is written to the stores: a row
   * of `reposts` for each hashtag and one for the reposter's own index, which say where the
   * content is placed as a new post (at the repost's time, with the likes it had then to count
   * from), and a row in the feed queue for each. The compactor's next run writes the hashtags into
   * the content's meta file and summary and builds the entries (see applyReposts), which is when
   * feeds show the repost. So a repost never writes a file an update of the content may be
   * writing: only the compactor writes the content's meta file.
   *
   * The content's row is locked first, as an update and an acceptance from the moderation queue
   * lock it, so what is checked here holds when it commits: the content is published (404
   * otherwise), this user hasn't reposted it (409), and the hashtags reposts gave it stay within
   * MAX_REPOSTED_TAGS (409). A hashtag another repost gave it meanwhile isn't given twice; a
   * repost left with none that way is refused (422), since it would place the content nowhere but
   * the reposter's own index.
   *
   * `carried` is the hashtags the content's meta file has, as its newest write made it, for the
   * count of related hashtags (see write). Returns the hashtags the repost gave the content, and when it was made: in whole
   * seconds, which is all an index entry keeps of it.
   */
  async function repost({ contentId, userId, tags, carried }: RepostWrite): Promise<{ tags: string[]; at: number }> {
    const own = authorIndex(userId);
    const at = wholeSeconds(now());
    const result = await db.transaction().execute(async (trx) => {
      await trx.updateTable('content').set((eb) => ({ ai_generated: eb.ref('ai_generated') })).where('id', '=', contentId).execute();
      const live = await trx
        .selectFrom('content')
        .leftJoin('moderation_queue', 'moderation_queue.content_id', 'content.id')
        .select(['content.like_count', 'content.origin_gone_at', 'moderation_queue.content_id as queued_id'])
        .where('content.id', '=', contentId)
        .where('content.delete_requested_at', 'is', null)
        .executeTakeFirst();
      if (!live || withheld(live)) throw contentNotFound();

      const places = await repostsOf(trx, contentId);
      if (places.some((r) => r.tag === own)) throw alreadyReposted();
      const given = repostedTags(places);
      const added = tags.filter((tag) => !given.includes(tag));
      if (!added.length) throw unprocessable(msg('repost.no_tags_left'), { removedTags: tags.map((tag) => ({ tag, reason: 'already_tagged' })) });
      if (given.length + added.length > MAX_REPOSTED_TAGS) throw tooManyReposted();

      const indexes = [...added, own];
      await trx
        .insertInto('reposts')
        .values(indexes.map((tag) => ({ content_id: contentId, tag, user_id: userId, likes_before: live.like_count, created_at: at })))
        .execute();
      await touchTags(trx, dialect, indexes, at);
      await enqueue(trx, contentId, indexes);
      return { added, all: [...new Set([...carried, ...given, ...added])] };
    });

    await countTagPairs(db, dialect, result.all, result.added, now()).catch((err) =>
      log.warn({ err, contentId }, 'could not count the hashtags of the repost; related hashtags go without it'),
    );
    return { tags: result.added, at };
  }

  /**
   * Removes a user's repost of content, as an admin or a server moderator does (DELETE
   * /content/:contentId/reposts/:userId): what the repost added goes, and the content stays as
   * its publisher and its other reposts made it. It is one commit, and nothing is written to the
   * stores. The repost's rows of `reposts` are deleted: its place in the reposter's own index,
   * and each hashtag it gave the content that the content still has from it. From then on nothing
   * reads it as a repost, and the user can make it again, unless they are banned: the removal
   * blocks nobody.
   *
   * What is left of it is the compactor's to take away: the entries in those indexes, the
   * hashtags in the content's meta file and summary, and the summary's copy under the day of the
   * repost. The deleted rows were what said where those are, so the commit leaves a row of
   * `repost_removals` for each, and the compactor's next run goes by them (see Compactor's
   * applyRemovals), which is when feeds stop showing the repost.
   *
   * The content's row is locked first, as a repost and an update lock it, so the rows deleted are
   * the ones that are there, and an update that commits after this finds them gone (see write).
   * Returns the hashtags the repost had given the content and when it was made, or null if the
   * user has no repost of it. 404 for content that isn't there, or is set for deletion.
   */
  async function unrepost({ contentId, userId }: RepostRemoval): Promise<{ tags: string[]; at: number } | null> {
    const at = now();
    return db.transaction().execute(async (trx) => {
      await trx.updateTable('content').set((eb) => ({ ai_generated: eb.ref('ai_generated') })).where('id', '=', contentId).execute();
      if (!(await isLive(trx, contentId))) throw contentNotFound();
      const made = (await repostsOf(trx, contentId)).filter((r) => r.user_id === userId);
      const [first] = made;
      if (!first) return null;
      await trx.deleteFrom('reposts').where('content_id', '=', contentId).where('user_id', '=', userId).execute();
      await trx
        .insertInto('repost_removals')
        .values(made.map((r) => ({ id: randomUUID(), content_id: contentId, tag: r.tag, reposted_at: r.created_at, created_at: at })))
        .execute();
      return { tags: repostedTags(made), at: Number(first.created_at) };
    });
  }

  /**
   * Hides the server's entry for a post on another server, on that server's signed word that it
   * publishes no post at the original's address (see AttestedGone). It says that of a post it
   * deleted and of one that only waits in its moderation queue, and nobody can tell which from
   * here, so the entry isn't deleted: it is withheld, as content that waits in this server's own
   * moderation queue is (see `withheld`). Readers get 404 from the moment this commits, and the
   * compactor's next run erases the entry's summary and takes it out of every index it is in,
   * which is every one this queues: its hashtags', its owner's own, and the ones reposts placed
   * it in. The hashtags and those places stay the entry's own.
   *
   * What happens next is one of two things. The original's server attests the post again, and
   * the update that brings (see write) puts the entry back where it was, reposts and all. Or it
   * doesn't, and the compactor sets the entry for deletion once it has been hidden for
   * REPOSTS_GONE_DAYS (see Compactor). Until then the server asks about the post again every
   * GONE_RECHECK_MS (src/originSweep.ts).
   *
   * It is a numbered write of the entry, as an update is: the row is locked, the meta file is
   * read with every write that committed before, and `recheck` refuses word that is no newer
   * than what the entry holds. What it writes is the entry's meta file as it was, as of when
   * this word was signed (`originAttestedAt`), so a later attestation is told from it. An entry
   * that is hidden already stays hidden from when it first was: returns that time. 404 for an
   * entry that is gone, or set for deletion.
   */
  async function withhold({ contentId, issuedAt, recheck }: OriginGone): Promise<number> {
    const at = now();
    return db.transaction().execute(async (trx) => {
      const seq = await nextSeq(trx, contentId, { origin_check_at: at + GONE_RECHECK_MS });
      if (seq === null) throw contentNotFound();
      const row = await trx.selectFrom('content').select(['user_id', 'origin_gone_at']).where('id', '=', contentId).executeTakeFirstOrThrow();
      const meta = await effectiveMeta(trx, content, contentId);
      if (!meta) throw new Error(`the meta file of ${contentId} is missing`);
      recheck(meta);
      if (row.origin_gone_at === null) await trx.updateTable('content').set({ origin_gone_at: at }).where('id', '=', contentId).execute();
      const places = await repostsOf(trx, contentId);
      await insertPending(trx, { contentId, seq, kind: 'post', payload: { meta: { ...meta, originAttestedAt: issuedAt } }, at });
      await enqueue(trx, contentId, [...new Set([...meta.tags, authorIndex(row.user_id), ...places.map((r) => r.tag)])]);
      return row.origin_gone_at === null ? at : Number(row.origin_gone_at);
    });
  }

  /** Whether the content is there and not set for deletion. */
  async function isLive(trx: Pick<typeof db, 'selectFrom'>, contentId: string): Promise<boolean> {
    return (await trx.selectFrom('content').select('id').where('id', '=', contentId).where('delete_requested_at', 'is', null).executeTakeFirst()) !== undefined;
  }

  /**
   * Whether the database holds a write whose commit reported an error: its row of
   * `pending_writes`, told by the file it staged, or with none, by when it was made. Null if it
   * can't say.
   */
  async function committed(contentId: string, seq: number, at: number, staged: string | undefined): Promise<boolean | null> {
    try {
      const row = await db.selectFrom('pending_writes').select(['staged_key', 'created_at']).where('content_id', '=', contentId).where('seq', '=', seq).where('kind', '=', 'post').executeTakeFirst();
      return row !== undefined && (staged !== undefined ? row.staged_key === staged : row.staged_key === null && Number(row.created_at) === at);
    } catch {
      return null;
    }
  }

  return { write, publish, repost, unrepost, withhold };
}

export type ContentWriter = ReturnType<typeof contentWriter>;
