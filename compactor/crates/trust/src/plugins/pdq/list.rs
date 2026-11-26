//! The list of PDQ hashes of known child sexual abuse material, as this process holds it: in
//! memory, about 100 bytes a hash, with an index that finds the hashes near another without
//! comparing it with each (see `nearest`). It is read whole from `pdq.hashList`, and again
//! every `pdq.refreshMinutes`.

use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use anyhow::{Context, Result, anyhow, bail};
use evieverse_core::config::PdqConfig;
use evieverse_core::log;
use evieverse_core::time::MINUTE;
use futures::future::{BoxFuture, FutureExt, Shared};
use serde_json::json;

use super::hash::{HASH_BITS, HASH_WORDS, Words, distance, from_hex, to_hex};
use crate::lines::{self, Lines};
use crate::trust::TrustContext;

/// How many values a word of a hash can have: the index has a table for each, for each of a
/// hash's words.
const WORD_VALUES: usize = 1 << 16;
/// How long a download of the list may take. An image waits for the first one.
const DOWNLOAD: Duration = Duration::from_millis(120_000);

/// The list, with its index.
pub struct HashList {
    /// How many hashes it has.
    pub size: usize,
    /// Their words, 16 to a hash, one hash after another.
    words: Vec<u16>,
    /// Where in `ids` each table of the index starts. There is a table for each value each of
    /// a hash's 16 words can have: that of word `w` with the value `v` is at `w * 65536 + v`,
    /// and ends where the next starts.
    starts: Vec<u32>,
    /// The tables, one after another: the hashes (by their place in `words`) that have that
    /// value in that word.
    ids: Vec<u32>,
}

/// The listed hash nearest an image's, where one is near enough to be of the same picture.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Match {
    /// The listed hash, as it is written: 64 hex digits.
    pub listed: String,
    /// How many of the 256 bits it differs from the image's hash in.
    pub distance: u32,
}

/// Whether `source`, which is `pdq.hashList`, is an address to download the list from, and
/// not a file's path.
fn is_url(source: &str) -> bool {
    let lower = source.get(..8).unwrap_or(source).to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// The 16-bit words that have at most `bits` bits set, fewest first: what `nearest` changes
/// a word by to find the ones near it. Worked out once for each number of bits.
fn within(bits: u32) -> Arc<Vec<u16>> {
    static WITHIN: Mutex<Vec<Option<Arc<Vec<u16>>>>> = Mutex::new(Vec::new());
    let bits = bits.min(16) as usize;
    let mut known = WITHIN.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if known.len() <= bits {
        known.resize(bits + 1, None);
    }
    known[bits]
        .get_or_insert_with(|| {
            let mut found = vec![];
            for set in 0..=bits as u32 {
                found.extend((0..=u16::MAX).filter(|word| word.count_ones() == set));
            }
            Arc::new(found)
        })
        .clone()
}

/// The hash of a line of the list: the first run of exactly 64 hex digits in it, so a plain
/// list of hashes is read, one a line, and so is a CSV or a TSV that has the hash in a
/// column. None for an empty line, a comment (#), and a line with no hash, as a header is.
pub fn hash_of_line(line: &str) -> Option<String> {
    let text = lines::trim(line);
    if text.is_empty() || text.starts_with('#') {
        return None;
    }
    text.split(|c: char| !c.is_ascii_hexdigit()).find(|run| run.len() == 64).map(str::to_ascii_lowercase)
}

/// The list of the hashes whose words are in `words`, with its index: for each of a hash's
/// 16 words, and each value it can have, the hashes that have it there.
fn indexed(words: Vec<u16>) -> HashList {
    let size = words.len() / HASH_WORDS;
    let tables = HASH_WORDS * WORD_VALUES;
    let mut starts = vec![0_u32; tables + 1];
    for id in 0..size {
        for word in 0..HASH_WORDS {
            starts[word * WORD_VALUES + usize::from(words[id * HASH_WORDS + word]) + 1] += 1;
        }
    }
    for table in 0..tables {
        starts[table + 1] += starts[table];
    }
    let mut ids = vec![0_u32; size * HASH_WORDS];
    // Where the next hash of each table goes.
    let mut next = starts[..tables].to_vec();
    for id in 0..size {
        for word in 0..HASH_WORDS {
            let table = word * WORD_VALUES + usize::from(words[id * HASH_WORDS + word]);
            ids[next[table] as usize] = id as u32;
            next[table] += 1;
        }
    }
    HashList { size, words, starts, ids }
}

/// What the lines of a list are gathered in, one at a time (see `hash_of_line`).
#[derive(Default)]
pub struct Gathered {
    words: Vec<u16>,
    half_set: usize,
}

impl Gathered {
    /// Takes the hash of a line, if it has one.
    pub fn line(&mut self, line: &str) {
        let Some(hash) = hash_of_line(line).and_then(|hex| from_hex(&hex)) else { return };
        if hash.iter().map(|word| word.count_ones()).sum::<u32>() == HASH_BITS / 2 {
            self.half_set += 1;
        }
        self.words.extend_from_slice(&hash);
    }

    /// The list of the hashes taken. Fails for one with no hash in it, and for one whose
    /// hashes aren't PDQ's: either mustn't take the place of a list.
    ///
    /// A PDQ hash sets the bits that are above the median of its 256 values, which is half
    /// of them, but for values that are equal. Hashes of another kind that are written the
    /// same way (a SHA-256 is 64 hex digits too) have exactly half their bits set one time
    /// in twenty, so a list of which fewer than half the hashes do is one of those, and
    /// would match nothing.
    pub fn list(self) -> Result<HashList> {
        let size = self.words.len() / HASH_WORDS;
        if size == 0 {
            bail!("PDQ_HASH_LIST has no hash in it: a PDQ hash is 64 hex digits, and the list has one a line");
        }
        if self.half_set * 2 < size {
            bail!(
                "PDQ_HASH_LIST doesn't hold PDQ hashes: only {} of its {size} have half their bits set, as nearly every PDQ hash has. Are they hashes of another kind, such as SHA-256, which is 64 hex digits too?",
                self.half_set
            );
        }
        Ok(indexed(self.words))
    }
}

/// The list that `lines` hold.
pub fn list_of<'a>(lines: impl IntoIterator<Item = &'a str>) -> Result<HashList> {
    let mut gathered = Gathered::default();
    for line in lines {
        gathered.line(line);
    }
    gathered.list()
}

/// The listed hash nearest the hash in `words`, if one differs from it in `most` bits or
/// fewer.
///
/// Two hashes that differ in so few bits differ in at most `most / 16` of them, rounded
/// down, in at least one of their 16 words. So the hashes to compare are only those that
/// have, in some word, a value that near this hash's, which the index finds: for the 31 bits
/// hashes are matched at by default, 17 values for each word. This is the multi-index
/// hashing the reference searches its own lists with.
pub fn nearest(list: &HashList, words: &Words, most: u32) -> Option<Match> {
    let mut best = most + 1;
    let mut found = None;
    for change in within(most / HASH_WORDS as u32).iter() {
        for (word, value) in words.iter().enumerate() {
            let table = word * WORD_VALUES + usize::from(value ^ change);
            for id in &list.ids[list.starts[table] as usize..list.starts[table + 1] as usize] {
                let listed = &list.words[*id as usize * HASH_WORDS..][..HASH_WORDS];
                let bits = distance(words, listed, best.saturating_sub(1));
                if bits < best {
                    best = bits;
                    found = Some(listed);
                }
            }
        }
        if best == 0 {
            break;
        }
    }
    found.map(|listed| Match { listed: to_hex(listed), distance: best })
}

/// Downloads the list. The address may hold a key, and the Authorization header is one, so
/// neither is put in an error.
async fn download(url: &str, authorization: Option<&str>) -> Result<HashList> {
    let client = reqwest::Client::builder().build().map_err(|err| anyhow!("could not ask for PDQ_HASH_LIST: {}", err.without_url()))?;
    let reading = async {
        let mut request = client.get(url).header("user-agent", "evieverse (pdq trust plugin)");
        if let Some(authorization) = authorization {
            request = request.header("authorization", authorization);
        }
        let response = request.send().await.map_err(|err| anyhow!("the server PDQ_HASH_LIST names could not be asked: {}", lines::cause(&err.without_url())))?;
        let status = response.status();
        if !status.is_success() {
            let refused = matches!(status.as_u16(), 401 | 403);
            bail!("the server PDQ_HASH_LIST names answered {}{}", status.as_u16(), if refused { ": it refused the request (PDQ_HASH_LIST_AUTHORIZATION)" } else { "" });
        }
        let mut gathered = Gathered::default();
        let mut lines = Lines::of(response);
        while let Some(line) = lines.next().await.map_err(|err| anyhow!("PDQ_HASH_LIST stopped arriving: {err}"))? {
            gathered.line(&line);
        }
        gathered.list()
    };
    tokio::time::timeout(DOWNLOAD, reading).await.map_err(|_| anyhow!("the server PDQ_HASH_LIST names took more than {} seconds to send the list", DOWNLOAD.as_secs()))?
}

struct State {
    list: Option<Arc<HashList>>,
    /// The reading under way, which leaves the list as it found it if it fails.
    reading: Option<Shared<BoxFuture<'static, ()>>>,
    /// When the next reading is due.
    due_at: i64,
    /// Why the last reading failed, if it did.
    failure: Option<String>,
    /// The file the list was read from, with its size and when it was last written: one that
    /// is still that isn't read again.
    read_file: Option<(String, u64, Option<SystemTime>)>,
}

/// The list, and what keeps it current. One per process.
pub struct KnownHashes {
    state: Arc<Mutex<State>>,
}

impl Default for KnownHashes {
    fn default() -> Self {
        Self { state: Arc::new(Mutex::new(State { list: None, reading: None, due_at: i64::MIN, failure: None, read_file: None })) }
    }
}

/// Reads the list from where `pdq.hashList` says: a file, unless it hasn't changed since it
/// was read, or an address. None for a file that is the one that was read.
async fn read(config: &PdqConfig, state: &Mutex<State>) -> Result<Option<(HashList, Option<(String, u64, Option<SystemTime>)>)>> {
    let Some(source) = &config.hash_list else { bail!("PDQ_HASH_LIST is not set: the pdq trust plugin needs the list of hashes to match images against") };
    if is_url(source) {
        return Ok(Some((download(source, config.authorization.as_deref()).await?, None)));
    }
    let facts = tokio::fs::metadata(source).await.with_context(|| format!("could not read PDQ_HASH_LIST ({source})"))?;
    let file = (source.clone(), facts.len(), facts.modified().ok());
    {
        let state = state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.list.is_some() && state.read_file.as_ref() == Some(&file) {
            return Ok(None);
        }
    }
    let mut gathered = Gathered::default();
    let mut lines = Lines::of_file(tokio::fs::File::open(source).await.with_context(|| format!("could not read PDQ_HASH_LIST ({source})"))?);
    while let Some(line) = lines.next().await.map_err(|err| anyhow!("could not read PDQ_HASH_LIST ({source}): {err}"))? {
        gathered.line(&line);
    }
    // Making the index of a long list is work that takes its thread a while.
    let list = tokio::task::spawn_blocking(move || gathered.list()).await.context("the list of hashes could not be indexed")??;
    Ok(Some((list, Some(file))))
}

impl KnownHashes {
    /// Starts a reading if one is due, and doesn't wait for it: the list is replaced when it
    /// ends. One that fails leaves the list there is, which is used for as long as no newer
    /// one can be had, and is tried again a minute later. The log is told either way.
    pub fn refresh(&self, ctx: &TrustContext<'_>) {
        self.refresh_with(&ctx.config.pdq, ctx.now, ctx.process_log);
    }

    /// As `refresh`, for what checks a file outside a request: a video, once it is made.
    pub fn refresh_with(&self, config: &PdqConfig, clock: &evieverse_core::time::Clock, log: &log::Logger) {
        let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = clock();
        if state.reading.is_some() || now < state.due_at {
            return;
        }
        // A minute from now the next one is tried, if this one fails.
        state.due_at = now + MINUTE;
        let (config, clock, log, shared) = (config.clone(), clock.clone(), log.clone(), self.state.clone());
        let task = tokio::spawn(async move {
            let done = read(&config, &shared).await;
            let mut state = shared.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            match done {
                Ok(read) => {
                    if let Some((list, file)) = read {
                        state.list = Some(Arc::new(list));
                        state.read_file = file;
                    }
                    state.failure = None;
                    state.due_at = clock() + config.refresh_minutes * MINUTE;
                    log.info(json!({ "hashes": state.list.as_ref().map(|list| list.size) }), "pdq: read the list of hashes of known child sexual abuse material");
                }
                Err(err) => {
                    log.error(json!({ "err": log::err(&err), "stale": state.list.is_some() }), "pdq: the list of hashes of known child sexual abuse material couldn't be read");
                    state.failure = Some(format!("{err:#}"));
                }
            }
            state.reading = None;
        });
        state.reading = Some(async move { drop(task.await) }.boxed().shared());
    }

    /// The list, current or not. A process that has none yet waits for its first reading,
    /// and fails if that fails: there is then nothing to check an image with.
    pub async fn get(&self, ctx: &TrustContext<'_>) -> Result<Arc<HashList>> {
        self.get_with(&ctx.config.pdq, ctx.now, ctx.process_log).await
    }

    /// As `get`, for what checks a file outside a request.
    pub async fn get_with(&self, config: &PdqConfig, clock: &evieverse_core::time::Clock, log: &log::Logger) -> Result<Arc<HashList>> {
        self.refresh_with(config, clock, log);
        let waiting = {
            let state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if state.list.is_some() { None } else { state.reading.clone() }
        };
        if let Some(reading) = waiting {
            reading.await;
        }
        let state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match &state.list {
            Some(list) => Ok(list.clone()),
            None => bail!("the pdq trust plugin has no list of hashes to check images with: {}", state.failure.as_deref().unwrap_or("its reading has not been tried yet")),
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A hash as a PDQ hash is: half its bits set, which ones made from `seed`.
    pub(crate) fn hash(seed: u64) -> Words {
        let mut words = [0_u16; HASH_WORDS];
        let mut state = seed.wrapping_mul(0x9e37_79b9_7f4a_7c15).wrapping_add(1);
        let mut set = 0;
        while set < 128 {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            let bit = (state % 256) as usize;
            if words[bit >> 4] & (1 << (bit & 15)) == 0 {
                words[bit >> 4] |= 1 << (bit & 15);
                set += 1;
            }
        }
        words
    }

    /// `words` with `bits` of its bits changed, spread over its words.
    pub(crate) fn changed(words: &Words, bits: usize) -> Words {
        let mut other = *words;
        for n in 0..bits {
            other[(n * 7) % HASH_WORDS] ^= 1 << ((n * 5 + n / HASH_WORDS) % 16);
        }
        other
    }

    #[test]
    fn reads_the_hash_of_a_line_of_any_kind_of_list() {
        let hex = to_hex(&hash(1));
        assert_eq!(hash_of_line(&hex), Some(hex.clone()));
        assert_eq!(hash_of_line(&format!("  {}  \r", hex.to_uppercase())), Some(hex.clone()));
        assert_eq!(hash_of_line(&format!("17,{hex},2026-01-01")), Some(hex.clone()));
        assert_eq!(hash_of_line(&format!("abc\t{hex}\tx")), Some(hex.clone()));
        assert_eq!(hash_of_line(&format!("# {hex}")), None);
        assert_eq!(hash_of_line("id,hash,added"), None);
        assert_eq!(hash_of_line(""), None);
        // Longer than a hash is no hash.
        assert_eq!(hash_of_line(&format!("{hex}0")), None);
        assert_eq!(hash_of_line(&hex[1..]), None);

        // As the API read them, before this replaced it.
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/pdq.json");
        let fixture: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let lines = fixture["lines"].as_array().unwrap();
        assert!(lines.len() >= 10);
        for case in lines {
            assert_eq!(hash_of_line(case[0].as_str().unwrap()).as_deref(), case[1].as_str(), "{}", case[0]);
        }
    }

    #[test]
    fn refuses_a_list_with_no_hash_and_one_of_hashes_of_another_kind() {
        let err = list_of(["# nothing", "", "hash"]).err().unwrap();
        assert!(err.to_string().contains("PDQ_HASH_LIST has no hash in it"), "{err}");
        let sha = ["0".repeat(64), "1".repeat(64), to_hex(&hash(1))];
        let err = list_of(sha.iter().map(String::as_str)).err().unwrap();
        assert!(err.to_string().contains("only 1 of its 3 have half their bits set"), "{err}");
        let pdq = [to_hex(&hash(1)), "0".repeat(64)];
        assert_eq!(list_of(pdq.iter().map(String::as_str)).unwrap().size, 2);
    }

    #[test]
    fn finds_the_nearest_listed_hash_within_the_distance() {
        let hashes: Vec<Words> = (1..=500).map(hash).collect();
        let lines: Vec<String> = hashes.iter().map(|words| to_hex(words)).collect();
        let list = list_of(lines.iter().map(String::as_str)).unwrap();
        assert_eq!(list.size, 500);
        for (at, words) in hashes.iter().enumerate().step_by(37) {
            assert_eq!(nearest(&list, words, 31), Some(Match { listed: lines[at].clone(), distance: 0 }));
            assert_eq!(nearest(&list, &changed(words, 31), 31), Some(Match { listed: lines[at].clone(), distance: 31 }));
            assert_eq!(nearest(&list, &changed(words, 32), 31), None);
            assert_eq!(nearest(&list, &changed(words, 5), 0), None);
            assert_eq!(nearest(&list, &changed(words, 40), 47), Some(Match { listed: lines[at].clone(), distance: 40 }));
        }
        // Of two that are near, the nearer.
        let near: Vec<String> = [changed(&hashes[0], 9), changed(&hashes[0], 3), changed(&hashes[0], 6)].iter().map(|words| to_hex(words)).collect();
        let list = list_of(near.iter().chain(&lines[1..]).map(String::as_str)).unwrap();
        assert_eq!(nearest(&list, &hashes[0], 31), Some(Match { listed: near[1].clone(), distance: 3 }));
        // And the very hash, where it is listed too.
        let list = list_of(near.iter().chain(&lines).map(String::as_str)).unwrap();
        assert_eq!(nearest(&list, &hashes[0], 31), Some(Match { listed: lines[0].clone(), distance: 0 }));
        assert_eq!(nearest(&list, &hash(9999), 31), None);
    }
}
