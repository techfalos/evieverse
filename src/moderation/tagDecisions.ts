import { loadPublished, requireMeta } from '../content.js';
import { isUniqueViolation, updateOnConflict } from '../db/index.js';
import type { AppDeps } from '../deps.js';
import { notFound } from '../http/errors.js';
import { msg } from '../language.js';

/**
 * What a hashtag's moderators decide about the content under it. Every post is published under its
 * hashtags unmoderated, which is what puts it in each hashtag's moderation queue: the hashtag's feed
 * with `moderated=false`. A moderator takes it out of the queue by approving it or by removing the
 * hashtag from it.
 *
 * A decision is recorded in `tag_moderation`, and that is all a request does: the compactor's next
 * run finds the row and applies it (see Compactor), which is when feeds show it. It flags the
 * content's entry in the hashtag's day index, or takes the hashtag off the content.
 */

type Deps = Pick<AppDeps, 'db' | 'config' | 'content' | 'now'>;

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
 * Approves content under `tag`: once the compactor has applied it, the content is flagged as
 * moderated in the hashtag's feeds, and so leaves the hashtag's moderation queue. The approval is
 * of the content as it is: an update makes it unmoderated again. 404 if the content doesn't carry
 * the hashtag.
 */
export async function approveTag(deps: Deps, contentId: string, tag: string, moderatorId: string): Promise<{ alreadyApproved: boolean }> {
  const { db, now = Date.now } = deps;
  const { approved } = await tagged(deps, contentId, tag);
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
  return { alreadyApproved: false };
}

export interface Removal {
  /** The content's publisher. */
  userId: string;
  /** The hashtags the content is left with: none, if this was its last. */
  tags: string[];
}

/**
 * Removes `tag` from content. The removal is recorded, over an approval if there was one. The
 * compactor's next run then takes the hashtag off the content: it writes the meta file and summary
 * again without it (the bytes stay as they are) and drops the content from the hashtag's day index,
 * which is when the hashtag's feeds stop returning it. 404 if the content doesn't carry the
 * hashtag.
 *
 * Content left with no hashtag stays: it is in no hashtag's feed, and is still read at /content,
 * and still in its publisher's own index, so in the following feeds of those who follow them.
 *
 * The removal stays: an update of the content doesn't get the hashtag back (see moderatePost), and
 * nor does a repost of it (see repostRoutes).
 */
export async function removeTag(deps: Deps, contentId: string, tag: string, moderatorId: string): Promise<Removal> {
  const { db, config, now = Date.now } = deps;
  const { row, meta, removed } = await tagged(deps, contentId, tag);

  const decidedAt = now();
  const decision = { decision: 'removed', moderator_id: moderatorId, decided_at: decidedAt, applied_at: null } as const;
  await updateOnConflict(
    db.insertInto('tag_moderation').values({ content_id: contentId, tag, ...decision }),
    config.db.dialect,
    ['content_id', 'tag'],
    decision,
  ).execute();

  return { userId: row.user_id, tags: meta.tags.filter((t) => t !== tag && !removed.has(t)) };
}
