//! Text as the API's own language reads it: what it takes for white space, how long it counts
//! a text to be, and how a word is folded so that it is found whatever its case and accents.

use unicode_normalization::UnicodeNormalization;

/// Whether a character is white space as the API's own language takes it (`trim`, and `\s`
/// of a regular expression).
pub fn is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// A text without the white space around it.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_space)
}

/// The length of a text as the API counts it: in UTF-16 units.
pub fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

/// Whether a character is one of the accents of Latin letters, once a letter is taken apart.
pub fn is_accent(c: char) -> bool {
    ('\u{300}'..='\u{36f}').contains(&c)
}

/// Lowercase, without the accents of Latin letters, as hashtags are normalised. A search
/// reads the words of a post and of a query the same way.
pub fn fold(text: &str) -> String {
    text.nfkd().filter(|c| !is_accent(*c)).collect::<String>().to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folds_case_and_accents_away() {
        assert_eq!(fold("Café ＣＡＦＥ Ａ"), "cafe cafe a");
        assert_eq!(trim("\u{feff} a\u{a0}"), "a");
        assert_eq!(units("a𝒜"), 3);
    }
}
