//! The links in what a post or a comment has to read, and what each is compared with
//! URLhaus's list by. A link is found wherever it is written: alone, as a link post's URL is,
//! or anywhere in a text, a caption or a comment, inside whatever markup surrounds it.

use std::sync::LazyLock;

use anyhow::{Context, Result};
use unicode_properties::{GeneralCategoryGroup, UnicodeGeneralCategory};
use url::Url;

use crate::lines::is_space;

/// A link of a text, or what may be one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Link {
    /// Whether it was written with its scheme (http:// or https://), so that it is a link
    /// for sure, and not a filename or the end of a sentence.
    pub schemed: bool,
    /// What it starts with, up to its host and port: one for a link with a scheme, and both
    /// schemes for one without.
    pub origins: Vec<String>,
    /// What follows the host in the text: the path, the query and the fragment, with
    /// whatever was written right after.
    pub tail: String,
}

/// A URL as it is compared: the way the URL parser writes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Address {
    /// The host, with its port if it isn't its scheme's own.
    pub host: String,
    /// The host and the path.
    pub path: String,
    /// The host, the path and the query.
    pub full: String,
}

/// What can't be in a link, so ends it: a space, and the characters markup puts around one.
fn ends_link(c: char) -> bool {
    is_space(c) || matches!(c, '<' | '>' | '"' | '`')
}

/// The dots domain names are written with: the full stop, and the ones the URL parser reads
/// as it.
fn is_dot(c: char) -> bool {
    matches!(c, '.' | '\u{3002}' | '\u{ff0e}' | '\u{ff61}')
}

/// What a host written after a scheme is made of. It is read loosely, as the URL parser then
/// says what it is: a name, or an IP address however it is written.
fn in_host(c: char) -> bool {
    is_dot(c) || matches!(c, '-' | '_' | '%') || matches!(c.general_category_group(), GeneralCategoryGroup::Letter | GeneralCategoryGroup::Number)
}

/// The longest path and query that is read, in characters as the API counts them (UTF-16
/// units): URLhaus lists none near as long.
const TAIL_CHARS: usize = 2048;

/// A host written without a scheme, as people write links and clients make them: a domain
/// name with its top-level domain, or an IPv4 address. Not what follows a letter, a slash or
/// an @, which is the rest of a word, of a URL already found, or of an email address.
static BARE: LazyLock<fancy_regex::Regex> = LazyLock::new(|| {
    fancy_regex::RegexBuilder::new(
        r"(?<![\p{L}\p{N}.\-_@/:%])((?:[\p{L}\p{N}\-_]{1,63}\.)+\p{L}[\p{L}\p{N}\-]{1,62}|[0-9]{1,3}(?:\.[0-9]{1,3}){3})(?::[0-9]{1,5})?(?![\p{L}\p{N}\-_@])",
    )
    // A text is read to its end, however long it is and whatever it holds.
    .backtrack_limit(usize::MAX)
    .build()
    .expect("the expression that finds links without a scheme is one")
});

/// What a sentence or markup puts right after a link, which isn't part of it.
const TRAILING: &str = ".,;:!?'\")]}*_~|";
/// What markup ends a link with before it goes on without a space, and what the server's own
/// formatting ends an address at.
const CLOSING: &str = ")]}[\\'|,;!*";

/// `url` as it is compared, the way the URL parser writes it; none if it isn't an http or
/// https URL.
pub fn address_of(url: &str) -> Option<Address> {
    let parsed = Url::parse(url).ok()?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return None;
    }
    // example.com. is example.com.
    let name = parsed.host_str()?.trim_end_matches('.');
    if name.is_empty() {
        return None;
    }
    let host = match parsed.port() {
        Some(port) => format!("{name}:{port}"),
        None => name.to_owned(),
    };
    let path = format!("{host}{}", parsed.path());
    let full = match parsed.query() {
        Some(query) if !query.is_empty() => format!("{path}?{query}"),
        _ => path.clone(),
    };
    Some(Address { host, path, full })
}

/// What follows a host that has a path, a query or a fragment, from `at` in `text`: nothing,
/// if what is there starts none of them.
fn tail_at(text: &str, at: usize) -> &str {
    let rest = &text[at..];
    if !rest.starts_with(['/', '?', '#', '\\']) {
        return "";
    }
    let mut units = 0;
    let mut end = 1;
    for (i, c) in rest.char_indices().skip(1) {
        units += c.len_utf16();
        if ends_link(c) || units > TAIL_CHARS {
            break;
        }
        end = i + c.len_utf8();
    }
    &rest[..end]
}

/// A link written with its scheme, as it is found at one place of a text.
struct Schemed {
    /// Where the scheme, and whoever it names before an @, ends.
    scheme_end: usize,
    host_end: usize,
    /// Where all of it ends: after its port, if it has one.
    end: usize,
}

/// How many of the characters from `at` are `wanted`, up to `most` of them, and where they end.
fn run(text: &str, at: usize, most: usize, wanted: impl Fn(char) -> bool) -> (usize, usize) {
    let mut end = at;
    let mut count = 0;
    for c in text[at..].chars() {
        if count == most || !wanted(c) {
            break;
        }
        count += 1;
        end += c.len_utf8();
    }
    (count, end)
}

/// Where the host that starts at `at` ends: an IPv6 address in its brackets, or a name.
fn host_end(text: &str, at: usize) -> Option<usize> {
    if text[at..].starts_with('[') {
        let (count, end) = run(text, at + 1, 45, |c| c.is_ascii_hexdigit() || c == ':' || c == '.');
        if count >= 2 && text[end..].starts_with(']') {
            return Some(end + 1);
        }
    }
    let (count, end) = run(text, at, 255, in_host);
    (count >= 1).then_some(end)
}

/// The link with a scheme that starts at `at`, if one does: http:// or https://, whoever it
/// names before an @, a host, and a port.
fn schemed_at(text: &str, at: usize) -> Option<Schemed> {
    let rest = &text[at..];
    if !rest.get(..4).is_some_and(|start| start.eq_ignore_ascii_case("http")) {
        return None;
    }
    let mut after = at + 4;
    // An s, however it is written: the long one of old print is one too, where case is ignored.
    if let Some(s) = text[after..].chars().next().filter(|c| matches!(c, 's' | 'S' | '\u{17f}')) {
        after += s.len_utf8();
    }
    if !text[after..].starts_with("://") {
        return None;
    }
    after += 3;
    // Whoever it names before an @: with them first, and without them if no host follows.
    let (_, named) = run(text, after, 256, |c| !ends_link(c) && !matches!(c, '/' | '?' | '#' | '\\' | '@'));
    let with_user = text[named..].starts_with('@').then(|| named + 1);
    let (scheme_end, host_end) = with_user.and_then(|start| Some((start, host_end(text, start)?))).or_else(|| Some((after, host_end(text, after)?)))?;
    let mut end = host_end;
    if text[end..].starts_with(':') {
        let (digits, port_end) = run(text, end + 1, 5, |c| c.is_ascii_digit());
        if digits >= 1 {
            end = port_end;
        }
    }
    Some(Schemed { scheme_end, host_end, end })
}

/// The links of `text`, and what may be one. A URL inside another's path or query is a link
/// of its own, so a redirect to a listed URL is found too.
pub fn find_links(text: &str) -> Result<Vec<Link>> {
    let mut links = vec![];
    let mut at = 0;
    while at < text.len() {
        let Some(found) = text[at..].char_indices().map(|(i, _)| at + i).find_map(|start| Some((start, schemed_at(text, start)?))) else { break };
        let (start, Schemed { scheme_end, host_end, end }) = found;
        let (scheme, host, port) = (&text[start..scheme_end], &text[scheme_end..host_end], &text[host_end..end]);
        let tail = tail_at(text, end);
        // A host with something after it is whole. One with nothing may end with what isn't its own:
        // "see https://example.com."
        let name = if port.is_empty() && tail.is_empty() { host.trim_end_matches(|c| is_dot(c) || matches!(c, '_' | '%' | '-')) } else { host };
        if !name.is_empty() {
            links.push(Link { schemed: true, origins: vec![format!("{scheme}{name}{port}")], tail: tail.to_owned() });
        }
        // The next one is looked for right after the scheme, so that a URL in this one's path is found.
        at = scheme_end;
    }
    for found in BARE.find_iter(text) {
        let found = found.context("a text could not be read for the links written in it without a scheme")?;
        let host = found.as_str();
        links.push(Link { schemed: false, origins: vec![format!("http://{host}"), format!("https://{host}")], tail: tail_at(text, found.end()).to_owned() });
    }
    Ok(links)
}

/// What `tail` is if the link ends where it could. Nothing in a text marks a link's end, and
/// any of these characters may be the link's own, so each place is tried: the whole of it
/// first, then without what trails it ("… at example.com/a)."), then up to each character
/// that could close it ("[a](example.com/a)[b](…"), from the first, so that nothing written
/// after a link hides its end.
pub fn endings(tail: &str) -> Vec<&str> {
    let mut ends = vec![tail.len()];
    let add = |end: usize, ends: &mut Vec<usize>| {
        if !ends.contains(&end) {
            ends.push(end);
        }
    };
    // The link is tried without up to 8 of the characters that trail it, and ending at up to 32 places in it.
    let mut end = tail.len();
    for c in tail.chars().rev().take(8) {
        if !TRAILING.contains(c) {
            break;
        }
        end -= c.len_utf8();
        add(end, &mut ends);
    }
    for (i, _) in tail.char_indices().filter(|(_, c)| CLOSING.contains(*c)).take(32) {
        add(i, &mut ends);
    }
    ends.into_iter().map(|end| &tail[..end]).collect()
}

/// `tail`, and `tail` up to each segment that steps back ("/.."). The URL parser takes such
/// a segment and the one before it out of a path, so what is written after a link could
/// otherwise take the link's own path away: "example.com/a.exe/../b" is read as
/// "example.com/b".
pub fn before_steps_back(tail: &str) -> Vec<&str> {
    /// Where a dot ends that starts at `at`, however it is written.
    fn dot_end(tail: &str, at: usize) -> Option<usize> {
        let rest = &tail[at..];
        if rest.starts_with('.') {
            Some(at + 1)
        } else if rest.get(..3).is_some_and(|start| start.eq_ignore_ascii_case("%2e")) {
            Some(at + 3)
        } else {
            None
        }
    }
    let mut tails = vec![tail];
    let mut at = 0;
    while at < tail.len() {
        // The most steps back that are read.
        if tails.len() > 4 {
            break;
        }
        let c = tail[at..].chars().next().expect("within the text");
        // Each path segment that takes back the one before it: "..", however it is written.
        let stepped = matches!(c, '/' | '\\')
            .then(|| dot_end(tail, at + 1).and_then(|next| dot_end(tail, next)))
            .flatten()
            .filter(|end| tail[*end..].chars().next().is_none_or(|next| matches!(next, '/' | '\\' | '?' | '#')));
        match stepped {
            Some(end) => {
                tails.push(&tail[..at]);
                at = end;
            }
            None => at += c.len_utf8(),
        }
    }
    tails
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn links(text: &str) -> Vec<(bool, Vec<String>, String)> {
        find_links(text).unwrap().into_iter().map(|link| (link.schemed, link.origins, link.tail)).collect()
    }

    fn schemed(origin: &str, tail: &str) -> (bool, Vec<String>, String) {
        (true, vec![origin.to_owned()], tail.to_owned())
    }

    fn bare(host: &str, tail: &str) -> (bool, Vec<String>, String) {
        (false, vec![format!("http://{host}"), format!("https://{host}")], tail.to_owned())
    }

    /// fixtures/links.json: what the API's own implementation made of the same texts, before
    /// this one replaced it.
    pub(crate) fn fixture() -> serde_json::Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/links.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn finds_and_writes_links_as_the_api_did() {
        use serde_json::{Value, json};
        let fixture = fixture();
        let (mut differ, mut count) = (vec![], 0);
        let mut same = |what: &str, of: &Value, made: Value, expected: &Value| {
            count += 1;
            if made != *expected {
                differ.push(format!("{what} of {of}: {made} and not {expected}"));
            }
        };
        for case in fixture["found"].as_array().unwrap() {
            let found: Vec<Value> = find_links(case[0].as_str().unwrap()).unwrap().into_iter().map(|link| json!({ "schemed": link.schemed, "origins": link.origins, "tail": link.tail })).collect();
            same("the links", &case[0], Value::Array(found), &case[1]);
        }
        for case in fixture["addresses"].as_array().unwrap() {
            let address = address_of(case[0].as_str().unwrap()).map_or(Value::Null, |address| json!({ "host": address.host, "path": address.path, "full": address.full }));
            // The one thing the two parsers write differently: a `^` in a path, which this one
            // escapes, as the URL standard has since said to. A list's URL and a post's link
            // are both written by the same parser, so they are still the same when they are.
            let expected: Value = serde_json::from_str(&case[1].to_string().replace('^', "%5E")).unwrap();
            same("the address", &case[0], address, &expected);
        }
        for case in fixture["tails"].as_array().unwrap() {
            let tail = case[0].as_str().unwrap();
            same("the endings", &case[0], json!(endings(tail)), &case[1]);
            same("the steps back", &case[0], json!(before_steps_back(tail)), &case[2]);
        }
        assert!(differ.is_empty(), "{} differ:\n{}", differ.len(), differ.join("\n"));
        assert!(count >= 100, "{count}");
    }

    #[test]
    fn finds_a_link_written_with_its_scheme() {
        assert_eq!(links("https://example.com/a.exe"), [schemed("https://example.com", "/a.exe")]);
        assert_eq!(links("see HTTP://Example.COM:8080/x?y=1#z now"), [schemed("HTTP://Example.COM:8080", "/x?y=1#z")]);
        // What a sentence puts after a host isn't the host's.
        assert_eq!(links("see https://example.com."), [schemed("https://example.com", "")]);
        assert_eq!(links("see https://example.com./a"), [schemed("https://example.com.", "/a")]);
        assert_eq!(links("<a href=\"http://example.com/a\">x</a>"), [schemed("http://example.com", "/a")]);
        assert_eq!(links("http://user:pw@example.com/a"), [schemed("http://user:pw@example.com", "/a")]);
        // No host after the @: whoever it names is the host.
        assert_eq!(links("http://user@/a"), [schemed("http://user", "")]);
        assert_eq!(links("http://[2001:db8::1]:80/a"), [schemed("http://[2001:db8::1]:80", "/a")]);
        assert_eq!(links("http://1.2.3.4/a http://0x7f.1/b"), [schemed("http://1.2.3.4", "/a"), schemed("http://0x7f.1", "/b")]);
        assert_eq!(links("http://例え.テスト/a"), [schemed("http://例え.テスト", "/a")]);
        assert_eq!(links("http:// nothing, https:/one, ftp://example.org/a"), []);
    }

    #[test]
    fn finds_a_url_inside_another_ones_path_or_query() {
        assert_eq!(
            links("https://r.example/?to=http://bad.example/a.exe"),
            [schemed("https://r.example", "/?to=http://bad.example/a.exe"), schemed("http://bad.example", "/a.exe")]
        );
    }

    #[test]
    fn finds_a_host_written_without_a_scheme() {
        assert_eq!(links("go to example.com/a.exe now"), [bare("example.com", "/a.exe")]);
        assert_eq!(links("Example.co.uk:8080/x"), [bare("Example.co.uk:8080", "/x")]);
        assert_eq!(links("at 10.0.0.1/a and 1.2.3"), [bare("10.0.0.1", "/a")]);
        // Not the rest of a word, of a URL already found, or of an email address.
        assert_eq!(links("me@example.com"), []);
        assert_eq!(links("a sentence.Another one"), [bare("sentence.Another", "")]);
        assert_eq!(links("file.x and v1.2"), []);
        assert_eq!(links("https://example.com/a"), [schemed("https://example.com", "/a")]);
        assert_eq!(links("example.com_"), []);
        assert_eq!(links("(example.com)"), [bare("example.com", "")]);
    }

    #[test]
    fn writes_a_url_as_the_parser_does() {
        let address = address_of("HTTPS://Example.COM.:443/a/../b%20c?q=1#f").unwrap();
        assert_eq!((address.host.as_str(), address.path.as_str(), address.full.as_str()), ("example.com", "example.com/b%20c", "example.com/b%20c?q=1"));
        assert_eq!(address_of("http://example.com:8080").unwrap().full, "example.com:8080/");
        assert_eq!(address_of("http://example.com/?").unwrap().full, "example.com/");
        assert_eq!(address_of("http://0x7f.1/").unwrap().host, "127.0.0.1");
        assert_eq!(address_of("http://例え.テスト/").unwrap().host, "xn--r8jz45g.xn--zckzah");
        assert_eq!(address_of("http://example。com/").unwrap().host, "example.com");
        assert_eq!(address_of("ftp://example.com/"), None);
        assert_eq!(address_of("http://"), None);
        assert_eq!(address_of("not a url"), None);
    }

    #[test]
    fn tries_each_place_a_link_could_end() {
        assert_eq!(endings("/a"), ["/a"]);
        assert_eq!(endings("/a)."), ["/a).", "/a)", "/a"]);
        assert_eq!(endings("/a)[b](c"), ["/a)[b](c", "/a", "/a)", "/a)[b"]);
        assert_eq!(endings(""), [""]);
        // Without up to 8 of what trails it, and ending at each of up to 32 places in it.
        assert_eq!(endings(&"!".repeat(20)).len(), 21);
        assert_eq!(endings(&"!".repeat(60)).len(), 41);
    }

    #[test]
    fn reads_a_tail_up_to_each_step_back() {
        assert_eq!(before_steps_back("/a.exe"), ["/a.exe"]);
        assert_eq!(before_steps_back("/a.exe/../b"), ["/a.exe/../b", "/a.exe"]);
        assert_eq!(before_steps_back("/a/%2E./b\\..?x"), ["/a/%2E./b\\..?x", "/a", "/a/%2E./b"]);
        assert_eq!(before_steps_back("/a/..b/...//.."), ["/a/..b/...//..", "/a/..b/.../"]);
        assert_eq!(before_steps_back("/../../../../../../x").len(), 5);
    }
}
