//! What a search goes by, as src/search has it. A post is found by its keywords, which are
//! rows of `search_terms`: the most frequent words of its text or caption, and its hashtags
//! (`keywords_of`). A search is of the words it was asked with, read the same way
//! (`query_terms`), and finds the posts that have them all. A user is found by the start of
//! their username, as `fold_username` has it.
//!
//! A word is what the Unicode rules for the boundaries of words say one is, with a dictionary
//! for the scripts written without spaces, in lowercase and without accents (`fold`): "Café"
//! and "CAFE" are the word "cafe". A word with an apostrophe is the words on each side of it,
//! so "Mumbai's" is found by "mumbai", and "l'amour" by "amour". Nothing else is done to a
//! word: "run" doesn't find "running".
//!
//! Both sides read words here: the compactor writes a post's keywords, and the API reads a
//! query's through the addon, so that what one writes the other finds.

use std::collections::HashSet;
use std::sync::LazyLock;

use anyhow::Result;
use icu_properties::props::{GeneralCategory, Ideographic, LineBreak, Script, WordBreak};
use icu_properties::{CodePointMapData, CodePointSetData};
use icu_segmenter::WordSegmenter;
use icu_segmenter::options::WordBreakInvariantOptions;
use indexmap::{IndexMap, IndexSet};
use unicode_normalization::UnicodeNormalization;
use unicode_properties::{GeneralCategoryGroup, UnicodeGeneralCategory};

use crate::content::ContentMeta;
use crate::db::{Db, Queries, Value, places};
use crate::format::plain_text;
use crate::posts::PreviewKind;
use crate::tags::normalize_tag;
use crate::text::{fold, is_space, units};

/// The longest a word or hashtag a post is found by, in characters: what `search_terms.term`
/// holds. A longer word is no keyword.
pub const MAX_TERM_CHARS: usize = 64;
/// The most words one search looks for: the ones a query has after these are left out.
pub const MAX_QUERY_TERMS: usize = 8;
/// The longest a folded username is kept, in characters: what `users.username_folded` holds.
pub const MAX_FOLDED_USERNAME_CHARS: usize = 255;
/// The most terms one statement names: the rows of a post it inserts, or deletes.
const BATCH: usize = 500;

/// The apostrophes a word is split at, as people type them: the plain one and the curled ones.
const APOSTROPHES: [char; 4] = ['\'', '\u{2018}', '\u{2019}', '\u{02bc}'];

/// The English words that say nothing of what a text is about: no post is found by one, so
/// none is kept among a post's keywords, and a search leaves them out of what it looks for
/// when it has other words to go by. Lowercase, as a folded word is. Among them are the ends
/// that a contraction leaves once it is split at its apostrophe ("ll", "ve").
///
/// English alone: a word of another language that is as common is kept like any other.
const STOPWORDS: &[&str] = &[
    "about",
    "above",
    "after",
    "again",
    "against",
    "all",
    "am",
    "an",
    "and",
    "any",
    "are",
    "as",
    "at",
    "be",
    "because",
    "been",
    "before",
    "being",
    "below",
    "between",
    "both",
    "but",
    "by",
    "can",
    "could",
    "did",
    "do",
    "does",
    "doing",
    "down",
    "during",
    "each",
    "few",
    "for",
    "from",
    "further",
    "had",
    "has",
    "have",
    "having",
    "he",
    "her",
    "here",
    "hers",
    "herself",
    "him",
    "himself",
    "his",
    "how",
    "if",
    "in",
    "into",
    "is",
    "it",
    "its",
    "itself",
    "just",
    "ll",
    "me",
    "more",
    "most",
    "my",
    "myself",
    "no",
    "nor",
    "not",
    "now",
    "of",
    "off",
    "on",
    "once",
    "only",
    "or",
    "other",
    "our",
    "ours",
    "ourselves",
    "out",
    "over",
    "own",
    "same",
    "she",
    "should",
    "so",
    "some",
    "such",
    "than",
    "that",
    "the",
    "their",
    "theirs",
    "them",
    "themselves",
    "then",
    "there",
    "these",
    "they",
    "this",
    "those",
    "through",
    "to",
    "too",
    "under",
    "until",
    "up",
    "ve",
    "very",
    "was",
    "we",
    "were",
    "what",
    "when",
    "where",
    "which",
    "while",
    "who",
    "whom",
    "why",
    "will",
    "with",
    "would",
    "you",
    "your",
    "yours",
    "yourself",
    "yourselves",
];

/// STOPWORDS, to look a word up in.
static STOPWORD_SET: LazyLock<HashSet<&'static str>> = LazyLock::new(|| STOPWORDS.iter().copied().collect());

/// Whether a word is one that says nothing (see STOPWORDS).
fn is_stopword(word: &str) -> bool {
    STOPWORD_SET.contains(word)
}

/// The words of a text, folded, in the order it has them, each as often as it has it. Not a
/// word longer than MAX_TERM_CHARS, nor a single ASCII letter or digit, which says too little
/// to look for: a single character of a script that writes a word with one is kept.
fn words_of(text: &str) -> Vec<String> {
    let composed = composed(&fold(text));
    let segmenter = WordSegmenter::new_dictionary(WordBreakInvariantOptions::default());
    let mut words = Vec::new();
    let mut from = 0;
    for to in segmenter.segment_str(&composed) {
        let segment = &composed[from..to];
        from = to;
        if !is_word_like(segment) {
            continue;
        }
        // As the folded text has it: taken apart again.
        let segment: String = segment.nfkd().collect();
        for word in segment.split(APOSTROPHES) {
            let length = units(word);
            if length == 0 || length > MAX_TERM_CHARS || (length == 1 && word.is_ascii()) {
                continue;
            }
            words.push(word.to_owned());
        }
    }
    words
}

/// A folded text with each character that folding took apart put together again, which is how
/// the dictionaries of the scripts written without spaces have their words: a kana with its
/// voicing mark as the one character, and the Thai and Lao vowel AM as the one it is typed as.
/// The words are the same either way for every other script.
fn composed(folded: &str) -> String {
    let mut out = String::with_capacity(folded.len());
    for c in folded.nfc() {
        match (out.chars().next_back(), c) {
            (Some('\u{e4d}'), '\u{e32}') => {
                out.pop();
                out.push('\u{e33}');
            }
            (Some('\u{ecd}'), '\u{eb2}') => {
                out.pop();
                out.push('\u{eb3}');
            }
            _ => out.push(c),
        }
    }
    out
}

/// Whether a segment of a text is a word, and not what stands between words: it has a letter
/// or a digit as the rules for the boundaries of words know them (which, of the numbers, are
/// the digits alone), a character of a script written without spaces, or an ideograph or a
/// kana; or it is underscores, two or more.
///
/// The segmenter tells what kind a segment is by its last character, and so takes a word that
/// ends in a vowel sign or another mark (as words of Devanagari do) for none: hence this.
fn is_word_like(segment: &str) -> bool {
    let word_break = CodePointMapData::<WordBreak>::new();
    let line_break = CodePointMapData::<LineBreak>::new();
    let script = CodePointMapData::<Script>::new();
    let ideographic = CodePointSetData::new::<Ideographic>();
    let category = CodePointMapData::<GeneralCategory>::new();
    let mut joiners = 0;
    segment.chars().any(|c| {
        let kind = word_break.get(c);
        joiners += usize::from(kind == WordBreak::ExtendNumLet);
        if joiners >= 2 {
            return true;
        }
        if category.get(c) == GeneralCategory::Unassigned {
            return false;
        }
        match script.get(c) {
            // The mark that says a character again is of a word, and none by itself.
            Script::Han => ideographic.contains(c),
            Script::Hiragana => kind != WordBreak::Extend,
            _ => {
                matches!(kind, WordBreak::ALetter | WordBreak::HebrewLetter | WordBreak::Numeric | WordBreak::Katakana)
                    // As is a vowel sign or a tone mark of a script written without spaces.
                    || (kind != WordBreak::Extend && (line_break.get(c) == LineBreak::ComplexContext || ideographic.contains(c)))
            }
        }
    })
}

/// Whether a character is one a written hashtag is made of: a letter, a mark, a digit or an
/// underscore.
fn in_hashtag(c: char) -> bool {
    c == '_'
        || matches!(
            c.general_category_group(),
            GeneralCategoryGroup::Letter | GeneralCategoryGroup::Mark | GeneralCategoryGroup::Number
        )
}

/// A text with a space in place of each hashtag written in it: a `#`, plain or full-width,
/// that follows no letter or digit, and the letters, digits and underscores after it.
fn without_hashtags(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let starts = matches!(c, '#' | '\u{ff03}') && !(i > 0 && in_hashtag(chars[i - 1])) && chars.get(i + 1).is_some_and(|next| in_hashtag(*next));
        if starts {
            i += 1;
            while chars.get(i).is_some_and(|next| in_hashtag(*next)) {
                i += 1;
            }
            out.push(' ');
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

/// The terms the post `meta` describes is found by: the `max` most frequent words of its text
/// or caption, and of two as frequent the one the text has first, without the words that say
/// nothing (STOPWORDS); and every one of its hashtags, whatever `max` is, each once.
///
/// The text is read as its readers read it, without what formats it (`plain_text`). The
/// server's entry for a post on another server holds no text but the start of the original's,
/// in its preview, which is then what it is found by. A link post has no text: it is found by
/// its hashtags.
///
/// A hashtag written in the text ("#news") is no word of it: the post is found by the
/// hashtags it has, which are `meta.tags`, and not by one it only writes.
pub fn keywords_of(meta: &ContentMeta, max: usize) -> Vec<String> {
    let text = match &meta.text {
        Some(text) => Some(text),
        None if meta.preview.kind == PreviewKind::Link => None,
        None => meta.preview.text.as_ref(),
    };
    let mut counts: IndexMap<String, usize> = IndexMap::new();
    if let Some(text) = text.filter(|text| !text.is_empty()) {
        for word in words_of(&without_hashtags(&plain_text(text, false))) {
            if !is_stopword(&word) {
                *counts.entry(word).or_default() += 1;
            }
        }
    }
    // The words are in the order they first came, and the sort keeps that order among those as frequent.
    let mut words: Vec<(String, usize)> = counts.into_iter().collect();
    words.sort_by_key(|(_, count)| std::cmp::Reverse(*count));
    let terms: IndexSet<String> = words.into_iter().take(max).map(|(word, _)| word).chain(meta.tags.iter().cloned()).collect();
    terms.into_iter().collect()
}

/// The terms a search for `q` looks for, MAX_QUERY_TERMS at most, each once: its words, as a
/// post's keywords are read from its text, and its hashtags, which are the words of it that
/// start with `#`, each read as a hashtag is ("#Central-Mumbai" is "centralmumbai"). None for
/// a query with no word in it.
///
/// The words that say nothing (STOPWORDS) are left out, since no post has one as a keyword,
/// unless the query has nothing else: it is then looked for as it is, and finds the posts
/// that have the word as a hashtag.
pub fn query_terms(q: &str) -> Vec<String> {
    let mut hashtags = Vec::new();
    let mut words = Vec::new();
    for token in q.split(is_space) {
        if token.starts_with(['#', '\u{ff03}']) {
            hashtags.extend(normalize_tag(token));
        } else {
            words.extend(words_of(token));
        }
    }
    let telling: Vec<String> = words.iter().filter(|word| !is_stopword(word)).cloned().collect();
    let kept = if !telling.is_empty() || !hashtags.is_empty() { telling } else { words };
    let terms: IndexSet<String> = hashtags.into_iter().chain(kept).collect();
    terms.into_iter().take(MAX_QUERY_TERMS).collect()
}

/// A username as a search compares it, and as `users.username_folded` keeps it: lowercase and
/// without accents, so "José" is found by "jose", and cut to MAX_FOLDED_USERNAME_CHARS
/// characters, which a name of the longest a username is can exceed once the characters that
/// stand for several are written out.
pub fn fold_username(username: &str) -> String {
    fold(username).chars().take(MAX_FOLDED_USERNAME_CHARS).collect()
}

/// Has `search_terms` hold the terms the post is found by, as the meta file `meta` has it (see
/// `keywords_of`, which `max` is the most words for): the rows of the terms it has no more
/// are deleted, and those of the ones it has since are inserted, in one transaction, so a
/// search finds the post by what it was or by what it is. A post whose terms are the ones it
/// has rows for is left as it is, and costs one read.
///
/// Whatever writes a post's meta file calls this first, with what it is about to write: the
/// compactor, which is one process at a time (see the lease), and `compactor reindex`, which
/// holds the compactor's lease while it does. So a post's rows have one writer, and are those
/// of its meta file, or of the one a run that stopped here was about to write, which the next
/// run writes. It can be made again: the second time finds nothing to change.
///
/// `created_at` is the post's own, which its rows are ordered by.
///
/// A database may hold two terms to be one (MySQL's collation takes "ß" for "ss"): the row
/// that is there then stands for both, and the insert of the other is let go. What is deleted
/// is deleted first, so that it never takes a row that stands for a term the post still has.
pub async fn index_content(db: &Db, content_id: &str, created_at: i64, meta: &ContentMeta, max: usize) -> Result<()> {
    let wanted: IndexSet<String> = keywords_of(meta, max).into_iter().collect();
    let mut had: IndexSet<String> = IndexSet::new();
    for row in db
        .fetch("SELECT term FROM search_terms WHERE content_id = ?", crate::params![content_id])
        .await?
    {
        had.insert(row.string("term")?);
    }
    let stale: Vec<&String> = had.iter().filter(|term| !wanted.contains(*term)).collect();
    let missing: Vec<&String> = wanted.iter().filter(|term| !had.contains(*term)).collect();
    if stale.is_empty() && missing.is_empty() {
        return Ok(());
    }
    let dialect = db.dialect();
    let mut tx = db.begin().await?;
    for batch in stale.chunks(BATCH) {
        let mut params = vec![Value::from(content_id)];
        params.extend(batch.iter().map(|term| Value::from(*term)));
        tx.execute(
            &format!("DELETE FROM search_terms WHERE content_id = ? AND term IN ({})", places(batch.len())),
            &params,
        )
        .await?;
    }
    for batch in missing.chunks(BATCH) {
        let mut params = Vec::with_capacity(batch.len() * 3);
        for term in batch {
            params.extend([Value::from(*term), Value::from(content_id), Value::from(created_at)]);
        }
        let rows = vec!["(?, ?, ?)"; batch.len()].join(", ");
        tx.execute(
            &format!(
                "{} search_terms (term, content_id, created_at) VALUES {rows}{}",
                dialect.insert_ignore(),
                dialect.ignore_end()
            ),
            &params,
        )
        .await?;
    }
    tx.commit().await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Whether a character is of a script written without spaces, whose words a dictionary says.
    fn by_dictionary(c: char) -> bool {
        CodePointMapData::<LineBreak>::new().get(c) == LineBreak::ComplexContext
            || matches!(CodePointMapData::<Script>::new().get(c), Script::Han | Script::Hiragana | Script::Katakana)
    }

    fn meta(text: &str, tags: &[&str]) -> ContentMeta {
        serde_json::from_value(serde_json::json!({
            "contentId": "c", "mimeType": "text/plain", "size": 1, "aiGenerated": false,
            "preview": { "kind": "text", "text": text }, "text": text, "tags": tags, "updatedAt": 1,
        }))
        .unwrap()
    }

    #[test]
    fn reads_the_words_a_post_is_found_by() {
        let found = keywords_of(&meta("The **Café** in Mumbai's centre: café, #news and l'amour. A b", &["mumbai"]), 3);
        assert_eq!(found, ["cafe", "mumbai", "centre"]);
        assert_eq!(keywords_of(&meta("one two two three three", &["two"]), 2), ["two", "three"]);
    }

    #[test]
    fn finds_a_post_by_its_words_folded_without_the_ones_that_say_nothing_and_by_its_hashtags() {
        let of = |text: &str, tags: &[&str]| keywords_of(&meta(text, tags), 100);
        assert_eq!(
            of("Flooding closes the Coast Road in Mumbai", &["news"]),
            ["flooding", "closes", "coast", "road", "mumbai", "news"]
        );
        // Whatever their case and accents, and each once.
        assert_eq!(of("Café, CAFE and cafe\u{301}!", &[]), ["cafe"]);
        // A word with an apostrophe is the words on each side of it; a single letter or digit is none.
        assert_eq!(of("Mumbai's l\u{2019}amour, a b c 1 2 42", &[]), ["mumbai", "amour", "42"]);
        // What formats a text is no word of it: a link's address isn't, and its label is.
        assert_eq!(
            of("**Bold** news at [the harbour](https://example.com/secret-path)", &[]),
            ["bold", "news", "harbour"]
        );
        // A hashtag that is also a word of the text is one term.
        assert_eq!(of("Rain #weather tomorrow", &["weather", "rain"]), ["rain", "tomorrow", "weather"]);
        // A hashtag the text writes is no word of it: the post is found by the hashtags it has.
        assert_eq!(
            of("Flooding #news \u{ff03}Mumbai in C# and at stand#4", &["weather"]),
            ["flooding", "stand", "weather"]
        );
        // Scripts written without spaces have words too.
        assert!(of("東京は大きい", &[]).contains(&"東京".to_owned()));
        // A word longer than a term can be is none.
        assert_eq!(
            of(&format!("short {} {}", "x".repeat(65), "y".repeat(64)), &[]),
            ["short".to_owned(), "y".repeat(64)]
        );
    }

    #[test]
    fn keeps_the_most_frequent_words_where_a_post_has_more_than_the_most_and_every_hashtag() {
        let post = meta("one two two three three three four", &["alpha", "beta", "gamma"]);
        assert_eq!(keywords_of(&post, 2), ["three", "two", "alpha", "beta", "gamma"]);
        // Of two as frequent, the one the text has first.
        assert_eq!(keywords_of(&meta("zebra apple zebra apple mango", &[]), 1), ["zebra"]);
        assert_eq!(keywords_of(&post, 0), ["alpha", "beta", "gamma"]);
    }

    #[test]
    fn reads_the_caption_of_a_file_the_preview_of_an_entry_and_the_hashtags_alone_of_a_link() {
        let of = |text: Option<&str>, preview: serde_json::Value, tag: &str| {
            let mut post = meta("", &[tag]);
            post.text = text.map(str::to_owned);
            post.preview = serde_json::from_value(preview).unwrap();
            keywords_of(&post, 100)
        };
        let caption = serde_json::json!({ "kind": "image", "url": "/content/x/raw", "text": "Sunset over the bay" });
        assert_eq!(of(Some("Sunset over the bay"), caption, "pics"), ["sunset", "bay", "pics"]);
        let entry = serde_json::json!({ "kind": "text", "text": "Flooding closes the coast road." });
        assert_eq!(of(None, entry, "news"), ["flooding", "closes", "coast", "road", "news"]);
        let link = serde_json::json!({ "kind": "link", "url": "https://news.example/flooding" });
        assert_eq!(of(None, link, "news"), ["news"]);
        assert_eq!(of(None, serde_json::json!({ "kind": "image", "url": "/content/x/raw" }), "pics"), ["pics"]);
    }

    /// fixtures/keywords.json: what the API's own implementation made of the same posts,
    /// queries, usernames and hashtags, before this one replaced it.
    #[test]
    fn reads_words_as_the_api_did() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/keywords.json");
        let mut fixture: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let strings = |value: &serde_json::Value| serde_json::from_value::<Vec<String>>(value.clone()).unwrap();
        let update = std::env::var("UPDATE_FIXTURES").is_ok_and(|v| v == "1");
        let mut differ = Vec::new();
        for post in fixture["posts"].as_array_mut().unwrap() {
            let mut meta = meta("", &[]);
            meta.text = post["text"].as_str().map(str::to_owned);
            meta.preview = serde_json::from_value(post["preview"].clone()).unwrap();
            meta.tags = strings(&post["tags"]);
            let found = keywords_of(&meta, usize::try_from(post["max"].as_u64().unwrap()).unwrap());
            // The words of a script written without spaces are where a dictionary and the way it is
            // read say, and this side's reads them otherwise than the API's did: such a post has what
            // this side makes of it as `here`, and is held to that.
            let dictionary = post["text"].as_str().is_some_and(|text| text.chars().any(by_dictionary));
            if found == strings(&post["keywords"]) {
                assert!(post.get("here").is_none(), "{post} has a `here` it has no need of");
            } else if update && dictionary {
                post["here"] = serde_json::json!(found);
            } else if post.get("here").is_none_or(|here| found != strings(here)) {
                differ.push(format!("{post}\n  here: {found:?}"));
            }
        }
        if update {
            std::fs::write(&path, format!("{}\n", serde_json::to_string_pretty(&fixture).unwrap())).unwrap();
        }
        for case in fixture["queries"].as_array().unwrap() {
            let found = query_terms(case[0].as_str().unwrap());
            if found != strings(&case[1]) {
                differ.push(format!("{case}\n  here: {found:?}"));
            }
        }
        for case in fixture["usernames"].as_array().unwrap() {
            assert_eq!(fold_username(case[0].as_str().unwrap()), case[1].as_str().unwrap(), "{:?}", case[0]);
        }
        for case in fixture["tags"].as_array().unwrap() {
            assert_eq!(normalize_tag(case[0].as_str().unwrap()).as_deref(), case[1].as_str(), "{:?}", case[0]);
        }
        assert!(differ.is_empty(), "{} differ:\n{}", differ.len(), differ.join("\n"));
    }

    #[test]
    fn reads_the_terms_of_a_query() {
        assert_eq!(query_terms("  The #Central-Mumbai café "), ["centralmumbai", "cafe"]);
        assert_eq!(query_terms("the"), ["the"]);
        assert_eq!(query_terms("a ! ?"), Vec::<String>::new());
        assert_eq!(fold_username("José"), "jose");
    }
}
