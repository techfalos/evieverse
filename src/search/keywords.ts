import { addon } from '../native.js';

/**
 * What a search goes by. A post is found by its keywords, which are rows of `search_terms`: the
 * most frequent words of its text or caption, and its hashtags, which the compactor writes as it
 * applies the post (compactor/crates/core/src/search.rs). A search is of the words it was asked
 * with, read the same way (queryTerms), and finds the posts that have them all. A user is found
 * by the start of their username, as foldUsername has it.
 *
 * A word is what Unicode's rules say one is, which holds for the scripts written without spaces
 * too, in lowercase and without accents: "Café" and "CAFE" are the word "cafe". A word with an
 * apostrophe is the words on each side of it, so "Mumbai's" is found by "mumbai", and "l'amour"
 * by "amour". Nothing else is done to a word: "run" doesn't find "running".
 *
 * How a text is read into words is Rust's, so that a query is read as the compactor read the
 * post: these are that code's, reached through the addon (src/native.ts).
 */

/**
 * The terms a search for `q` looks for, a few at most, each once: its words, as a post's keywords
 * are read from its text, and its hashtags, which are the words of it that start with `#`, each
 * read as a hashtag is ("#Central-Mumbai" is "centralmumbai"). None for a query with no word in
 * it.
 *
 * The words that say nothing ("the", "and") are left out, since no post has one as a keyword,
 * unless the query has nothing else: it is then looked for as it is, and finds the posts that
 * have the word as a hashtag.
 */
export function queryTerms(q: string): string[] {
  return addon().queryTerms(q);
}

/**
 * A username as a search compares it, and as `users.username_folded` keeps it: lowercase and
 * without accents, so "José" is found by "jose", and cut to the length of that column, which a
 * name of the longest a username is can exceed once the characters that stand for several are
 * written out.
 */
export function foldUsername(username: string): string {
  return addon().foldUsername(username);
}
