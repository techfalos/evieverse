//! Blocked words: the lists the server's admins and each hashtag's moderators keep, of words,
//! phrases and patterns, and how a text is read for them.

use std::collections::{BTreeSet, HashMap, VecDeque};

use evieverse_core::log::Logger;
pub use evieverse_core::text::fold;
use evieverse_core::text::{is_accent, units};
use serde_json::json;
use unicode_normalization::UnicodeNormalization;
use unicode_properties::{GeneralCategoryGroup, UnicodeGeneralCategory};

use crate::lines::{is_space, trim};
use crate::patterns::{self, PATTERN_BUDGET};

/// The server's own list of blocked words, stored under a tag no hashtag can be.
pub const SERVER_LIST: &str = "*";

/// The most entries one list holds: words, phrases and patterns.
pub const MAX_LIST_WORDS: usize = 10_000;
/// Of which this many patterns. A word costs a post nothing more to read, and a pattern is
/// run over all of it.
pub const MAX_LIST_PATTERNS: usize = 100;
/// The longest entry, in characters: a word or phrase once normalised, a pattern with its
/// slashes. Characters are counted as the API always counted them: in UTF-16 units.
pub const MAX_WORD_CHARS: usize = 100;
/// The most words in one phrase.
pub const MAX_PHRASE_WORDS: usize = 8;
/// How long the patterns of one list get to read one post, in milliseconds.
pub const PATTERN_BUDGET_MS: u64 = 100;

/// Whether a character is one a word is made of: a letter, a combining mark (which some
/// scripts write vowels with) or a digit.
fn is_word_char(c: char) -> bool {
    matches!(
        c.general_category_group(),
        GeneralCategoryGroup::Letter | GeneralCategoryGroup::Mark | GeneralCategoryGroup::Number
    )
}

/// Without the accents of Latin letters, and with one way of writing each character:
/// full-width letters as plain ones, a letter and the mark it was typed with as the one
/// letter. Case is left to a pattern's `i` flag.
pub fn plain(text: &str) -> String {
    text.nfkd().filter(|c| !is_accent(*c)).nfc().collect()
}

/// The words of a text, in order: its runs of the characters a word is made of.
fn words_of(text: &str) -> impl Iterator<Item = &str> {
    text.split(|c: char| !is_word_char(c)).filter(|word| !word.is_empty())
}

/// Whether an entry is a pattern, a regular expression written between slashes, and not a
/// word or a phrase. No normalised word starts with a slash, so the lists tell the two apart
/// as they are.
pub fn is_pattern(entry: &str) -> bool {
    entry.trim_start_matches(is_space).starts_with('/')
}

/// The regular expression of a pattern as stored, which reads text made `plain`. What isn't
/// ASCII in it is made plain as the text is, so `/café/` finds "CAFE" and `/ｓｐａｍ/` finds
/// "spam". What that turns into ASCII is written as escapes, so it stays the characters it
/// was and never becomes syntax: a full-width `？` is a question mark to find, not a
/// quantifier.
fn source_of(entry: &str) -> String {
    let inner = entry.get(1..entry.len().saturating_sub(1)).unwrap_or("");
    let mut source = String::with_capacity(inner.len());
    let mut run = String::new();
    let flush = |run: &mut String, source: &mut String| {
        for c in plain(run).chars() {
            if c.is_ascii() {
                source.push_str(&format!("\\u{{{:x}}}", c as u32));
            } else {
                source.push(c);
            }
        }
        run.clear();
    };
    for c in inner.chars() {
        if c.is_ascii() {
            if !run.is_empty() {
                flush(&mut run, &mut source);
            }
            source.push(c);
        } else {
            run.push(c);
        }
    }
    if !run.is_empty() {
        flush(&mut run, &mut source);
    }
    source
}

/// "/垃圾|广告/" as it is stored: trimmed, and composed. None for one that isn't closed by a
/// slash (so `/spam/i` isn't taken for the phrase "spam i"), isn't a regular expression, is
/// longer than MAX_WORD_CHARS, or matches empty text, as it would then match every post.
fn normalize_pattern(input: &str) -> Option<String> {
    let entry: String = trim(input).nfc().collect();
    let length = units(&entry);
    if !(3..=MAX_WORD_CHARS).contains(&length) || !entry.ends_with('/') {
        return None;
    }
    // As written too: making it plain mustn't make a pattern of what isn't one.
    patterns::syntax(&entry[1..entry.len() - 1]).ok()?;
    match patterns::matches_empty(&source_of(&entry)) {
        Ok(false) => Some(entry),
        _ => None,
    }
}

/// An entry as it is stored. A word or phrase: "  Buy NOW! " -> "buy now"; None for no words,
/// more than MAX_PHRASE_WORDS, or more than MAX_WORD_CHARS. A pattern: see `normalize_pattern`.
pub fn normalize_word(input: &str) -> Option<String> {
    if is_pattern(input) {
        return normalize_pattern(input);
    }
    let folded = fold(input);
    let words: Vec<&str> = words_of(&folded).collect();
    let phrase = words.join(" ");
    (!words.is_empty() && words.len() <= MAX_PHRASE_WORDS && units(&phrase) <= MAX_WORD_CHARS).then_some(phrase)
}

/// Where the word at the end of `text` starts; its length if it doesn't end in one.
fn trailing_word(text: &str) -> usize {
    text.char_indices()
        .rev()
        .take_while(|(_, c)| is_word_char(*c))
        .last()
        .map_or(text.len(), |(at, _)| at)
}

/// Finds which lists have a word or phrase in the texts it's given, which can arrive in
/// chunks of any size. Only whole words match, whatever their case and accents: "Spam!"
/// matches "spam", "spammers" doesn't. A phrase matches its words in a row, whatever
/// separates them. Patterns aren't its to read (see `scan_texts`).
pub struct WordScanner {
    /// Each word or phrase, and the lists holding it, by their places in `names`.
    lists: HashMap<String, Vec<usize>>,
    names: Vec<String>,
    /// How many words the phrases have.
    lengths: Vec<usize>,
    longest: usize,
    recent: VecDeque<String>,
    /// The end of the last chunk, if it may be the start of a word the next chunk finishes.
    carry: String,
    /// The lists that matched so far, by their places in `names`.
    hits: BTreeSet<usize>,
}

impl WordScanner {
    /// `words` holds each list's normalised words and phrases.
    pub fn new<'a>(words: impl IntoIterator<Item = (&'a str, &'a [String])>) -> Self {
        let mut lists: HashMap<String, Vec<usize>> = HashMap::new();
        let mut names = vec![];
        for (list, entries) in words {
            let at = names.len();
            names.push(list.to_owned());
            for entry in entries {
                lists.entry(entry.clone()).or_default().push(at);
            }
        }
        let lengths: Vec<usize> = lists
            .keys()
            .map(|entry| entry.split(' ').count())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let longest = lengths.iter().copied().max().unwrap_or(0);
        Self {
            lists,
            names,
            lengths,
            longest,
            recent: VecDeque::new(),
            carry: String::new(),
            hits: BTreeSet::new(),
        }
    }

    /// The next chunk of the current text.
    pub fn feed(&mut self, chunk: &str) {
        let mut text = std::mem::take(&mut self.carry);
        text.push_str(&fold(chunk));
        let end = trailing_word(&text);
        // No entry is longer than MAX_WORD_CHARS, so neither is a word worth finishing.
        let mut kept = 0;
        self.carry = text[end..]
            .chars()
            .take_while(|c| {
                kept += c.len_utf16();
                kept <= MAX_WORD_CHARS + 1
            })
            .collect();
        for word in words_of(&text[..end]) {
            self.word(word);
        }
    }

    /// Ends the current text; no phrase spans it and the next.
    pub fn end(&mut self) {
        if !self.carry.is_empty() {
            let word = std::mem::take(&mut self.carry);
            self.word(&word);
        }
        self.recent.clear();
    }

    /// One whole text.
    pub fn scan(&mut self, text: &str) {
        self.feed(text);
        self.end();
    }

    /// The lists that matched so far.
    pub fn matched(&self) -> impl Iterator<Item = &str> {
        self.hits.iter().map(|at| self.names[*at].as_str())
    }

    /// Whether the list named so matched so far.
    pub fn has(&self, list: &str) -> bool {
        self.matched().any(|name| name == list)
    }

    fn word(&mut self, word: &str) {
        if self.longest == 0 {
            return;
        }
        self.recent.push_back(word.to_owned());
        if self.recent.len() > self.longest {
            self.recent.pop_front();
        }
        for n in &self.lengths {
            if *n > self.recent.len() {
                continue;
            }
            let found = if *n == 1 {
                self.lists.get(word)
            } else {
                let phrase = self.recent.iter().skip(self.recent.len() - n).map(String::as_str).collect::<Vec<_>>().join(" ");
                self.lists.get(&phrase)
            };
            self.hits.extend(found.into_iter().flatten());
        }
    }
}

/// The lists that have one of their entries in one of `texts`, each of which is read on its
/// own. `lists` holds each list's entries as stored. Its words and phrases are a
/// `WordScanner`'s to find. Each of its patterns is tried on each text made `plain`, and
/// matches wherever it is found in it, in the middle of a word too: that is what blocks a
/// word of a script written without spaces.
///
/// A list whose patterns take more than PATTERN_BUDGET_MS over the texts counts as having
/// matched: a post the server couldn't finish reading isn't one it found nothing in. So does
/// one whose patterns could not be run at all. `log` is told which pattern the time ran out
/// on, for whoever keeps the list to write it again.
pub fn scan_texts(lists: &[(String, Vec<String>)], texts: &[String], log: &Logger) -> BTreeSet<String> {
    let mut words: Vec<(&str, Vec<String>)> = vec![];
    let mut list_patterns: Vec<(&str, Vec<&String>)> = vec![];
    for (list, entries) in lists {
        let (are, are_not): (Vec<&String>, Vec<&String>) = entries.iter().partition(|entry| is_pattern(entry));
        if !are.is_empty() {
            list_patterns.push((list, are));
        }
        if !are_not.is_empty() {
            words.push((list, are_not.into_iter().cloned().collect()));
        }
    }
    let mut matched = BTreeSet::new();
    if !words.is_empty() {
        let mut scanner = WordScanner::new(words.iter().map(|(list, entries)| (*list, entries.as_slice())));
        for text in texts {
            scanner.scan(text);
        }
        matched.extend(scanner.matched().map(str::to_owned));
    }
    if list_patterns.is_empty() {
        return matched;
    }
    let plain_texts: Vec<String> = texts.iter().map(|text| plain(text)).collect();
    for (list, entries) in list_patterns {
        // A word of the list already said what its patterns would.
        if matched.contains(list) {
            continue;
        }
        let sources: Vec<String> = entries.iter().map(|entry| source_of(entry)).collect();
        match patterns::run(&sources, &plain_texts, PATTERN_BUDGET) {
            Ok(ran) => {
                if let Some(slow) = ran.slow {
                    log.warn(
                        json!({ "list": list, "pattern": entries[slow], "budgetMs": PATTERN_BUDGET_MS }),
                        "a blocked pattern took too long to read a post, which counts as matching it",
                    );
                }
                if ran.hit || ran.slow.is_some() {
                    matched.insert(list.to_owned());
                }
            }
            Err(err) => {
                log.error(
                    json!({ "list": list, "err": evieverse_core::log::err(&err) }),
                    "blocked patterns could not be run over a post, which counts as matching them",
                );
                matched.insert(list.to_owned());
            }
        }
    }
    matched
}

#[cfg(test)]
mod tests {
    use evieverse_core::log::Level;

    use super::*;

    fn lists(of: &[(&str, &[&str])]) -> Vec<(String, Vec<String>)> {
        of.iter()
            .map(|(list, entries)| ((*list).to_owned(), entries.iter().map(|entry| (*entry).to_owned()).collect()))
            .collect()
    }

    fn matched(of: &[(&str, &[&str])], texts: &[&str]) -> Vec<String> {
        let texts: Vec<String> = texts.iter().map(|text| (*text).to_owned()).collect();
        scan_texts(&lists(of), &texts, &Logger::none()).into_iter().collect()
    }

    #[test]
    fn stores_a_word_or_a_phrase_lowercase_without_accents_or_punctuation() {
        assert_eq!(normalize_word("  Buy NOW! "), Some("buy now".to_owned()));
        assert_eq!(normalize_word("Café"), Some("cafe".to_owned()));
        assert_eq!(normalize_word("ＳＰＡＭ"), Some("spam".to_owned()));
        assert_eq!(normalize_word("crème-brûlée"), Some("creme brulee".to_owned()));
        assert_eq!(normalize_word("垃圾"), Some("垃圾".to_owned()));
        assert_eq!(normalize_word("ΣΟΦΟΣ"), Some("σοφος".to_owned()));
        assert_eq!(normalize_word("!!! ..."), None);
        assert_eq!(normalize_word(""), None);
        assert_eq!(normalize_word("a b c d e f g h"), Some("a b c d e f g h".to_owned()));
        assert_eq!(normalize_word("a b c d e f g h i"), None);
        assert_eq!(normalize_word(&"a".repeat(100)), Some("a".repeat(100)));
        assert_eq!(normalize_word(&"a".repeat(101)), None);
        // Counted as the API counts: a character outside the basic plane is two.
        assert_eq!(normalize_word(&"𐐷".repeat(50)).map(|word| word.chars().count()), Some(50));
        assert_eq!(normalize_word(&"𐐷".repeat(51)), None);
    }

    #[test]
    fn stores_a_pattern_as_written_if_it_is_one() {
        assert!(is_pattern("/spam/") && is_pattern("  /spam/") && is_pattern("\u{feff}/x/") && !is_pattern("spam/") && !is_pattern(""));
        assert_eq!(normalize_word(" /buy\\s+now/ "), Some("/buy\\s+now/".to_owned()));
        assert_eq!(normalize_word("/垃圾|广告/"), Some("/垃圾|广告/".to_owned()));
        // Composed, as one way of writing it.
        assert_eq!(normalize_word("/cafe\u{301}/"), Some("/caf\u{e9}/".to_owned()));
        // Not closed by a slash, so not `/spam/` with a flag, and not the phrase "spam i".
        assert_eq!(normalize_word("/spam/i"), None);
        assert_eq!(normalize_word("/spam"), None);
        assert_eq!(normalize_word("//"), None);
        assert_eq!(normalize_word("/(/"), None);
        assert_eq!(normalize_word("/[a-/"), None);
        // Would match every post.
        assert_eq!(normalize_word("/a*/"), None);
        assert_eq!(normalize_word("/(spam)?/"), None);
        assert_eq!(normalize_word("/|x/"), None);
        assert_eq!(normalize_word(&format!("/{}/", "a".repeat(98))), Some(format!("/{}/", "a".repeat(98))));
        assert_eq!(normalize_word(&format!("/{}/", "a".repeat(99))), None);
        // A full-width question mark is one to find, and never a quantifier.
        assert_eq!(normalize_word("/a？/"), Some("/a？/".to_owned()));
        assert_eq!(source_of("/a？/"), "a\\u{3f}");
        assert_eq!(source_of("/café|ｓｐａｍ/"), "caf\\u{65}|\\u{73}\\u{70}\\u{61}\\u{6d}");
        assert_eq!(source_of("/垃圾|广告/"), "垃圾|广告");
    }

    #[test]
    fn finds_whole_words_whatever_their_case_and_accents() {
        let spam: &[(&str, &[&str])] = &[("*", &["spam", "buy now", "cafe"])];
        assert_eq!(matched(spam, &["This is Spam!"]), ["*"]);
        assert_eq!(matched(spam, &["SPÁM"]), ["*"]);
        assert_eq!(matched(spam, &["spammers and antispam"]), Vec::<String>::new());
        assert_eq!(matched(spam, &["Buy... NOW"]), ["*"]);
        assert_eq!(matched(spam, &["buy it now"]), Vec::<String>::new());
        assert_eq!(matched(spam, &["at the CAFÉ"]), ["*"]);
        // No phrase spans two texts.
        assert_eq!(matched(spam, &["buy", "now"]), Vec::<String>::new());
        assert_eq!(
            matched(&[("a", &["one"]), ("b", &["two", "one"]), ("c", &["three"])], &["One, two"]),
            ["a", "b"]
        );
        assert_eq!(matched(&[], &["anything"]), Vec::<String>::new());
    }

    #[test]
    fn finds_a_word_that_arrives_in_chunks() {
        let entries = ["spam".to_owned(), "buy now".to_owned()];
        let chunked = |chunks: &[&str]| {
            let mut scanner = WordScanner::new([("*", entries.as_slice())]);
            for chunk in chunks {
                scanner.feed(chunk);
            }
            scanner.end();
            scanner.has("*")
        };
        assert!(chunked(&["this is sp", "am, really"]));
        assert!(chunked(&["s", "p", "a", "m"]));
        assert!(!chunked(&["sp", "ammers"]));
        assert!(chunked(&["please bu", "y ", "no", "w"]));
        assert!(!chunked(&["spa", " m"]));
        // A word longer than any entry is never one, however it is cut.
        assert!(!chunked(&[&"a".repeat(150), "spam"]));
        assert!(chunked(&[&"a".repeat(150), " spam"]));
    }

    #[test]
    fn finds_a_pattern_anywhere_in_a_text_made_plain() {
        let list: &[(&str, &[&str])] = &[("*", &["/垃圾|广告/", "/buy\\s+now/", "/café/", "/ｓｐａｍ/"])];
        assert_eq!(matched(list, &["这是垃圾邮件"]), ["*"]);
        assert_eq!(matched(list, &["BUY   NOW"]), ["*"]);
        assert_eq!(matched(list, &["at the CAFE"]), ["*"]);
        assert_eq!(matched(list, &["antiSPAMmer"]), ["*"]);
        assert_eq!(matched(list, &["ｓｐａｍ"]), ["*"]);
        assert_eq!(matched(list, &["nothing of it"]), Vec::<String>::new());
        // Each list by its own entries, and each text on its own.
        assert_eq!(
            matched(&[("cats", &["/c.t/"]), ("dogs", &["/d.g/", "puppy"])], &["a cut above", "do", "g"]),
            ["cats"]
        );
        assert_eq!(matched(&[("cats", &["/c.t/"]), ("dogs", &["/d.g/", "puppy"])], &["a Puppy"]), ["dogs"]);
    }

    /// fixtures/words.json: what the API's own implementation made of the same entries and
    /// texts, before this one replaced it.
    fn fixture() -> serde_json::Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/words.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    /// Syntax this engine reads and the API's didn't: modifiers, and a group name used again
    /// in another alternative.
    fn newer_syntax(entry: &str) -> bool {
        entry.contains("(?i:") || entry.contains("(?-i:") || entry.matches("(?<n>").count() > 1
    }

    #[test]
    fn stores_each_entry_as_the_api_stored_it() {
        let fixture = fixture();
        let mut differ = vec![];
        for case in fixture["normalize"].as_array().unwrap() {
            let input = case[0].as_str().unwrap();
            assert_eq!(is_pattern(input), case[2].as_bool().unwrap(), "{input:?}");
            let stored = normalize_word(input);
            if stored.as_deref() != case[1].as_str() {
                assert!(
                    case[1].is_null() && newer_syntax(input),
                    "{input:?} is stored as {stored:?}, and was as {:?}",
                    case[1]
                );
                differ.push(input);
            }
        }
        assert!(differ.len() <= 3, "{differ:?}");
        for case in fixture["fold"].as_array().unwrap() {
            assert_eq!(fold(case[0].as_str().unwrap()), case[1].as_str().unwrap(), "{:?}", case[0]);
        }
    }

    #[test]
    fn finds_what_the_api_found() {
        let fixture = fixture();
        let texts: Vec<String> = serde_json::from_value(fixture["patterns"]["texts"].clone()).unwrap();
        let (mut tried, mut slow) = (0, vec![]);
        for case in fixture["patterns"]["entries"].as_array().unwrap() {
            let entry = case["entry"].as_str().unwrap();
            let list = vec![("list".to_owned(), vec![entry.to_owned()])];
            for (text, hit) in texts.iter().zip(case["hits"].as_array().unwrap()) {
                let (log, said) = Logger::collecting();
                let found = scan_texts(&list, std::slice::from_ref(text), &log).contains("list");
                tried += 1;
                // Its time ran out, here or there: it counts as found, whatever it would have.
                if !said.take().is_empty() {
                    slow.push((entry, text.chars().take(30).collect::<String>()));
                    assert!(found);
                } else if let Some(hit) = hit.as_bool() {
                    assert_eq!(found, hit, "{entry} over {text:?}");
                }
            }
        }
        assert!(tried > 2000 && slow.len() <= 6, "{tried} tried, of which these ran out of time: {slow:?}");

        for case in fixture["scans"].as_array().unwrap() {
            let lists: Vec<(String, Vec<String>)> = case["lists"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(list, entries)| (list.clone(), serde_json::from_value(entries.clone()).unwrap()))
                .collect();
            let texts: Vec<String> = serde_json::from_value(case["texts"].clone()).unwrap();
            let found: Vec<String> = scan_texts(&lists, &texts, &Logger::none()).into_iter().collect();
            let expected: Vec<String> = serde_json::from_value(case["matched"].clone()).unwrap();
            assert_eq!(found, expected, "{:?} over {:?}", case["lists"], case["texts"]);
        }
    }

    #[test]
    fn a_list_whose_patterns_outrun_their_time_counts_as_matched_and_is_told() {
        let (log, said) = Logger::collecting();
        let texts = vec![format!("{}b", "a".repeat(40))];
        let found = scan_texts(&lists(&[("slow", &["/quick/", "/(a+)+$/"]), ("fine", &["/zzz/"])]), &texts, &log);
        assert_eq!(found.into_iter().collect::<Vec<_>>(), ["slow"]);
        let entries = said.take();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].level, Level::Warn);
        assert_eq!(
            serde_json::Value::Object(entries[0].fields.clone()),
            json!({ "list": "slow", "pattern": "/(a+)+$/", "budgetMs": 100 })
        );
    }
}
