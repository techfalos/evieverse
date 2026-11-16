import type { FastifyBaseLogger } from 'fastify';
import { createContext, Script, type Context } from 'node:vm';

/** The server's own list of blocked words, stored under a tag no hashtag can be. */
export const SERVER_LIST = '*';

/** The most entries one list holds: words, phrases and patterns. */
export const MAX_LIST_WORDS = 10_000;
/** Of which this many patterns. A word costs a post nothing more to read, and a pattern is run over all of it. */
export const MAX_LIST_PATTERNS = 100;
/** The longest entry, in characters: a word or phrase once normalised, a pattern with its slashes. */
export const MAX_WORD_CHARS = 100;
/** The most words in one phrase. */
export const MAX_PHRASE_WORDS = 8;
/** How long the patterns of one list get to read one post, in milliseconds. */
export const PATTERN_BUDGET_MS = 100;

/** A word is a run of letters, combining marks (which some scripts write vowels with) and digits. */
const WORD = /[\p{L}\p{M}\p{N}]+/gu;
/** Whether a string is made of the characters a word is, and nothing else. `trailingWord` asks it of one character at a time. */
const WORD_CHAR = /^[\p{L}\p{M}\p{N}]+$/u;

/** Whatever their case, and by code point, so that `.` and a class take a whole character of any script. */
const PATTERN_FLAGS = 'iu';

/**
 * The script that runs patterns in the sandbox: it tries each pattern of the sandbox's `job` on
 * each of its texts, in order, and stops at the first that matches, with `job.hit` set. `job.at`
 * is the pattern it is at, so the one it was stopped on if its time ran out.
 */
const RUN_PATTERNS = new Script(`{
  const { patterns, texts } = job;
  run: for (; job.at < patterns.length; job.at++) {
    for (const text of texts) {
      if (patterns[job.at].test(text)) {
        job.hit = true;
        break run;
      }
    }
  }
}`);

/**
 * Without the accents of Latin letters, and with one way of writing each character: full-width
 * letters as plain ones, a letter and the mark it was typed with as the one letter. Case is left
 * to a pattern's `i` flag.
 */
const plain = (text: string) => text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').normalize('NFC');

/** Lowercase, without the accents of Latin letters, as hashtags are normalised. */
const fold = (text: string) => text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/**
 * Whether an entry is a pattern, a regular expression written between slashes, and not a word or
 * a phrase. No normalised word starts with a slash, so the lists tell the two apart as they are.
 */
export const isPattern = (entry: string): boolean => entry.trimStart().startsWith('/');

/**
 * The regular expression of a pattern as stored, which reads text made `plain`. What isn't ASCII
 * in it is made plain as the text is, so `/café/` finds "CAFE" and `/ｓｐａｍ/` finds "spam". What
 * that turns into ASCII is written as escapes, so it stays the characters it was and never
 * becomes syntax: a full-width `？` is a question mark to find, not a quantifier.
 */
function compilePattern(entry: string): RegExp {
  return new RegExp(
    entry.slice(1, -1).replace(/[^\x00-\x7f]+/g, (run) => plain(run).replace(/[\x00-\x7f]/g, (c) => `\\u{${c.charCodeAt(0).toString(16)}}`)),
    PATTERN_FLAGS,
  );
}

/**
 * "/垃圾|广告/" as it is stored: trimmed, and composed. null for one that isn't closed by a slash
 * (so `/spam/i` isn't taken for the phrase "spam i"), isn't a regular expression, is longer than
 * MAX_WORD_CHARS, or matches empty text, as it would then match every post.
 */
function normalizePattern(input: string): string | null {
  const entry = input.trim().normalize('NFC');
  if (entry.length < 3 || entry.length > MAX_WORD_CHARS || !entry.endsWith('/')) return null;
  try {
    // As written too: making it plain mustn't make a pattern of what isn't one.
    new RegExp(entry.slice(1, -1), PATTERN_FLAGS);
    return compilePattern(entry).test('') ? null : entry;
  } catch {
    return null;
  }
}

/**
 * An entry as it is stored. A word or phrase: "  Buy NOW! " -> "buy now"; null for no words, more
 * than MAX_PHRASE_WORDS, or more than MAX_WORD_CHARS. A pattern: see normalizePattern.
 */
export function normalizeWord(input: string): string | null {
  if (isPattern(input)) return normalizePattern(input);
  const words = fold(input).match(WORD) ?? [];
  const phrase = words.join(' ');
  return words.length && words.length <= MAX_PHRASE_WORDS && phrase.length <= MAX_WORD_CHARS ? phrase : null;
}

/** Where the word at the end of `text` starts; `text.length` if it doesn't end in one. */
function trailingWord(text: string): number {
  let i = text.length;
  while (i > 0) {
    const code = text.charCodeAt(i - 1);
    const n = code >= 0xdc00 && code <= 0xdfff && i > 1 ? 2 : 1;
    if (!WORD_CHAR.test(text.slice(i - n, i))) break;
    i -= n;
  }
  return i;
}

/**
 * Finds which lists have a word or phrase in the texts it's given, which can arrive in chunks of any
 * size. Only whole words match, whatever their case and accents: "Spam!" matches "spam", "spammers"
 * doesn't. A phrase matches its words in a row, whatever separates them. Patterns aren't its to
 * read (see scanTexts).
 */
export class WordScanner {
  /** Each word or phrase, and the lists holding it. */
  private readonly lists = new Map<string, string[]>();
  /** How many words the phrases have. */
  private readonly lengths: number[];
  private readonly longest: number;
  private recent: string[] = [];
  /** The end of the last chunk, if it may be the start of a word the next chunk finishes. */
  private carry = '';
  /** The lists that matched so far. */
  readonly matched = new Set<string>();

  /** `words` holds each list's normalised words and phrases. */
  constructor(words: Map<string, string[]>) {
    for (const [list, entries] of words) {
      for (const entry of entries) this.lists.set(entry, [...(this.lists.get(entry) ?? []), list]);
    }
    this.lengths = [...new Set([...this.lists.keys()].map((e) => e.split(' ').length))];
    this.longest = Math.max(0, ...this.lengths);
  }

  /** The next chunk of the current text. */
  feed(chunk: string): void {
    const text = this.carry + fold(chunk);
    const end = trailingWord(text);
    // No entry is longer than MAX_WORD_CHARS, so neither is a word worth finishing.
    this.carry = text.slice(end, end + MAX_WORD_CHARS + 1);
    for (const word of text.slice(0, end).match(WORD) ?? []) this.word(word);
  }

  /** Ends the current text; no phrase spans it and the next. */
  end(): void {
    if (this.carry) this.word(this.carry);
    this.carry = '';
    this.recent = [];
  }

  /** One whole text. */
  scan(text: string): void {
    this.feed(text);
    this.end();
  }

  private word(word: string) {
    this.recent.push(word);
    if (this.recent.length > this.longest) this.recent.shift();
    for (const n of this.lengths) {
      if (n > this.recent.length) continue;
      for (const list of this.lists.get(n === 1 ? word : this.recent.slice(-n).join(' ')) ?? []) this.matched.add(list);
    }
  }
}

/** What the script that runs patterns is given, and leaves its answer in. */
interface PatternJob {
  patterns: RegExp[];
  texts: string[];
  /** The pattern it is at: the one time ran out on, if it did. */
  at: number;
  hit: boolean;
}

/**
 * Where patterns run. Some take longer to say no than a server stays up (`(a+)+$`, of a row of
 * a's that ends otherwise), and nothing stops a pattern that is run as it is. Node does stop a
 * script that outruns the time it is given, whatever the script is doing, so a script runs them.
 */
let sandbox: Context | undefined;

/** Whether one of `patterns` matches one of `texts`; `slow` is the pattern PATTERN_BUDGET_MS ran out on, if it did. */
function runPatterns(patterns: RegExp[], texts: string[]): { hit: boolean; slow?: number } {
  sandbox ??= createContext({});
  const job: PatternJob = { patterns, texts, at: 0, hit: false };
  sandbox.job = job;
  try {
    RUN_PATTERNS.runInContext(sandbox, { timeout: PATTERN_BUDGET_MS });
    return { hit: job.hit };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw err;
    return { hit: false, slow: job.at };
  } finally {
    sandbox.job = undefined;
  }
}

/**
 * The lists that have one of their entries in one of `texts`, each of which is read on its own.
 * `lists` holds each list's entries as stored. Its words and phrases are a WordScanner's to find.
 * Each of its patterns is tried on each text made `plain`, and matches wherever it is found in
 * it, in the middle of a word too: that is what blocks a word of a script written without spaces.
 *
 * A list whose patterns take more than PATTERN_BUDGET_MS over the texts counts as having matched:
 * a post the server couldn't finish reading isn't one it found nothing in. `log` is told which
 * pattern the time ran out on, for whoever keeps the list to write it again.
 */
export function scanTexts(lists: Map<string, string[]>, texts: string[], log?: Pick<FastifyBaseLogger, 'warn'>): Set<string> {
  const words = new Map<string, string[]>();
  const patterns = new Map<string, string[]>();
  for (const [list, entries] of lists) {
    const listPatterns = entries.filter(isPattern);
    if (listPatterns.length) patterns.set(list, listPatterns);
    if (listPatterns.length < entries.length) words.set(list, entries.filter((entry) => !isPattern(entry)));
  }
  const matched = new Set<string>();
  if (words.size) {
    const scanner = new WordScanner(words);
    for (const text of texts) scanner.scan(text);
    for (const list of scanner.matched) matched.add(list);
  }
  const plainTexts = patterns.size ? texts.map(plain) : [];
  for (const [list, entries] of patterns) {
    // A word of the list already said what its patterns would.
    if (matched.has(list)) continue;
    const { hit, slow } = runPatterns(entries.map(compilePattern), plainTexts);
    if (slow !== undefined) {
      log?.warn({ list, pattern: entries[slow], budgetMs: PATTERN_BUDGET_MS }, 'a blocked pattern took too long to read a post, which counts as matching it');
    }
    if (hit || slow !== undefined) matched.add(list);
  }
  return matched;
}
