import { randomUUID } from 'node:crypto';
import { loadPublished, requireMeta } from '../content.js';
import { isUniqueViolation, updateOnConflict, type Db } from '../db/index.js';
import type { ModeratorRole, TagDecision } from '../db/schema.js';
import type { AppDeps } from '../deps.types.js';
import { notFound } from '../http/errors.js';
import { msg, type MessageKey } from '../language.js';
import type { Message } from '../language.types.js';
import { iso } from '../time.js';
import type { Moderator, Removal, TagAction } from './tagDecisions.types.js';

/**
 * What a hashtag's moderators decide about the content under it. Every post is published under its
 * hashtags unmoderated, which is what puts it in each hashtag's moderation queue: the hashtag's feed
 * with `moderated=false`. A moderator takes it out of the queue by approving it or by removing the
 * hashtag from it.
 *
 * A decision is recorded in `tag_moderation`, and that is all a request does: the compactor's next
 * run finds the row and applies it (see Compactor), which is when feeds show it. It flags the
 * content's entry in the hashtag's day index, or takes the hashtag off the content.
 *
 * Each decision is also written down on the post it is about (`tag_moderation_log`), in the commit
 * that records it: what was done under which hashtag, as what the moderator did it, when, and for
 * a removal why, if they said. `tag_moderation` holds what stands now, and is written over; the
 * post's record is what happened, and stays as it is for as long as the post does. GET
 * /content/:contentId gives it with the post (see tagActions), for a client to show beside it.
 * It never names the moderator, as the notice the publisher is left doesn't.
 */

/** The longest reason a moderator gives for removing a hashtag from a post, which is what `tag_moderation_log.reason` holds. */
export const MAX_REASON_CHARS = 500;

/** The most of a post's record of what moderators did to it that is given with the post: the newest ones. */
export const MAX_TAG_ACTIONS = 100;

/** The words for as what a moderator decided, which a record's own words name them by ({by}). */
const ROLES = {
  tag_moderator: 'tag_action.by.tag_moderator',
  server_moderator: 'tag_action.by.server_moderator',
  admin: 'tag_action.by.admin',
} as const satisfies Record<ModeratorRole, MessageKey>;

type Deps = Pick<AppDeps, 'db' | 'config' | 'content' | 'now'>;

/** The 404 for content that doesn't carry `tag`: it never did, or a moderator removed it. */
const notTagged = (tag: string) => notFound(msg('content.not_tagged', { tag }));

/** Writes a decision down on the post it is about. `trx` is the transaction that records the decision. */
const record = (trx: Db, action: { contentId: string; tag: string; decision: TagDecision; by: Moderator; reason?: string; at: number }) =>
  trx
    .insertInto('tag_moderation_log')
    .values({
      id: randomUUID(),
      content_id: action.contentId,
      tag: action.tag,
      decision: action.decision,
      moderator_id: action.by.id,
      moderator_role: action.by.role,
      reason: action.reason ?? null,
      created_at: action.at,
    })
    .execute();

/**
 * The content a moderator of `tag` decides on: published (404 otherwise, as for content that waits
 * in the moderation queue, which admins decide on), and carrying the hashtag. One a moderator
 * removed isn't carried any more, whether or not the compactor has taken it off the meta file yet.
 */
async function tagged({ db, content }: Deps, contentId: string, tag: string) {
  const row = await loadPublished(db, contentId);
  const [meta, decisions] = await Promise.all([
    requireMeta({ db, content }, contentId),
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
 * the hashtag. An approval that is made is written down on the post; one that was there already
 * isn't written down again.
 */
export async function approveTag(deps: Deps, contentId: string, tag: string, by: Moderator): Promise<{ alreadyApproved: boolean }> {
  const { db, now = Date.now } = deps;
  if ((await tagged(deps, contentId, tag)).approved) return { alreadyApproved: true };

  const at = now();
  try {
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('tag_moderation').values({ content_id: contentId, tag, decision: 'approved', moderator_id: by.id, decided_at: at, applied_at: null }).execute();
      await record(trx, { contentId, tag, decision: 'approved', by, at });
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Another moderator decided meanwhile, and a removal is the last word.
    if ((await db.selectFrom('tag_moderation').select('decision').where('content_id', '=', contentId).where('tag', '=', tag).executeTakeFirst())?.decision === 'removed') {
      throw notTagged(tag);
    }
    return { alreadyApproved: true };
  }
  return { alreadyApproved: false };
}

/**
 * Removes `tag` from content. The removal is recorded, over an approval if there was one, and
 * written down on the post, with `reason` if the moderator gave one. The
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
export async function removeTag(deps: Deps, contentId: string, tag: string, by: Moderator, reason?: string): Promise<Removal> {
  const { db, config, now = Date.now } = deps;
  const { row, meta, removed } = await tagged(deps, contentId, tag);

  const at = now();
  const decision = { decision: 'removed', moderator_id: by.id, decided_at: at, applied_at: null } as const;
  await db.transaction().execute(async (trx) => {
    await updateOnConflict(
      trx.insertInto('tag_moderation').values({ content_id: contentId, tag, ...decision }),
      config.db.dialect,
      ['content_id', 'tag'],
      decision,
    ).execute();
    await record(trx, { contentId, tag, decision: 'removed', by, reason, at });
  });

  return { userId: row.user_id, tags: meta.tags.filter((t) => t !== tag && !removed.has(t)) };
}

/**
 * A post's record of what moderators did to it under its hashtags, oldest first: the newest
 * MAX_TAG_ACTIONS of them, which is all of them for any post but one that was approved again
 * after update upon update.
 */
export async function tagActions(db: Db, contentId: string): Promise<TagAction[]> {
  const rows = await db
    .selectFrom('tag_moderation_log')
    .select(['tag', 'decision', 'moderator_role', 'reason', 'created_at'])
    .where('content_id', '=', contentId)
    .orderBy('created_at', 'desc')
    // Two at the same instant are told apart by their ids, so the list is the same each time it is read.
    .orderBy('id', 'desc')
    .limit(MAX_TAG_ACTIONS)
    .execute();
  return rows.reverse();
}

/**
 * One thing a moderator did to a post, as GET /content/:contentId gives it: what was done
 * (`tag_approved` or `tag_removed`) under which hashtag, as what the moderator did it (`by`: a
 * moderator of the hashtag, a server moderator or an admin, and never who), when, the reason a
 * removal came with, and what it says (`text`), which `say` puts in the reader's language: the
 * words a client shows beside the post.
 */
export function tagActionItem(action: TagAction, say: (text: Message) => string) {
  const params = { tag: action.tag, by: msg(ROLES[action.moderator_role]) };
  return {
    action: action.decision === 'removed' ? ('tag_removed' as const) : ('tag_approved' as const),
    tag: action.tag,
    by: action.moderator_role,
    ...(action.reason !== null && { reason: action.reason }),
    at: iso(action.created_at),
    text: say(
      action.decision === 'approved'
        ? msg('tag_action.approved', params)
        : action.reason === null
          ? msg('tag_action.removed', params)
          : msg('tag_action.removed_for', { ...params, reason: action.reason }),
    ),
  };
}
