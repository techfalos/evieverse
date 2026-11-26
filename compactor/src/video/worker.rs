//! What makes the videos users send into videos that play: the video worker. Where the server
//! processes videos (`video.processing`), a video is not published as it was sent. Its write
//! waits (see `PostPayload::process`), and the worker, which runs beside the compactor, in its
//! process, takes its job (`super::jobs`), reads the staged file, and makes of it, with
//! ffmpeg (`super::ffmpeg`):
//!
//! - **an MP4** of H.264 and AAC, which every browser and phone plays, whatever the phone
//!   that filmed it wrote (HEVC, a MOV, a picture on its side), no larger than 720p, with its
//!   index at its start so that it plays as it downloads. It becomes the post's bytes, in
//!   place of the file that was sent, which is deleted;
//! - **an adaptive stream** (HLS): the video at each of `video.heights` that it is large
//!   enough for, cut into segments of a few seconds, with a master playlist that lists them.
//!   A player takes the size its connection carries, and changes as that changes;
//! - **a poster**: a JPEG of a frame near its start, to show before anything of it is read.
//!
//! None of them has anything of the file's metadata: not where it was filmed, nor when, nor
//! with what (see `encode_video`). That is why the write waits, and the file that was sent is
//! never served: it is published once it is stripped, as an image is.
//!
//! The stream and the poster are written beside the posts' bytes, under an id of the job's
//! own (see `ContentStore`). Then one commit makes the write ready: it puts the MP4 in the
//! write's row, in place of the file that was sent, with what the post's preview says of the
//! video (see `Video`), and takes the mark off. The compactor's next run applies it as it
//! would any write, and from then on the post is in feeds, and its video is there to play.
//!
//! An update that sends the file its post's video was made from, with another caption or
//! other hashtags, is not processed again: the post keeps the video it has (see `keep_video`).
//!
//! A comment's video is made the MP4 alone, no larger than `video.commentHeight`.
//!
//! A video that can't be processed (see `VideoError`), or that failed MAX_ATTEMPTS times, is
//! given up, and its author is told by a notice:
//!
//! - a new post is deleted, as nothing of it can be published;
//! - an update keeps the video the post had, and is made in everything else it said;
//! - a comment is published with its text alone, or not at all if the video was all of it.
//!
//! On a server that runs the pdq trust plugin (TRUST_OPTIONAL_PLUGINS), a video is checked
//! against the plugin's list of hashes of known child sexual abuse material here, as an image
//! is checked by the plugin when it is sent: the pictures of it are not there to read until it
//! is decoded, which is this worker's work. Once the renditions are made, and before anything
//! of the video is written anywhere, the keyframes of the largest are hashed and matched (see
//! `FrameCheck`). A video of which one matches is refused, as an image is:
//!
//! - the admins are told as they are of an image, with who sent the video and from where,
//!   which the job kept for this (`jobClient` in src/video/jobs.ts), and on a server that has
//!   a quarantine the file as it was sent is kept there (see the plugin's `report`);
//! - nothing of the video is published, and the file is deleted from where it waited;
//! - what was sent with it goes the way of a video that can't be processed, but for a
//!   comment, which is not published even with a text: a new post is deleted, and an update
//!   keeps the video the post had. Its author is told that the video wasn't trusted, and not
//!   why.
//!
//! No video is published unchecked there: while the process has no list to check with, since
//! it couldn't be read, a video waits, and is tried again, without that counting against it.
//!
//! Several processes may run a worker: a job is one worker's at a time (see `jobs::claim`),
//! and each takes one at a time, since one ffmpeg already uses every core there is.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use evieverse_core::comments::{Comment, CommentMedia};
use evieverse_core::content::{BytesOwner, ContentMeta, is_media_file};
use evieverse_core::db::{Queries, Tx};
use evieverse_core::inbox::{Notice, notify};
use evieverse_core::json::js_number;
use evieverse_core::log;
use evieverse_core::object::is_not_found;
use evieverse_core::params;
use evieverse_core::pending::{CommentPutPayload, PostPayload, RowChange, kind, next_seq, payload_of};
use evieverse_core::posts::{PreviewKind, Video};
use evieverse_core::time::MINUTE;
use evieverse_core::util::map_limit;
use evieverse_trust::plugins::pdq::image::MAX_SIDE;
use evieverse_trust::plugins::pdq::list::{HashList, KnownHashes};
use evieverse_trust::plugins::pdq::report::{Found, InVideo, Sent, report};
use evieverse_trust::plugins::pdq::video::FrameCheck;
use evieverse_trust::trust::{MAX_TRUST_SCORE, TrustContext, TrustImage};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::ffmpeg::{
    ProbedVideo, Rendition, Tools, VideoError, encode_video, keyframes_of, master_playlist, missing_tools, poster_of, probe_video, rendition_sizes,
    segment_video,
};
use super::jobs::{self, VideoJob};
use super::{Dropped, Halt, Why};
use crate::compactor::Stopper;
use crate::deps::Deps;

/// How long a worker has a job before another may take it, unless it says it is still at it:
/// every third of this.
const LEASE_MS: i64 = 2 * MINUTE;

/// How long a worker that found nothing to do waits before it looks again.
const IDLE: Duration = Duration::from_millis(2000);

/// How long a worker waits after a failure that isn't the video's (the database, the store),
/// before it takes a job again.
const RETRY_MS: i64 = 15_000;

/// How many times a video is tried before it is given up: the times after the first are for a
/// worker that died, or a store that failed.
const MAX_ATTEMPTS: i64 = 3;

/// The size of the MP4 that is a post's bytes, by its shorter side: the largest rendition no
/// larger than this.
const FALLBACK_SHORT: i64 = 720;

/// The size of a poster, by its shorter side: no larger than this.
const POSTER_SHORT: i64 = 720;

/// How far into a video its poster is taken: this share of its length, and no later than
/// POSTER_SECONDS. A first frame is often black.
const POSTER_AT: f64 = 0.1;

/// The latest a poster is taken, in seconds from the start.
const POSTER_SECONDS: f64 = 3.0;

/// How many of a video's files are written to the content store at a time.
const UPLOADS: usize = 8;

/// The tags a file the server made has that say nothing of the file it was made from: what
/// the MP4 container itself is described by, the same in every file ffmpeg writes.
const HARMLESS_TAGS: [&str; 7] = [
    "major_brand",
    "minor_version",
    "compatible_brands",
    "handler_name",
    "vendor_id",
    "language",
    "encoder",
];

/// What stops a job whose video matched the list of the pdq trust plugin: the admins are told
/// by then, and the video is refused.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
struct Untrusted(String);

/// What stops a job whose video can't be checked against that list, since the process has
/// none: the video waits, and nothing of it is published.
#[derive(Debug, thiserror::Error)]
#[error("there is no list of hashes to check the video against")]
struct Unchecked(#[source] anyhow::Error);

/// What became of a video that was worked on to the end.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Outcome {
    /// It is processed, and its write is ready.
    Processed,
    /// The post keeps the video it has: the file is the one that was made from.
    Kept,
    /// The comment was removed before it was ever published, and its video with it.
    Removed,
}

/// Whether a write keeps a video its post already has (see `keep_video`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Keeping {
    /// It keeps one, and is ready.
    Kept,
    /// The post has none to keep: nothing changed.
    Nothing,
    /// A newer write has superseded this one, which is then never applied.
    Superseded,
}

/// The SHA-256 of a local file, in hex.
async fn hash_file(path: &Path) -> Result<String> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || -> Result<String> {
        use std::io::Read;
        let mut file = std::fs::File::open(&path).with_context(|| format!("could not open {}", path.display()))?;
        let mut hash = Sha256::new();
        let mut piece = vec![0_u8; 1 << 16];
        loop {
            let read = file.read(&mut piece).with_context(|| format!("could not read {}", path.display()))?;
            if read == 0 {
                return Ok(hex::encode(hash.finalize()));
            }
            hash.update(&piece[..read]);
        }
    })
    .await
    .context("a file could not be hashed")?
}

/// The file a video was sent as, as the trust plugin that reports a match is given it.
fn sent_file(source: &Path, mime_type: &str, sha256: String) -> TrustImage {
    TrustImage {
        mime_type: mime_type.to_owned(),
        filename: None,
        file: source.to_owned(),
        sha256,
    }
}

/// What a meta file says of the file its post's bytes are, and of what the server made of it:
/// what a write that keeps another's video takes of that one.
struct FileOf {
    mime_type: String,
    size: i64,
    sha256: Option<String>,
    video: Option<Video>,
}

/// What is stored of a processed video, without the addresses a preview that was read has
/// beside it.
fn stored(video: &Video) -> Video {
    Video {
        poster: None,
        hls: None,
        ..video.clone()
    }
}

fn file_of(meta: &ContentMeta) -> FileOf {
    FileOf {
        mime_type: meta.mime_type.clone(),
        size: meta.size,
        sha256: meta.sha256.clone(),
        video: meta.preview.video.as_ref().filter(|_| meta.preview.kind == PreviewKind::Video).map(stored),
    }
}

/// A post's meta file as a write said it, with the file of `file` in place of its own.
fn with_file(meta: &ContentMeta, file: FileOf) -> ContentMeta {
    let mut next = meta.clone();
    next.mime_type = file.mime_type;
    next.size = file.size;
    next.sha256 = file.sha256;
    // A video post's preview: no other post's write waits for a video.
    next.preview.video = file.video;
    next
}

/// A write of a post, as its row holds it.
fn post_payload(meta: ContentMeta, keep_bytes: bool) -> Result<String> {
    let payload = PostPayload {
        meta,
        process: None,
        keep_bytes: keep_bytes.then_some(true),
        extra: Map::new(),
    };
    serde_json::to_string(&payload).context("could not write a post's write as JSON")
}

/// The row of a post's job, where it still waits for its video.
struct PostWrite {
    meta: ContentMeta,
    staged: String,
}

/// A row that puts the job's comment as it is.
struct Put {
    seq: i64,
    key: String,
    staged: Option<String>,
    payload: CommentPutPayload,
}

/// The rows that put the job's comment as it is, oldest first, which of them made the comment
/// and staged its file, and whether a removal of it has committed.
struct CommentWrites {
    puts: Vec<Put>,
    first: Option<usize>,
    removed: bool,
}

/// What a comment's writes are made by a rewrite (see `rewrite_comment`).
type Change<'a> = &'a (dyn Fn(&CommentPutPayload) -> CommentPutPayload + Sync);

/// A comment's write without the mark that it waits for its video.
fn unmarked(payload: &CommentPutPayload) -> CommentPutPayload {
    CommentPutPayload {
        process: None,
        ..payload.clone()
    }
}

/// The content type of one of a processed video's files, by its name: what it is stored with
/// (`videoFileType` in src/video/files.ts is what it is served with).
fn video_file_type(file: &str) -> &'static str {
    match file.rsplit('.').next() {
        Some("jpg") => "image/jpeg",
        Some("m3u8") => "application/vnd.apple.mpegurl",
        Some("ts") => "video/mp2t",
        _ => "application/octet-stream",
    }
}

/// The video worker of a process (see the top of this file). `run_once` processes one video,
/// for whoever runs it by hand (the tests); `run` is what a process that runs the compactor
/// calls.
///
/// `check` is to be called first: it fails in a process that has no ffmpeg to work with,
/// since a server that takes videos it can never publish is worse than one that doesn't
/// start. The remedy is in the error: install ffmpeg, or turn processing off
/// (`VIDEO_PROCESSING=false`), and videos are stored and served as they are sent.
///
/// `hashes` is the list videos are checked against where the server runs the pdq trust
/// plugin: the one the plugin of this process holds.
pub struct VideoWorker {
    deps: Deps,
    tools: Tools,
    hashes: Arc<KnownHashes>,
    /// Whether videos are checked against the pdq trust plugin's list: where the server runs
    /// the plugin.
    checks: bool,
}

impl VideoWorker {
    pub fn new(deps: Deps, hashes: Arc<KnownHashes>) -> Self {
        let tools = Tools {
            ffmpeg: deps.config.video.ffmpeg_path.clone(),
            ffprobe: deps.config.video.ffprobe_path.clone(),
        };
        Self {
            checks: deps.config.trust.optional_plugins.iter().any(|plugin| plugin == "pdq"),
            deps,
            tools,
            hashes,
        }
    }

    /// This worker, with other programs than the settings name: a test's.
    #[cfg(feature = "harness")]
    pub fn with_tools(mut self, tools: Tools) -> Self {
        self.tools = tools;
        self
    }

    /// Fails in a process that lacks what videos are processed with, with what it lacks and
    /// what to do about it.
    pub async fn check(&self) -> Result<()> {
        match missing_tools(&self.tools).await {
            None => Ok(()),
            Some(missing) => bail!(
                "{missing}. This server processes the videos users send (VIDEO_PROCESSING), which needs ffmpeg and ffprobe in the process that runs the compactor: install ffmpeg there, or set VIDEO_PROCESSING=false to store and serve videos as they are sent."
            ),
        }
    }

    /// The list to check a video against, or None on a server that checks none. Fails with
    /// Unchecked where there is none to be had.
    async fn hash_list(&self) -> Result<Option<Arc<HashList>>> {
        if !self.checks {
            return Ok(None);
        }
        let Deps { config, now, log, .. } = &self.deps;
        match self.hashes.get_with(&config.pdq, now, log).await {
            Ok(list) => Ok(Some(list)),
            Err(err) => Err(Unchecked(err).into()),
        }
    }

    /// Checks a video against the list, by the largest rendition made of it (see
    /// `FrameCheck`), and does nothing more with one that doesn't match. One that does is
    /// told to the admins, and kept in the quarantine where the server has one, as the file
    /// that was sent, which is `image` (see the plugin's `report`, which never fails); and it
    /// fails with Untrusted, which refuses the video.
    async fn match_video(&self, job: &VideoJob, list: &HashList, rendition: &Rendition, sent: Sent, image: TrustImage, halt: &Halt) -> Result<()> {
        let Deps { db, config, now, log, .. } = &self.deps;
        let mut check = FrameCheck::new(list, &config.pdq);
        let found = keyframes_of(&self.tools, rendition, i64::from(MAX_SIDE), halt, |frame| {
            check.check(frame.pixels, frame.width, frame.height, frame.seconds)
        })
        .await?;
        let Some(found) = found else { return Ok(()) };
        let ctx = TrustContext {
            db,
            config,
            now,
            log,
            process_log: log,
            client: job.client.as_ref(),
            score: MAX_TRUST_SCORE,
        };
        let seconds = found.seconds;
        let found = Found {
            listed: found.listed,
            distance: found.distance,
            image,
            pdq: found.pdq,
            quality: found.quality,
            frame: found.frame,
            video: Some(InVideo {
                seconds,
                sent_at: job.created_at,
            }),
        };
        report(&sent, &ctx, &found).await;
        Err(Untrusted(format!(
            "the picture the video shows {seconds} seconds in matches the list of hashes of known child sexual abuse material"
        ))
        .into())
    }

    /// The write's row of a post's job, if it is there and still waits for its video.
    async fn post_write(&self, job: &VideoJob) -> Result<Option<PostWrite>> {
        let db = &self.deps.db;
        let payload = db.dialect().json_text("payload");
        let row = db
            .fetch_optional(
                &format!("SELECT {payload} AS payload, staged_key FROM pending_writes WHERE content_id = ? AND seq = ? AND write_key = ? AND kind = ?"),
                params![&job.content_id, job.seq, &job.key, kind::POST],
            )
            .await?;
        let Some(row) = row else { return Ok(None) };
        let Some(staged) = row.opt_string("staged_key")? else { return Ok(None) };
        let Some(write) = payload_of::<PostPayload>(row.opt_str("payload")?)? else {
            return Ok(None);
        };
        Ok(write.processing().then_some(PostWrite { meta: write.meta, staged }))
    }

    /// Whether the post is there, and not set for deletion.
    async fn live(&self, content_id: &str) -> Result<bool> {
        let row = self
            .deps
            .db
            .fetch_optional("SELECT id FROM content WHERE id = ? AND delete_requested_at IS NULL", params![content_id])
            .await?;
        Ok(row.is_some())
    }

    /// Deletes a staged file that is nobody's any more. One that can't be deleted is the
    /// bucket's to expire.
    async fn unstage(&self, key: &str, content_id: &str) {
        if let Err(err) = self.deps.content.remove_staged(key).await {
            self.deps.log.warn(
                json!({ "err": log::err(&err), "contentId": content_id, "staged": key }),
                "could not delete a staged video that is no longer needed",
            );
        }
    }

    /// Deletes what a job wrote of a post's video beside the posts' bytes, which no write
    /// names. What can't be deleted goes with the post.
    async fn unwrite(&self, job: &VideoJob) {
        if job.comment_id.is_some() {
            return;
        }
        if let Err(err) = self.deps.content.remove_media(&job.content_id, Some(&job.id)).await {
            self.deps.log.warn(
                json!({ "err": log::err(&err), "contentId": job.content_id, "video": job.id }),
                "could not delete the files of a video that no write names",
            );
        }
    }

    /// Makes the renditions of a video, largest first, each an MP4 in `dir`. One after
    /// another: each encoder uses every core, and the memory of one is all a small machine has.
    async fn renditions(&self, source: &Path, video: &ProbedVideo, sizes: &[i64], dir: &Path, halt: &Halt) -> Result<Vec<Rendition>> {
        let mut made = Vec::with_capacity(sizes.len());
        for short in sizes {
            made.push(encode_video(&self.tools, source, video, *short, &dir.join(format!("{short}.mp4")), halt).await?);
        }
        // None of them says anything the file said of itself: checked of what was made, not trusted of how it was made.
        for rendition in &made {
            let probed = probe_video(&self.tools, &rendition.path, false, halt).await?;
            let kept: Vec<&str> = probed.tags.keys().map(String::as_str).filter(|tag| !HARMLESS_TAGS.contains(tag)).collect();
            if !kept.is_empty() {
                bail!(
                    "the {} rendition still has metadata ({}); nothing of the video is published",
                    rendition.name,
                    kept.join(", ")
                );
            }
        }
        Ok(made)
    }

    /// Processes a post's video (see the top of this file). `dir` is a folder of the job's
    /// own, which is deleted when it is over.
    async fn process_post(&self, job: &VideoJob, dir: &Path, halt: &Halt) -> Result<Outcome> {
        let Deps { db, config, content, .. } = &self.deps;
        let settings = &config.video;
        let Some(write) = self.post_write(job).await? else {
            return Err(Dropped.into());
        };
        if !self.live(&job.content_id).await? || superseded(&mut &*db, job).await? {
            return Err(Dropped.into());
        }
        // Before any work is done: a video that can't be checked isn't processed either.
        let list = self.hash_list().await?;

        let source = dir.join("source");
        content.fetch_to(BytesOwner::Staged(&write.staged), &source).await?;
        let sha256 = match &write.meta.sha256 {
            Some(sha256) => sha256.clone(),
            None => hash_file(&source).await?,
        };
        // The file the post's video was made from, sent again with an update of something else: the post keeps the video it has.
        match self.keep_video(job, &write, Some(&sha256)).await? {
            Keeping::Superseded => return Err(Dropped.into()),
            Keeping::Kept => {
                self.unstage(&write.staged, &job.content_id).await;
                return Ok(Outcome::Kept);
            }
            Keeping::Nothing => {}
        }
        let video = probe_video(&self.tools, &source, true, halt).await?;

        let out = dir.join("out");
        tokio::fs::create_dir(&out)
            .await
            .context("could not make the folder a video's files are made in")?;
        let made = self
            .renditions(&source, &video, &rendition_sizes(video.width, video.height, &settings.heights), &out, halt)
            .await?;
        let largest = made.first().context("no rendition of the video was made")?;
        // Checked before anything of it is written anywhere. An update is of a post that was there before this write.
        if let Some(list) = &list {
            let Some(post) = db
                .fetch_optional("SELECT user_id, created_at FROM content WHERE id = ?", params![&job.content_id])
                .await?
            else {
                return Err(Dropped.into());
            };
            let new = post.i64("created_at")? == job.created_at;
            let sent = Sent {
                user_id: post.string("user_id")?,
                content_id: (!new).then(|| job.content_id.clone()),
                created: new.then(|| job.content_id.clone()),
                ..Sent::default()
            };
            let image = sent_file(&source, &write.meta.mime_type, sha256.clone());
            self.match_video(job, list, largest, sent, image, halt).await?;
        }
        for rendition in &made {
            segment_video(&self.tools, rendition, halt).await?;
        }
        tokio::fs::write(out.join("master.m3u8"), master_playlist(&made))
            .await
            .context("could not write a video's master playlist")?;
        poster_of(
            &self.tools,
            largest,
            (video.duration * POSTER_AT).min(POSTER_SECONDS),
            POSTER_SHORT,
            &out.join("poster.jpg"),
            halt,
        )
        .await?;

        // The stream and the poster, under the job's id, which no write names yet. Then the MP4, where a write's file waits.
        let mut files = Vec::new();
        let mut listing = tokio::fs::read_dir(&out).await.context("could not list a video's files")?;
        while let Some(entry) = listing.next_entry().await.context("could not list a video's files")? {
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_media_file(&name) {
                files.push(name);
            }
        }
        map_limit(files, UPLOADS, |file| {
            let out = &out;
            async move {
                halt.check()?;
                let of = BytesOwner::Video {
                    content_id: &job.content_id,
                    video: &job.id,
                    file: &file,
                };
                content.put_file(of, &out.join(&file), video_file_type(&file)).await
            }
        })
        .await?;
        let fallback = made
            .iter()
            .find(|rendition| rendition.short <= FALLBACK_SHORT)
            .or(made.last())
            .context("no rendition of the video was made")?;
        halt.check()?;
        let mp4 = content.stage_file(&Uuid::new_v4().to_string(), &fallback.path, "video/mp4").await?;

        let seconds = (video.duration * 1000.0).round() / 1000.0;
        let file = FileOf {
            mime_type: "video/mp4".to_owned(),
            size: fallback.size,
            sha256: Some(sha256),
            video: Some(Video {
                id: job.id.clone(),
                width: largest.width.into(),
                height: largest.height.into(),
                duration: js_number(seconds).context("the video's length is no number")?,
                poster: None,
                hls: None,
            }),
        };
        let next = post_payload(with_file(&write.meta, file), false)?;
        let done = async {
            let mut tx = db.begin().await?;
            // The post's row is locked, as a write of the post locks it: none commits between this check and this commit.
            lock_post(&mut tx, &job.content_id).await?;
            if superseded(&mut tx, job).await? {
                return Ok(false);
            }
            let json = tx.dialect().json_place();
            let updated = tx
                .execute(
                    &format!("UPDATE pending_writes SET staged_key = ?, payload = {json} WHERE content_id = ? AND seq = ? AND write_key = ? AND kind = ? AND staged_key = ?"),
                    params![&mp4, &next, &job.content_id, job.seq, &job.key, kind::POST, &write.staged],
                )
                .await?;
            if updated != 1 {
                return Ok(false);
            }
            jobs::remove(&mut tx, &job.id).await?;
            tx.commit().await?;
            anyhow::Ok(true)
        }
        .await;
        if !matches!(done, Ok(true)) {
            self.unstage(&mp4, &job.content_id).await;
            done?;
            return Err(Dropped.into());
        }
        // The file as it was sent, which nothing names any more, and nobody was ever given a link to.
        self.unstage(&write.staged, &job.content_id).await;
        Ok(Outcome::Processed)
    }

    /// Has the job's write keep a video the post already has, in place of the file it came
    /// with: the write is then ready, with everything else it said, and the job is over. The
    /// video is the one of the write before it, if that is still to be applied and is
    /// processed, which this write then takes the file of; else the one the store has, whose
    /// bytes the compactor leaves as they are (see `PostPayload::keep_bytes`).
    ///
    /// `sha256` narrows it to a processed video made from the file with that hash: the same
    /// file, sent again with an update of something else, is not processed again. Without it,
    /// any video the post has will do: what an update whose video can't be processed falls
    /// back to.
    async fn keep_video(&self, job: &VideoJob, write: &PostWrite, sha256: Option<&str>) -> Result<Keeping> {
        let Deps { db, content, .. } = &self.deps;
        let stored = content.get_meta(&job.content_id).await?;
        let keeps = |had: &ContentMeta| sha256.is_none_or(|sha256| had.sha256.as_deref() == Some(sha256) && file_of(had).video.is_some());
        let mut tx = db.begin().await?;
        // The post's row is locked, as a write of the post locks it: none commits between these reads and this commit.
        lock_post(&mut tx, &job.content_id).await?;
        if superseded(&mut tx, job).await? {
            return Ok(Keeping::Superseded);
        }
        let payload = tx.dialect().json_text("payload");
        let earlier = tx
            .fetch_optional(
                &format!(
                    "SELECT seq, {payload} AS payload, staged_key FROM pending_writes WHERE content_id = ? AND kind = ? AND seq < ? ORDER BY seq DESC LIMIT 1"
                ),
                params![&job.content_id, kind::POST, job.seq],
            )
            .await?;
        let waiting = match &earlier {
            Some(row) => payload_of::<PostPayload>(row.opt_str("payload")?)?,
            None => None,
        };
        let earlier_staged = match &earlier {
            Some(row) => row.opt_string("staged_key")?,
            None => None,
        };
        // What the write's row is given: where its file waits, if it has one, and what it holds.
        let mut next: Option<(Option<String>, String)> = None;
        match &waiting {
            // The write before it has the file, or keeps the store's: this one takes its place, so that the file is still one row's.
            Some(waiting) if !waiting.processing() && (earlier_staged.is_some() || waiting.keeps_bytes()) => {
                if keeps(&waiting.meta) {
                    next = Some((
                        earlier_staged.clone(),
                        post_payload(with_file(&write.meta, file_of(&waiting.meta)), waiting.keeps_bytes())?,
                    ));
                }
            }
            _ => {
                if let Some(stored) = stored.as_ref().filter(|stored| keeps(stored)) {
                    next = Some((None, post_payload(with_file(&write.meta, file_of(stored)), true)?));
                }
            }
        }
        let Some((staged, held)) = next else { return Ok(Keeping::Nothing) };
        let json = tx.dialect().json_place();
        let updated = tx
            .execute(
                &format!("UPDATE pending_writes SET staged_key = ?, payload = {json} WHERE content_id = ? AND seq = ? AND write_key = ? AND kind = ? AND staged_key = ?"),
                params![staged.as_deref(), &held, &job.content_id, job.seq, &job.key, kind::POST, &write.staged],
            )
            .await?;
        if updated != 1 {
            return Ok(Keeping::Superseded);
        }
        if let (Some(row), Some(_)) = (&earlier, &staged) {
            tx.execute(
                "UPDATE pending_writes SET staged_key = NULL WHERE content_id = ? AND seq = ? AND kind = ?",
                params![&job.content_id, row.i64("seq")?, kind::POST],
            )
            .await?;
        }
        jobs::remove(&mut tx, &job.id).await?;
        tx.commit().await?;
        Ok(Keeping::Kept)
    }

    /// Gives up a post's video (see the top of this file). An update keeps the video the post
    /// had (see `keep_video`). A post that has none is a new one, and is deleted. `refused`
    /// is for a video that matched the pdq plugin's list, whose author is told that it wasn't
    /// trusted.
    async fn fail_post(&self, job: &VideoJob, refused: bool) -> Result<()> {
        let Deps { db, content, log, .. } = &self.deps;
        let Some(write) = self.post_write(job).await? else {
            return jobs::remove(&mut &*db, &job.id).await;
        };
        let owner = db.fetch_optional("SELECT user_id FROM content WHERE id = ?", params![&job.content_id]).await?;
        let user_id = owner.map(|row| row.string("user_id")).transpose()?;

        let kept = match self.keep_video(job, &write, None).await? {
            Keeping::Superseded => return jobs::remove(&mut &*db, &job.id).await,
            Keeping::Kept => true,
            Keeping::Nothing => false,
        };
        // Set for deletion before its file goes: from then on nothing reads the write that names the file.
        if !kept {
            db.execute(
                "UPDATE content SET delete_requested_at = ? WHERE id = ? AND delete_requested_at IS NULL",
                params![self.deps.now(), &job.content_id],
            )
            .await?;
            jobs::remove(&mut &*db, &job.id).await?;
        }
        self.unstage(&write.staged, &job.content_id).await;
        self.unwrite(job).await;
        let kind = match (refused, kept) {
            (true, true) => "video_update_refused",
            (true, false) => "video_refused",
            (false, true) => "video_update_failed",
            (false, false) => "video_failed",
        };
        if let Some(user_id) = user_id {
            // Nobody did this to them: `by` is nobody's id.
            let notice = Notice {
                user_id: &user_id,
                kind,
                content_id: Some(&job.content_id),
                ..Notice::default()
            };
            notify(db, content, self.deps.now(), &notice, log).await;
        }
        Ok(())
    }

    /// Writes every put of the job's comment again, each as `change` makes it, and deletes
    /// the job: in one commit, after the post's next number is taken, so that an edit of the
    /// comment that read it before this reads it again (see `writePending` in
    /// src/pending.ts). False, with nothing written but the job's end, if the comment's first
    /// write is no longer as `staged` names it, or the post is going.
    async fn rewrite_comment(&self, job: &VideoJob, staged: &str, new_staged: Option<&str>, change: Change<'_>) -> Result<bool> {
        let mut tx = self.deps.db.begin().await?;
        jobs::remove(&mut tx, &job.id).await?;
        let rewritten = rewrite(&mut tx, job, staged, new_staged, change).await?;
        tx.commit().await?;
        Ok(rewritten)
    }

    /// Processes a comment's video: the MP4 alone (see the top of this file).
    async fn process_comment(&self, job: &VideoJob, dir: &Path, halt: &Halt) -> Result<Outcome> {
        let Deps { db, config, content, .. } = &self.deps;
        let writes = comment_writes(&mut &*db, job).await?;
        let Some(first) = writes.first.map(|at| &writes.puts[at]) else {
            return Err(Dropped.into());
        };
        if !self.live(&job.content_id).await? {
            return Err(Dropped.into());
        }
        let staged = first.staged.clone().context("the write that made the comment names no file")?;
        if writes.removed {
            // Removed before it was ever published: nothing of the video is, and the comment's writes go their way without it.
            content.remove_staged(&staged).await?;
            self.rewrite_comment(job, &staged, None, &unmarked).await?;
            return Ok(Outcome::Removed);
        }
        let list = self.hash_list().await?;

        let source = dir.join("source");
        content.fetch_to(BytesOwner::Staged(&staged), &source).await?;
        let video = probe_video(&self.tools, &source, true, halt).await?;
        let out = dir.join("out");
        tokio::fs::create_dir(&out)
            .await
            .context("could not make the folder a video's files are made in")?;
        let sizes = rendition_sizes(video.width, video.height, &[config.video.comment_height]);
        let made = self.renditions(&source, &video, &sizes[..1], &out, halt).await?;
        let made = made.first().context("no rendition of the video was made")?;
        if let Some(list) = &list {
            let comment = &first.payload.comment;
            let sent = Sent {
                user_id: comment.user_id.clone(),
                comment_on: Some(job.content_id.clone()),
                ..Sent::default()
            };
            let mime_type = comment.media.as_ref().map_or("application/octet-stream", |media| media.mime_type.as_str());
            let image = sent_file(&source, mime_type, hash_file(&source).await?);
            self.match_video(job, list, made, sent, image, halt).await?;
        }
        halt.check()?;
        let mp4 = content.stage_file(&Uuid::new_v4().to_string(), &made.path, "video/mp4").await?;

        let size = made.size;
        let processed = move |payload: &CommentPutPayload| CommentPutPayload {
            comment: Comment {
                media: Some(CommentMedia {
                    kind: "video".to_owned(),
                    mime_type: "video/mp4".to_owned(),
                    size,
                    alt: None,
                    extra: Map::new(),
                }),
                ..payload.comment.clone()
            },
            held: payload.held,
            process: None,
            extra: Map::new(),
        };
        let done = self.rewrite_comment(job, &staged, Some(&mp4), &processed).await;
        if !matches!(done, Ok(true)) {
            self.unstage(&mp4, &job.content_id).await;
            done?;
            return Err(Dropped.into());
        }
        self.unstage(&staged, &job.content_id).await;
        Ok(Outcome::Processed)
    }

    /// Gives up a comment's video: the file is deleted from where it waits, and the comment's
    /// writes are the compactor's to apply, which publishes a comment whose file is gone with
    /// its text alone, or removes it if it had none (see `apply_comments`).
    ///
    /// `refused` is for a video that matched the pdq plugin's list: nothing of that comment
    /// is published, as nothing is of a comment whose image matched. Its writes are made ones
    /// of a comment with no text, which the compactor then removes, as it does one whose file
    /// was all of it; and its author is told that the video wasn't trusted.
    async fn fail_comment(&self, job: &VideoJob, refused: bool) -> Result<()> {
        let Deps { db, content, log, .. } = &self.deps;
        let writes = comment_writes(&mut &*db, job).await?;
        let Some(first) = writes.first.map(|at| &writes.puts[at]) else {
            return jobs::remove(&mut &*db, &job.id).await;
        };
        let comment = &first.payload.comment;
        let staged = first.staged.as_deref().context("the write that made the comment names no file")?;
        // The file first: once the mark is off, the compactor publishes whatever is there.
        content.remove_staged(staged).await?;
        let change = move |payload: &CommentPutPayload| {
            let mut next = unmarked(payload);
            if refused {
                next.comment.mentions = None;
                next.comment.text = String::new();
            }
            next
        };
        if !self.rewrite_comment(job, staged, None, &change).await? {
            return Ok(());
        }
        let notice = Notice {
            user_id: &comment.user_id,
            kind: if refused { "comment_video_refused" } else { "comment_video_failed" },
            content_id: Some(&job.content_id),
            comment: Some(&comment.text),
            ..Notice::default()
        };
        notify(db, content, self.deps.now(), &notice, log).await;
        Ok(())
    }

    /// Works on a job the worker has taken, in a folder of its own, for no longer than
    /// `video.timeoutSeconds`, and keeps the job its own meanwhile.
    async fn work(&self, job: &VideoJob, stopper: &Stopper) -> Result<Outcome> {
        let Deps { db, config, log, .. } = &self.deps;
        let (halter, halt) = Halt::new();
        // Where the server keeps the files it works on (`storage.tmpPath`, or the system's folder for them): a video
        // needs room for itself and for every size it is made in.
        let tmp = config.storage.tmp_path.as_ref().map_or_else(std::env::temp_dir, PathBuf::from);
        tokio::fs::create_dir_all(&tmp)
            .await
            .with_context(|| format!("could not make {}", tmp.display()))?;
        let dir = tmp.join(format!("video-{}", Uuid::new_v4().simple()));
        tokio::fs::create_dir(&dir).await.with_context(|| format!("could not make {}", dir.display()))?;

        // What stops the work: its time is up, its job is gone, or the process is shutting down. It runs beside the
        // work, and never ends by itself.
        let watching = async {
            let timeout = tokio::time::sleep(Duration::from_secs(config.video.timeout_seconds.unsigned_abs()));
            tokio::pin!(timeout);
            let every = Duration::from_millis((LEASE_MS / 3).unsigned_abs());
            let mut renewal = tokio::time::interval_at(tokio::time::Instant::now() + every, every);
            let mut timed = false;
            let mut stopped = false;
            loop {
                tokio::select! {
                    () = &mut timeout, if !timed => {
                        timed = true;
                        halter.halt(Why::Timeout(config.video.timeout_seconds));
                    }
                    () = stopper.stopped(), if !stopped => {
                        stopped = true;
                        halter.halt(Why::Stopped);
                    }
                    _ = renewal.tick() => match jobs::renew(db, &job.id, self.deps.now(), LEASE_MS).await {
                        Ok(true) => {}
                        Ok(false) => halter.halt(Why::Gone),
                        Err(err) => log.warn(json!({ "err": log::err(&err), "job": job.id }), "could not keep hold of a video job; it is tried again"),
                    },
                }
            }
        };
        let working = async {
            if job.comment_id.is_none() {
                self.process_post(job, &dir, &halt).await
            } else {
                self.process_comment(job, &dir, &halt).await
            }
        };
        let outcome = tokio::select! {
            outcome = working => outcome,
            () = watching => unreachable!("what watches the work on a video never ends"),
        };
        if let Err(err) = tokio::fs::remove_dir_all(&dir).await {
            log.warn(
                json!({ "err": log::err(&err.into()), "dir": dir.to_string_lossy() }),
                "could not delete the folder a video was processed in",
            );
        }
        // What the work failed with once it was told to stop is what stopped it, whatever it met as it stopped.
        match (outcome, halt.why()) {
            (Err(_), Some(why)) => Err(why.error()),
            (outcome, _) => outcome,
        }
    }

    /// Takes the oldest job that waits and sees it through: processed, kept waiting for
    /// another try, or given up. False if no job waited. `stopper` is what a process that
    /// shuts down stops it with.
    pub async fn run_once(&self, stopper: &Stopper) -> Result<bool> {
        let Deps { db, log, .. } = &self.deps;
        let Some(job) = jobs::claim(db, self.deps.now(), LEASE_MS).await? else {
            return Ok(false);
        };
        let about = |more: Value| {
            let mut about = json!({ "job": job.id, "contentId": job.content_id });
            if let Some(comment_id) = &job.comment_id {
                about["commentId"] = json!(comment_id);
            }
            about["attempt"] = json!(job.attempts);
            if let (Some(about), Value::Object(more)) = (about.as_object_mut(), more) {
                about.extend(more);
            }
            about
        };
        let started = self.deps.now();
        let worked = if job.attempts > MAX_ATTEMPTS {
            // Taken more often than a video is tried: the worker that had it died of it, each time.
            Err(VideoError(format!("the video was tried {MAX_ATTEMPTS} times, and no worker finished it")).into())
        } else {
            self.work(&job, stopper).await
        };
        let err = match worked {
            Ok(outcome) => {
                if outcome == Outcome::Processed {
                    log.info(about(json!({ "ms": self.deps.now() - started })), "processed a video");
                }
                return Ok(true);
            }
            Err(err) => err,
        };
        if err.is::<Dropped>() {
            // Whatever it wrote is nobody's; the staged file is its write's, and goes with that.
            self.unwrite(&job).await;
            jobs::remove(&mut &*db, &job.id).await?;
            return Ok(true);
        }
        if stopper.is_stopped() {
            // The process is shutting down: the job is the next worker's, at once, and this try doesn't count against the video.
            self.unwrite(&job).await;
            jobs::release_uncounted(db, &job.id, 0).await?;
            return Ok(true);
        }
        if let Some(Unchecked(cause)) = err.downcast_ref::<Unchecked>() {
            // No list to check it with: the video waits for one, however long, and this try doesn't count against it.
            self.unwrite(&job).await;
            log.error(
                about(json!({ "err": log::err(cause) })),
                "could not check a video against the list of hashes of known child sexual abuse material, which could not be read (PDQ_HASH_LIST); nothing of it is published, and it is tried again",
            );
            jobs::release_uncounted(db, &job.id, self.deps.now() + RETRY_MS).await?;
            return Ok(true);
        }
        let refused = err.downcast_ref::<Untrusted>().map(|untrusted| untrusted.0.clone());
        // The staged file is gone: expired, after a week with no worker. There is nothing to try again with.
        let last = refused.is_some() || err.is::<VideoError>() || is_not_found(&err) || job.attempts >= MAX_ATTEMPTS;
        self.unwrite(&job).await;
        if !last {
            log.error(about(json!({ "err": log::err(&err) })), "could not process a video; it is tried again");
            jobs::release(db, &job.id, self.deps.now() + RETRY_MS).await?;
            return Ok(true);
        }
        match &refused {
            Some(why) => log.warn(
                about(json!({ "why": why })),
                "a video matches the list of hashes of known child sexual abuse material; it is refused, and its author is told that it was not trusted",
            ),
            None => log.error(
                about(json!({ "err": log::err(&err) })),
                "could not process a video; it is given up, and its author is told",
            ),
        }
        let given_up = if job.comment_id.is_none() {
            self.fail_post(&job, refused.is_some()).await
        } else {
            self.fail_comment(&job, refused.is_some()).await
        };
        if let Err(cause) = given_up {
            log.error(
                about(json!({ "err": log::err(&cause) })),
                "could not give up a video that can not be processed; it is tried again",
            );
            jobs::release(db, &job.id, self.deps.now() + RETRY_MS).await?;
        }
        Ok(true)
    }

    /// Takes job after job until stopped, and looks again a moment after it found none.
    /// Returns once it is stopped and the job under way is given back.
    pub async fn run(&self, stopper: &Stopper) {
        while !stopper.is_stopped() {
            let wait = match self.run_once(stopper).await {
                Ok(true) => continue,
                Ok(false) => IDLE,
                Err(err) => {
                    self.deps
                        .log
                        .error(json!({ "err": log::err(&err) }), "the video worker failed; trying again in a moment");
                    Duration::from_millis(RETRY_MS.unsigned_abs())
                }
            };
            tokio::select! {
                () = stopper.stopped() => {}
                () = tokio::time::sleep(wait) => {}
            }
        }
    }
}

/// Locks the post's row until the transaction ends, as a write of the post locks it.
async fn lock_post(tx: &mut Tx, content_id: &str) -> Result<()> {
    tx.execute("UPDATE content SET ai_generated = ai_generated WHERE id = ?", params![content_id])
        .await?;
    Ok(())
}

/// Whether a newer write of the post than the job's has committed: the job's is then never
/// applied.
async fn superseded(db: &mut impl Queries, job: &VideoJob) -> Result<bool> {
    let newer = db
        .fetch_optional(
            "SELECT seq FROM pending_writes WHERE content_id = ? AND kind = ? AND seq > ? LIMIT 1",
            params![&job.content_id, kind::POST, job.seq],
        )
        .await?;
    Ok(newer.is_some())
}

/// The rows that put the job's comment as it is (see `CommentWrites`).
async fn comment_writes(db: &mut impl Queries, job: &VideoJob) -> Result<CommentWrites> {
    let comment_id = job.comment_id.as_deref().ok_or_else(|| anyhow!("the job {} is of no comment", job.id))?;
    let payload = db.dialect().json_text("payload");
    let rows = db
        .fetch(
            &format!("SELECT seq, write_key, kind, {payload} AS payload, staged_key FROM pending_writes WHERE content_id = ? AND comment_id = ? AND kind IN (?, ?) ORDER BY seq"),
            params![&job.content_id, comment_id, kind::COMMENT_PUT, kind::COMMENT_REMOVE],
        )
        .await?;
    let mut writes = CommentWrites {
        puts: vec![],
        first: None,
        removed: false,
    };
    for row in rows {
        if row.str("kind")? == kind::COMMENT_REMOVE {
            writes.removed = true;
            continue;
        }
        let Some(payload) = payload_of::<CommentPutPayload>(row.opt_str("payload")?)? else {
            continue;
        };
        let put = Put {
            seq: row.i64("seq")?,
            key: row.string("write_key")?,
            staged: row.opt_string("staged_key")?,
            payload,
        };
        // The one that made the comment, which is the one that staged its file.
        if writes.first.is_none() && put.seq == job.seq && put.key == job.key && put.staged.is_some() && put.payload.processing() {
            writes.first = Some(writes.puts.len());
        }
        writes.puts.push(put);
    }
    Ok(writes)
}

/// What `rewrite_comment` writes, in its transaction.
async fn rewrite(tx: &mut Tx, job: &VideoJob, staged: &str, new_staged: Option<&str>, change: Change<'_>) -> Result<bool> {
    if next_seq(tx, &job.content_id, RowChange::default()).await?.is_none() {
        return Ok(false);
    }
    let writes = comment_writes(tx, job).await?;
    let Some(first) = writes.first.filter(|at| writes.puts[*at].staged.as_deref() == Some(staged)) else {
        return Ok(false);
    };
    let json = tx.dialect().json_place();
    for (at, put) in writes.puts.iter().enumerate() {
        let payload = serde_json::to_string(&change(&put.payload)).context("could not write a comment's write as JSON")?;
        match new_staged.filter(|_| at == first) {
            Some(new_staged) => {
                tx.execute(
                    &format!("UPDATE pending_writes SET payload = {json}, staged_key = ? WHERE content_id = ? AND seq = ? AND write_key = ?"),
                    params![&payload, new_staged, &job.content_id, put.seq, &put.key],
                )
                .await?
            }
            None => {
                tx.execute(
                    &format!("UPDATE pending_writes SET payload = {json} WHERE content_id = ? AND seq = ? AND write_key = ?"),
                    params![&payload, &job.content_id, put.seq, &put.key],
                )
                .await?
            }
        };
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(json: Value) -> ContentMeta {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn a_write_that_keeps_a_video_takes_the_file_and_the_video_of_the_one_it_keeps() {
        let had = meta(json!({
            "contentId": "p1", "mimeType": "video/mp4", "size": 900, "sha256": "abc", "aiGenerated": false,
            "preview": { "kind": "video", "text": "before", "video": { "id": "v1", "width": 1280, "height": 720, "duration": 4.5, "poster": "https://x/poster.jpg", "hls": "https://x/master.m3u8" } },
            "tags": ["news"], "updatedAt": 5,
        }));
        let sent = meta(json!({
            "contentId": "p1", "mimeType": "video/quicktime", "size": 5000, "sha256": "sent", "aiGenerated": true,
            "preview": { "kind": "video", "text": "after" }, "text": "after", "tags": ["news", "more"], "updatedAt": 9,
        }));
        let next = with_file(&sent, file_of(&had));
        assert_eq!(
            serde_json::to_value(&next).unwrap(),
            json!({
                "contentId": "p1", "mimeType": "video/mp4", "size": 900, "sha256": "abc", "aiGenerated": true,
                "preview": { "kind": "video", "text": "after", "video": { "id": "v1", "width": 1280, "height": 720, "duration": 4.5 } },
                "text": "after", "tags": ["news", "more"], "updatedAt": 9,
            })
        );
        // A post whose bytes are no processed video gives no video, and no hash where it has none.
        let plain = meta(
            json!({ "contentId": "p1", "mimeType": "video/webm", "size": 7, "aiGenerated": false, "preview": { "kind": "video" }, "tags": [], "updatedAt": 1 }),
        );
        let next = with_file(&sent, file_of(&plain));
        assert_eq!(
            (next.mime_type.as_str(), next.size, next.sha256, next.preview.video),
            ("video/webm", 7, None, None)
        );
        assert_eq!(
            post_payload(plain.clone(), true).unwrap(),
            format!("{{\"meta\":{},\"keepBytes\":true}}", serde_json::to_string(&plain).unwrap())
        );
    }

    #[test]
    fn names_the_content_type_of_each_file_of_a_video() {
        assert_eq!(video_file_type("poster.jpg"), "image/jpeg");
        assert_eq!(video_file_type("master.m3u8"), "application/vnd.apple.mpegurl");
        assert_eq!(video_file_type("720p_00001.ts"), "video/mp2t");
        assert_eq!(video_file_type("720.mp4"), "application/octet-stream");
    }
}
