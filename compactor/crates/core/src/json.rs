//! JSON as the API writes it, read here.
//!
//! The API's strings are JavaScript's: sequences of UTF-16 code units, which may hold half of a
//! surrogate pair with no other half. `JSON.stringify` writes such a half as an escape
//! (`\ud83d`), which is valid JSON and names no character, so a strict reader refuses the whole
//! document. A row of `pending_writes` that held one would then never be applied. So what the
//! API wrote is read with each such half taken for U+FFFD, the replacement character, which is
//! what the half becomes wherever else the text is turned into UTF-8.

use std::borrow::Cow;

use serde::de::DeserializeOwned;

/// The escape that stands in for half of a surrogate pair that has no other half.
const REPLACEMENT: &[u8; 6] = b"\\ufffd";

/// The four hex digits of a `\uXXXX` escape that begins at `at`, as a number; none if what is
/// there is no such escape.
fn escape_at(json: &[u8], at: usize) -> Option<u16> {
    let escape = json.get(at..at + 6)?;
    if escape[0] != b'\\' || escape[1] != b'u' {
        return None;
    }
    u16::from_str_radix(std::str::from_utf8(&escape[2..]).ok()?, 16).ok()
}

/// `json` with every escape of half a surrogate pair that has no other half written as the
/// escape of U+FFFD. Borrowed where there is none, which is nearly always.
pub fn well_formed(json: &[u8]) -> Cow<'_, [u8]> {
    let mut out: Option<Vec<u8>> = None;
    let mut i = 0;
    while i < json.len() {
        if json[i] != b'\\' {
            i += 1;
            continue;
        }
        let lone = match escape_at(json, i) {
            // A high half is whole only with a low half right after it.
            Some(0xd800..=0xdbff) => !matches!(escape_at(json, i + 6), Some(0xdc00..=0xdfff)),
            // A low half that is reached here follows no high half.
            Some(0xdc00..=0xdfff) => true,
            Some(_) => {
                i += 6;
                continue;
            }
            // Any other escape is two bytes, the backslash of `\\` among them.
            None => {
                i += 2;
                continue;
            }
        };
        if lone {
            out.get_or_insert_with(|| json.to_vec())[i..i + 6].copy_from_slice(REPLACEMENT);
            i += 6;
        } else {
            i += 12;
        }
    }
    out.map_or(Cow::Borrowed(json), Cow::Owned)
}

/// What a JSON document the API wrote holds (see the top of this file).
pub fn from_slice<T: DeserializeOwned>(json: &[u8]) -> serde_json::Result<T> {
    serde_json::from_slice(&well_formed(json))
}

/// As `from_slice`, of a document held as text.
pub fn from_str<T: DeserializeOwned>(json: &str) -> serde_json::Result<T> {
    from_slice(json.as_bytes())
}

/// The largest whole number the API's language counts with exactly.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// A number as the API's language writes it in JSON: a whole one without a point ("2", where
/// this side would write "2.0"), so that what one side wrote the other writes the same. None
/// for what is no number of JSON's.
pub fn js_number(n: f64) -> Option<serde_json::Number> {
    if n.fract() == 0.0 && n.abs() <= MAX_SAFE_INTEGER {
        // Whole, and within what is counted with exactly: the cast loses nothing.
        return Some((n as i64).into());
    }
    serde_json::Number::from_f64(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_a_whole_number_without_a_point() {
        let written = |n: f64| js_number(n).map(|n| n.to_string());
        assert_eq!(written(2.0).as_deref(), Some("2"));
        assert_eq!(written(-0.0).as_deref(), Some("0"));
        assert_eq!(written(12.5).as_deref(), Some("12.5"));
        assert_eq!(written(f64::NAN), None);
    }

    #[test]
    fn reads_half_a_surrogate_pair_as_the_replacement_character() {
        let lone_high: String = from_str(r#""a\ud83db""#).unwrap();
        assert_eq!(lone_high, "a\u{fffd}b");
        let lone_low: String = from_str(r#""a\udc00b""#).unwrap();
        assert_eq!(lone_low, "a\u{fffd}b");
        let two_highs: String = from_str(r#""\ud83d\ud83d\ude00""#).unwrap();
        assert_eq!(two_highs, "\u{fffd}\u{1f600}");
        let at_the_end: String = from_str(r#""\ud83d""#).unwrap();
        assert_eq!(at_the_end, "\u{fffd}");
    }

    #[test]
    fn leaves_whole_pairs_and_escaped_backslashes_as_they_are() {
        let pair = br#""\ud83d\ude00""#;
        assert!(matches!(well_formed(pair), Cow::Borrowed(_)));
        assert_eq!(from_slice::<String>(pair).unwrap(), "\u{1f600}");
        // A backslash that is escaped, then the letters of an escape: no escape at all.
        let escaped = br#""\\ud83d""#;
        assert!(matches!(well_formed(escaped), Cow::Borrowed(_)));
        assert_eq!(from_slice::<String>(escaped).unwrap(), "\\ud83d");
    }
}
