import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cutFormatted, parseFormatted, plainText, type Block, type Inline } from '../src/format.js';
import { setAdmin } from '../src/moderation/policy.js';
import { parseFormatted as parseInBrowser } from '../testbed/web/format.js';
import { as, createTestContext, requests, TARGETS, type TestContext } from './helpers.js';

const text = (s: string): Inline => ({ type: 'text', text: s });
const bold = (...children: Inline[]): Inline => ({ type: 'bold', children });
const italic = (...children: Inline[]): Inline => ({ type: 'italic', children });
const strike = (...children: Inline[]): Inline => ({ type: 'strike', children });
const code = (s: string): Inline => ({ type: 'code', text: s });
const link = (url: string, ...children: Inline[]): Inline => ({ type: 'link', url, children: children.length ? children : [text(url)] });
const br: Inline = { type: 'break' };
const p = (...children: Inline[]): Block => ({ type: 'paragraph', children });
const quote = (...children: Inline[]): Block => ({ type: 'quote', children });
const list = (...items: Inline[][]): Block => ({ type: 'list', ordered: false, start: 1, items });
const numbered = (start: number, ...items: Inline[][]): Block => ({ type: 'list', ordered: true, start, items });

/** Texts, and what each says to show. The testbed's page reads them with its own copy of the parser, which is held to the same answers. */
const READS: [string, Block[]][] = [
  ['', []],
  ['plain text', [p(text('plain text'))]],
  ['**bold**, *italic*, ~~gone~~', [p(bold(text('bold')), text(', '), italic(text('italic')), text(', '), strike(text('gone')))]],
  ['__bold__ and _italic_', [p(bold(text('bold')), text(' and '), italic(text('italic')))]],
  ['***both***', [p(bold(italic(text('both'))))]],
  ['**bold *italic***', [p(bold(text('bold '), italic(text('italic'))))]],
  ['*italic **bold***', [p(italic(text('italic '), bold(text('bold'))))]],
  ['*a**b**c*', [p(italic(text('a'), bold(text('b')), text('c')))]],
  ['~~**a** _b_~~', [p(strike(bold(text('a')), text(' '), italic(text('b'))))]],
  // What opens nothing, closes nothing, or is never closed is the characters it is.
  ['2 * 3 * 4, snake_case_name, ~5 and a ~~ b', [p(text('2 * 3 * 4, snake_case_name, ~5 and a ~~ b'))]],
  ['**never closed and * neither*', [p(text('**never closed and * neither*'))]],
  ['a****b and ~~~c~~~', [p(text('a****b and ~~~c~~~'))]],
  ['*a *b* c*', [p(italic(text('a *b')), text(' c*'))]],
  ['sp**am**', [p(text('sp'), bold(text('am')))]],
  ['\\*not italic\\* and \\\\ and a\\b', [p(text('*not italic* and \\ and a\\b'))]],
  ['a `code *x* \\` b', [p(text('a '), code('code *x* \\'), text(' b'))]],
  ['a ` b\nand ` c', [p(text('a ` b'), br, text('and ` c'))]],
  ['a `` b', [p(text('a `` b'))]],
  ['[label](https://example.com/a_(b))', [p(link('https://example.com/a_(b)', text('label')))]],
  ['[**bold** label](http://x.example)', [p(link('http://x.example', bold(text('bold')), text(' label')))]],
  ['see https://example.com/x_y. (And https://example.com/z)', [p(text('see '), link('https://example.com/x_y'), text('. (And '), link('https://example.com/z'), text(')'))]],
  ['**https://example.com**', [p(bold(link('https://example.com')))]],
  ['[https://a.example/x_y](https://b.example)', [p(link('https://b.example', text('https://a.example/x_y')))]],
  ['[1] see [this](https://x.example)', [p(text('[1] see '), link('https://x.example', text('this')))]],
  ['[a *b](https://x.example) c*', [p(link('https://x.example', text('a *b')), text(' c*'))]],
  // Nothing but http and https is a link, and no tag is anything but its characters.
  ['[a](javascript:alert(1)) [b](data:text/html,x) [c](//x.example) [d](/path)', [p(text('[a](javascript:alert(1)) [b](data:text/html,x) [c](//x.example) [d](/path)'))]],
  ['<b onclick="x()">hi</b> <script>alert(1)</script> &amp;', [p(text('<b onclick="x()">hi</b> <script>alert(1)</script> &amp;'))]],
  ['[](https://x.example) [ ](https://x.example)', [p(text('[]('), link('https://x.example'), text(') [ ]('), link('https://x.example'), text(')'))]],
  ['[a](https://x.example "title") xhttps://x.example', [p(text('[a]('), link('https://x.example'), text(' "title") xhttps://x.example'))]],
  ['one\ntwo\n\nthree', [p(text('one'), br, text('two')), p(text('three'))]],
  ['**one\ntwo**\n\n**three\n\nfour**', [p(bold(text('one'), br, text('two'))), p(text('**three')), p(text('four**'))]],
  ['> said\n>so\n>\n> twice', [quote(text('said'), br, text('so'), br, br, text('twice'))]],
  ['- a\n* **b**\n\n3. c\n4. d\n- e', [list([text('a')], [bold(text('b'))]), numbered(3, [text('c')], [text('d')]), list([text('e')])]],
  ['-5 degrees\n1.5 litres\n \\- not a list\n\\> nor a quote', [p(text('-5 degrees'), br, text('1.5 litres'), br, text(' - not a list'), br, text('> nor a quote'))]],
  ['intro\r\n- a\r\n\r\nend', [p(text('intro')), list([text('a')]), p(text('end'))]],
];

describe('formatted text', () => {
  it.each(READS)('reads %j', (source, blocks) => {
    expect(parseFormatted(source)).toEqual(blocks);
    expect(parseInBrowser(source)).toEqual(blocks);
  });

  it('reads a text as its readers do, with where its links lead', () => {
    const source = 'sp**am** and [click *here*](https://spam.example/buy), or https://x.example\n\n> quoted\n\n- one\n- `two`';
    expect(plainText(source)).toBe('spam and click here, or https://x.example\nquoted\none\ntwo');
    expect(plainText(source, true)).toBe('spam and click here https://spam.example/buy , or https://x.example\nquoted\none\ntwo');
  });

  it('ends a link’s address where it ends, whatever the text goes on with', () => {
    // Read as it stands, "http://bad.examplenow" would be another host.
    expect(plainText('[x](http://bad.example)now', true)).toBe('x http://bad.example now');
    expect(plainText('**[x](http://bad.example)**now', true)).toBe('x http://bad.example now');
    expect(plainText('[x](http://bad.example)`now`', true)).toBe('x http://bad.example now');
    expect(plainText('[x](http://bad.example)[y](http://worse.example)', true)).toBe('x http://bad.example y http://worse.example');
    // A link written as its address has it once, and it ends there too.
    expect(plainText('[http://bad.example](http://bad.example)now', true)).toBe('http://bad.example now');
    expect(plainText('**http://bad.example**, _http://bad.example_. and http://bad.example<now', true)).toBe('http://bad.example , http://bad.example . and http://bad.example <now');
    // Where a space or a new line follows already, or nothing does, nothing is added.
    expect(plainText('[x](http://bad.example) now\n[y](http://bad.example)\nthen', true)).toBe('x http://bad.example now\ny http://bad.example\nthen');
    // Without the addresses, the text is as it reads.
    expect(plainText('[x](http://bad.example)now and http://bad.example<now')).toBe('xnow and http://bad.example<now');
  });

  it('cuts a text to its first words, closing what the cut leaves open', () => {
    const cut = (source: string, words: number, chars = 1000) => cutFormatted(source, words, chars);
    // A text with no formatting is cut as it always was: its words, a space between them.
    expect(cut('  one two\n\nthree  ', 5)).toBe('one two three');
    expect(cut('one two\tthree four', 3)).toBe('one two three …');
    expect(cut('字'.repeat(50), 5, 10)).toBe(`${'字'.repeat(10)} …`);
    expect(cut(`a${'😀'.repeat(10)}`, 5, 10)).toBe(`a${'😀'.repeat(4)} …`);

    expect(cut('**one two three four**', 2)).toBe('**one two** …');
    expect(cut('*a **b c** d*', 2)).toBe('*a **b*** …');
    expect(cut('**a *b c* d**', 2)).toBe('**a *b*** …');
    expect(cut('~~_a b_~~ c', 1)).toBe('~~_a_~~ …');
    expect(cut('see [the long label here](https://example.com) ok', 3)).toBe('see [the long](https://example.com) …');
    expect(cut('`a b c` d', 2)).toBe('`a b` …');
    // What is cut before it starts isn't opened.
    expect(cut('one **two** [three](https://example.com)', 1)).toBe('one …');
    // What closes it has its room kept: the link's address doesn't fit after its label, so the cut comes before the link.
    expect(cut('go [here now](https://example.com/a/long/path)', 5, 30)).toBe('go …');
    expect(cut('**abcdefgh**', 5, 8)).toBe('**abcd** …');
    // An address that is cut leads elsewhere, so it isn't a link.
    expect(cut('https://example.com/a_very_long_path', 5, 22)).toBe('https\\://example.com/a …');
    expect(parseFormatted(cut('https://example.com/a_very_long_path', 5, 22))).toEqual([p(text('https://example.com/a …'))]);

    // One paragraph: blocks and lines are joined, with what marked them as text.
    expect(cut('intro\n\n- milk\n- eggs\n\n> said\n> twice\n\n7. seven\n8. eight', 20)).toBe('intro - milk - eggs > said twice 7. seven 8. eight');
    expect(cut('- milk\n- eggs', 20)).toBe('\\- milk - eggs');
    expect(cut('> said', 20)).toBe('\\> said');
    expect(cut('3. three\n4. four', 20)).toBe('3\\. three 4. four');
    expect(parseFormatted(cut('- milk\n- eggs', 20))).toEqual([p(text('- milk - eggs'))]);

    // What formed nothing in the text forms nothing in its start, where it has other neighbours.
    expect(cut('**oops\n\nfine** x', 20)).toBe('\\*\\*oops fine\\*\\* x');
    expect(cut('see [1\n\nfoo](https://example.com)', 20)).toBe('see \\[1 foo\\](https://example.com)');
    expect(cut('a ` b\n\nc ` d', 20)).toBe('a \\` b c \\` d');
    expect(cut('**a ~ b c**', 2)).toBe('**a \\~** …');
    expect(cut('2 * 3 * 4 and snake_case', 20)).toBe('2 * 3 * 4 and snake_case');
    // The space before a link's end comes after it, which mustn't leave the backslash before the `]`.
    expect(cut('[a \\ ](https://x.co) b', 20)).toBe('[a \\\\](https://x.co) b');
    // An address in a label is text, and cut where its `_` would otherwise close the italic around the link.
    const labelled = cut('_see [https://x.co/a_b c](https://x.co/a_b) d_', 9, 42);
    expect(labelled).toBe('_see [https://x.co/a\\_](https://x.co/a_b)_ …');
    expect(parseFormatted(labelled)).toEqual([p(italic(text('see '), link('https://x.co/a_b', text('https://x.co/a_'))), text(' …'))]);
  });

  /** Each character a reader reads, by word, with how it is shown: "b" for bold, a link's address, and so on. */
  function shown(blocks: Block[]): [string, string][][] {
    const chars: [string, string][] = [];
    const walk = (nodes: Inline[], marks: string[]) => {
      for (const node of nodes) {
        if (node.type === 'break') chars.push([' ', '']);
        else if (node.type === 'text' || node.type === 'code') for (const c of node.text) chars.push([c, [...marks, ...(node.type === 'code' ? ['code'] : [])].sort().join()]);
        else walk(node.children, [...marks, node.type === 'link' ? node.url : node.type]);
      }
    };
    const block = (nodes: Inline[], marker?: string) => {
      chars.push([' ', ''], ...[...(marker ?? '')].map((c): [string, string] => [c, '']), [' ', '']);
      walk(nodes, []);
    };
    for (const b of blocks) {
      if (b.type === 'list') b.items.forEach((item, i) => block(item, b.ordered ? `${b.start + i}.` : '-'));
      else block(b.children, b.type === 'quote' ? '>' : undefined);
    }
    const words: [string, string][][] = [];
    let word: [string, string][] | undefined;
    for (const char of chars) {
      if (/\s/.test(char[0])) word = undefined;
      else if (word) word.push(char);
      else words.push((word = [char]));
    }
    return words;
  }

  it('cuts any text to a start that reads as the text does', () => {
    // A small generator, the same texts on every run.
    let seed = 20261115;
    const random = (n: number) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
    };
    const PIECES = ['a', 'b', 'c', 'é', '😀', ' ', ' ', ' ', '\n', '\n\n', '*', '*', '**', '**', '***', '_', '__', '~~', '~', '`', '[', ']', '](https://x.co/a_b)', '(', ')', '\\', '.', '- ', '> ', '1. ', 'https://x.co/a_(b)*c', '[https://x.co/a_b', '<b>'];
    for (let run = 0; run < 8000; run++) {
      const source = Array.from({ length: random(24) }, () => PIECES[random(PIECES.length)]).join('');
      const maxWords = 1 + random(8);
      const maxChars = random(4) ? 1000 : 4 + random(40);
      const start = cutFormatted(source, maxWords, maxChars);
      const where = JSON.stringify({ source, maxWords, maxChars, start });

      const whole = shown(parseFormatted(source));
      const cut = start.endsWith('…') && !source.trimEnd().endsWith('…');
      const blocks = parseFormatted(cut ? start.slice(0, -1) : start);
      expect(blocks.length, where).toBeLessThanOrEqual(1);
      expect(blocks.every((b) => b.type === 'paragraph' && !b.children.some((node) => node.type === 'break')), where).toBe(true);
      const words = shown(blocks);
      expect(words.length, where).toBeLessThanOrEqual(maxWords);
      if (!cut) expect(words, where).toEqual(whole);
      if (cut && maxChars === 1000) expect(words.length, where).toBe(maxWords);
      // Within the limit, but for " …" and the backslash a start that looks like a list is given.
      expect(start.length, where).toBeLessThanOrEqual(maxChars + 3);

      words.forEach((word, i) => {
        const last = cut && i === words.length - 1;
        // The last word may be cut short, and an address that is, is no link.
        const expected = last ? whole[i]!.slice(0, word.length) : whole[i]!;
        const unlinked = (chars: [string, string][]) => chars.map(([c, marks]) => [c, marks.replace(/,?https:[^,]*/, '').replace(/^,/, '')]);
        if (last && word.length < whole[i]!.length) expect(unlinked(word), where).toEqual(unlinked(expected));
        else expect(word, where).toEqual(expected);
      });
    }
  });
});

for (const target of TARGETS) {
  describe(`formatted posts and comments (${target.name})`, () => {
    let ctx: TestContext;
    beforeEach(async () => {
      ctx = await createTestContext(target);
    });
    afterEach(async () => {
      await ctx.close();
    });
    const { storeText, post } = requests(() => ctx);

    it('stores a text as written, tags and all, and previews its start with the formatting whole', async () => {
      const alice = await ctx.register('alice');
      const source = `<b>Not bold</b>, **bold**, and [a link](https://example.com/page).\n\n**${Array.from({ length: 150 }, (_, i) => `w${i}`).join(' ')}** #long`;
      const res = await storeText(alice, source);
      expect(res.statusCode).toBe(201);
      const { contentId, preview } = res.json();
      // Its first 100 words, with the bold that the cut leaves open closed.
      expect(preview.text).toMatch(/^<b>Not bold<\/b>, \*\*bold\*\*, and \[a link\]\(https:\/\/example\.com\/page\)\. \*\*w0 w1 .* w93\*\* …$/);
      expect(preview.text.split(' ')).toHaveLength(101);
      expect((await ctx.app.inject({ method: 'GET', url: `/content/${contentId}` })).json()).toMatchObject({ text: source, preview });
      expect((await ctx.app.inject({ method: 'GET', url: `/content/${contentId}/raw` })).body).toBe(source);
    });

    it('reads a post and a comment for blocked words as their readers read them, and where their links lead', async () => {
      const root = await ctx.register('root');
      await setAdmin(ctx.db, root.userId, true);
      const alice = await ctx.register('alice');
      const blocked = await ctx.app.inject({ method: 'POST', url: '/moderation/blocked-words', headers: as(root), payload: { words: ['spam', 'buy now'] } });
      expect(blocked.statusCode, blocked.body).toBe(200);

      const contentId = await post(alice, 'An honest post #news', { comments: true });
      const comment = (text: string) => ctx.app.inject({ method: 'POST', url: `/content/${contentId}/comments`, headers: as(alice), payload: { text } });
      for (const text of ['sp**am**', 's*p*a~~m~~', '**buy** _now_', 'sp\\_am is s\\pam, [click](https://spam.example/deals)', '- buy\n- now']) {
        expect((await storeText(alice, `${text} #news`)).statusCode, text).toBe(422);
        expect((await comment(text)).statusCode, text).toBe(422);
      }
      // What a reader doesn't read as the word isn't it: the characters are shown, not hidden.
      for (const text of ['sp\\*\\*am\\*\\*', 'sp_am and s\\pam', '<b>sp</b>am']) {
        expect((await storeText(alice, `${text} #news`)).statusCode, text).toBe(201);
        expect((await comment(text)).statusCode, text).toBe(201);
      }
    });

    it('quotes a comment in a notice as it reads', async () => {
      const root = await ctx.register('root');
      await setAdmin(ctx.db, root.userId, true);
      const [alice, bob] = [await ctx.register('alice'), await ctx.register('bob')];
      const contentId = await post(alice, 'Say something #news', { comments: true });
      const sent = await ctx.app.inject({ method: 'POST', url: `/content/${contentId}/comments`, headers: as(bob), payload: { text: '**Loud** and [linked](https://example.com/x)\n\n- twice' } });
      expect(sent.statusCode, sent.body).toBe(201);
      const removed = await ctx.app.inject({ method: 'DELETE', url: `/content/${contentId}/comments/${sent.json().commentId}`, headers: as(root) });
      expect(removed.statusCode, removed.body).toBe(200);
      const { inbox } = (await ctx.app.inject({ method: 'GET', url: `/users/${bob.userId}/inbox`, headers: as(bob) })).json();
      expect(inbox.map((m: { kind: string; excerpt: string }) => [m.kind, m.excerpt])).toEqual([['comment_deleted', 'Loud and linked twice']]);
    });
  });
}
