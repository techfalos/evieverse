import type { Db } from './db/index.js';
import type { RepostRow } from './db/schema.js';
import { plainText } from './format.js';
import type { ContentMeta } from './storage/contentStore.types.js';
import { indexAuthor } from './tagfeed/layout.js';

/**
 * Reposts. A repost gives a post that is there more hashtags (POST /repost, routes/reposts.ts). It
 * copies nothing: the post stays one piece of content, with one like count, credited to its
 * publisher. What it adds is rows of `reposts`, one for each index it puts the content in: each
 * hashtag it gave it, and the reposter's own index, which following feeds read.
 *
 * In those indexes the content is placed as a new post: at the time of the repost, counting the
 * likes since. That is the compactor's work (see Placement there), like everything in the index;
 * and it is the compactor that writes the hashtags a repost added into the content's meta file and
 * summary, which is when the content carries them.
 *
 * A post on another server is reposted as content of its own here, which is a link to the
 * original with the original's summary (see ContentMeta.origin). The server holds one such entry
 * per original (`content.origin_hash`), and from then on it is reposted like a post written here.
 */

/** The most hashtags reposts can add to one piece of content, beside the ones its publisher gave it. */
export const MAX_REPOSTED_TAGS = 10;

/** A place a repost gave content, as far as anything but the database's keys goes. */
export type Repost = Pick<RepostRow, 'tag' | 'user_id' | 'likes_before' | 'created_at'>;

/** The places reposts gave a piece of content, oldest first, and those of one repost by tag: the columns of `reposts` that a `Repost` is made of. */
export const repostsOf = (db: Pick<Db, 'selectFrom'>, contentId: string): Promise<Repost[]> =>
  db.selectFrom('reposts').select(['tag', 'user_id', 'likes_before', 'created_at']).where('content_id', '=', contentId).orderBy('created_at').orderBy('tag').execute();

/** The hashtags reposts gave the content: its places but for the reposters' own indexes. */
export const repostedTags = (rows: { tag: string }[]): string[] => rows.filter((r) => indexAuthor(r.tag) === null).map((r) => r.tag);

/** The reposters' own indexes the content is in. */
export const reposterIndexes = (rows: { tag: string }[]): string[] => rows.filter((r) => indexAuthor(r.tag) !== null).map((r) => r.tag);

/**
 * What there is to read of content that is there, as moderation reads a post (see moderatePost):
 * its text or caption without its formatting, or the URL it links to; and, of a repost of a post
 * on another server, the original's address and its publisher's name.
 */
export function readableOf(meta: Pick<ContentMeta, 'preview' | 'text' | 'origin'>): string[] {
  const { preview, origin } = meta;
  const text = meta.text ?? (preview.kind === 'link' ? undefined : preview.text);
  return [preview.kind === 'link' ? preview.url : text && plainText(text, true), origin?.url, origin?.publisher.username].filter((t): t is string => !!t);
}

/** When the content was reposted, once for each repost, oldest first: where its summary is kept beside its own day (see SummaryRef). */
export const repostTimes = (rows: { created_at: number }[]): number[] => [...new Set(rows.map((r) => r.created_at))].sort((a, b) => a - b);
