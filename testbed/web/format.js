// Reads the formatting of a post's text, as a client does to show it: a small subset of Markdown, and no
// HTML. The rules are in docs/TEXT_EDITORS.md, and this is the server's own reading of them (src/format.ts) as
// a page can load it: test/formatting.test.ts holds the two to the same answers.
//
// parseFormatted returns what to show, and no markup: blocks ({ type: 'paragraph' | 'quote', children } and
// { type: 'list', ordered, start, items }) of text, code, breaks, bold, italic, strike, links
// ({ type: 'link', url, children }) and mentions ({ type: 'mention', userId, username }). A link's url is
// http or https, and nothing else is ever a link.
//
// A mention is an `@name` of the text that names one of its `mentions`: the list the server gives beside
// the text ([{ userId, username }]), which parseFormatted takes with it. It is shown as `@username`, and
// leads to the profile of `userId`. A text read without its mentions has none.

const MAX_ADDRESS_CHARS = 2048;

const SPACE = /\s/;
/** ASCII punctuation: what a backslash can stand before. */
const PUNCTUATION = /[!-/:-@[-`{-~]/;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
/** An address written out in a text. It ends before a space and before what no address has. */
const ADDRESS = /https?:\/\/[^\s<>[\]`"\\]+/iy;
const NOT_IN_ADDRESS = /[\s<>[\]`"\\]/;
/** What says, right after a name, that the word goes on, so that the name isn't the one written: `@ann_marie` doesn't mention ann. */
const WORD_GOES_ON = /(?:\\?_)*[\p{L}\p{N}]/uy;
/** What ends a sentence or a formatted run, and so isn't the end of an address written before it. */
const AFTER_ADDRESS = ".,;:!?'*_~";

const isSpace = (c) => c === undefined || SPACE.test(c);
const isWord = (c) => c !== undefined && LETTER_OR_DIGIT.test(c);

/** The address written out at `i`, if one is: without the punctuation that follows it. */
function addressAt(src, i) {
  if (isWord(src[i - 1])) return null;
  ADDRESS.lastIndex = i;
  const found = ADDRESS.exec(src)?.[0];
  if (!found) return null;
  let end = found.length;
  // A `)` ends it only if it closes a `(` that isn't in it.
  let unopened = 0;
  for (const c of found) unopened += c === ')' ? 1 : c === '(' ? -1 : 0;
  for (;;) {
    const last = found[end - 1];
    if (last === ')' && unopened > 0) unopened--;
    else if (!AFTER_ADDRESS.includes(last)) break;
    end--;
  }
  const url = found.slice(0, end);
  return /^https?:\/\/./i.test(url) ? url : null;
}

/** The address of a link whose label ends at the `]` at `i`, and where the link ends; null if `](address)` isn't what is there. */
function linkEnd(src, i) {
  if (src[i + 1] !== '(') return null;
  const from = i + 2;
  let depth = 0;
  for (let j = from; j < src.length && j <= from + MAX_ADDRESS_CHARS; j++) {
    const c = src[j];
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
 * Where the name written at `i` ends, if it is `name` and ends there; null if it isn't. It is the name
 * character for character, or with a backslash before a punctuation character of it (`@snake\_case`).
 */
function nameEnd(src, i, name) {
  let end = i;
  for (const c of name.split('')) {
    if (src[end] === '\\' && src[end + 1] === c && PUNCTUATION.test(c)) end += 2;
    else if (src[end] === c) end++;
    else return null;
  }
  WORD_GOES_ON.lastIndex = end;
  return WORD_GOES_ON.test(src) ? null : end;
}

/** The mention the `@` at `i` starts, and where it ends: of the first of `names` that is written after it. Null if none is. */
function mentionAt(src, i, names) {
  for (const user of names) {
    const end = nameEnd(src, i + 1, user.username);
    if (end !== null) return { user, end };
  }
  return null;
}

/** The mentions a text is read with: the longest name first, so that `@Ann Lee` is Ann Lee where there is an Ann too. A name is on one line. */
const known = (mentions) => mentions.filter((m) => m.username !== '' && !/[\r\n]/.test(m.username)).sort((a, b) => b.username.length - a.username.length);

/**
 * Reads a block's text into tokens, from left to right, once. What is open is a stack, and what closes
 * something closes the innermost thing it can; whatever was opened inside and not closed by then is the
 * characters it was written with. At most one of each mark is open, and one `[`. `names` is who the text
 * can mention (see `known`).
 */
function scan(src, names) {
  const tokens = [];
  const stack = [];
  let text = '';
  const flush = () => {
    if (text) tokens.push({ kind: 'text', text });
    text = '';
  };
  const literal = (chars) => {
    flush();
    tokens.push({ kind: 'text', text: chars });
  };
  const open = (chars, mark, pos) => {
    flush();
    const token = { kind: 'open', text: chars, mark };
    stack.push({ token, ch: chars[0], len: chars.length, index: tokens.length, pos });
    tokens.push(token);
  };
  const drop = ({ token }) => (token.kind = 'text');
  const close = (at, url) => {
    flush();
    for (const inner of stack.splice(at + 1)) drop(inner);
    const { token } = stack.pop();
    if (url !== undefined) token.url = url;
    tokens.push({ kind: 'close' });
  };
  const innermost = (ch, fits = () => true) => stack.findLastIndex((o) => o.ch === ch && fits(o.len));

  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      const next = src[i + 1];
      if (next !== undefined && PUNCTUATION.test(next)) {
        text += next;
        i += 2;
      } else {
        text += ch;
        i++;
      }
    } else if (ch === '\n') {
      flush();
      tokens.push({ kind: 'break' });
      i++;
    } else if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      const content = end < 0 ? '' : src.slice(i + 1, end);
      if (content && !content.includes('\n')) {
        flush();
        tokens.push({ kind: 'code', text: content });
        i = end + 1;
      } else {
        text += ch;
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
        const { len } = stack[at];
        close(at);
        left -= len;
      }
      if (left > 0 && canOpen) {
        for (const len of left === 3 ? [2, 1] : [left]) {
          const mark = ch === '~' ? 'strike' : len === 2 ? 'bold' : 'italic';
          if (stack.some((o) => o.token.mark === mark)) literal(ch.repeat(len));
          else open(ch.repeat(len), mark, i);
        }
      } else if (left > 0) {
        literal(ch.repeat(left));
      }
      i = end;
    } else if (ch === '[') {
      // The last `[` is the one a `](…)` closes: a link has no link in its label.
      const at = innermost('[');
      if (at >= 0) drop(stack.splice(at, 1)[0]);
      open(ch, 'link', i);
      i++;
    } else if (ch === ']') {
      const at = innermost('[');
      const link = linkEnd(src, i);
      if (link && at >= 0 && src.slice(stack[at].pos + 1, i).trim()) {
        flush();
        // An address written out in a label is the label's text, not a link of its own, and so is a name.
        for (const token of tokens.slice(stack[at].index)) if (token.kind === 'url' || token.kind === 'mention') token.kind = 'text';
        close(at, link.url);
        i = link.end;
      } else {
        if (at >= 0) drop(stack.splice(at, 1)[0]);
        literal(ch);
        i++;
      }
    } else if (ch === '@' && names.length > 0 && !isWord(src[i - 1])) {
      const mention = mentionAt(src, i, names);
      if (mention) {
        flush();
        tokens.push({ kind: 'mention', text: `@${mention.user.username}`, user: mention.user });
        i = mention.end;
      } else {
        text += ch;
        i++;
      }
    } else {
      const url = ch === 'h' || ch === 'H' ? addressAt(src, i) : null;
      if (url) {
        flush();
        tokens.push({ kind: 'url', text: url });
        i += url.length;
      } else {
        text += ch;
        i++;
      }
    }
  }
  flush();
  for (const unclosed of stack) drop(unclosed);
  return tokens;
}

/** Tokens as the tree they are: what is between an `open` and its `close` is inside it. */
function tree(tokens) {
  const root = [];
  const stack = [root];
  for (const token of tokens) {
    const into = stack.at(-1);
    if (token.kind === 'open') {
      const children = [];
      into.push(token.mark === 'link' ? { type: 'link', url: token.url, children } : { type: token.mark, children });
      stack.push(children);
    } else if (token.kind === 'close') {
      stack.pop();
    } else if (token.kind === 'code') {
      into.push({ type: 'code', text: token.text });
    } else if (token.kind === 'break') {
      into.push({ type: 'break' });
    } else if (token.kind === 'url') {
      into.push({ type: 'link', url: token.text, children: [{ type: 'text', text: token.text }] });
    } else if (token.kind === 'mention') {
      into.push({ type: 'mention', userId: token.user.userId, username: token.user.username });
    } else {
      const before = into.at(-1);
      if (before?.type === 'text') before.text += token.text;
      else into.push({ type: 'text', text: token.text });
    }
  }
  return root;
}

/**
 * A formatted text as what it says to show: its blocks, and within each what is bold, a link, and so on.
 * `mentions` is who the text mentions, as the server gives them with it; without them it has none.
 */
export function parseFormatted(text, mentions = []) {
  const names = known(mentions);
  const inline = (src) => tree(scan(src, names));
  const blocks = [];
  let last;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!line.trim()) {
      last = undefined;
      continue;
    }
    const quote = /^>[ \t]?(.*)$/.exec(line);
    const item = /^([-*]|\d{1,9}\.)[ \t]+(\S.*)$/.exec(line);
    if (quote) {
      if (last?.type === 'quote') last.src += `\n${quote[1]}`;
      else blocks.push((last = { type: 'quote', src: quote[1] }));
    } else if (item) {
      const ordered = item[1].endsWith('.');
      if (last?.type !== 'list' || last.ordered !== ordered) blocks.push((last = { type: 'list', ordered, start: ordered ? parseInt(item[1], 10) : 1, items: [] }));
      last.items.push(item[2]);
    } else if (last?.type === 'paragraph') {
      last.src += `\n${line}`;
    } else {
      blocks.push((last = { type: 'paragraph', src: line }));
    }
  }
  return blocks.map((block) => (block.type === 'list' ? { ...block, items: block.items.map(inline) } : { type: block.type, children: inline(block.src) }));
}
