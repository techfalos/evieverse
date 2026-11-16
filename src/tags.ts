import { sql } from 'kysely';
import { updateOnConflict, type Db, type DbDialect } from './db/index.js';
import { msg } from './language.js';
import type { Message } from './language.types.js';

/** The most hashtags a post can have. */
export const MAX_TAGS = 10;

/** "#Central-Mumbai" -> "centralmumbai"; returns null if nothing usable is left. */
export function normalizeTag(input: string): string | null {
  const tag = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/^#+/, '')
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 64);
  // A tag is a single hashtag word: lowercase letters, digits and underscores.
  return /^[a-z0-9_]{1,64}$/.test(tag) ? tag : null;
}

/**
 * Hashtags a person chose: a list, or one string of them separated by commas or spaces ("news, #Mumbai").
 * It refuses what it can't use instead of dropping it, so nobody's tag silently goes missing.
 * `max` is how many there can be: a post's, unless the list is of something else.
 */
export function parseTagList(input: string | string[], max = MAX_TAGS): { tags: string[] } | { error: Message } {
  const tags = new Set<string>();
  for (const word of typeof input === 'string' ? input.split(/[\s,]+/) : input) {
    if (!word.trim()) continue;
    const tag = normalizeTag(word);
    if (!tag) return { error: msg('tags.unusable', { word }) };
    tags.add(tag);
  }
  if (tags.size > max) return { error: msg('tags.too_many', { max, got: tags.size }) };
  return { tags: [...tags] };
}

/**
 * The hashtags a post can have: the server's own in server tagging mode, and any (null) in user mode.
 * Either way a post's hashtags are the ones its publisher chose for it.
 */
export const allowedTags = (tagging: { mode: 'server' | 'user'; serverTags: string[] }): string[] | null =>
  tagging.mode === 'server' ? tagging.serverTags : null;

/** Whether two lists hold the same hashtags, in whatever order. Each is taken to name a hashtag once, as `parseTagList` gives them. */
export function sameTags(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((t) => b.includes(t));
}

/** Records that a post was just published or updated under these tags, which /tags lists hashtags by, and gives a new tag its row. */
export async function touchTags(db: Db, dialect: DbDialect, tags: string[], now: number): Promise<void> {
  // Sorted, so concurrent transactions lock shared tag rows in the same order and can't deadlock.
  for (const name of [...tags].sort()) {
    await updateOnConflict(db.insertInto('tags').values({ name, created_at: now, last_appended_at: now }), dialect, 'name', { last_appended_at: now }).execute();
  }
}

/**
 * Counts a write's hashtags in `tag_pairs`, which is what related hashtags are worked out from:
 * one more post for each hashtag in `added`, and one more for each pair made of one of them and
 * another of the post's `tags`. `added` is every hashtag of new content, and for an update those
 * the content didn't have. One statement, so it holds its rows' locks only for as long as it runs.
 */
export async function countTagPairs(db: Db, dialect: DbDialect, tags: string[], added: string[], now: number): Promise<void> {
  const pairs = new Set<string>();
  for (const a of added) for (const b of tags) pairs.add(a < b ? `${a} ${b}` : `${b} ${a}`);
  if (!pairs.size) return;
  await updateOnConflict(
    db.insertInto('tag_pairs').values(
      // Sorted, so concurrent statements lock shared rows in the same order and can't deadlock.
      [...pairs].sort().map((pair) => {
        const [tag_a, tag_b] = pair.split(' ') as [string, string];
        return { tag_a, tag_b, posts: 1, updated_at: now };
      }),
    ),
    dialect,
    ['tag_a', 'tag_b'],
    // The row's own count, named by its table: Postgres takes a bare `posts` to be ambiguous here.
    { posts: sql<number>`${sql.ref('tag_pairs.posts')} + 1`, updated_at: now },
  ).execute();
}
