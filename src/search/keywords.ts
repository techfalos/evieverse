import { plainText } from '../format.js';
import { fold } from '../moderation/words.js';
import type { ContentMeta } from '../storage/index.js';
import { normalizeTag } from '../tags.js';
import { STOPWORDS } from './stopwords.js';

/**
 * What a search goes by. A post is found by its keywords, which are rows of `search_terms`: the
 * most frequent words of its text or caption, and its hashtags (keywordsOf). A search is of the
 * words it was asked with, read the same way (queryTerms), and finds the posts that have them
 * all. A user is found by the start of their username, as foldUsername has it.
 *
 * A word is what Intl.Segmenter says one is, which holds for the scripts written without spaces
 * too, in lowercase and without accents (`fold`): "Café" and "CAFE" are the word "cafe". A word
 * with an apostrophe is the words on each side of it, so "Mumbai's" is found by "mumbai", and
 * "l'amour" by "amour". Nothing else is done to a word: "run" doesn't find "running".
 */

/** The longest a word or hashtag a post is found by, in characters: what `search_terms.term` holds. A longer word is no keyword. */
export const MAX_TERM_CHARS = 64;

/** The most words one search looks for: the ones a query has after these are left out. */
export const MAX_QUERY_TERMS = 8;

/** The longest a folded username is kept, in characters: what `users.username_folded` holds. */
export const MAX_FOLDED_USERNAME_CHARS = 255;

/** Says where the words of a text are. English's rules, which differ from any other language's only in what they do with a few marks between letters. */
const SEGMENTER = new Intl.Segmenter('en', { granularity: 'word' });

/** The apostrophes a word is split at, as people type them: the plain one and the curled ones. */
const APOSTROPHE = /['\u2018\u2019\u02bc]/;

/** How a query says that a word of it is a hashtag: it starts with `#`, plain or full-width. */
const HASHTAG = /^[#\uff03]/;

/** A hashtag as a text has it written: a `#`, plain or full-width, that follows no letter or digit, and the letters, digits and underscores after it. */
const WRITTEN_HASHTAG = /(?<![\p{L}\p{M}\p{N}_])[#\uff03][\p{L}\p{M}\p{N}_]+/gu;

/**
 * The words of a text, folded, in the order it has them, each as often as it has it. Not a
 * word longer than MAX_TERM_CHARS, nor a single ASCII letter or digit, which says too little
 * to look for: a single character of a script that writes a word with one is kept.
 */
function wordsOf(text: string): string[] {
  const words: string[] = [];
  for (const { segment, isWordLike } of SEGMENTER.segment(fold(text))) {
    if (!isWordLike) continue;
    for (const word of segment.split(APOSTROPHE)) {
      if (word.length === 0 || word.length > MAX_TERM_CHARS || (word.length === 1 && word.charCodeAt(0) < 128)) continue;
      words.push(word);
    }
  }
  return words;
}

/**
 * The terms the post `meta` describes is found by: the `max` most frequent words of its text or
 * caption, and of two as frequent the one the text has first, without the words that say nothing
 * (STOPWORDS); and every one of its hashtags, whatever `max` is, each once.
 *
 * The text is read as its readers read it, without what formats it (plainText). The server's
 * entry for a post on another server holds no text but the start of the original's, in its
 * preview, which is then what it is found by. A link post has no text: it is found by its
 * hashtags.
 *
 * A hashtag written in the text ("#news") is no word of it: the post is found by the hashtags
 * it has, which are `meta.tags`, and not by one it only writes. So a post stops being found by
 * a hashtag its moderators took off it, whose text still has it written, and a hashtag takes
 * none of the `max` words.
 */
export function keywordsOf(meta: Pick<ContentMeta, 'text' | 'preview' | 'tags'>, max: number): string[] {
  const text = meta.text ?? (meta.preview.kind === 'link' ? undefined : meta.preview.text);
  const counts = new Map<string, number>();
  if (text) {
    for (const word of wordsOf(plainText(text).replace(WRITTEN_HASHTAG, ' '))) {
      if (!STOPWORDS.has(word)) counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  // A map lists its words in the order they first came, and the sort keeps that order among those as frequent.
  const words = [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([word]) => word);
  return [...new Set([...words, ...meta.tags])];
}

/**
 * The terms a search for `q` looks for, MAX_QUERY_TERMS at most, each once: its words, as a
 * post's keywords are read from its text, and its hashtags, which are the words of it that
 * start with `#`, each read as a hashtag is ("#Central-Mumbai" is "centralmumbai"). None for a
 * query with no word in it.
 *
 * The words that say nothing (STOPWORDS) are left out, since no post has one as a keyword,
 * unless the query has nothing else: it is then looked for as it is, and finds the posts that
 * have the word as a hashtag.
 */
export function queryTerms(q: string): string[] {
  const hashtags: string[] = [];
  const words: string[] = [];
  for (const token of q.split(/\s+/)) {
    if (HASHTAG.test(token)) {
      const tag = normalizeTag(token);
      if (tag) hashtags.push(tag);
    } else words.push(...wordsOf(token));
  }
  const telling = words.filter((word) => !STOPWORDS.has(word));
  return [...new Set([...hashtags, ...(telling.length > 0 || hashtags.length > 0 ? telling : words)])].slice(0, MAX_QUERY_TERMS);
}

/**
 * A username as a search compares it, and as `users.username_folded` keeps it: lowercase and
 * without accents, so "José" is found by "jose", and cut to MAX_FOLDED_USERNAME_CHARS
 * characters, which a name of the longest a username is can exceed once the characters that
 * stand for several are written out.
 */
export function foldUsername(username: string): string {
  return [...fold(username)].slice(0, MAX_FOLDED_USERNAME_CHARS).join('');
}
