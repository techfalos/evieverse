import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { contentNotFound, summaryOf, takesComments } from './content.js';
import { updateOnConflict } from './db/index.js';
import type { AppDeps } from './deps.types.js';
import { badRequest, conflict, unprocessable } from './http/errors.js';
import { msg } from './language.js';
import { previewOf } from './posts.js';
import { MAX_REPOSTED_TAGS, reposterIndexes, repostedTags, repostsOf, repostTimes } from './reposts.js';
import type { Publisher, Summary } from './storage/index.js';
import { countTagPairs, touchTags } from './tags.js';
import { authorIndex } from './tagfeed/layout.js';
import { wholeSeconds } from './time.js';
import type { ContentWrite, RepostWrite } from './write.types.js';

/** 409: the content is set for deletion, and takes no update. */
export const pendingDeletion = () => conflict(msg('content.pending_deletion'));

/** Refuses an update, of content type `mimeType`, that the content can't take. `meta` is its meta file as it is. */
export function assertUpdatable(existing: { delete_requested_at: number | null }, meta: { mimeType: string }, mimeType: string) {
  if (existing.delete_requested_at !== null) throw pendingDeletion();
  if (mimeType !== meta.mimeType) {
    throw badRequest(msg('content.type_changed', { original: meta.mimeType, mimeType }));
  }
}

/** 409: a user reposts a post once. */
export const alreadyReposted = () => conflict(msg('repost.already'));
/** 409: reposts have given the post all the hashtags they can. */
export const tooManyReposted = () => conflict(msg('repost.too_many_tags', { max: MAX_REPOSTED_TAGS }));

/** Writes content for /store and reposts for /repost, and publishes what an admin accepts from the moderation queue. */
export function contentWriter({ db, config, content, summaries, publishers, now = Date.now }: AppDeps, log: FastifyBaseLogger) {
  const { dialect } = config.db;

  /**
   * Queues the content's entry in each of these indexes (see `feed_queue`): the compactor rebuilds it
   * there on its next run. The rows are stamped as one write's, over what an earlier write queued.
   * `committed` is false for the rows an update queues before it writes anything, which a run
   * leaves alone until the update has had the grace period to commit, and stamp them again.
   */
  const enqueue = (trx: Pick<typeof db, 'insertInto'>, contentId: string, tags: string[], committed: boolean) => {
    const stamp = { token: randomUUID(), committed: committed ? 1 : 0, created_at: now() };
    return updateOnConflict(
      trx.insertInto('feed_queue').values(tags.map((tag) => ({ content_id: contentId, tag, ...stamp }))),
      dialect,
      ['content_id', 'tag'],
      stamp,
    ).execute();
  };

  /**
   * Writes new content, or over content that is there: content has one version, and the last write
   * wins. Its bytes, summary and meta file go to the stores (the meta file last: what it says is
   * there; it also keeps the hash of a file's bytes, which an update that writes another file
   * takes out before it does), then the database commits the write, and with it a row in the feed
   * queue for every hashtag of the content and for the publisher's own index. Nothing is written
   * to the feed index here: the compactor's next run takes the rows and rebuilds the content's
   * entries, so the index never holds content the database rejected, and a write is queued if and
   * only if it committed.
   *
   * So a new post is in feeds once that run has published its indexes. An update shows at once
   * where the content already is, since feeds read its summary, which is written over; and it is
   * left out of the feeds of a hashtag it dropped at once too, since a feed leaves out a record
   * whose summary doesn't carry the hashtag it is listed under (see renderFeed). The hashtags it
   * dropped are queued with the ones it has, which is what takes its entries out of their indexes.
   *
   * New content the database doesn't take is removed from the stores. An update can't be taken
   * back, since it writes over what was there: one that stops half way, or whose commit fails, is
   * reported as failed, and sending it again completes it. It queues its rows before it writes
   * anything, uncommitted, so that if it stops there the index is still brought into line with
   * what the meta file says, once the grace period has passed.
   *
   * A write sent to the moderation queue (`queued`) is stored the same way, and its commit puts the
   * content in `moderation_queue` with its trust score, but it gets no entry anywhere: new content
   * queues nothing, and an update queues every index that may hold the content, which the compactor
   * then takes it out of. Such an update also erases the content's summary, in place of writing it:
   * that is what hides the content from feeds at once, and keeps what is yet to be reviewed out of
   * them, in the indexes the compactor hasn't rebuilt yet and in the ones feed sessions under way
   * still read. Accepting the content writes its summary again (see publish). A write that isn't
   * queued takes the content out of the queue, if it was there. Either way, an update makes the
   * content unmoderated again under its hashtags: the approvals of their moderators were of what
   * it was.
   *
   * Content that was reposted is also in the indexes its reposts put it in (`reposts`): an update
   * queues those too, the reposters' own among them, so its entries there are rebuilt like the
   * others. The hashtags a repost gave it are the content's, and an update keeps them: they aren't
   * its publisher's to drop. One the update is refused, by the hashtag's own rules, is recorded as
   * removed from the content (see ContentWrite.droppedReposts). A repost that commits while an update is under way may be one the
   * update never read, and whose hashtags it wrote the meta file without: the update's commit
   * reads the content's places again, with the content's row locked as a repost locks it, and
   * queues the ones it didn't know of, which has the compactor write them back (see applyReposts).
   *
   * Last, the write's hashtags are counted in `tag_pairs`, from which related hashtags are worked
   * out: all of new content's, and those an update added. It is counted once the write is
   * committed, queued or not, and outside its transaction, which then holds no lock on rows every
   * post of a busy hashtag counts on. A count that fails is lost, and the write stands.
   */
  async function write({ publisher, previous, summary, meta, putBytes, queued, reposts = [], droppedReposts = [], originHash }: ContentWrite): Promise<void> {
    const { contentId, createdAt, updatedAt: ts, aiGenerated } = summary;
    const own = authorIndex(publisher.userId);
    const reposters = reposterIndexes(reposts);
    const touched = [
      ...new Set([
        // The indexes the content is published in: its hashtags', its publisher's own, and those of whoever reposted it.
        ...(queued ? [] : [...summary.tags, own, ...reposters]),
        // The ones an update dropped. Queued: also the hashtags it has now, should an admin accept what it was while this is under way.
        ...(!previous
          ? []
          : queued
            ? [...previous.tags, ...summary.tags, own, ...reposters, ...droppedReposts]
            : [...previous.tags.filter((tag) => !summary.tags.includes(tag)), ...droppedReposts]),
      ]),
    ];

    if (previous && touched.length) await enqueue(db, contentId, touched, false);
    try {
      // The hash the meta file keeps is of the bytes there now. An update that writes others takes it out
      // first: if it then stops before its own meta file is written, nothing says the bytes are a file they aren't.
      if (previous?.sha256 !== undefined && previous.sha256 !== meta.sha256) {
        const { sha256: _, ...unhashed } = previous;
        await content.putMeta(unhashed);
      }
      const stored = await putBytes();
      // A held update: erased, and the request fails if it can't be, since feeds would go on showing the content.
      if (queued && previous) await summaries.erase(summary);
      else if (!queued) await summaries.put(summary);
      await content.putMeta({ ...meta, ...stored });
    } catch (err) {
      if (!previous) await discard(summary);
      // Content that waited in the moderation queue still does, and has no summary, whatever this write had stored.
      else if (await isHeld(contentId).catch(() => false)) await summaries.erase(summary).catch(() => {});
      // The meta file is still the one before: feeds go back to showing what it describes.
      else {
        await summaries
          // The summary of the content before the update, which its meta file then (`previous`) still describes.
          .put({
            ...summary,
            updatedAt: previous.updatedAt,
            mimeType: previous.mimeType,
            aiGenerated: previous.aiGenerated,
            comments: takesComments(previous),
            tags: previous.tags,
            preview: previewOf(previous, config.publicBaseUrl),
          })
          .catch(() => {});
      }
      throw err;
    }

    try {
      await db.transaction().execute(async (trx) => {
        if (previous) {
          // MySQL counts the rows it changed, not those it matched, so a row it left as it was is looked for.
          if (
            Number(
              (
                await trx
                  .updateTable('content')
                  .set({ ai_generated: aiGenerated ? 1 : 0 })
                  .where('id', '=', contentId)
                  .where('delete_requested_at', 'is', null)
                  .executeTakeFirst()
              ).numUpdatedRows,
            ) !== 1 &&
            !(await isLive(trx, contentId))
          ) {
            throw pendingDeletion();
          }
        } else {
          await trx
            .insertInto('content')
            .values({ id: contentId, user_id: publisher.userId, ai_generated: aiGenerated ? 1 : 0, created_at: createdAt, delete_requested_at: null, origin_hash: originHash ?? null })
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
        if (!queued) await touchTags(trx, dialect, [...summary.tags, own], ts);
        // The places of reposts this write didn't read, which committed since: the row is locked, so there are no more to come before this commits.
        let late: string[] = [];
        if (previous) {
          // Recorded as removals, with no moderator: the compactor takes them off the content as it does any (see applyDecisions).
          const removal = { decision: 'removed', moderator_id: null, decided_at: ts, applied_at: null } as const;
          for (const tag of droppedReposts) {
            await updateOnConflict(trx.insertInto('tag_moderation').values({ content_id: contentId, tag, ...removal }), dialect, ['content_id', 'tag'], removal).execute();
          }
          late = (await repostsOf(trx, contentId)).map((r) => r.tag).filter((tag) => !touched.includes(tag));
        }
        if (touched.length + late.length) await enqueue(trx, contentId, [...touched, ...late], true);
      });
    } catch (err) {
      if (previous) {
        // An update that didn't commit is in the stores all the same. One that would have taken the
        // content out of the moderation queue wrote its summary, which content that waits there doesn't have.
        if (!queued && (await isHeld(contentId).catch(() => false))) await summaries.erase(summary).catch(() => {});
        throw err;
      }
      // A COMMIT can fail yet still be applied, e.g. if the connection dropped mid-commit.
      const held = await inserted(contentId);
      if (held === false) await discard(summary);
      if (held !== true) throw err;
    }

    await publishers.put(publisher).catch((err) => log.warn({ err, userId: publisher.userId }, 'could not refresh the publisher credit in Redis'));
    // Not the hashtags a repost gave it, which the repost counted, whether the meta file had them yet or not.
    const reposted = new Set(repostedTags(reposts));
    // Stamped now, not when the write began: the compactor goes by it, and must find the rows written by then.
    await countTagPairs(
      db,
      dialect,
      summary.tags,
      previous ? summary.tags.filter((tag) => !previous.tags.includes(tag) && !reposted.has(tag)) : summary.tags,
      now(),
    ).catch((err) => log.warn({ err, contentId }, 'could not count the hashtags of the write; related hashtags go without it'));
  }

  /**
   * Publishes content that waits in the moderation queue, as an admin accepting it does: takes it
   * out of the queue, queues its entry in the index of each of its hashtags, in its publisher's
   * own and in each that a repost put it in, as the write that was held back would have, and writes
   * its summary, which content that waits has none of. Returns the content's hashtags, or null if
   * it isn't in the queue (any more).
   *
   * The content's row is locked first, as an update of it does, so the two take turns: whichever
   * commits last decides whether the content is in the queue.
   */
  async function publish(row: { id: string; user_id: string; username: string; created_at: number; ai_generated: number }): Promise<string[] | null> {
    const contentId = row.id;
    const accepted = await db.transaction().execute(async (trx) => {
      await trx.updateTable('content').set((eb) => ({ ai_generated: eb.ref('ai_generated') })).where('id', '=', contentId).execute();
      if (
        !(await isLive(trx, contentId)) ||
        Number((await trx.deleteFrom('moderation_queue').where('content_id', '=', contentId).executeTakeFirst()).numDeletedRows) === 0
      ) {
        return null;
      }
      // Read with the row locked: a write that commits after this one has it as its `previous`, or wrote it.
      const meta = await content.getMeta(contentId);
      if (!meta) throw new Error(`the meta file of ${contentId} is missing`);
      const tags = [...meta.tags, authorIndex(row.user_id)];
      // Content that was reposted before an update of it was held is back where the reposts put it.
      const reposts = await repostsOf(trx, contentId);
      await touchTags(trx, dialect, tags, now());
      await enqueue(trx, contentId, [...new Set([...tags, ...reposts.map((r) => r.tag)])], true);
      return { meta, reposts };
    });
    if (!accepted) return null;
    const { meta, reposts } = accepted;

    const publisher: Publisher = { userId: row.user_id, username: row.username };
    // Written, not only looked for: whatever summary a write that failed may have left is not of what was accepted.
    // The compactor writes it when it rebuilds the content's entries, should this fail.
    await summaries
      .put(summaryOf({ ...row, ai_generated: meta.aiGenerated ? 1 : 0 }, meta, config.publicBaseUrl, repostTimes(reposts)))
      .catch((err) => log.warn({ err, contentId }, 'could not write the summary of accepted content; the compactor will'));
    await publishers.put(publisher).catch((err) => log.warn({ err, userId: publisher.userId }, 'could not refresh the publisher credit in Redis'));
    return meta.tags;
  }

  /**
   * Reposts content that is there: gives it `tags`, which it doesn't have, in the name of `userId`,
   * who isn't its publisher. All of it is one commit, and nothing is written to the stores: a row
   * of `reposts` for each hashtag and one for the reposter's own index, which say where the
   * content is placed as a new post (at the repost's time, with the likes it had then to count
   * from), and a row in the feed queue for each. The compactor's next run writes the hashtags into
   * the content's meta file and summary and builds the entries (see applyReposts), which is when
   * feeds show the repost. So a repost never writes a file an update of the content may be
   * writing: only the compactor and the content's publisher write its meta file, and the compactor
   * leaves alone what an update has queued and not yet committed.
   *
   * The content's row is locked first, as an update and an acceptance from the moderation queue
   * lock it, so what is checked here holds when it commits: the content is published (404
   * otherwise), this user hasn't reposted it (409), and the hashtags reposts gave it stay within
   * MAX_REPOSTED_TAGS (409). A hashtag another repost gave it meanwhile isn't given twice; a
   * repost left with none that way is refused (422), since it would place the content nowhere but
   * the reposter's own index.
   *
   * `carried` is the hashtags the content's meta file has, for the count of related hashtags (see
   * write). Returns the hashtags the repost gave the content, and when it was made: in whole
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
        .select(['content.like_count', 'moderation_queue.content_id as queued_id'])
        .where('content.id', '=', contentId)
        .where('content.delete_requested_at', 'is', null)
        .executeTakeFirst();
      if (!live || live.queued_id !== null) throw contentNotFound();

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
      await enqueue(trx, contentId, indexes, true);
      return { added, all: [...new Set([...carried, ...given, ...added])] };
    });

    await countTagPairs(db, dialect, result.all, result.added, now()).catch((err) =>
      log.warn({ err, contentId }, 'could not count the hashtags of the repost; related hashtags go without it'),
    );
    return { tags: result.added, at };
  }

  /** Whether the content waits in the moderation queue. */
  async function isHeld(contentId: string): Promise<boolean> {
    return (await db.selectFrom('moderation_queue').select('content_id').where('content_id', '=', contentId).executeTakeFirst()) !== undefined;
  }

  /** Whether the content is there and not set for deletion. */
  async function isLive(trx: Pick<typeof db, 'selectFrom'>, contentId: string): Promise<boolean> {
    return (await trx.selectFrom('content').select('id').where('id', '=', contentId).where('delete_requested_at', 'is', null).executeTakeFirst()) !== undefined;
  }

  /** Whether the database holds new content whose insert reported an error; null if it can't say. */
  async function inserted(contentId: string): Promise<boolean | null> {
    try {
      return (await db.selectFrom('content').select('id').where('id', '=', contentId).executeTakeFirst()) !== undefined;
    } catch {
      return null;
    }
  }

  /** Removes what was stored of new content that the database doesn't hold. */
  async function discard(summary: Summary): Promise<void> {
    await content.remove(summary.contentId).catch(() => {});
    await summaries.remove([summary]).catch(() => {});
  }

  return { write, publish, repost };
}

export type ContentWriter = ReturnType<typeof contentWriter>;
