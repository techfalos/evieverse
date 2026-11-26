//! Feed summaries: what a feed record holds of a post except its likes and its publisher's
//! name, as text, Brotli-compressed, one per piece of content. The same format and the same
//! places as src/storage/summaryStore.ts, which the API reads them by.

use std::collections::BTreeSet;
use std::io::Cursor;

use anyhow::{Context, Result, anyhow, bail};
use brotli::enc::BrotliEncoderParams;
use brotli::enc::backward_references::BrotliEncoderMode;
use futures::StreamExt;
use futures::stream;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::content::ContentMeta;
use crate::format::mentions_in;
use crate::hot::HotStore;
use crate::object::ObjectStore;
use crate::posts::{Mention, Origin, OriginPublisher, Preview, PreviewKind, Video, media_url, origin_media_url, preview_of, read_preview};
use crate::time::{Clock, DAY, utc_day};

/// The most one call has under way at the object store at once: summaries being looked for,
/// and written where one is missing (`ensure_many`), or copies being deleted (`remove`).
const STORE_CONCURRENCY: usize = 32;

/// The window Brotli compresses within, as a power of two: zlib's default, which is what the
/// API's own compression of a summary uses.
const BROTLI_WINDOW: i32 = 22;

/// Everything a feed record holds except its likes and the publisher's name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub content_id: String,
    pub created_at: i64,
    /// When the content was last written.
    pub updated_at: i64,
    pub user_id: String,
    pub mime_type: String,
    /// Declared by the publisher at /store.
    pub ai_generated: bool,
    /// Whether the post takes comments.
    pub comments: bool,
    pub tags: Vec<String>,
    /// The post's title. Absent on a post that has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub preview: Preview,
    /// On a repost of a post on another server: the original, which the preview is of.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<Origin>,
    /// The users the preview's text mentions. Absent where it mentions nobody.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mentions: Option<Vec<Mention>>,
    /// When the content was reposted, once for each repost of it. It isn't part of what a
    /// summary says, and a summary that is read has none: it says where one that is written is
    /// kept (see `SummaryRef`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reposted_at: Option<Vec<i64>>,
}

/// What locates a summary: it is kept under the day the content was created and under each
/// day it was reposted, the same bytes under each. To write or erase one, `created_at` is the
/// content's and `reposted_at` its reposts', which covers every copy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryRef {
    pub content_id: String,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reposted_at: Vec<i64>,
}

impl From<&Summary> for SummaryRef {
    fn from(s: &Summary) -> Self {
        Self {
            content_id: s.content_id.clone(),
            created_at: s.created_at,
            reposted_at: s.reposted_at.clone().unwrap_or_default(),
        }
    }
}

/// What a summary takes from the content's row of the database.
#[derive(Debug, Clone, Copy)]
pub struct Posted<'a> {
    pub content_id: &'a str,
    pub user_id: &'a str,
    pub created_at: i64,
    pub ai_generated: bool,
}

/// The users the start of a post's text mentions, which is what its summary keeps of the
/// post's mentions: none where it mentions nobody.
fn preview_mentions(meta: &ContentMeta) -> Option<Vec<Mention>> {
    let all = meta.mentions.as_ref().filter(|mentions| !mentions.is_empty())?;
    let text = meta
        .preview
        .text
        .as_ref()
        .filter(|text| !text.is_empty() && meta.preview.kind != PreviewKind::Link)?;
    Some(mentions_in(text, all)).filter(|mentions| !mentions.is_empty())
}

/// The summary of the content `meta` describes, rebuilt from the database and the meta file,
/// which outlives the summary store's retention. `reposted_at` is when the content was
/// reposted, once for each repost (see `repost_times`): it says where the summary is kept,
/// beside the content's own day.
pub fn summary_of(post: Posted<'_>, meta: &ContentMeta, public_base_url: &str, reposted_at: &[i64]) -> Summary {
    Summary {
        content_id: post.content_id.to_owned(),
        created_at: post.created_at,
        updated_at: meta.updated_at,
        user_id: post.user_id.to_owned(),
        mime_type: meta.mime_type.clone(),
        ai_generated: post.ai_generated,
        comments: meta.comments == Some(true),
        tags: meta.tags.clone(),
        title: meta.title.clone().filter(|title| !title.is_empty()),
        preview: preview_of(post.content_id, &meta.preview, meta.origin.as_ref(), public_base_url),
        origin: meta.origin.clone(),
        mentions: preview_mentions(meta),
        reposted_at: Some(reposted_at.to_vec()).filter(|times| !times.is_empty()),
    }
}

/// The Redis key of a piece of content's summary: one key, under however many days the object
/// store keeps it.
pub fn summary_key(content_id: &str) -> String {
    format!("sum:{content_id}")
}

/// The object-store prefix of the summaries kept under a UTC day: the day's number, as five
/// digits, which is how `purge_before` knows a day.
fn day_prefix(day: i64) -> String {
    format!("summaries/{day:05}/")
}

/// Where a piece of content's summary is kept under one UTC day.
fn object_key(content_id: &str, day: i64) -> String {
    format!("{}{content_id}.br", day_prefix(day))
}

/// Where a feed reads the summary of an entry placed at `created_at`.
pub fn summary_object_key(content_id: &str, created_at: i64) -> String {
    object_key(content_id, utc_day(created_at))
}

/// Every key a summary is kept under: one for the day the content was created, and one for
/// each day it was reposted, each once, in the order of those times.
fn summary_object_keys(r: &SummaryRef) -> Vec<String> {
    let mut seen = BTreeSet::new();
    std::iter::once(r.created_at)
        .chain(r.reposted_at.iter().copied())
        .map(utc_day)
        .filter(|day| seen.insert(*day))
        .map(|day| object_key(&r.content_id, day))
        .collect()
}

/// The latest time a summary is found by: for as long as that is young, Redis keeps the summary.
fn latest(r: &SummaryRef) -> i64 {
    r.reposted_at.iter().copied().fold(r.created_at, i64::max)
}

/// What a summary keeps beside the preview's text, on a header line of its own, as JSON: the
/// post's title, the alternative texts of an image post's images, and what a processed video
/// is. With them, the users the preview's text mentions. None of a summary whose post has
/// none of the four.
fn extras_of(s: &Summary) -> Option<Map<String, Value>> {
    let mentions = s.mentions.as_ref().filter(|m| !m.is_empty());
    let mut extras = Map::new();
    if let Some(title) = s.title.as_ref().filter(|title| !title.is_empty()) {
        extras.insert("title".into(), Value::from(title.clone()));
    }
    match s.preview.kind {
        PreviewKind::Image => {
            if let Some(alt) = s.preview.alts() {
                extras.insert("alt".into(), Value::from(alt));
            }
        }
        PreviewKind::Video => {
            if let Some(video) = &s.preview.video {
                let mut stored = Map::new();
                stored.insert("id".into(), Value::from(video.id.clone()));
                stored.insert("width".into(), Value::Number(video.width.clone()));
                stored.insert("height".into(), Value::Number(video.height.clone()));
                stored.insert("duration".into(), Value::Number(video.duration.clone()));
                extras.insert("video".into(), Value::Object(stored));
            }
        }
        _ => {}
    }
    if let Some(mentions) = mentions {
        extras.insert("mentions".into(), serde_json::to_value(mentions).ok()?);
    }
    (!extras.is_empty()).then_some(extras)
}

/// A summary as it is written, before it is compressed. Plain text rather than JSON, which
/// compresses better: a header line of numbers (when the content was created and last written,
/// 1 if AI-generated, else 0, and 1 if it takes comments, else 0), then one line each for the
/// publisher's id, MIME type, hashtags and preview kind. Everything after those five lines is
/// the preview's text: a text post's or a caption, or a link's URL.
///
/// The summary of a repost of a post on another server has a fifth number, 1, and with it a
/// sixth header line, for the original: its address, then its publisher's id and username
/// there. The summary of an image post of more than one image has a sixth number: how many
/// images it has. The summary of a post that has a title, of an image post whose images are
/// described, of a video the server has processed, and of a post whose preview mentions users,
/// has a seventh number, 1, and with it one more header line: what it keeps beside the
/// preview's text, as JSON.
/// As few of the numbers are written as say it all.
pub fn encode_summary(s: &Summary) -> String {
    let images = s.preview.album();
    let extras = extras_of(s);
    let numbers = [
        s.created_at,
        s.updated_at,
        i64::from(s.ai_generated),
        i64::from(s.comments),
        i64::from(s.origin.is_some()),
        images.unwrap_or(0),
        i64::from(extras.is_some()),
    ];
    let said = if extras.is_some() {
        7
    } else if images.is_some() {
        6
    } else if s.origin.is_some() {
        5
    } else {
        4
    };
    let mut lines = vec![
        numbers[..said].iter().map(i64::to_string).collect::<Vec<_>>().join(" "),
        s.user_id.clone(),
        s.mime_type.clone(),
        s.tags.join(" "),
        s.preview.kind.as_str().to_owned(),
    ];
    if let Some(origin) = &s.origin {
        lines.push(format!("{} {} {}", origin.url, origin.publisher.user_id, origin.publisher.username));
    }
    if let Some(extras) = extras {
        lines.push(Value::Object(extras).to_string());
    }
    // What a summary holds after its header: a text post's text or a caption, or a link's URL.
    lines.push(if s.preview.kind == PreviewKind::Link {
        s.preview.url.clone().unwrap_or_default()
    } else {
        s.preview.text.clone().unwrap_or_default()
    });
    lines.join("\n")
}

/// The original a summary's sixth header line names.
fn stored_origin(content_id: &str, line: &str) -> Result<Origin> {
    let mut parts = line.split(' ');
    let (url, user_id) = (parts.next().unwrap_or_default(), parts.next().unwrap_or_default());
    let username = parts.collect::<Vec<_>>();
    if url.is_empty() || user_id.is_empty() || username.is_empty() {
        bail!("summary of {content_id} names no original");
    }
    Ok(Origin {
        url: url.to_owned(),
        publisher: OriginPublisher {
            user_id: user_id.to_owned(),
            username: username.join(" "),
        },
    })
}

/// The title a summary's line of extras holds: none where it holds none, or one that is empty.
fn stored_title(extras: &Map<String, Value>) -> Option<String> {
    extras.get("title")?.as_str().filter(|title| !title.is_empty()).map(str::to_owned)
}

/// The mentions a summary's line of extras holds: each of them that names a user.
fn stored_mentions(extras: &Map<String, Value>) -> Option<Vec<Mention>> {
    let mentions: Vec<Mention> = extras
        .get("mentions")?
        .as_array()?
        .iter()
        .filter_map(|m| {
            Some(Mention {
                user_id: m.get("userId")?.as_str()?.to_owned(),
                username: m.get("username")?.as_str()?.to_owned(),
            })
        })
        .collect();
    (!mentions.is_empty()).then_some(mentions)
}

/// The preview a summary's kind line and body hold, and for an image post of several images,
/// how many its first line says it has; with what its line of extras holds of it.
fn stored_preview(content_id: &str, kind: &str, text: &str, images: Option<i64>, extras: &Map<String, Value>) -> Result<Preview> {
    let kind = PreviewKind::parse(kind).ok_or_else(|| anyhow!("summary of {content_id} has an unknown preview kind"))?;
    let mut preview = Preview::of(kind);
    match kind {
        PreviewKind::Link => preview.url = Some(text.to_owned()),
        PreviewKind::Image => {
            preview.text = Some(text.to_owned());
            preview.image_count = images.filter(|count| *count > 1);
            preview.alt = extras
                .get("alt")
                .and_then(Value::as_array)
                .map(|alt| alt.iter().map(|a| a.as_str().map_or_else(|| a.to_string(), str::to_owned)).collect());
        }
        PreviewKind::Video => {
            preview.text = Some(text.to_owned());
            preview.video = extras.get("video").and_then(|v| serde_json::from_value::<Video>(v.clone()).ok());
        }
        PreviewKind::Text | PreviewKind::Audio => preview.text = Some(text.to_owned()),
    }
    Ok(preview)
}

/// The next line of a summary's header, which `rest` then begins after. Fails if the text ends
/// before the line does.
fn header_line<'a>(rest: &mut &'a str, content_id: &str) -> Result<&'a str> {
    let (line, after) = rest.split_once('\n').ok_or_else(|| anyhow!("summary of {content_id} is truncated"))?;
    *rest = after;
    Ok(line)
}

/// The summary that `text` holds, as `encode_summary` wrote it, of the content with this id,
/// which the text doesn't say. An image's, video's or audio's URL is built here: from
/// `public_base_url` and the id, or for a repost of a post on another server, from the
/// original's address. `reposted_at` is never set. Fails if the text ends before its header
/// does, names a preview kind that is none of a post's, or says it has an original and names
/// none.
pub fn decode_summary(content_id: &str, text: &str, public_base_url: &str) -> Result<Summary> {
    let mut rest = text;
    let numbers = header_line(&mut rest, content_id)?;
    let user_id = header_line(&mut rest, content_id)?;
    let mime_type = header_line(&mut rest, content_id)?;
    let tags = header_line(&mut rest, content_id)?;
    let kind = header_line(&mut rest, content_id)?;
    let numbers: Vec<Option<i64>> = numbers.split(' ').map(|n| n.parse().ok()).collect();
    let number = |i: usize| numbers.get(i).copied().flatten();
    let origin = if number(4) == Some(1) {
        Some(stored_origin(content_id, header_line(&mut rest, content_id)?)?)
    } else {
        None
    };
    let extras = if number(6) == Some(1) {
        let line = header_line(&mut rest, content_id)?;
        match serde_json::from_str::<Value>(line).with_context(|| format!("summary of {content_id} has extras that are no JSON"))? {
            Value::Object(extras) => extras,
            _ => bail!("summary of {content_id} has extras that are no object"),
        }
    } else {
        Map::new()
    };
    let stored = stored_preview(content_id, kind, rest, number(5), &extras)?;
    let bytes_url = origin.as_ref().map_or_else(|| media_url(public_base_url, content_id), origin_media_url);
    Ok(Summary {
        content_id: content_id.to_owned(),
        created_at: number(0).ok_or_else(|| anyhow!("summary of {content_id} doesn't say when it was created"))?,
        updated_at: number(1).ok_or_else(|| anyhow!("summary of {content_id} doesn't say when it was written"))?,
        user_id: user_id.to_owned(),
        mime_type: mime_type.to_owned(),
        ai_generated: number(2) == Some(1),
        comments: number(3) == Some(1),
        tags: if tags.is_empty() {
            vec![]
        } else {
            tags.split(' ').map(str::to_owned).collect()
        },
        title: stored_title(&extras),
        preview: read_preview(&stored, &bytes_url),
        origin,
        mentions: stored_mentions(&extras),
        reposted_at: None,
    })
}

/// A summary's text, Brotli-compressed as the API compresses one: as text, at `quality`
/// (0-11), told how long the text is.
pub fn compress_summary(text: &str, quality: u32) -> Result<Vec<u8>> {
    let params = BrotliEncoderParams {
        mode: BrotliEncoderMode::BROTLI_MODE_TEXT,
        quality: i32::try_from(quality.min(11)).unwrap_or(11),
        lgwin: BROTLI_WINDOW,
        size_hint: text.len(),
        ..BrotliEncoderParams::default()
    };
    let mut out = Vec::with_capacity(text.len() / 2 + 16);
    brotli::BrotliCompress(&mut Cursor::new(text.as_bytes()), &mut out, &params).context("could not compress a summary")?;
    Ok(out)
}

/// The text a compressed summary holds.
pub fn decompress_summary(blob: &[u8]) -> Result<String> {
    let mut out = Vec::with_capacity(blob.len() * 4);
    brotli::BrotliDecompress(&mut Cursor::new(blob), &mut out).context("a summary is not Brotli-compressed text")?;
    String::from_utf8(out).context("a summary is not UTF-8 text")
}

/// How a `SummaryStore` keeps and reads summaries: `feed.summary*` and `publicBaseUrl` of the
/// configuration.
#[derive(Debug, Clone)]
pub struct SummaryOptions {
    /// Posts younger than this are kept in Redis too.
    pub hot_days: i64,
    /// Brotli quality, 0-11.
    pub quality: u32,
    /// What the URL of an image's, video's or audio's bytes begins with in a summary that is read.
    pub public_base_url: String,
}

/// Feed summaries, Brotli-compressed, one per piece of content (not one per hashtag); an
/// update writes over it. The object store holds every summary for the retention period under
/// `summaries/<createdAt day>/`, so a day past retention is deleted as a whole. Redis holds
/// the same bytes until the post is `hot_days` old.
///
/// Content that was reposted is in indexes at the time of the repost as well as at its own, so
/// its summary is also under the day of each repost, and Redis holds it until the latest
/// repost is `hot_days` old. It is still one summary: every copy is written by the same write,
/// with the same bytes.
///
/// This is the compactor's side of the store: it writes and erases. What the API keeps in
/// memory of the summaries it reads (src/storage/summaryStore.ts) has no part here.
#[derive(Clone)]
pub struct SummaryStore {
    hot: HotStore,
    objects: ObjectStore,
    opts: SummaryOptions,
    now: Clock,
}

impl SummaryStore {
    pub fn new(hot: HotStore, objects: ObjectStore, opts: SummaryOptions, now: Clock) -> Self {
        Self { hot, objects, opts, now }
    }

    /// How much longer a post created, or reposted, at `created_at` counts as hot; zero or
    /// less once that is `hot_days` ago.
    fn hot_ttl(&self, created_at: i64) -> i64 {
        created_at + self.opts.hot_days * DAY - (self.now)()
    }

    /// The summary as it is stored.
    pub fn compress(&self, s: &Summary) -> Result<Vec<u8>> {
        compress_summary(&encode_summary(s), self.opts.quality)
    }

    /// The summary that stored bytes hold, of the content with this id.
    pub fn decode(&self, content_id: &str, blob: &[u8]) -> Result<Summary> {
        decode_summary(content_id, &decompress_summary(blob)?, &self.opts.public_base_url)
    }

    /// Writes the object store, under every day the summary is kept, then Redis while the
    /// post, or its latest repost, is younger than `hot_days`.
    pub async fn put(&self, s: &Summary) -> Result<()> {
        let blob = self.compress(s)?;
        self.put_blob(&SummaryRef::from(s), blob).await
    }

    /// As `put`, of a summary that is compressed already.
    pub async fn put_blob(&self, r: &SummaryRef, blob: Vec<u8>) -> Result<()> {
        for key in summary_object_keys(r) {
            self.objects.write(&key, blob.clone(), None).await?;
        }
        let ttl = self.hot_ttl(latest(r));
        if ttl > 0 {
            self.hot.set(&summary_key(&r.content_id), &blob, Some(ttl)).await?;
        }
        Ok(())
    }

    /// Writes whichever tier is missing each of the summaries: Redis is asked about them all
    /// in one round trip, and the object store about several at a time. Returns, in order,
    /// what went wrong with each, and none where nothing did, so one that fails doesn't keep
    /// the others from being looked at.
    pub async fn ensure_many(&self, list: &[Summary]) -> Result<Vec<Option<anyhow::Error>>> {
        let refs: Vec<SummaryRef> = list.iter().map(SummaryRef::from).collect();
        let due: Vec<bool> = refs.iter().map(|r| self.hot_ttl(latest(r)) > 0).collect();
        let asked: Vec<String> = refs
            .iter()
            .zip(&due)
            .filter(|(_, due)| **due)
            .map(|(r, _)| summary_key(&r.content_id))
            .collect();
        let mut found = self.hot.exists(&asked).await?.into_iter();
        let in_hot: Vec<bool> = due.iter().map(|due| if *due { found.next().unwrap_or(false) } else { true }).collect();
        let errors = stream::iter(list.iter().zip(&refs).zip(in_hot))
            .map(|((s, r), in_hot)| async move {
                let ensure = async {
                    // Every copy: one under a day the content was reposted on is the only one an entry of that day finds.
                    let mut missing = false;
                    for key in summary_object_keys(r) {
                        missing |= !self.objects.exists(&key).await?;
                    }
                    if missing {
                        self.put(s).await
                    } else if !in_hot {
                        self.hot
                            .set(&summary_key(&r.content_id), &self.compress(s)?, Some(self.hot_ttl(latest(r))))
                            .await
                    } else {
                        Ok(())
                    }
                };
                ensure.await.err()
            })
            .buffered(STORE_CONCURRENCY)
            .collect()
            .await;
        Ok(errors)
    }

    /// The summaries, in order; none where neither tier has one. Each is found by the time of
    /// the index entry it is read for, which is the content's creation or a repost of it.
    pub async fn get_many(&self, refs: &[(String, i64)]) -> Result<Vec<Option<Summary>>> {
        let hot: Vec<usize> = (0..refs.len()).filter(|i| self.hot_ttl(refs[*i].1) > 0).collect();
        let mut blobs: Vec<Option<Vec<u8>>> = vec![None; refs.len()];
        if !hot.is_empty() {
            let keys: Vec<String> = hot.iter().map(|i| summary_key(&refs[*i].0)).collect();
            for (i, blob) in hot.iter().zip(self.hot.mget(&keys).await?) {
                blobs[*i] = blob;
            }
        }
        let cold: Vec<usize> = (0..refs.len()).filter(|i| blobs[*i].is_none()).collect();
        let read: Vec<Result<(usize, Option<Vec<u8>>)>> = stream::iter(cold)
            .map(|i| async move {
                let (content_id, created_at) = &refs[i];
                let blob = self.objects.read(&summary_object_key(content_id, *created_at)).await?;
                if let Some(blob) = &blob {
                    let ttl = self.hot_ttl(*created_at);
                    // Only where Redis has none, so a summary read just before an update never replaces the update's.
                    if ttl > 0 {
                        let _ = self.hot.set_if_absent(&summary_key(content_id), blob, ttl).await;
                    }
                }
                Ok((i, blob))
            })
            .buffer_unordered(STORE_CONCURRENCY)
            .collect()
            .await;
        for found in read {
            let (i, blob) = found?;
            blobs[i] = blob;
        }
        Ok(blobs
            .into_iter()
            .zip(refs)
            .map(|(blob, (content_id, _))| blob.and_then(|blob| self.decode(content_id, &blob).ok()))
            .collect())
    }

    /// Erases one summary from both tiers, every copy of it, and fails if it can't: for
    /// content that must leave feeds now, which leave out a record with no summary. One that
    /// isn't there is no error.
    pub async fn erase(&self, r: &SummaryRef) -> Result<()> {
        for key in summary_object_keys(r) {
            self.objects.delete(&key).await?;
        }
        self.hot.del(&[summary_key(&r.content_id)]).await
    }

    /// Erases the copies of a summary that are under the days of reposts that are no more
    /// (`gone`, when each was made), and fails if it can't. `r` is the summary as it is kept
    /// now, and a copy under one of its days stays, whichever repost put it there. Redis has
    /// one copy, which goes if none of the times the summary is still found by keeps it there.
    pub async fn erase_copies(&self, r: &SummaryRef, gone: &[i64]) -> Result<()> {
        let kept: BTreeSet<String> = summary_object_keys(r).into_iter().collect();
        let stale: BTreeSet<String> = gone.iter().map(|at| object_key(&r.content_id, utc_day(*at))).collect();
        for key in stale.difference(&kept) {
            self.objects.delete(key).await?;
        }
        if self.hot_ttl(latest(r)) <= 0 {
            self.hot.del(&[summary_key(&r.content_id)]).await?;
        }
        Ok(())
    }

    /// Erases the summaries from both tiers, every copy of each, as far as it can: one it
    /// couldn't is left behind.
    pub async fn remove(&self, refs: &[SummaryRef]) -> Result<()> {
        if refs.is_empty() {
            return Ok(());
        }
        let keys: Vec<String> = refs.iter().flat_map(summary_object_keys).collect();
        stream::iter(keys)
            .for_each_concurrent(STORE_CONCURRENCY, |key| async move {
                let _ = self.objects.delete(&key).await;
            })
            .await;
        let hot: Vec<String> = refs.iter().map(|r| summary_key(&r.content_id)).collect();
        self.hot.del(&hot).await
    }

    /// Deletes every day of summaries before `day`; returns the days deleted.
    pub async fn purge_before(&self, day: i64) -> Result<Vec<i64>> {
        let days: Vec<i64> = self
            .objects
            .names("summaries/", false)
            .await?
            .iter()
            .filter_map(|name| {
                let digits = name.strip_suffix('/')?;
                (digits.len() == 5 && digits.bytes().all(|b| b.is_ascii_digit())).then(|| digits.parse::<i64>().ok())?
            })
            .filter(|d| *d < day)
            .collect();
        for d in &days {
            self.objects.remove_all(&day_prefix(*d)).await?;
        }
        Ok(days)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_summary() -> Summary {
        Summary {
            content_id: "c1".into(),
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_000_500,
            user_id: "u1".into(),
            mime_type: "text/plain".into(),
            ai_generated: false,
            comments: true,
            tags: vec!["news".into(), "art".into()],
            title: None,
            preview: Preview {
                text: Some("first line\nsecond line".into()),
                ..Preview::of(PreviewKind::Text)
            },
            origin: None,
            mentions: None,
            reposted_at: None,
        }
    }

    #[test]
    fn writes_as_few_numbers_as_say_it_all_and_reads_them_back() {
        let s = text_summary();
        let text = encode_summary(&s);
        assert_eq!(text, "1700000000000 1700000000500 0 1\nu1\ntext/plain\nnews art\ntext\nfirst line\nsecond line");
        assert_eq!(decode_summary("c1", &text, "https://a.example").unwrap(), s);
    }

    #[test]
    fn keeps_a_title_on_the_line_of_extras_and_reads_it_back() {
        let s = Summary {
            title: Some("Coast road \"closed\"".into()),
            ..text_summary()
        };
        let text = encode_summary(&s);
        assert_eq!(
            text,
            "1700000000000 1700000000500 0 1 0 0 1\nu1\ntext/plain\nnews art\ntext\n{\"title\":\"Coast road \\\"closed\\\"\"}\nfirst line\nsecond line"
        );
        assert_eq!(decode_summary("c1", &text, "https://a.example").unwrap(), s);
        // One that is empty is none.
        let empty = Summary {
            title: Some(String::new()),
            ..text_summary()
        };
        assert_eq!(encode_summary(&empty), encode_summary(&text_summary()));
    }

    #[test]
    fn keeps_a_summary_once_under_each_day_it_is_found_by() {
        let r = SummaryRef {
            content_id: "c1".into(),
            created_at: 3 * DAY + 5,
            reposted_at: vec![3 * DAY + 9, 7 * DAY, 7 * DAY + 1],
        };
        assert_eq!(summary_object_keys(&r), ["summaries/00003/c1.br", "summaries/00007/c1.br"]);
        assert_eq!(latest(&r), 7 * DAY + 1);
    }

    #[test]
    fn compresses_to_what_reads_back_as_the_same_text() {
        let text = encode_summary(&text_summary());
        assert_eq!(decompress_summary(&compress_summary(&text, 11).unwrap()).unwrap(), text);
    }

    #[test]
    fn refuses_a_summary_that_ends_before_its_header_does() {
        assert!(decode_summary("c1", "1 2 0 0\nu1\ntext/plain", "").is_err());
        assert!(decode_summary("c1", "1 2 0 0\nu1\ntext/plain\n\nsticker\nhi", "").is_err());
        assert!(decode_summary("c1", "1 2 0 0 1\nu1\ntext/plain\n\nlink\nhttps://o.example\nbody", "").is_err());
    }
}
