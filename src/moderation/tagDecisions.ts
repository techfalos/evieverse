import type { FastifyBaseLogger } from 'fastify';
import { loadPublished, requireMeta } from '../content.js';
import { isUniqueViolation, updateOnConflict } from '../db/index.js';
import { setForDeletion } from '../deletion.js';
import type { AppDeps } from '../deps.js';
import { notFound } from '../http/errors.js';
import { msg } from '../language.js';
import { touchTags } from '../tags.js';
import { iso } from '../time.js';

/**
 * What a hashtag's moderators decide about the content under it. Every post is published under its
 * hashtags unmoderated, which is what puts it in each hashtag's moderation queue: the hashtag's feed
 * with `moderated=false`. A moderator takes it out of the queue by approving it or by removing the
 * hashtag from it.
 *
 * A decision is recorded in `tag_moderation` and shown to readers at once by a line in the hashtag's
 * tail. The compactor applies it for good (see Compactor): it flags the content's entry in the
 * hashtag's day index, or takes the hashtag off the content.
 */

type Deps = Pick<AppDeps, 'db' | 'config' | 'content' | 'appender' | 'now'>;

const notTagged = (tag: string) => notFound(msg('content.not_tagged', { tag }));

/**
 * The content a moderator of `tag` decides on: published (404 otherwise, as for content that waits
 * in the moderation queue, which admins decide on), and carrying the hashtag. One a moderator
 * removed isn't carried any more, whether or not the compactor has taken it off the meta file yet.
 */
async function tagged({ db, content }: Deps, contentId: string, tag: string) {
  const row = await loadPublished(db, contentId);
  const [meta, decisions] = await Promise.all([
    requireMeta(content, contentId),
    db.selectFrom('tag_moderation').select(['tag', 'decision']).where('content_id', '=', contentId).execute(),
  ]);
  const removed = new Set(decisions.filter((d) => d.decision === 'removed').map((d) => d.tag));
  if (!meta.tags.includes(tag) || removed.has(tag)) throw notTagged(tag);
  return { row, meta, removed, approved: decisions.some((d) => d.tag === tag && d.decision === 'approved') };
}

/**
 * Approves content under `tag`: it is flagged as moderated in the hashtag's feeds, and so leaves the
 * hashtag's moderation queue. The approval is of the content as it is: an update makes it
 * unmoderated again. 404 if the content doesn't carry the hashtag.
 */
export async function approveTag(deps: Deps, contentId: string, tag: string, moderatorId: string, log: FastifyBaseLogger): Promise<{ alreadyApproved: boolean }> {
  const { db, config, appender, now = Date.now } = deps;
  const { row, approved } = await tagged(deps, contentId, tag);
  if (approved) return { alreadyApproved: true };

  const decidedAt = now();
  try {
    await db
      .insertInto('tag_moderation')
      .values({ content_id: contentId, tag, decision: 'approved', moderator_id: moderatorId, decided_at: decidedAt, applied_at: null })
      .execute();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Another moderator decided meanwhile, and a removal is the last word.
    const other = await db.selectFrom('tag_moderation').select('decision').where('content_id', '=', contentId).where('tag', '=', tag).executeTakeFirst();
    if (other?.decision === 'removed') throw notTagged(tag);
    return { alreadyApproved: true };
  }
  // The line only shows the approval until the compactor has applied it, which it does from the row.
  try {
    await touchTags(db, config.db.dialect, [tag], decidedAt);
    await appender.append(tag, { approval: true, contentId, createdAt: row.created_at });
  } catch (err) {
    log.warn({ err, contentId, tag }, 'approval append failed; feeds show the content as unmoderated until the compactor applies the approval');
  }
  return { alreadyApproved: false };
}

export interface Removal {
  /** The content's publisher. */
  userId: string;
  /** The hashtags the content is left with. */
  tags: string[];
  /** No hashtag was left, so the content is set for deletion. */
  status?: 'pending_deletion';
  requestedAt?: string;
}

/**
 * Removes `tag` from content. The removal is recorded, over an approval if there was one, and a
 * tombstone hides the content from the hashtag's feeds at once. The compactor then takes the
 * hashtag off the content: it writes the meta file and summary again without it (the bytes stay as
 * they are) and drops the content from the hashtag's day index. Content left with no hashtag is set
 * for deletion here and now instead, since a post needs one. 404 if the content doesn't carry the
 * hashtag.
 *
 * The removal stays: an update of the content doesn't get the hashtag back (see moderatePost).
 */
export async function removeTag(deps: Deps, contentId: string, tag: string, moderatorId: string, log: FastifyBaseLogger): Promise<Removal> {
  const { db, config, appender, now = Date.now } = deps;
  const { row, meta, removed } = await tagged(deps, contentId, tag);

  const decidedAt = now();
  const decision = { decision: 'removed', moderator_id: moderatorId, decided_at: decidedAt, applied_at: null } as const;
  await updateOnConflict(
    db.insertInto('tag_moderation').values({ content_id: contentId, tag, ...decision }),
    config.db.dialect,
    ['content_id', 'tag'],
    decision,
  ).execute();

  const tags = meta.tags.filter((t) => t !== tag && !removed.has(t));
  if (!tags.length) {
    const requestedAt = await setForDeletion(deps, row, log);
    return { userId: row.user_id, tags, status: 'pending_deletion', requestedAt: iso(requestedAt) };
  }
  // It hides every entry of the content there, whenever written: no later write gets the hashtag back.
  await touchTags(db, config.db.dialect, [tag], decidedAt);
  const failed = await appender.tombstone([tag], { tombstone: true, contentId, before: null, createdAt: row.created_at });
  if (failed.length) log.warn({ contentId, tag }, 'tombstone append failed; the feed shows the content until the compactor applies the removal');
  return { userId: row.user_id, tags };
}
