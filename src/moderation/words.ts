import { addon } from '../native.js';
import type { Said } from '../native.types.js';

/**
 * Blocked words: the lists the server's admins and each hashtag's moderators keep, of words,
 * phrases and patterns. How an entry is stored and how a text is read for them is Rust's
 * (compactor/crates/trust/src/words.rs), which the compactor's process reads posts with too:
 * these are that code's, reached through the addon (src/native.ts).
 */

/** The limits of a list, and the name the server's own is kept under, as the addon has them. */
const LIMITS = JSON.parse(addon().wordLimits()) as { serverList: string; maxListWords: number; maxListPatterns: number; maxWordChars: number; maxPhraseWords: number; patternBudgetMs: number };

/** The server's own list of blocked words, stored under a tag no hashtag can be. */
export const SERVER_LIST = LIMITS.serverList;

/** The most entries one list holds: words, phrases and patterns. */
export const MAX_LIST_WORDS = LIMITS.maxListWords;
/** Of which this many patterns. A word costs a post nothing more to read, and a pattern is run over all of it. */
export const MAX_LIST_PATTERNS = LIMITS.maxListPatterns;
/** The longest entry, in characters: a word or phrase once normalised, a pattern with its slashes. */
export const MAX_WORD_CHARS = LIMITS.maxWordChars;
/** The most words in one phrase. */
export const MAX_PHRASE_WORDS = LIMITS.maxPhraseWords;
/** How long the patterns of one list get to read one post, in milliseconds. */
export const PATTERN_BUDGET_MS = LIMITS.patternBudgetMs;

/** Lowercase, without the accents of Latin letters, as hashtags are normalised. A search reads the words of a post and of a query the same way (src/search/keywords.ts). */
export const fold = (text: string): string => addon().fold(text);

/**
 * Whether an entry is a pattern, a regular expression written between slashes, and not a word or
 * a phrase. No normalised word starts with a slash, so the lists tell the two apart as they are.
 */
export const isPattern = (entry: string): boolean => addon().isPattern(entry);

/**
 * An entry as it is stored. A word or phrase: "  Buy NOW! " -> "buy now"; null for no words, more
 * than MAX_PHRASE_WORDS, or more than MAX_WORD_CHARS. A pattern, "/垃圾|广告/": trimmed, and
 * composed; null for one that isn't closed by a slash (so `/spam/i` isn't taken for the phrase
 * "spam i"), isn't a regular expression, is longer than MAX_WORD_CHARS, or matches empty text, as
 * it would then match every post.
 */
export const normalizeWord = (input: string): string | null => addon().normalizeWord(input);

/**
 * The lists that have one of their entries in one of `texts`, each of which is read on its own.
 * `lists` holds each list's entries as stored. Only whole words match, whatever their case and
 * accents, and a phrase matches its words in a row, whatever separates them. Each pattern is
 * tried on each text, and matches wherever it is found in it, in the middle of a word too.
 *
 * A list whose patterns take more than PATTERN_BUDGET_MS over the texts counts as having matched:
 * a post the server couldn't finish reading isn't one it found nothing in. `said` is what there
 * is to tell the log of that: which pattern the time ran out on, for whoever keeps the list to
 * write it again.
 */
export async function scanTexts(lists: Map<string, string[]>, texts: string[]): Promise<{ matched: Set<string>; said: Said[] }> {
  const { matched, logs } = JSON.parse(await addon().scanTexts(JSON.stringify({ lists: [...lists], texts }))) as { matched: string[]; logs: Said[] };
  return { matched: new Set(matched), said: logs };
}
