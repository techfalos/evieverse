import type { Db, DbDialect } from './db/index.js';

/** A tag is a single hashtag word: lowercase letters, digits and underscores. */
export const TAG_PATTERN = /^[a-z0-9_]{1,64}$/;

/** The most hashtags a version can have. */
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
  return TAG_PATTERN.test(tag) ? tag : null;
}

export function normalizeTags(inputs: string[], max = MAX_TAGS): string[] {
  const out = new Set<string>();
  for (const input of inputs) {
    const tag = normalizeTag(input);
    if (tag) out.add(tag);
    if (out.size >= max) break;
  }
  return [...out];
}

/**
 * Hashtags a person chose: a list, or one string of them separated by commas or spaces ("news, #Mumbai").
 * Unlike normalizeTags, it refuses what it can't use instead of dropping it, so nobody's tag silently goes missing.
 */
export function parseTagList(input: string | string[]): { tags: string[] } | { error: string } {
  const words = typeof input === 'string' ? input.split(/[\s,]+/) : input;
  const tags = new Set<string>();
  for (const word of words) {
    if (!word.trim()) continue;
    const tag = normalizeTag(word);
    if (!tag) return { error: `"${word}" is not a usable hashtag: hashtags are letters, digits and underscores` };
    tags.add(tag);
  }
  if (tags.size > MAX_TAGS) return { error: `at most ${MAX_TAGS} hashtags are allowed, got ${tags.size}` };
  return { tags: [...tags] };
}

export function sameTags(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((t) => b.includes(t));
}

/** Records that these tags just received a tail append, so the compactor will merge them. */
export async function touchTags(db: Db, dialect: DbDialect, tags: string[], now: number): Promise<void> {
  // Sorted, so concurrent transactions lock shared tag rows in the same order and can't deadlock.
  for (const name of [...tags].sort()) {
    const insert = db.insertInto('tags').values({ name, created_at: now, last_appended_at: now });
    await (dialect === 'mysql'
      ? insert.onDuplicateKeyUpdate({ last_appended_at: now })
      : insert.onConflict((oc) => oc.column('name').doUpdateSet({ last_appended_at: now }))
    ).execute();
  }
}
