/** The server's own list of blocked words, stored under a tag no hashtag can be. */
export const SERVER_LIST = '*';

/** The most words and phrases one list holds. */
export const MAX_LIST_WORDS = 10_000;
/** The longest word or phrase, in characters once normalised. */
export const MAX_WORD_CHARS = 100;
/** The most words in one phrase. */
export const MAX_PHRASE_WORDS = 8;

/** A word is a run of letters, combining marks (which some scripts write vowels with) and digits. */
const WORD = /[\p{L}\p{M}\p{N}]+/gu;
const WORD_CHAR = /^[\p{L}\p{M}\p{N}]+$/u;

/** Lowercase, without the accents of Latin letters, as hashtags are normalised. */
const fold = (text: string) => text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** "  Buy NOW! " -> "buy now"; null for no words, more than MAX_PHRASE_WORDS, or more than MAX_WORD_CHARS. */
export function normalizeWord(input: string): string | null {
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
 * doesn't. A phrase matches its words in a row, whatever separates them.
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
