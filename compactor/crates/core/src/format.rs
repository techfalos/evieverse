//! The formatting of the text users write, as this side reads it: a text as its readers read
//! it (`plain_text`), whom of its mentions it names (`mentions_in`), and its start, cut to the
//! length of a preview (`cut_formatted`). The rules are those of src/format.ts, which says
//! what they are and reads a text for the API; fixtures/format.json holds what both make of
//! the same texts.
//!
//! The API's language counts a text in UTF-16 units, and a character outside the Basic
//! Multilingual Plane is two of them, neither of which is a letter. Where the rules look at
//! the one unit before or after a place, such a character is therefore no letter here either
//! (`is_word`), while what follows a name is read character by character (`word_goes_on`).

use unicode_properties::{GeneralCategoryGroup, UnicodeGeneralCategory};

use crate::posts::Mention;
use crate::text::{is_space, trim, units};

/// The longest address of a `[label](address)` link, in UTF-16 units.
const MAX_LINK_ADDRESS: usize = 2048;
/// The characters that end a sentence or a formatted run, and so aren't the end of an address
/// written before them.
const AFTER_ADDRESS: &str = ".,;:!?'*_~";

/// What something open is: a mark, or a link's label.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mark {
    Bold,
    Italic,
    Strike,
    Link,
}

/// What a token is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Text,
    Literal,
    Code,
    Url,
    Mention,
    Break,
    Open,
    Close,
}

/// What a block's text is made of, in order.
#[derive(Debug, Clone)]
struct Token {
    kind: Kind,
    /// As written: the tokens' `src` joined is the block's text.
    src: String,
    /// What a reader reads of it: a text without its backslashes, a code's content, a
    /// mention's `@` and name, an address.
    text: String,
    /// Of a `Mention`: who it mentions.
    user: Option<Mention>,
    /// Of an `Open`: what it opens.
    mark: Option<Mark>,
    /// Of an `Open`: what closes it, as written.
    closer: String,
    /// Of a link's `Open`: its address.
    url: Option<String>,
    /// Of a `Literal`, which is syntax characters that formed nothing: whether they couldn't
    /// have, wherever they stood between the same neighbours (a `*` between spaces). One that
    /// isn't could have opened or closed something, had its other half been there.
    inert: bool,
}

impl Token {
    /// A token of `kind`, written as `src`, that reads as `text`.
    fn of(kind: Kind, src: String, text: String) -> Self {
        Self {
            kind,
            src,
            text,
            user: None,
            mark: None,
            closer: String::new(),
            url: None,
            inert: false,
        }
    }
}

/// Something open, waiting for what closes it: a mark's characters, or a link's `[`.
struct Open {
    ch: char,
    len: usize,
    mark: Mark,
    /// Where its token is among the tokens, and its characters in the text.
    index: usize,
    pos: usize,
}

/// A part of a block, as the tree it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Inline {
    Text(String),
    Code(String),
    Break,
    /// What is bold, italic or struck through.
    Marked(Vec<Inline>),
    Link {
        url: String,
        children: Vec<Inline>,
    },
    Mention(Mention),
}

/// A block of a text: a paragraph or a quote, or a list with its items.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Block {
    Lines(Vec<Inline>),
    List(Vec<Vec<Inline>>),
}

/// A text's blocks, each as the text within it: a list's items one by one, and the number
/// its first was given.
enum Source {
    Lines { quote: bool, src: String },
    List { ordered: bool, start: u64, items: Vec<String> },
}

/// Whether a character is a letter of any script.
fn is_letter(c: char) -> bool {
    c.general_category_group() == GeneralCategoryGroup::Letter
}

/// Whether a character is a letter or a digit of any script.
fn is_letter_or_digit(c: char) -> bool {
    is_letter(c) || c.is_numeric()
}

/// Whether what is at a place is a letter or a digit, as the API's language reads the one
/// unit there: the start and the end of a text are neither, nor is half of a character that
/// takes two units.
fn is_word(c: Option<char>) -> bool {
    c.is_some_and(|c| c.len_utf16() == 1 && is_letter_or_digit(c))
}

/// Whether what is at a place is a space, or isn't there at all: the start and the end of a
/// text count as one.
fn is_gap(c: Option<char>) -> bool {
    c.is_none_or(is_space)
}

/// Whether a character is one no address has, which is what an address ends before.
fn not_in_address(c: char) -> bool {
    is_space(c) || matches!(c, '<' | '>' | '[' | ']' | '`' | '"' | '\\')
}

/// Whether a text starts as an address does and goes on after it: `http://` or `https://`, in
/// any case, and a character that ends no line.
fn is_address(url: &[char]) -> bool {
    let starts = |with: &str| url.len() >= with.len() && url.iter().zip(with.chars()).all(|(a, b)| a.eq_ignore_ascii_case(&b));
    let rest = if starts("https://") {
        8
    } else if starts("http://") {
        7
    } else {
        return false;
    };
    url.get(rest).is_some_and(|c| !matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
}

/// The address written out at `i`, if one is: without the punctuation that follows it.
fn address_at(src: &[char], i: usize) -> Option<&[char]> {
    if i > 0 && is_word(src.get(i - 1).copied()) {
        return None;
    }
    let rest = &src[i..];
    let scheme = ["https://", "http://"]
        .into_iter()
        .find(|with| rest.len() >= with.len() && rest.iter().zip(with.chars()).all(|(a, b)| a.eq_ignore_ascii_case(&b)))?
        .len();
    let more = rest[scheme..].iter().take_while(|c| !not_in_address(**c)).count();
    if more == 0 {
        return None;
    }
    let found = &rest[..scheme + more];
    let mut end = found.len();
    // A `)` ends it only if it closes a `(` that isn't in it: "(see https://example.com/a_(b))".
    let mut unopened: i64 = found.iter().map(|c| i64::from(*c == ')') - i64::from(*c == '(')).sum();
    while end > 0 {
        let last = found[end - 1];
        if last == ')' && unopened > 0 {
            unopened -= 1;
        } else if !AFTER_ADDRESS.contains(last) {
            break;
        }
        end -= 1;
    }
    let url = &found[..end];
    is_address(url).then_some(url)
}

/// The address of a link whose label ends at the `]` at `i`, and where the link ends; none if
/// `](address)` isn't what is there.
fn link_end(src: &[char], i: usize) -> Option<(String, usize)> {
    if src.get(i + 1) != Some(&'(') {
        return None;
    }
    let from = i + 2;
    let mut depth = 0usize;
    let mut units = 0usize;
    for (j, &c) in src.iter().enumerate().skip(from) {
        if units > MAX_LINK_ADDRESS {
            return None;
        }
        units += c.len_utf16();
        if c == '(' {
            depth += 1;
        } else if c == ')' {
            if depth > 0 {
                depth -= 1;
                continue;
            }
            let url = &src[from..j];
            return is_address(url).then(|| (url.iter().collect(), j + 1));
        } else if not_in_address(c) {
            return None;
        }
    }
    None
}

/// Whether the word goes on at `i`, so that a name that ends there isn't the one written: a
/// letter or a digit is there, or a `_` (with its backslash or without) before one.
fn word_goes_on(src: &[char], mut i: usize) -> bool {
    loop {
        match (src.get(i), src.get(i + 1)) {
            (Some('\\'), Some('_')) => i += 2,
            (Some('_'), _) => i += 1,
            (Some(&c), _) => return is_letter_or_digit(c),
            (None, _) => return false,
        }
    }
}

/// Where the name written at `i` ends, if it is `name` and ends there; none if it isn't. It is
/// the name character for character, or with a backslash before a punctuation character of
/// it, which is how an editor that escapes what its user types sends it.
fn name_end(src: &[char], i: usize, name: &str) -> Option<usize> {
    let mut end = i;
    for c in name.chars() {
        if src.get(end) == Some(&'\\') && src.get(end + 1) == Some(&c) && c.is_ascii_punctuation() {
            end += 2;
        } else if src.get(end) == Some(&c) {
            end += 1;
        } else {
            return None;
        }
    }
    (!word_goes_on(src, end)).then_some(end)
}

/// The mentions a text is read with, as `scan` goes through them: the longest name first. One
/// with no name, or with a name of more than one line, is none a text can make.
fn known(mentions: &[Mention]) -> Vec<&Mention> {
    let mut names: Vec<&Mention> = mentions
        .iter()
        .filter(|m| !m.username.is_empty() && !m.username.contains(['\r', '\n']))
        .collect();
    names.sort_by_key(|m| std::cmp::Reverse(m.username.encode_utf16().count()));
    names
}

/// The tokens a block's text is read into, and what is open among them.
struct Scan {
    tokens: Vec<Token>,
    stack: Vec<Open>,
    /// The text read since the last token, which is one of its own once something else comes:
    /// as it is written, and as it reads.
    raw: String,
    text: String,
}

impl Scan {
    /// Makes a token of the text read so far.
    fn flush(&mut self) {
        if !self.raw.is_empty() {
            let (raw, text) = (std::mem::take(&mut self.raw), std::mem::take(&mut self.text));
            self.tokens.push(Token::of(Kind::Text, raw, text));
        }
    }

    /// Syntax characters that formed nothing (see `Token::inert`).
    fn literal(&mut self, chars: String, inert: bool) {
        self.flush();
        self.tokens.push(Token {
            inert,
            ..Token::of(Kind::Literal, chars.clone(), chars)
        });
    }

    /// Opens a mark or a link's label, written with `chars` at `pos`.
    fn open(&mut self, chars: String, mark: Mark, pos: usize) {
        self.flush();
        self.stack.push(Open {
            ch: chars.chars().next().unwrap_or_default(),
            len: chars.chars().count(),
            mark,
            index: self.tokens.len(),
            pos,
        });
        self.tokens.push(Token {
            mark: Some(mark),
            ..Token::of(Kind::Open, chars, String::new())
        });
    }

    /// What was opened and isn't closed is the characters it was written with.
    fn drop(&mut self, open: &Open) {
        let token = &mut self.tokens[open.index];
        token.kind = Kind::Literal;
        token.text = token.src.clone();
        token.inert = false;
    }

    /// Closes what is open at `at` with `chars`, and with it leaves what was opened inside
    /// and not closed.
    fn close(&mut self, at: usize, chars: String, url: Option<String>) {
        self.flush();
        for inner in self.stack.split_off(at + 1) {
            self.drop(&inner);
        }
        if let Some(open) = self.stack.pop() {
            let token = &mut self.tokens[open.index];
            token.closer = chars.clone();
            token.url = url;
            self.tokens.push(Token::of(Kind::Close, chars, String::new()));
        }
    }

    /// The innermost thing open that was written with `ch` and whose length fits.
    fn innermost(&self, ch: char, fits: impl Fn(usize) -> bool) -> Option<usize> {
        self.stack.iter().rposition(|open| open.ch == ch && fits(open.len))
    }

    /// Leaves the thing open at `at`, if there is one, as the characters it was written with.
    fn leave(&mut self, at: Option<usize>) {
        if let Some(at) = at {
            let open = self.stack.remove(at);
            self.drop(&open);
        }
    }
}

/// Reads a block's text into tokens, from left to right, once. What is open is a stack, and
/// what closes something closes the innermost thing it can, so what it leaves is nested.
/// `names` is who the text can mention (see `known`). Where there are any, an `@` that could
/// start a mention and starts none is a literal of its own, so that the start of the text is
/// written with it as the `@` it is (see `cut_formatted`).
fn scan(src: &[char], names: &[&Mention]) -> Vec<Token> {
    let mut s = Scan {
        tokens: Vec::new(),
        stack: Vec::new(),
        raw: String::new(),
        text: String::new(),
    };
    let at = |i: usize| src.get(i).copied();
    let mut i = 0;
    while i < src.len() {
        let ch = src[i];
        match ch {
            '\\' => match at(i + 1) {
                Some(next) if next.is_ascii_punctuation() => {
                    s.raw.push(ch);
                    s.raw.push(next);
                    s.text.push(next);
                    i += 2;
                }
                _ => {
                    s.literal(ch.into(), true);
                    i += 1;
                }
            },
            '\n' => {
                s.flush();
                s.tokens.push(Token::of(Kind::Break, ch.into(), String::new()));
                i += 1;
            }
            '`' => {
                let end = src[i + 1..].iter().position(|c| *c == '`').map(|n| i + 1 + n);
                match end {
                    Some(end) if end > i + 1 && !src[i + 1..end].contains(&'\n') => {
                        s.flush();
                        s.tokens
                            .push(Token::of(Kind::Code, src[i..=end].iter().collect(), src[i + 1..end].iter().collect()));
                        i = end + 1;
                    }
                    _ => {
                        s.literal(ch.into(), false);
                        i += 1;
                    }
                }
            }
            '*' | '_' | '~' => {
                let mut end = i + 1;
                while at(end) == Some(ch) {
                    end += 1;
                }
                let before = if i > 0 { at(i - 1) } else { None };
                let after = at(end);
                // `~~` and nothing else of `~`; one, two or three of the others, three being bold and italic.
                let marks = if ch == '~' { end - i == 2 } else { end - i <= 3 };
                let can_open = marks && !is_gap(after) && !(ch == '_' && is_word(before));
                let can_close = marks && !is_gap(before) && !(ch == '_' && is_word(after));
                let mut left = end - i;
                while can_close && left > 0 {
                    // What is open with as many characters first, so that `**` closes a `**` before it closes a `*`.
                    let mut found = s.innermost(ch, |len| len == left);
                    if found.is_none() && left == 3 {
                        found = s.innermost(ch, |_| true);
                    }
                    if found.is_none() && !can_open {
                        found = s.innermost(ch, |len| len < left);
                    }
                    let Some(found) = found else { break };
                    let len = s.stack[found].len;
                    s.close(found, std::iter::repeat_n(ch, len).collect(), None);
                    left = left.saturating_sub(len);
                }
                let repeat = |n: usize| std::iter::repeat_n(ch, n).collect::<String>();
                if left > 0 && can_open {
                    let lens: &[usize] = if left == 3 { &[2, 1] } else { &[left] };
                    for &len in lens {
                        let mark = if ch == '~' {
                            Mark::Strike
                        } else if len == 2 {
                            Mark::Bold
                        } else {
                            Mark::Italic
                        };
                        if s.stack.iter().any(|open| open.mark == mark) {
                            s.literal(repeat(len), false);
                        } else {
                            s.open(repeat(len), mark, i);
                        }
                    }
                } else if left > 0 {
                    s.literal(repeat(left), !can_close);
                }
                i = end;
            }
            '[' => {
                // The last `[` is the one a `](…)` closes: a link has no link in its label.
                let found = s.innermost('[', |_| true);
                s.leave(found);
                s.open(ch.into(), Mark::Link, i);
                i += 1;
            }
            ']' => {
                let found = s.innermost('[', |_| true);
                let labelled = found.filter(|at| !trim(&src[s.stack[*at].pos + 1..i].iter().collect::<String>()).is_empty());
                let link = link_end(src, i);
                let inert = link.is_none();
                match (link, labelled) {
                    (Some((url, end)), Some(found)) => {
                        s.flush();
                        // An address written out in a label is the label's text, not a link of its own,
                        // and so is a name written in one: it leads where the label does.
                        let from = s.stack[found].index;
                        for token in &mut s.tokens[from..] {
                            match token.kind {
                                Kind::Url => token.src = escaped(&token.src),
                                Kind::Mention => token.src = escaped(&token.text),
                                _ => continue,
                            }
                            token.kind = Kind::Text;
                        }
                        s.close(found, src[i..end].iter().collect(), Some(url));
                        i = end;
                    }
                    _ => {
                        s.leave(found);
                        s.literal(ch.into(), inert);
                        i += 1;
                    }
                }
            }
            '@' if !names.is_empty() && !(i > 0 && is_word(at(i - 1))) => {
                let mention = names.iter().find_map(|user| name_end(src, i + 1, &user.username).map(|end| (*user, end)));
                match mention {
                    Some((user, end)) => {
                        s.flush();
                        s.tokens.push(Token {
                            user: Some(user.clone()),
                            ..Token::of(Kind::Mention, src[i..end].iter().collect(), format!("@{}", user.username))
                        });
                        i = end;
                    }
                    None => {
                        s.literal(ch.into(), false);
                        i += 1;
                    }
                }
            }
            _ => {
                let url = if ch == 'h' || ch == 'H' { address_at(src, i) } else { None };
                match url {
                    Some(url) => {
                        s.flush();
                        let address: String = url.iter().collect();
                        s.tokens.push(Token::of(Kind::Url, address.clone(), address));
                        i += url.len();
                    }
                    None => {
                        s.raw.push(ch);
                        s.text.push(ch);
                        i += 1;
                    }
                }
            }
        }
    }
    s.flush();
    for unclosed in std::mem::take(&mut s.stack) {
        s.drop(&unclosed);
    }
    s.tokens
}

/// Whether a character ends a line, as a pattern's `.` has it: it stands for no such one.
fn ends_line(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// What a line quotes, if it is a quote's: what follows its `>` and the one space or tab after it.
fn quote_of(line: &str) -> Option<&str> {
    let rest = line.strip_prefix('>')?;
    let rest = rest.strip_prefix([' ', '\t']).unwrap_or(rest);
    (!rest.contains(ends_line)).then_some(rest)
}

/// Whether a line is a list's item, and what the item is: with its number, if the list is a
/// numbered one.
fn item_of(line: &str) -> Option<(Option<u64>, &str)> {
    let (number, rest) = match line.strip_prefix(['-', '*']) {
        Some(rest) => (None, rest),
        None => {
            let digits = line.bytes().take_while(u8::is_ascii_digit).count();
            if !(1..=9).contains(&digits) {
                return None;
            }
            (Some(line[..digits].parse().ok()?), line[digits..].strip_prefix('.')?)
        }
    };
    let item = rest.trim_start_matches([' ', '\t']);
    let first = item.chars().next()?;
    (item.len() < rest.len() && !is_space(first) && !item.contains(ends_line)).then_some((number, item))
}

/// A text's blocks: its quotes, its lists, and its paragraphs, which a blank line ends.
fn blocks_of(text: &str) -> Vec<Source> {
    let mut blocks: Vec<Source> = Vec::new();
    // Whether the last block is still open, for the next line to go on with.
    let mut open = false;
    for line in text.replace("\r\n", "\n").replace('\r', "\n").split('\n') {
        if trim(line).is_empty() {
            open = false;
            continue;
        }
        let last = if open { blocks.last_mut() } else { None };
        if let Some(quoted) = quote_of(line) {
            match last {
                Some(Source::Lines { quote: true, src }) => {
                    src.push('\n');
                    src.push_str(quoted);
                }
                _ => blocks.push(Source::Lines {
                    quote: true,
                    src: quoted.to_owned(),
                }),
            }
        } else if let Some((number, item)) = item_of(line) {
            match last {
                Some(Source::List { ordered, items, .. }) if *ordered == number.is_some() => items.push(item.to_owned()),
                _ => blocks.push(Source::List {
                    ordered: number.is_some(),
                    start: number.unwrap_or(1),
                    items: vec![item.to_owned()],
                }),
            }
        } else {
            match last {
                Some(Source::Lines { quote: false, src }) => {
                    src.push('\n');
                    src.push_str(line);
                }
                _ => blocks.push(Source::Lines {
                    quote: false,
                    src: line.to_owned(),
                }),
            }
        }
        open = true;
    }
    blocks
}

/// Tokens as the tree they are: what is between an `Open` and its `Close` is inside it.
fn tree(tokens: Vec<Token>) -> Vec<Inline> {
    // What is open, outermost first, each with the address of the link it is, if it is one.
    let mut stack: Vec<(Option<String>, bool, Vec<Inline>)> = vec![(None, false, Vec::new())];
    for token in tokens {
        match token.kind {
            Kind::Open => stack.push((token.url, token.mark == Some(Mark::Link), Vec::new())),
            Kind::Close => {
                if stack.len() > 1
                    && let Some((url, link, children)) = stack.pop()
                    && let Some((_, _, into)) = stack.last_mut()
                {
                    into.push(if link {
                        Inline::Link {
                            url: url.unwrap_or_default(),
                            children,
                        }
                    } else {
                        Inline::Marked(children)
                    });
                }
            }
            kind => {
                let Some((_, _, into)) = stack.last_mut() else { continue };
                match kind {
                    Kind::Code => into.push(Inline::Code(token.text)),
                    Kind::Break => into.push(Inline::Break),
                    Kind::Url => into.push(Inline::Link {
                        children: vec![Inline::Text(token.text.clone())],
                        url: token.text,
                    }),
                    Kind::Mention => match token.user {
                        Some(user) => into.push(Inline::Mention(user)),
                        None => into.push(Inline::Text(token.text)),
                    },
                    _ => match into.last_mut() {
                        Some(Inline::Text(before)) => before.push_str(&token.text),
                        _ => into.push(Inline::Text(token.text)),
                    },
                }
            }
        }
    }
    stack.into_iter().next().map(|(_, _, root)| root).unwrap_or_default()
}

/// A formatted text as what it says to show: its blocks, and within each what is a link, a
/// mention and so on. `mentions` is who the text mentions, as the server keeps them with it:
/// each `@name` of theirs is a mention, and without them the text has none.
pub fn parse_formatted(text: &str, mentions: &[Mention]) -> Vec<Block> {
    let names = known(mentions);
    let read = |src: &str| tree(scan(&src.chars().collect::<Vec<char>>(), &names));
    blocks_of(text)
        .into_iter()
        .map(|block| match block {
            Source::Lines { src, .. } => Block::Lines(read(&src)),
            Source::List { items, .. } => Block::List(items.iter().map(|item| read(item)).collect()),
        })
        .collect()
}

/// Whom of `mentions` a text mentions, each name once, in the order the text first has them.
/// A user who is there under two names, an old one and a new, is there twice if the text has
/// both: each `@name` of the text is read by its name.
pub fn mentions_in(text: &str, mentions: &[Mention]) -> Vec<Mention> {
    fn read(nodes: &[Inline], found: &mut Vec<Mention>) {
        for node in nodes {
            match node {
                Inline::Mention(user) => {
                    if !found.iter().any(|m| m.username == user.username) {
                        found.push(user.clone());
                    }
                }
                Inline::Marked(children) | Inline::Link { children, .. } => read(children, found),
                _ => {}
            }
        }
    }
    let mut found = Vec::new();
    if mentions.is_empty() || !text.contains('@') {
        return found;
    }
    for block in parse_formatted(text, mentions) {
        match block {
            Block::Lines(children) => read(&children, &mut found),
            Block::List(items) => items.iter().for_each(|item| read(item, &mut found)),
        }
    }
    found
}

/// A line of a text as its readers read it, as it is written out.
struct Line {
    out: String,
    /// An address was the last thing written, so what comes next mustn't run on from it.
    after_address: bool,
    addresses: bool,
}

impl Line {
    /// Writes characters, after a space if they would run on from an address.
    fn write(&mut self, chars: &str) {
        let Some(first) = chars.chars().next() else { return };
        if self.after_address && !is_space(first) {
            self.out.push(' ');
        }
        self.after_address = false;
        self.out.push_str(chars);
    }

    /// Writes what the nodes read as.
    fn read(&mut self, nodes: &[Inline]) {
        for node in nodes {
            match node {
                Inline::Text(text) | Inline::Code(text) => self.write(text),
                Inline::Break => self.write("\n"),
                Inline::Mention(user) => self.write(&format!("@{}", user.username)),
                Inline::Marked(children) => self.read(children),
                Inline::Link { url, children } => {
                    let from = self.out.len();
                    self.read(children);
                    if !self.addresses {
                        continue;
                    }
                    // A link that is written as its address has it already.
                    if trim(&self.out[from..]) != url.as_str() {
                        self.write(&format!(" {url}"));
                    }
                    self.after_address = true;
                }
            }
        }
    }
}

/// A formatted text as its readers read it: the characters that are shown, without the ones
/// that format them. Each block is a line, and so is each item of a list. With `addresses`, a
/// link's address follows its label, so that whoever reads the text for what it says reads
/// where it leads too.
///
/// It is read without its mentions, which it needs none of: a name reads as it is written,
/// `@` and all, whether it mentions someone or not.
pub fn plain_text(text: &str, addresses: bool) -> String {
    let line = |nodes: &[Inline]| {
        let mut line = Line {
            out: String::new(),
            after_address: false,
            addresses,
        };
        line.read(nodes);
        line.out
    };
    let mut lines = Vec::new();
    for block in parse_formatted(text, &[]) {
        match block {
            Block::Lines(children) => lines.push(line(&children)),
            Block::List(items) => lines.extend(items.iter().map(|item| line(item))),
        }
    }
    lines.join("\n")
}

/// Text in which nothing formats anything: each character the format reads gets a backslash.
fn escaped(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    for c in src.chars() {
        if matches!(c, '\\' | '*' | '_' | '~' | '`' | '[' | ']' | '@') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// A text that would start a quote or a list, made the paragraph it is meant to be.
fn as_paragraph(text: String) -> String {
    let mut chars = text.chars();
    let (first, second, third) = (chars.next(), chars.next(), chars.next());
    let item = matches!(first, Some('-' | '*')) && second == Some(' ') && third.is_some_and(|c| !is_space(c));
    if item || first == Some('>') {
        return format!("\\{text}");
    }
    let digits = text.bytes().take_while(u8::is_ascii_digit).count();
    let mut after = text[digits..].chars();
    if (1..=9).contains(&digits) && after.next() == Some('.') && after.next() == Some(' ') && after.next().is_some_and(|c| !is_space(c)) {
        return format!("{}\\{}", &text[..digits], &text[digits..]);
    }
    text
}

/// The start of a text as it is written out (see `cut_formatted`).
struct Cut {
    max_words: usize,
    max_chars: usize,
    out: String,
    /// How long `out` is, in UTF-16 units, which is what `max_chars` counts.
    units: usize,
    words: usize,
    in_word: bool,
    /// A space is to come before what is written next.
    gap: bool,
    cut: bool,
    /// What is open: `waiting` until something in it is written, each as it is written and
    /// with what closes it; then `written`, by what closes it, the innermost last.
    waiting: Vec<(String, String)>,
    written: Vec<String>,
    /// The units `written` will be closed with, which are kept room for.
    closing: usize,
    /// Where `out` ends in an inert literal, which it may be closed after; none if it doesn't.
    tail: Option<usize>,
}

impl Cut {
    fn space(&mut self) {
        self.in_word = false;
        self.gap = true;
    }

    /// Writes what can't be split, with the space and the openings that come before it. False
    /// once the text is cut.
    fn write(&mut self, src: &str, inert: bool) -> bool {
        if self.cut || (!self.in_word && self.words == self.max_words) {
            self.cut = true;
            return false;
        }
        let mut lead = String::new();
        if self.gap && !self.out.is_empty() {
            lead.push(' ');
        }
        for (open, _) in &self.waiting {
            lead.push_str(open);
        }
        let closers: usize = self.waiting.iter().map(|(_, closer)| units(closer)).sum();
        // An inert literal may need its backslashes yet (see `tail`).
        let length = units(src) * if inert { 2 } else { 1 };
        if self.units + units(&lead) + length + self.closing + closers > self.max_chars {
            self.cut = true;
            return false;
        }
        if !self.in_word {
            self.words += 1;
        }
        self.out.push_str(&lead);
        self.closing += closers;
        self.written.extend(self.waiting.drain(..).map(|(_, closer)| closer));
        self.tail = inert.then_some(self.out.len());
        self.out.push_str(src);
        self.units += units(&lead) + units(src);
        self.in_word = true;
        self.gap = false;
        true
    }

    /// Writes text a character at a time, a backslash with what it stands before; code is
    /// `verbatim`, with none.
    fn write_text(&mut self, src: &str, verbatim: bool) -> bool {
        let chars: Vec<char> = src.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            if is_space(chars[i]) {
                self.space();
                i += 1;
                continue;
            }
            let n = if chars[i] == '\\' && !verbatim { 2.min(chars.len() - i) } else { 1 };
            if !self.write(&chars[i..i + n].iter().collect::<String>(), false) {
                return false;
            }
            i += n;
        }
        true
    }

    /// Gives the inert literal `out` ends in its backslashes: what follows it would otherwise
    /// be read with it.
    fn escape_tail(&mut self) {
        if let Some(tail) = self.tail {
            let end = escaped(&self.out[tail..]);
            self.out.truncate(tail);
            self.out.push_str(&end);
            self.units = units(&self.out);
        }
    }

    /// Closes the innermost thing open, with `src`.
    fn close(&mut self, src: &str) {
        // Nothing was written in it: it is left out.
        if self.waiting.pop().is_some() {
            return;
        }
        // The space that was before a link's `]` comes after it here, which leaves the `]` right after the literal.
        if self.gap {
            self.escape_tail();
        }
        self.written.pop();
        self.closing = self.closing.saturating_sub(units(src));
        self.out.push_str(src);
        self.units += units(src);
        self.tail = None;
    }

    /// Writes a block, after what marks it if it is a quote or an item of a list. False once
    /// the text is cut.
    fn write_block(&mut self, src: &str, marker: Option<&str>, names: &[&Mention]) -> bool {
        self.space();
        if let Some(marker) = marker
            && !self.write_text(marker, false)
        {
            return false;
        }
        self.space();
        for token in scan(&src.chars().collect::<Vec<char>>(), names) {
            let whole = match token.kind {
                Kind::Text => self.write_text(&token.src, false),
                Kind::Literal if token.inert => self.write(&token.src, true),
                Kind::Literal => self.write(&escaped(&token.src), false),
                Kind::Url => {
                    if self.write(&token.src, false) {
                        true
                    } else if !self.in_word && self.words == self.max_words {
                        false
                    } else {
                        // It has no room. An address that is cut leads elsewhere, so it is written as text, as far as it goes.
                        self.cut = false;
                        self.write_text(&escaped(&token.src).replacen("://", "\\://", 1), false)
                    }
                }
                Kind::Mention => {
                    // Whole, each word of the name counted, or not at all: the start of a name is nobody's.
                    let spaces = |(runs, after): (usize, bool), c: char| (runs + usize::from(is_space(c) && !after), is_space(c));
                    let more = token.text.chars().fold((0, false), spaces).0;
                    if self.words + usize::from(!self.in_word) + more > self.max_words {
                        self.cut = true;
                        false
                    } else if self.write(&token.src, false) {
                        self.words += more;
                        true
                    } else {
                        false
                    }
                }
                Kind::Code => {
                    self.waiting.push(("`".to_owned(), "`".to_owned()));
                    let whole = self.write_text(&token.text, true);
                    if whole {
                        self.close("`");
                    }
                    whole
                }
                Kind::Open => {
                    self.waiting.push((token.src, token.closer));
                    true
                }
                Kind::Close => {
                    self.close(&token.src);
                    true
                }
                Kind::Break => {
                    self.space();
                    true
                }
            };
            if !whole {
                return false;
            }
        }
        true
    }
}

/// The start of a formatted text, itself a formatted text: its first `max_words` words, of at
/// most `max_chars` characters as written (UTF-16 units), which bounds a text written without
/// spaces. It is one paragraph: what separates words, lines and blocks is a space, and a
/// quote or an item of a list starts with what marks it, as text: `>`, `-`, or the item's
/// number. A text that is cut ends in " …", which the two limits don't count, nor the
/// backslash that keeps a start such as "- milk" from being a list.
///
/// What is bold, a link and so on at the start of the text is so in its start, and nothing
/// else is. Whatever is open where the text is cut is closed there, and what closes it is
/// within `max_chars`: a link is cut before it starts if its address has no room. And what
/// formed nothing in the text is written so that it forms nothing in the start either, where
/// it has other neighbours: a `**` nothing closed gets its backslashes.
///
/// `mentions` is who the text mentions (see `parse_formatted`), and its start is to be read
/// with them too. A mention is written whole, as many words as its name has, or the text is
/// cut before it. And an `@` that mentions nobody gets its backslash, so that it mentions
/// nobody in the start, where a name may end that went on in the text.
pub fn cut_formatted(text: &str, max_words: usize, max_chars: usize, mentions: &[Mention]) -> String {
    let names = known(mentions);
    let mut cut = Cut {
        max_words,
        max_chars,
        out: String::new(),
        units: 0,
        words: 0,
        in_word: false,
        gap: false,
        cut: false,
        waiting: Vec::new(),
        written: Vec::new(),
        closing: 0,
        tail: None,
    };
    'blocks: for block in blocks_of(text) {
        match block {
            Source::Lines { quote, src } => {
                if !cut.write_block(&src, quote.then_some(">"), &names) {
                    break 'blocks;
                }
            }
            Source::List { ordered, start, items } => {
                for (number, item) in (start..).zip(&items) {
                    let marker = if ordered { format!("{number}.") } else { "-".to_owned() };
                    if !cut.write_block(item, Some(&marker), &names) {
                        break 'blocks;
                    }
                }
            }
        }
    }
    if !cut.cut {
        return as_paragraph(cut.out);
    }
    // What closes the text's open marks would otherwise follow the literal, and be read with it.
    cut.escape_tail();
    let mut out = cut.out;
    for closer in cut.written.iter().rev() {
        out.push_str(closer);
    }
    as_paragraph(format!("{out} …"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mention(user_id: &str, username: &str) -> Mention {
        Mention {
            user_id: user_id.to_owned(),
            username: username.to_owned(),
        }
    }

    #[test]
    fn reads_a_text_without_what_formats_it() {
        assert_eq!(plain_text("**bold** and _it_ ~~gone~~ `co*de`", false), "bold and it gone co*de");
        assert_eq!(plain_text("snake_case \\*kept\\* * alone", false), "snake_case *kept* * alone");
        assert_eq!(plain_text("> quoted\n> more\n\n- one\n- two\n1. three", false), "quoted\nmore\none\ntwo\nthree");
        assert_eq!(plain_text("[here](http://example.com)now", true), "here http://example.com now");
        assert_eq!(plain_text("[here](http://example.com)now", false), "herenow");
        assert_eq!(plain_text("see https://example.com/a_(b)).", true), "see https://example.com/a_(b) ).");
        assert_eq!(plain_text("[a *b](https://x.example) c*", false), "a *b c*");
        assert_eq!(plain_text("***both*** **a *b* c**", false), "both a b c");
    }

    /// fixtures/format.json: what the API's own implementation makes of the same texts.
    #[test]
    fn reads_every_text_as_the_api_does() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/format.json");
        let fixture: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let users: Vec<Mention> = serde_json::from_value(fixture["users"].clone()).unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        assert!(cases.len() > 40);
        for case in cases {
            let text = case["text"].as_str().unwrap();
            assert_eq!(plain_text(text, false), case["plain"].as_str().unwrap(), "plain text of {text:?}");
            assert_eq!(
                plain_text(text, true),
                case["addresses"].as_str().unwrap(),
                "plain text with addresses of {text:?}"
            );
            let mentions: Vec<Mention> = serde_json::from_value(case["mentions"].clone()).unwrap();
            assert_eq!(mentions_in(text, &users), mentions, "mentions of {text:?}");
            let cuts = case["cuts"].as_array().unwrap();
            assert!(!cuts.is_empty());
            for cut in cuts {
                let (words, chars) = (cut["words"].as_u64().unwrap() as usize, cut["chars"].as_u64().unwrap() as usize);
                assert_eq!(
                    cut_formatted(text, words, chars, &users),
                    cut["cut"].as_str().unwrap(),
                    "the first {words} words and {chars} characters of {text:?}"
                );
            }
        }
    }

    #[test]
    fn finds_whom_a_text_mentions() {
        let users = [mention("1", "Ann"), mention("2", "Ann Lee"), mention("3", "snake_case")];
        let names = |text: &str| mentions_in(text, &users).into_iter().map(|m| m.username).collect::<Vec<_>>();
        assert_eq!(names("hi @Ann Lee and @Ann, not ann@Ann nor @Annie"), ["Ann Lee", "Ann"]);
        assert_eq!(names("@snake\\_case `@Ann` [@Ann](https://x.example)"), ["snake_case"]);
        assert_eq!(names("@Ann_marie @Ann_ @Ann"), ["Ann"]);
    }
}
