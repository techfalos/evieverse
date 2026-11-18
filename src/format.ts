import type { Mention } from './mentions.types.js';

/**
 * The formatting of the text users write: a text post's text, a caption, and a comment's text.
 * It is a small subset of Markdown and no HTML. A tag is the characters it is written with, as in
 * any text: nothing here reads one, and a client shows it as written.
 *
 * The server stores a text as it was sent, and so do its responses give it. It reads the
 * formatting for two things: to cut a preview that is whole (cutFormatted), and to read a text
 * as its readers do when it looks for blocked words (plainText). Clients read it to show it, by
 * the same rules, which are these; docs/TEXT_EDITORS.md has them with examples.
 *
 * Blocks, each told by how its lines start, at the very start of the line:
 * - `> ` a quote, of the lines in a row that start so;
 * - `- ` or `* ` an item of a bulleted list, and `1. ` (any number) one of a numbered list;
 * - any other lines in a row are a paragraph, which a blank line ends.
 * A new line within a paragraph or a quote is a line break.
 *
 * Within a block:
 * - `**bold**` or `__bold__`, `*italic*` or `_italic_`, `~~struck through~~`: what opens one is
 *   followed by something other than a space, and what closes it follows one. A `_` within a
 *   word is itself, so snake_case is. They nest, but not each in itself;
 * - `` `code` ``, on one line, in which nothing else is read;
 * - `[label](https://address)`, and an address written out on its own (https://example.com),
 *   are links. An address is http or https and nothing else, with no space in it;
 * - `@name` mentions a user, where the name is one of the text's mentions: the users the server
 *   found by the names written in it when it was sent, which it keeps beside the text and gives
 *   with it (src/mentions.ts). A name is as its user has it, with its spaces: nothing here
 *   says what a name is made of, and a text read without its mentions has none. The `@` doesn't
 *   follow a letter or a digit, so an address such as ann@example.com mentions nobody, and the
 *   name isn't followed by one, nor by a `_` within a word. Of two names that fit, the longer
 *   is the one. Nothing is a mention in code, or in the label of a link;
 * - a backslash before a punctuation character makes it that character: `\*`, and `\@`.
 *
 * Whatever doesn't fit these is the text it is written with: there is no text the format refuses.
 */

type Mark = 'bold' | 'italic' | 'strike';

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'break' }
  | { type: Mark; children: Inline[] }
  | { type: 'link'; url: string; children: Inline[] }
  /** Shown as `@username`, and leads to the user's profile: `userId` is whose it is. */
  | { type: 'mention'; userId: string; username: string };

export type Block =
  | { type: 'paragraph' | 'quote'; children: Inline[] }
  /** `start` is the number a numbered list starts at. */
  | { type: 'list'; ordered: boolean; start: number; items: Inline[][] };

/** A whitespace character: what separates words, and what a mark can't open before or close after. */
const SPACE = /\s/;
/** ASCII punctuation: what a backslash can stand before. */
const PUNCTUATION = /[!-/:-@[-`{-~]/;
/** A letter or a digit of any script. A `_` between two of them is within a word, and an address written out doesn't start right after one. */
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
/** An address written out in a text. It ends before a space and before what no address has. */
const ADDRESS = /https?:\/\/[^\s<>[\]`"\\]+/iy;
/** A character no address has, which is what ADDRESS ends before: with one in its `(address)`, a `[label](address)` is no link. */
const NOT_IN_ADDRESS = /[\s<>[\]`"\\]/;
/** What says, right after a name, that the word goes on, so that the name isn't the one written: a letter or a digit, or a `_` (with its backslash or without) before one. `@ann_marie` doesn't mention ann. */
const WORD_GOES_ON = /(?:\\?_)*[\p{L}\p{N}]/uy;
/** A line break, which no name that is mentioned has: a mention is on one line. */
const LINE_BREAK = /[\r\n]/;

/** Whether `c` is a space, or isn't there at all (undefined): the start and the end of a text count as one. */
const isSpace = (c: string | undefined) => c === undefined || SPACE.test(c);
/** Whether `c` is a letter or a digit. The start and the end of a text (undefined) are neither. */
const isWord = (c: string | undefined) => c !== undefined && LETTER_OR_DIGIT.test(c);

/** What a block's text is made of, in order: its `src` joined is the text. */
interface Token {
  kind: 'text' | 'literal' | 'code' | 'url' | 'mention' | 'break' | 'open' | 'close';
  /** As written. */
  src: string;
  /** What a reader reads of it: a text without its backslashes, a code's content, a mention's `@` and name. */
  text: string;
  /** Of a `mention`: who it mentions. */
  user?: Mention;
  /** Of an `open` and a `close`: what it opens or closes. */
  mark?: Mark | 'link';
  /** Of an `open`: what closes it, as written. */
  closer?: string;
  /** Of a link's `open`: its address. */
  url?: string;
  /**
   * Of a `literal`, which is syntax characters that formed nothing: whether they couldn't have,
   * wherever they stood between the same neighbours (a `*` between spaces). One that isn't could
   * have opened or closed something, had its other half been there.
   */
  inert?: boolean;
}

/** Something open, waiting for what closes it: a mark's characters, or a link's `[`. */
interface Open {
  token: Token;
  ch: string;
  len: number;
  /** Where its token is among the tokens, and its characters in the text. */
  index: number;
  pos: number;
}

/** The address written out at `i`, if one is: without the punctuation that follows it. */
function addressAt(src: string, i: number): string | null {
  if (isWord(src[i - 1])) return null;
  ADDRESS.lastIndex = i;
  const found = ADDRESS.exec(src)?.[0];
  if (!found) return null;
  let end = found.length;
  // A `)` ends it only if it closes a `(` that isn't in it: "(see https://example.com/a_(b))".
  let unopened = 0;
  for (const c of found) unopened += c === ')' ? 1 : c === '(' ? -1 : 0;
  for (;;) {
    const last = found[end - 1]!;
    if (last === ')' && unopened > 0) unopened--;
    // These end a sentence or a formatted run, and so aren't the end of an address written before them.
    else if (!".,;:!?'*_~".includes(last)) break;
    end--;
  }
  const url = found.slice(0, end);
  return /^https?:\/\/./i.test(url) ? url : null;
}

/** The address of a link whose label ends at the `]` at `i`, and where the link ends; null if `](address)` isn't what is there. */
function linkEnd(src: string, i: number): { url: string; end: number } | null {
  if (src[i + 1] !== '(') return null;
  const from = i + 2;
  let depth = 0;
  // 2048 characters is the longest address of a `[label](address)` link.
  for (let j = from; j < src.length && j <= from + 2048; j++) {
    const c = src[j]!;
    if (c === '(') depth++;
    else if (c === ')') {
      if (depth-- > 0) continue;
      const url = src.slice(from, j);
      return /^https?:\/\/./i.test(url) ? { url, end: j + 1 } : null;
    } else if (NOT_IN_ADDRESS.test(c)) return null;
  }
  return null;
}

/**
 * Where the name written at `i` ends, if it is `name` and ends there (see WORD_GOES_ON); null if
 * it isn't. It is the name character for character, or with a backslash before a punctuation
 * character of it, which is how an editor that escapes what its user types sends it:
 * `@snake\_case` names snake_case.
 */
function nameEnd(src: string, i: number, name: string): number | null {
  let end = i;
  for (const c of name.split('')) {
    if (src[end] === '\\' && src[end + 1] === c && PUNCTUATION.test(c)) end += 2;
    else if (src[end] === c) end++;
    else return null;
  }
  WORD_GOES_ON.lastIndex = end;
  return WORD_GOES_ON.test(src) ? null : end;
}

/** The mention the `@` at `i` starts, and where it ends: of the first of `names` that is written after it, which is the longest (see `known`). Null if none is. */
function mentionAt(src: string, i: number, names: Mention[]): { user: Mention; end: number } | null {
  for (const user of names) {
    const end = nameEnd(src, i + 1, user.username);
    if (end !== null) return { user, end };
  }
  return null;
}

/**
 * The mentions a text is read with, as `scan` goes through them: the longest name first, so that
 * `@Ann Lee` is Ann Lee where there is an Ann too. One with no name, or with a name of more than
 * one line, is none a text can make.
 */
const known = (mentions: readonly Mention[]): Mention[] => mentions.filter((m) => m.username !== '' && !LINE_BREAK.test(m.username)).sort((a, b) => b.username.length - a.username.length);

/** Text in which nothing formats anything: each character the format reads gets a backslash. */
const escaped = (src: string) => src.replace(/[\\*_~`[\]@]/g, '\\$&');

/**
 * Reads a block's text into tokens, from left to right, once. What is open is a stack, and what
 * closes something closes the innermost thing it can, so what it leaves is nested: whatever was
 * opened inside and not closed by then is the characters it was written with (`[a *b](…)`).
 *
 * At most one of each mark is open, and one `[`, so nothing nests deeper than four.
 *
 * `names` is who the text can mention (see `known`). Where there are any, an `@` that could
 * start a mention and starts none is a literal of its own, so that the start of the text is
 * written with it as the `@` it is (see cutFormatted).
 */
function scan(src: string, names: Mention[] = []): Token[] {
  const tokens: Token[] = [];
  const stack: Open[] = [];
  let raw = '';
  let text = '';
  const flush = () => {
    if (raw) tokens.push({ kind: 'text', src: raw, text });
    raw = text = '';
  };
  const literal = (chars: string, inert: boolean) => {
    flush();
    tokens.push({ kind: 'literal', src: chars, text: chars, inert });
  };
  const open = (chars: string, mark: Mark | 'link', pos: number) => {
    flush();
    const token: Token = { kind: 'open', src: chars, text: '', mark };
    stack.push({ token, ch: chars[0]!, len: chars.length, index: tokens.length, pos });
    tokens.push(token);
  };
  /** What was opened and isn't closed: the characters it was written with. */
  const drop = ({ token }: Open) => Object.assign(token, { kind: 'literal', text: token.src, inert: false });
  const close = (at: number, chars: string, url?: string) => {
    flush();
    for (const inner of stack.splice(at + 1)) drop(inner);
    const { token } = stack.pop()!;
    token.closer = chars;
    if (url !== undefined) token.url = url;
    tokens.push({ kind: 'close', src: chars, text: '', mark: token.mark });
  };
  const innermost = (ch: string, fits: (len: number) => boolean = () => true) => stack.findLastIndex((o) => o.ch === ch && fits(o.len));

  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '\\') {
      const next = src[i + 1];
      if (next !== undefined && PUNCTUATION.test(next)) {
        raw += ch + next;
        text += next;
        i += 2;
      } else {
        literal(ch, true);
        i++;
      }
    } else if (ch === '\n') {
      flush();
      tokens.push({ kind: 'break', src: ch, text: '' });
      i++;
    } else if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      const content = end < 0 ? '' : src.slice(i + 1, end);
      if (content && !content.includes('\n')) {
        flush();
        tokens.push({ kind: 'code', src: src.slice(i, end + 1), text: content });
        i = end + 1;
      } else {
        literal(ch, false);
        i++;
      }
    } else if (ch === '*' || ch === '_' || ch === '~') {
      let end = i + 1;
      while (src[end] === ch) end++;
      const before = src[i - 1];
      const after = src[end];
      // `~~` and nothing else of `~`; one, two or three of the others, three being bold and italic.
      const marks = ch === '~' ? end - i === 2 : end - i <= 3;
      const canOpen = marks && !isSpace(after) && !(ch === '_' && isWord(before));
      const canClose = marks && !isSpace(before) && !(ch === '_' && isWord(after));
      let left = end - i;
      while (canClose && left > 0) {
        // What is open with as many characters first, so that `**` closes a `**` before it closes a `*`.
        let at = innermost(ch, (len) => len === left);
        if (at < 0 && left === 3) at = innermost(ch);
        if (at < 0 && !canOpen) at = innermost(ch, (len) => len < left);
        if (at < 0) break;
        const { len } = stack[at]!;
        close(at, ch.repeat(len));
        left -= len;
      }
      if (left > 0 && canOpen) {
        for (const len of left === 3 ? [2, 1] : [left]) {
          const mark: Mark = ch === '~' ? 'strike' : len === 2 ? 'bold' : 'italic';
          if (stack.some((o) => o.token.mark === mark)) literal(ch.repeat(len), false);
          else open(ch.repeat(len), mark, i);
        }
      } else if (left > 0) {
        literal(ch.repeat(left), !canClose);
      }
      i = end;
    } else if (ch === '[') {
      // The last `[` is the one a `](…)` closes: a link has no link in its label.
      const at = innermost('[');
      if (at >= 0) drop(stack.splice(at, 1)[0]!);
      open(ch, 'link', i);
      i++;
    } else if (ch === ']') {
      const at = innermost('[');
      const link = linkEnd(src, i);
      if (link && at >= 0 && src.slice(stack[at]!.pos + 1, i).trim()) {
        flush();
        // An address written out in a label is the label's text, not a link of its own.
        for (const token of tokens.slice(stack[at]!.index)) {
          if (token.kind === 'url') Object.assign(token, { kind: 'text', src: escaped(token.src) });
          // And so is a name written in one: it leads where the label does.
          else if (token.kind === 'mention') Object.assign(token, { kind: 'text', src: escaped(token.text) });
        }
        close(at, src.slice(i, link.end), link.url);
        i = link.end;
      } else {
        if (at >= 0) drop(stack.splice(at, 1)[0]!);
        literal(ch, !link);
        i++;
      }
    } else if (ch === '@' && names.length > 0 && !isWord(src[i - 1])) {
      const mention = mentionAt(src, i, names);
      if (mention) {
        flush();
        tokens.push({ kind: 'mention', src: src.slice(i, mention.end), text: `@${mention.user.username}`, user: mention.user });
        i = mention.end;
      } else {
        literal(ch, false);
        i++;
      }
    } else {
      const url = ch === 'h' || ch === 'H' ? addressAt(src, i) : null;
      if (url) {
        flush();
        tokens.push({ kind: 'url', src: url, text: url });
        i += url.length;
      } else {
        raw += ch;
        text += ch;
        i++;
      }
    }
  }
  flush();
  for (const unclosed of stack) drop(unclosed);
  return tokens;
}

/** A text's blocks, each as the text within it: a list's items one by one, and the number its first was given. */
type Source = { type: 'paragraph' | 'quote'; src: string } | { type: 'list'; ordered: boolean; start: number; items: string[] };

function blocksOf(text: string): Source[] {
  const blocks: Source[] = [];
  let last: Source | undefined;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!line.trim()) {
      last = undefined;
      continue;
    }
    const quote = /^>[ \t]?(.*)$/.exec(line);
    const item = /^([-*]|\d{1,9}\.)[ \t]+(\S.*)$/.exec(line);
    if (quote) {
      if (last?.type === 'quote') last.src += `\n${quote[1]}`;
      else blocks.push((last = { type: 'quote', src: quote[1]! }));
    } else if (item) {
      const ordered = item[1]!.endsWith('.');
      if (last?.type !== 'list' || last.ordered !== ordered) blocks.push((last = { type: 'list', ordered, start: ordered ? parseInt(item[1]!, 10) : 1, items: [] }));
      last.items.push(item[2]!);
    } else if (last?.type === 'paragraph') {
      last.src += `\n${line}`;
    } else {
      blocks.push((last = { type: 'paragraph', src: line }));
    }
  }
  return blocks;
}

/** Tokens as the tree they are: what is between an `open` and its `close` is inside it. */
function tree(tokens: Token[]): Inline[] {
  const root: Inline[] = [];
  const stack = [root];
  for (const token of tokens) {
    const into = stack.at(-1)!;
    if (token.kind === 'open') {
      const children: Inline[] = [];
      into.push(token.mark === 'link' ? { type: 'link', url: token.url!, children } : { type: token.mark as Mark, children });
      stack.push(children);
    } else if (token.kind === 'close') {
      stack.pop();
    } else if (token.kind === 'code') {
      into.push({ type: 'code', text: token.text });
    } else if (token.kind === 'break') {
      into.push({ type: 'break' });
    } else if (token.kind === 'url') {
      into.push({ type: 'link', url: token.src, children: [{ type: 'text', text: token.src }] });
    } else if (token.kind === 'mention') {
      into.push({ type: 'mention', userId: token.user!.userId, username: token.user!.username });
    } else {
      const before = into.at(-1);
      if (before?.type === 'text') before.text += token.text;
      else into.push({ type: 'text', text: token.text });
    }
  }
  return root;
}

/**
 * A formatted text as what it says to show: its blocks, and within each what is bold, a link, and
 * so on. `mentions` is who the text mentions, as the server gives them with it: each `@name` of
 * theirs is a mention, and without them the text has none.
 */
export function parseFormatted(text: string, mentions: readonly Mention[] = []): Block[] {
  const names = known(mentions);
  return blocksOf(text).map((block): Block => {
    if (block.type !== 'list') return { type: block.type, children: tree(scan(block.src, names)) };
    return { ...block, items: block.items.map((item) => tree(scan(item, names))) };
  });
}

/**
 * Whom of `mentions` a text mentions, each name once, in the order the text first has them. A
 * user who is there under two names, an old one and a new, is there twice if the text has both:
 * each `@name` of the text is read by its name.
 */
export function mentionsIn(text: string, mentions: readonly Mention[]): Mention[] {
  if (!mentions.length || !text.includes('@')) return [];
  const found = new Map<string, Mention>();
  const read = (nodes: Inline[]) => {
    for (const node of nodes) {
      if (node.type === 'mention') found.set(node.username, found.get(node.username) ?? { userId: node.userId, username: node.username });
      else if ('children' in node) read(node.children);
    }
  };
  for (const block of parseFormatted(text, mentions)) (block.type === 'list' ? block.items : [block.children]).forEach(read);
  return [...found.values()];
}

/**
 * Every name a text could mention: what follows each `@` that could start a mention, up to each
 * place a name could end, on its line, both as it is written and as it reads without the
 * backslashes of an editor that escapes (see nameEnd). That is more than the names it does
 * mention, which only whoever knows the users can tell (src/mentions.ts): it is what to look
 * for. `sites` is how many such `@` are read, from the start of the text, and `chars` how long a
 * name can be.
 */
export function mentionable(text: string, { sites, chars }: { sites: number; chars: number }): Set<string> {
  const names = new Set<string>();
  let read = 0;
  for (let at = text.indexOf('@'); at >= 0 && read < sites; at = text.indexOf('@', at + 1)) {
    if (isWord(text[at - 1])) continue;
    read++;
    let written = '';
    let name = '';
    for (let i = at + 1; i < text.length && name.length < chars; ) {
      const ch = text[i]!;
      // A name is on one line, and starts with no space.
      if (LINE_BREAK.test(ch) || (name === '' && SPACE.test(ch))) break;
      const next = text[i + 1];
      const pair = ch === '\\' && next !== undefined && PUNCTUATION.test(next);
      written += pair ? ch + next : ch;
      name += pair ? next : ch;
      i += pair ? 2 : 1;
      WORD_GOES_ON.lastIndex = i;
      // Nor does it end with one, or where the word goes on.
      if (SPACE.test(ch) || WORD_GOES_ON.test(text)) continue;
      names.add(name);
      if (written.length <= chars) names.add(written);
    }
  }
  return names;
}

/**
 * A formatted text as its readers read it: the characters that are shown, without the ones that
 * format them. Each block is a line, and so is each item of a list. With `addresses`, a link's
 * address follows its label, so that whoever reads the text for what it says reads where it
 * leads too. The address ends where it ends: a space follows it if the text goes on right after
 * the link, as in `[here](http://example.com)now`, which would otherwise read as one address.
 *
 * It is read without its mentions, which it needs none of: a name reads as it is written, `@`
 * and all, whether it mentions someone or not.
 */
export function plainText(text: string, addresses = false): string {
  const line = (nodes: Inline[]): string => {
    let out = '';
    // An address was the last thing written, so what comes next mustn't run on from it.
    let afterAddress = false;
    const write = (chars: string) => {
      if (!chars) return;
      if (afterAddress && !isSpace(chars[0])) out += ' ';
      afterAddress = false;
      out += chars;
    };
    const read = (nodes: Inline[]) => {
      for (const node of nodes) {
        if (node.type === 'text' || node.type === 'code') write(node.text);
        else if (node.type === 'break') write('\n');
        else if (node.type === 'mention') write(`@${node.username}`);
        else {
          const from = out.length;
          read(node.children);
          if (node.type !== 'link' || !addresses) continue;
          // A link that is written as its address has it already.
          if (out.slice(from).trim() !== node.url) write(` ${node.url}`);
          afterAddress = true;
        }
      }
    };
    read(nodes);
    return out;
  };
  return parseFormatted(text)
    .flatMap((block) => (block.type === 'list' ? block.items.map(line) : [line(block.children)]))
    .join('\n');
}

/** A text that would start a quote or a list, made the paragraph it is meant to be. */
function asParagraph(text: string): string {
  if (/^(?:[-*] \S|>)/.test(text)) return `\\${text}`;
  return text.replace(/^(\d{1,9})(\. \S)/, '$1\\$2');
}

/**
 * The start of a formatted text, itself a formatted text: its first `maxWords` words, of at most
 * `maxChars` characters as written, which bounds a text written without spaces. It is one
 * paragraph: what separates words, lines and blocks is a space, and a quote or an item of a list
 * starts with what marks it, as text: `>`, `-`, or the item's number. A text that is cut ends in
 * " …", which the two limits don't count, nor the backslash that keeps a start such as "- milk"
 * from being a list.
 *
 * What is bold, a link and so on at the start of the text is so in its start, and nothing else
 * is. Whatever is open where the text is cut is closed there, and what closes it is within
 * `maxChars`: a link is cut before it starts if its address has no room. And what formed nothing
 * in the text is written so that it forms nothing in the start either, where it has other
 * neighbours: a `**` nothing closed gets its backslashes.
 *
 * `mentions` is who the text mentions (see parseFormatted), and its start is to be read with
 * them too. A mention is written whole, as many words as its name has, or the text is cut before
 * it. And an `@` that mentions nobody gets its backslash, so that it mentions nobody in the
 * start, where a name may end that went on in the text: "@Ann Lee" isn't the start of
 * "@Ann Leeds".
 */
export function cutFormatted(text: string, maxWords: number, maxChars: number, mentions: readonly Mention[] = []): string {
  const names = known(mentions);
  let out = '';
  let words = 0;
  let inWord = false;
  let gap = false;
  let cut = false;
  /** What is open: `waiting` until something in it is written, then `written`, the innermost last. */
  const waiting: Token[] = [];
  const written: Token[] = [];
  /** The characters `written` will be closed with, which are kept room for. */
  let closing = 0;
  /** Where `out` ends in an inert literal, which it may be closed after; -1 if it doesn't. */
  let tail = -1;

  const space = () => {
    inWord = false;
    gap = true;
  };
  /** Writes what can't be split, with the space and the openings that come before it. False once the text is cut. */
  const write = (src: string, inert = false): boolean => {
    if (cut || (!inWord && words === maxWords)) return !(cut = true);
    const lead = (gap && out ? ' ' : '') + waiting.map((token) => token.src).join('');
    const closers = waiting.reduce((n, token) => n + token.closer!.length, 0);
    // An inert literal may need its backslashes yet (see `tail`).
    if (out.length + lead.length + src.length * (inert ? 2 : 1) + closing + closers > maxChars) return !(cut = true);
    if (!inWord) words++;
    out += lead;
    closing += closers;
    written.push(...waiting.splice(0));
    tail = inert ? out.length : -1;
    out += src;
    inWord = true;
    gap = false;
    return true;
  };
  /** Writes text a character at a time, a backslash with what it stands before; code is `verbatim`, with none. */
  const writeText = (src: string, verbatim = false): boolean => {
    for (let i = 0; i < src.length; ) {
      const code = src.charCodeAt(i);
      if (SPACE.test(src[i]!)) {
        space();
        i++;
        continue;
      }
      // A backslash and what follows it, and the two halves of a surrogate pair, stay together.
      const n = (src[i] === '\\' && !verbatim) || (code >= 0xd800 && code <= 0xdbff) ? 2 : 1;
      if (!write(src.slice(i, i + n))) return false;
      i += n;
    }
    return true;
  };
  const close = (src: string) => {
    // Nothing was written in it: it is left out.
    if (waiting.pop()) return;
    // The space that was before a link's `]` comes after it here, which leaves the `]` right after the literal.
    if (tail >= 0 && gap) out = out.slice(0, tail) + escaped(out.slice(tail));
    written.pop();
    closing -= src.length;
    out += src;
    tail = -1;
  };
  const writeBlock = (src: string, marker?: string): boolean => {
    space();
    if (marker !== undefined && !writeText(marker)) return false;
    space();
    return scan(src, names).every((token: Token): boolean => {
      switch (token.kind) {
        case 'text':
          return writeText(token.src);
        case 'literal':
          return token.inert ? write(token.src, true) : write(escaped(token.src));
        case 'url':
          if (write(token.src)) return true;
          if (!inWord && words === maxWords) return false;
          // It has no room. An address that is cut leads elsewhere, so it is written as text, as far as it goes.
          cut = false;
          return writeText(escaped(token.src).replace('://', '\\://'));
        case 'mention': {
          // Whole, each word of the name counted, or not at all: the start of a name is nobody's.
          const more = token.text.split(/\s+/).length - 1;
          if (words + (inWord ? 0 : 1) + more > maxWords) return !(cut = true);
          if (!write(token.src)) return false;
          words += more;
          return true;
        }
        case 'code':
          waiting.push({ kind: 'open', src: '`', text: '', closer: '`' });
          if (!writeText(token.text, true)) return false;
          close('`');
          return true;
        case 'open':
          waiting.push(token);
          return true;
        case 'close':
          close(token.src);
          return true;
        case 'break':
          space();
          return true;
      }
    });
  };

  blocksOf(text).every((block) =>
    block.type === 'list'
      ? block.items.every((item, i) => writeBlock(item, block.ordered ? `${block.start + i}.` : '-'))
      : writeBlock(block.src, block.type === 'quote' ? '>' : undefined),
  );
  if (!cut) return asParagraph(out);
  // What closes the text's open marks would otherwise follow the literal, and be read with it.
  if (tail >= 0) out = out.slice(0, tail) + escaped(out.slice(tail));
  for (const token of written.reverse()) out += token.closer!;
  return asParagraph(`${out} …`);
}
