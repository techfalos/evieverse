//! URLhaus's list of the URLs that spread malware, as this process holds it, and what keeps
//! it current.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use evieverse_core::config::UrlhausConfig;
use evieverse_core::log;
use evieverse_core::time::MINUTE;
use futures::future::{BoxFuture, FutureExt, Shared};
use serde_json::json;

use super::links::{Link, address_of, before_steps_back, endings};
use crate::lines::{self, Lines};
use crate::trust::TrustContext;

/// How long a download of the list may take. A post with a link waits for the first one.
const DOWNLOAD: Duration = Duration::from_secs(30);

/// The longest listed URL that a link is taken for when it only starts with it, in
/// characters. A longer one is matched whole.
const LONGEST_START: usize = 512;

/// The list: what is listed, as it is compared.
#[derive(Debug, Default)]
pub struct Listed {
    /// Each host that has a listed URL, with the length of its longest one.
    pub hosts: HashMap<String, usize>,
    /// The listed URLs: host, path and query.
    pub urls: HashSet<String>,
}

impl Listed {
    /// The list that holds these URLs, each as a line of the list has it.
    pub fn of<'a>(urls: impl IntoIterator<Item = &'a str>) -> Self {
        let mut listed = Self::default();
        for url in urls {
            listed.add(url);
        }
        listed
    }

    fn add(&mut self, line: &str) {
        let Some(address) = url_of_line(line).and_then(|url| address_of(&url)) else { return };
        let longest = self.hosts.entry(address.host).or_insert(0);
        *longest = (*longest).max(address.full.len());
        self.urls.insert(address.full);
    }
}

/// Whether `link` is on the list. It is when it is a listed URL:
/// - as the text has it, or ending at any of the places it could end (see `endings`);
/// - with a query added, if the listed URL has none: that changes nothing of what it serves;
/// - with anything written after it, unless the listed URL ends in a slash. A server gives
///   the same file for example.com/a.exe/x as for example.com/a.exe, and a text can go on
///   right after a link (as the server's own reading of "[a](example.com/a.exe)b" does), so
///   a link that starts with a listed file's address is that file's. A listed folder, or a
///   host's front page, isn't matched so: every other page of the host would be.
pub fn is_listed(listed: &Listed, link: &Link) -> bool {
    for origin in &link.origins {
        // Nothing on that host is listed, which is so of nearly every link: no need to read on.
        let Some(longest) = address_of(origin).and_then(|address| listed.hosts.get(&address.host).copied()) else { continue };
        for tail in endings(&link.tail) {
            if address_of(&format!("{origin}{tail}")).is_some_and(|address| listed.urls.contains(&address.full) || listed.urls.contains(&address.path)) {
                return true;
            }
        }
        for tail in before_steps_back(&link.tail) {
            let Some(address) = address_of(&format!("{origin}{tail}")) else { continue };
            if listed.urls.contains(&address.full) || listed.urls.contains(&address.path) {
                return true;
            }
            // Each start of it that could be a listed URL: longer than the host and its slash,
            // and no longer than the host's longest.
            let full = address.full.as_bytes();
            let mut end = (full.len().saturating_sub(1)).min(longest).min(LONGEST_START);
            while end > address.host.len() + 1 {
                if full[end - 1] != b'/' && address.full.is_char_boundary(end) && listed.urls.contains(&address.full[..end]) {
                    return true;
                }
                end -= 1;
            }
        }
    }
    false
}

/// The URL of a line of the list. URLhaus writes it as a CSV, of which the URL is the first
/// field that is one, and as a plain list of URLs, one a line; either is read. None for a
/// comment (#), and for a line with no URL.
pub fn url_of_line(line: &str) -> Option<String> {
    let text = lines::trim(line);
    if text.starts_with('#') {
        return None;
    }
    let lower = text.to_ascii_lowercase();
    let start = match (lower.find("http://"), lower.find("https://")) {
        (Some(a), Some(b)) => a.min(b),
        (a, b) => a.or(b)?,
    };
    if start == 0 {
        return Some(text.to_owned());
    }
    // A field without quotes ends at the next comma.
    if !text[..start].ends_with('"') {
        return Some(text[start..].split(',').next().unwrap_or("").to_owned());
    }
    // A quoted one ends at the next quote that isn't doubled, which is how a CSV writes a quote.
    let mut url = String::new();
    let mut chars = text[start..].chars().peekable();
    while let Some(c) = chars.next() {
        if c != '"' {
            url.push(c);
        } else if chars.peek() == Some(&'"') {
            url.push(c);
            chars.next();
        } else {
            break;
        }
    }
    Some(url)
}

/// `text` as part of an address, as the API writes one (`encodeURIComponent`).
fn component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Downloads the list. The Auth-Key is part of the address, so neither is put in an error.
async fn download(config: &UrlhausConfig) -> Result<Listed> {
    let key = config.auth_key.clone().unwrap_or_default();
    let address = config.list_url.replace("{key}", &component(&key));
    let client = reqwest::Client::builder().build().map_err(|err| anyhow!("could not ask URLhaus for its list: {}", err.without_url()))?;
    let reading = async {
        let response = client
            .get(address)
            .header("auth-key", key)
            .header("user-agent", "evieverse (urlhaus trust plugin)")
            .send()
            .await
            .map_err(|err| anyhow!("URLhaus could not be asked for its list: {}", lines::cause(&err.without_url())))?;
        let status = response.status();
        if !status.is_success() {
            let refused = matches!(status.as_u16(), 401 | 403);
            bail!("URLhaus answered {}{}", status.as_u16(), if refused { ": it refused the Auth-Key (URLHAUS_AUTH_KEY)" } else { "" });
        }
        let mut listed = Listed::default();
        let mut lines = Lines::of(response);
        while let Some(line) = lines.next().await.map_err(|err| anyhow!("URLhaus's list stopped arriving: {err}"))? {
            listed.add(&line);
        }
        Ok(listed)
    };
    let listed = tokio::time::timeout(DOWNLOAD, reading).await.map_err(|_| anyhow!("URLhaus took more than {} seconds to send its list", DOWNLOAD.as_secs()))??;
    // An answer that isn't the list (an error page, a list that moved) mustn't take the place of one.
    if listed.urls.is_empty() {
        bail!("what URLhaus answered with has no URL in it: is URLHAUS_LIST_URL one of its lists?");
    }
    Ok(listed)
}

struct State {
    listed: Option<Arc<Listed>>,
    /// The download under way, which leaves the list as it found it if it fails.
    download: Option<Shared<BoxFuture<'static, ()>>>,
    /// When the next download is due.
    due_at: i64,
    /// Why the last download failed, if it did.
    failure: Option<String>,
}

/// The list, and what keeps it current. One per process.
pub struct MalwareList {
    state: Arc<Mutex<State>>,
}

impl Default for MalwareList {
    fn default() -> Self {
        Self { state: Arc::new(Mutex::new(State { listed: None, download: None, due_at: i64::MIN, failure: None })) }
    }
}

impl MalwareList {
    /// Starts a download if one is due, and doesn't wait for it: the list is replaced when
    /// it ends. One that fails leaves the list there is, which is used for as long as no
    /// newer one can be had, and is tried again a minute later. The log is told either way.
    pub fn refresh(&self, ctx: &TrustContext<'_>) {
        let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = (ctx.now)();
        if state.download.is_some() || now < state.due_at {
            return;
        }
        // A minute from now the next one is tried, if this one fails.
        state.due_at = now + MINUTE;
        let (config, clock, log, shared) = (ctx.config.urlhaus.clone(), ctx.now.clone(), ctx.process_log.clone(), self.state.clone());
        let task = tokio::spawn(async move {
            let downloaded = download(&config).await;
            let mut state = shared.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            match downloaded {
                Ok(listed) => {
                    log.info(json!({ "urls": listed.urls.len(), "hosts": listed.hosts.len() }), "urlhaus: downloaded URLhaus's list of malware URLs");
                    state.listed = Some(Arc::new(listed));
                    state.failure = None;
                    state.due_at = clock() + config.refresh_minutes * MINUTE;
                }
                Err(err) => {
                    log.error(json!({ "err": log::err(&err), "stale": state.listed.is_some() }), "urlhaus: URLhaus's list of malware URLs couldn't be downloaded");
                    state.failure = Some(format!("{err:#}"));
                }
            }
            state.download = None;
        });
        state.download = Some(async move { drop(task.await) }.boxed().shared());
    }

    /// The list, current or not. A process that has none yet waits for its first download,
    /// and fails if that fails: there is then nothing to check a link with.
    pub async fn get(&self, ctx: &TrustContext<'_>) -> Result<Arc<Listed>> {
        self.refresh(ctx);
        let waiting = {
            let state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if state.listed.is_some() { None } else { state.download.clone() }
        };
        if let Some(download) = waiting {
            download.await;
        }
        let state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match &state.listed {
            Some(listed) => Ok(listed.clone()),
            None => bail!("the urlhaus trust plugin has no list of malware URLs to check links with: {}", state.failure.as_deref().unwrap_or("its download has not been tried yet")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::links::find_links;
    use super::*;

    fn listed(text: &str, urls: &[&str]) -> bool {
        let list = Listed::of(urls.iter().copied());
        find_links(text).unwrap().iter().any(|link| is_listed(&list, link))
    }

    #[test]
    fn reads_lines_and_checks_links_as_the_api_did() {
        let fixture = super::super::links::tests::fixture();
        let mut differ = vec![];
        for case in fixture["lines"].as_array().unwrap() {
            let url = url_of_line(case[0].as_str().unwrap());
            if url.as_deref() != case[1].as_str() {
                differ.push(format!("the URL of the line {}: {url:?} and not {}", case[0], case[1]));
            }
        }
        let urls: Vec<String> = serde_json::from_value(fixture["listed"].clone()).unwrap();
        let list = Listed::of(urls.iter().map(String::as_str));
        let checks = fixture["checks"].as_array().unwrap();
        for case in checks {
            let is = find_links(case[0].as_str().unwrap()).unwrap().iter().any(|link| is_listed(&list, link));
            if is != case[1].as_bool().unwrap() {
                differ.push(format!("whether {} has a listed link: {is} and not {}", case[0], case[1]));
            }
        }
        assert!(checks.len() > 40);
        assert!(differ.is_empty(), "{} differ:\n{}", differ.len(), differ.join("\n"));
    }

    #[test]
    fn reads_the_url_of_a_line_of_either_kind_of_list() {
        assert_eq!(url_of_line("http://bad.example/a.exe").as_deref(), Some("http://bad.example/a.exe"));
        assert_eq!(url_of_line("  HTTPS://bad.example/a  \r").as_deref(), Some("HTTPS://bad.example/a"));
        assert_eq!(url_of_line("# a comment with http://bad.example/"), None);
        assert_eq!(url_of_line(""), None);
        assert_eq!(url_of_line("id,dateadded,url"), None);
        assert_eq!(url_of_line(r#""1","2026-01-01 00:00:00","http://bad.example/a,b ""c"".exe","online""#).as_deref(), Some(r#"http://bad.example/a,b "c".exe"#));
        assert_eq!(url_of_line("1,2026-01-01,http://bad.example/a.exe,online").as_deref(), Some("http://bad.example/a.exe"));
        assert_eq!(component("a b/ü?*"), "a%20b%2F%C3%BC%3F*");
    }

    #[test]
    fn a_link_is_listed_as_the_text_has_it_or_where_it_could_end() {
        let list = &["http://bad.example/a.exe", "https://other.example/dir/", "http://front.example/", "http://q.example/x?id=1"];
        assert!(listed("get http://bad.example/a.exe", list));
        assert!(listed("get it at bad.example/a.exe.", list));
        assert!(!listed("[it](https://BAD.example:80/a.exe)", list));
        assert!(listed("[it](http://BAD.example:80/a.exe)", list));
        assert!(listed("[a](bad.example/a.exe)[b](x", list));
        // With a query added, and with anything written after it.
        assert!(listed("http://bad.example/a.exe?x=1", list));
        assert!(listed("[a](bad.example/a.exe)b", list));
        assert!(listed("bad.example/a.exe/more", list));
        // A step back doesn't take the link's own path away.
        assert!(listed("bad.example/a.exe/../b", list));
        assert!(listed("http://r.example/?to=http://bad.example/a.exe", list));
        // Another file of the host isn't listed, nor is what only starts as a listed folder or front page does.
        assert!(!listed("http://bad.example/b.exe", list));
        assert!(!listed("http://bad.example/a.ex", list));
        assert!(listed("https://other.example/dir/", list));
        assert!(!listed("https://other.example/dir/file", list));
        assert!(listed("front.example", list));
        assert!(!listed("front.example/page", list));
        assert!(listed("http://q.example/x?id=1", list));
        assert!(!listed("http://q.example/x?id=2", list));
        assert!(!listed("nothing.example/a.exe and no link at all", list));
    }
}
