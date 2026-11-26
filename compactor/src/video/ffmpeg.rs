//! What the server does to a video with ffmpeg (see `super::worker`): reads what it is, makes
//! it an MP4 that plays anywhere, cuts that into the segments of an HLS stream, and takes a
//! picture of it. ffmpeg and ffprobe are programs of their own, which the process that runs
//! the worker has to have (the server's image does): nothing of them is part of this app.
//!
//! A file a user sent is read as what it is, and as nothing else. A playlist, a script, or a
//! list of files to join is a "video" to ffmpeg too, and one that names other files or URLs
//! would have the server read them. So only the containers real videos come in are read
//! (CONTAINERS), and nothing is opened but files on the local disk (PROTOCOLS), which is the
//! one the worker put there.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{Context, Result, anyhow};
use serde_json::Value;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use super::Halt;

/// The containers a video is read from, as ffmpeg names its demuxers: MP4, MOV and 3GP
/// (`mov`), Matroska and WebM, AVI, MPEG-TS and MPEG-PS, ASF/WMV, FLV and Ogg. Any other file
/// is refused unread, whatever its name says: no playlists (hls, concat), no scripts, no
/// pictures, no text.
const CONTAINERS: &str = "mov,matroska,webm,avi,mpegts,mpeg,asf,flv,ogg";

/// What ffmpeg may open: files on the local disk, and nothing over a network.
const PROTOCOLS: &str = "file";

/// The options every read of a file a user sent is made with (see the top of this file).
const SAFE_INPUT: [&str; 4] = ["-protocol_whitelist", PROTOCOLS, "-format_whitelist", CONTAINERS];

/// The longest side a video's picture may have, in pixels: 8K. A file that claims more is
/// refused before a frame of it is decoded.
const MAX_SIDE: i64 = 8192;

/// The most pictures a second a processed video shows: one that has more (a phone's slow
/// motion) is made with this many.
const MAX_FPS: f64 = 60.0;

/// How often a processed video has a keyframe, in seconds: every rendition at the same times,
/// so a player changes between them at any segment.
pub const KEYFRAME_SECONDS: i64 = 2;

/// How long a segment of the stream is, in seconds: Apple's recommendation, and a multiple of
/// KEYFRAME_SECONDS.
const SEGMENT_SECONDS: i64 = 6;

/// The bits a second a processed video's sound takes: AAC, stereo.
const AUDIO_BITRATE: i64 = 128_000;

/// How much of what ffmpeg wrote of an error is kept, in characters: the end of it, which is
/// where it says what failed.
const ERROR_CHARS: usize = 2000;

/// The most bits a second a rendition's picture takes, by its shorter side: the first whose
/// side it reaches. The encoder aims at a quality (CRF), not at these, so a still picture
/// takes far less; they are what holds a busy one to what a connection of that class carries.
const BITRATES: [(i64, i64); 7] = [
    (2160, 16_000_000),
    (1440, 9_000_000),
    (1080, 5_000_000),
    (720, 2_800_000),
    (480, 1_400_000),
    (360, 800_000),
    (0, 400_000),
];

/// A file that is no video the server can process: not one at all, one in a container or with
/// a picture it doesn't read, one that is broken, or one too large. Sending it again fails
/// again, so the worker gives it up at once, where any other failure is tried again.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct VideoError(pub String);

/// The programs the worker runs: where each is, as the settings name it.
#[derive(Debug, Clone)]
pub struct Tools {
    pub ffmpeg: String,
    pub ffprobe: String,
}

/// What a video file is, as ffprobe describes it.
#[derive(Debug, Clone, PartialEq)]
pub struct ProbedVideo {
    /// Of the picture as it is shown, in pixels: upright, with the rotation the file asks for.
    pub width: i64,
    pub height: i64,
    /// In seconds.
    pub duration: f64,
    /// Pictures a second; 0 where the file doesn't say.
    pub fps: f64,
    /// Whether it has sound.
    pub audio: bool,
    /// The tags of the file, of its picture and of its sound, by their names in lower case.
    pub tags: BTreeMap<String, String>,
}

/// A version of a video the server made: an MP4, at one size.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendition {
    /// The shorter side of its picture, in pixels.
    pub short: i64,
    /// Its name among the video's files: `720p`.
    pub name: String,
    pub path: PathBuf,
    pub width: i64,
    pub height: i64,
    /// Of the file, in bytes.
    pub size: i64,
    /// The most bits a second it takes, sound and all.
    pub bitrate: i64,
}

/// The name of a program, without where it is.
fn basename(program: &str) -> String {
    Path::new(program)
        .file_name()
        .map_or_else(|| program.to_owned(), |name| name.to_string_lossy().into_owned())
}

/// The end of what a program wrote of an error: no more than ERROR_CHARS characters of it.
fn tail(written: &[u8]) -> String {
    let text = String::from_utf8_lossy(written);
    let chars = text.chars().count();
    text.chars().skip(chars.saturating_sub(ERROR_CHARS)).collect::<String>().trim().to_owned()
}

/// What a program that ended badly fails with: a VideoError, unless something else killed it
/// (the kernel, out of memory), which is nothing the file is to blame for.
fn failure(program: &str, status: std::process::ExitStatus, written: &[u8]) -> anyhow::Error {
    let name = basename(program);
    #[cfg(unix)]
    if let Some(signal) = std::os::unix::process::ExitStatusExt::signal(&status) {
        return anyhow!("{name} was killed by signal {signal}");
    }
    let said = tail(written);
    let code = status.code().map_or_else(|| "?".to_owned(), |code| code.to_string());
    VideoError(format!("{name} failed ({code}): {}", if said.is_empty() { "it said nothing" } else { &said })).into()
}

/// What a program that could not be started fails with: what the system said, as words. The
/// system's own error is left out of it, since one that says the program isn't there would
/// read as a file of the content store that is gone (see `is_not_found`), which gives a
/// video up, and a machine without ffmpeg is nothing the video did.
fn unstarted(program: &str, err: &std::io::Error) -> anyhow::Error {
    anyhow!("{} could not be started: {err}", basename(program))
}

/// Runs one of the programs, and returns what it wrote to its output. Killed when `halt` is
/// told, and fails then with what stopped it.
async fn run(program: &str, args: &[String], halt: &Halt, cwd: Option<&Path>) -> Result<String> {
    halt.check()?;
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let child = command.spawn().map_err(|err| unstarted(program, &err))?;
    let output = tokio::select! {
        biased;
        // The program goes with what waited for it: it is killed as that is dropped.
        why = halt.halted() => return Err(why.error()),
        output = child.wait_with_output() => output.with_context(|| format!("{} could not be waited for", basename(program)))?,
    };
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
    }
    Err(failure(program, output.status, &output.stderr))
}

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|arg| (*arg).to_owned()).collect()
}

/// Whether the list of an ffmpeg's encoders has one: a line of its flags, then its name.
fn has_encoder(encoders: &str, encoder: &str) -> bool {
    encoders.lines().any(|line| {
        let mut words = line.split_whitespace();
        let flags = words.next().unwrap_or("");
        flags.len() == 6 && flags.bytes().all(|b| b.is_ascii_uppercase() || b == b'.') && words.next() == Some(encoder)
    })
}

/// What the process lacks to process videos with, as a sentence to log; None if it has all of
/// it: ffprobe, and an ffmpeg that encodes H.264 (libx264) and AAC and writes HLS.
pub async fn missing_tools(tools: &Tools) -> Option<String> {
    let never = Halt::never();
    if run(&tools.ffprobe, &args(&["-version"]), &never, None).await.is_err() {
        return Some(format!("ffprobe was not found (\"{}\")", tools.ffprobe));
    }
    let Ok(encoders) = run(&tools.ffmpeg, &args(&["-hide_banner", "-encoders"]), &never, None).await else {
        return Some(format!("ffmpeg was not found (\"{}\")", tools.ffmpeg));
    };
    ["libx264", "aac"]
        .into_iter()
        .find(|encoder| !has_encoder(&encoders, encoder))
        .map(|encoder| format!("ffmpeg (\"{}\") was built without the {encoder} encoder", tools.ffmpeg))
}

/// A number ffprobe gave, as a number or as text; 0 for none, or for what isn't one.
fn number(value: Option<&Value>) -> f64 {
    let n = match value {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(text)) => text.trim().parse().unwrap_or(0.0),
        _ => 0.0,
    };
    if n.is_finite() { n } else { 0.0 }
}

/// A rate ffprobe gave as a fraction ("30000/1001"); 0 for none.
fn rate(value: Option<&Value>) -> f64 {
    let text = value.and_then(Value::as_str).unwrap_or("");
    let (n, d) = text.split_once('/').unwrap_or((text, "1"));
    let part = |text: &str| text.trim().parse::<f64>().ok().filter(|n| n.is_finite()).unwrap_or(0.0);
    let fps = part(n) / if part(d) == 0.0 { 1.0 } else { part(d) };
    if fps.is_finite() { fps } else { 0.0 }
}

/// The tags of what ffprobe described, by their names in lower case.
fn tags_of(of: Option<&Value>) -> Vec<(String, String)> {
    let tags = of.and_then(|of| of.get("tags")).and_then(Value::as_object);
    tags.into_iter()
        .flatten()
        .map(|(name, value)| (name.to_lowercase(), value.as_str().map_or_else(|| value.to_string(), str::to_owned)))
        .collect()
}

/// A whole number of pixels, of what ffprobe gave.
#[allow(clippy::cast_possible_truncation)]
fn pixels(value: Option<&Value>) -> i64 {
    number(value) as i64
}

/// What ffprobe's description says a video is. Fails with a VideoError for what is no video
/// the server can process.
fn probed(said: &str) -> Result<ProbedVideo> {
    let described: Value = serde_json::from_str(said).map_err(|_| VideoError("ffprobe could not describe the file".to_owned()))?;
    let streams = described.get("streams").and_then(Value::as_array).cloned().unwrap_or_default();
    let is = |stream: &Value, kind: &str| stream.get("codec_type").and_then(Value::as_str) == Some(kind);
    // Not a cover picture, which a sound file has as a "video" of one frame.
    let cover = |stream: &Value| stream.pointer("/disposition/attached_pic").and_then(Value::as_i64) == Some(1);
    let picture = streams
        .iter()
        .find(|stream| is(stream, "video") && !cover(stream))
        .ok_or_else(|| VideoError("the file has no video in it".to_owned()))?;
    let sound = streams.iter().find(|stream| is(stream, "audio"));

    let (w, h) = (pixels(picture.get("width")), pixels(picture.get("height")));
    if w < 2 || h < 2 {
        return Err(VideoError(format!("the video's picture has no size ({w}x{h})")).into());
    }
    if w > MAX_SIDE || h > MAX_SIDE {
        return Err(VideoError(format!("the video's picture is too large ({w}x{h}); the most is {MAX_SIDE} pixels a side")).into());
    }
    // A phone films upright as a picture on its side with a rotation, which a player, and ffmpeg as it encodes, makes.
    let sides = picture.get("side_data_list").and_then(Value::as_array);
    let rotation = sides
        .into_iter()
        .flatten()
        .find_map(|side| side.get("rotation"))
        .or_else(|| picture.pointer("/tags/rotate"));
    #[allow(clippy::cast_possible_truncation)]
    let turned = ((number(rotation) / 90.0 + 0.5).floor() as i64).rem_euclid(2) == 1;

    let format = described.get("format");
    let whole = number(format.and_then(|format| format.get("duration")));
    let duration = if whole == 0.0 { number(picture.get("duration")) } else { whole };
    if duration <= 0.0 {
        return Err(VideoError("the video has no length".to_owned()).into());
    }
    let average = rate(picture.get("avg_frame_rate"));
    Ok(ProbedVideo {
        width: if turned { h } else { w },
        height: if turned { w } else { h },
        duration,
        fps: if average == 0.0 { rate(picture.get("r_frame_rate")) } else { average },
        audio: sound.is_some(),
        tags: tags_of(format).into_iter().chain(tags_of(Some(picture))).chain(tags_of(sound)).collect(),
    })
}

/// Reads what a video file is (see `ProbedVideo`). `sent` is for a file a user sent, which is
/// read with care (see the top of this file); a file the server made is read as it is. Fails
/// with a VideoError for a file that isn't a video the server can process.
pub async fn probe_video(tools: &Tools, path: &Path, sent: bool, halt: &Halt) -> Result<ProbedVideo> {
    let mut asked = args(&["-v", "error"]);
    if sent {
        asked.extend(args(&SAFE_INPUT));
    }
    asked.extend(args(&["-show_format", "-show_streams", "-of", "json"]));
    asked.push(path.to_string_lossy().into_owned());
    probed(&run(&tools.ffprobe, &asked, halt, None).await?)
}

/// The shorter side of a picture made `short` pixels, or as near under it as is even: H.264
/// takes no odd size.
fn even(short: i64) -> i64 {
    (short.div_euclid(2) * 2).max(2)
}

/// The name of a rendition among a video's files, by its shorter side: `720p`, `064p` (see
/// `is_media_file`, which is what they are served by).
pub fn rendition_name(short: i64) -> String {
    format!("{short:03}p")
}

/// The sizes to make a video in, largest first, as the shorter sides of their pictures: each
/// of `heights` that the video is at least as large as, and never a size larger than it is. A
/// video smaller than all of them is made in its own size.
pub fn rendition_sizes(width: i64, height: i64, heights: &[i64]) -> Vec<i64> {
    let short = even(width.min(height));
    let mut sizes: Vec<i64> = heights.iter().map(|height| even(*height)).filter(|height| *height <= short).collect();
    sizes.sort_unstable_by(|a, b| b.cmp(a));
    sizes.dedup();
    if sizes.is_empty() { vec![short] } else { sizes }
}

/// Makes a video an MP4 of H.264 and AAC, with its picture's shorter side `short` pixels:
/// what every browser and phone plays. Written to `out`. The MP4 says nothing of where, when
/// or with what the video was made: none of the file's metadata is copied (its tags, its
/// chapters, its subtitles and its data tracks, where a phone keeps the place it was filmed
/// at), and the encoder's own name is left out. What makes it play well:
///
/// - its index is at its start (`faststart`), so it plays as it downloads;
/// - its picture is 8 bits of 4:2:0, the one form every decoder reads, and upright, with the
///   rotation the file asked for made;
/// - it has a keyframe every KEYFRAME_SECONDS, at the same times in every size, so a stream
///   changes between sizes at any segment;
/// - its bitrate is held to what its size is given (BITRATES).
///
/// `source` is the file as the user sent it, already probed. Fails with a VideoError for one
/// ffmpeg can't decode.
pub async fn encode_video(tools: &Tools, source: &Path, video: &ProbedVideo, short: i64, out: &Path, halt: &Halt) -> Result<Rendition> {
    let bitrate = BITRATES.iter().find(|(side, _)| short >= *side).map_or(400_000, |(_, bitrate)| *bitrate);
    // The shorter side as asked, the other in proportion, to an even number.
    let mut filters = vec![if video.width >= video.height {
        format!("scale=-2:{short}")
    } else {
        format!("scale={short}:-2")
    }];
    if video.fps > MAX_FPS {
        filters.push(format!("fps={MAX_FPS}"));
    }
    filters.push("format=yuv420p".to_owned());
    let mut asked = args(&["-nostdin", "-hide_banner", "-loglevel", "error", "-y"]);
    asked.extend(args(&SAFE_INPUT));
    asked.extend(["-i".to_owned(), source.to_string_lossy().into_owned()]);
    // Its first picture and, if it has any, its first sound: no subtitles, no data, no attachments.
    asked.extend(args(&[
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-sn",
        "-dn",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
    ]));
    asked.extend(["-vf".to_owned(), filters.join(",")]);
    asked.extend(args(&["-c:v", "libx264", "-preset", "veryfast", "-crf", "23"]));
    asked.extend(["-maxrate".to_owned(), bitrate.to_string(), "-bufsize".to_owned(), (bitrate * 2).to_string()]);
    asked.extend(args(&["-profile:v", if short > 480 { "high" } else { "main" }, "-pix_fmt", "yuv420p"]));
    asked.extend(["-force_key_frames".to_owned(), format!("expr:gte(t,n_forced*{KEYFRAME_SECONDS})")]);
    asked.extend(args(&["-sc_threshold", "0", "-c:a", "aac"]));
    asked.extend(["-b:a".to_owned(), AUDIO_BITRATE.to_string()]);
    asked.extend(args(&["-ac", "2", "-ar", "48000"]));
    // Nothing of the program that made it, either.
    asked.extend(args(&[
        "-fflags",
        "+bitexact",
        "-flags:v",
        "+bitexact",
        "-flags:a",
        "+bitexact",
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
    ]));
    asked.push(out.to_string_lossy().into_owned());
    run(&tools.ffmpeg, &asked, halt, None).await?;

    let made = probe_video(tools, out, false, halt).await?;
    let size = tokio::fs::metadata(out)
        .await
        .with_context(|| format!("could not read the size of {}", out.display()))?
        .len();
    Ok(Rendition {
        short,
        name: rendition_name(short),
        path: out.to_owned(),
        width: made.width,
        height: made.height,
        size: i64::try_from(size).unwrap_or(i64::MAX),
        bitrate: bitrate + if made.audio { AUDIO_BITRATE } else { 0 },
    })
}

/// The folder a rendition is in, and its file's name there.
fn placed(path: &Path) -> Result<(&Path, String)> {
    let dir = path.parent().with_context(|| format!("{} is in no folder", path.display()))?;
    let file = path.file_name().with_context(|| format!("{} names no file", path.display()))?;
    Ok((dir, file.to_string_lossy().into_owned()))
}

/// Cuts a rendition into the segments of an HLS stream, beside it: `<name>_00000.ts` and so
/// on, each SEGMENT_SECONDS long, and the playlist that lists them, `<name>.m3u8`. Nothing is
/// encoded again: the segments are the MP4's picture and sound as they are.
pub async fn segment_video(tools: &Tools, rendition: &Rendition, halt: &Halt) -> Result<()> {
    let (dir, file) = placed(&rendition.path)?;
    let name = &rendition.name;
    let mut asked = args(&["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i"]);
    asked.push(file);
    asked.extend(args(&[
        "-map",
        "0",
        "-c",
        "copy",
        "-map_metadata",
        "-1",
        "-fflags",
        "+bitexact",
        "-f",
        "hls",
        "-hls_time",
    ]));
    asked.push(SEGMENT_SECONDS.to_string());
    asked.extend(args(&[
        "-hls_playlist_type",
        "vod",
        "-hls_flags",
        "independent_segments",
        "-hls_segment_filename",
    ]));
    asked.extend([format!("{name}_%05d.ts"), format!("{name}.m3u8")]);
    // In the folder itself, so the playlist names its segments by their names alone: they are served from beside it.
    run(&tools.ffmpeg, &asked, halt, Some(dir)).await?;
    Ok(())
}

/// The master playlist of a video's stream: its renditions, largest first, each with the most
/// bits a second it takes and the size of its picture, which is what a player picks one by,
/// as its connection and its screen allow. It names each rendition's playlist by its name
/// alone: they are served from beside it.
pub fn master_playlist(renditions: &[Rendition]) -> String {
    let mut lines = vec!["#EXTM3U".to_owned(), "#EXT-X-VERSION:6".to_owned(), "#EXT-X-INDEPENDENT-SEGMENTS".to_owned()];
    for rendition in renditions {
        lines.push(format!(
            "#EXT-X-STREAM-INF:BANDWIDTH={},RESOLUTION={}x{}",
            rendition.bitrate, rendition.width, rendition.height
        ));
        lines.push(format!("{}.m3u8", rendition.name));
    }
    lines.push(String::new());
    lines.join("\n")
}

/// A keyframe of a rendition, as pixels: 3 bytes each (red, green, blue), row after row.
pub struct Keyframe<'a> {
    pub pixels: &'a [u8],
    pub width: usize,
    pub height: usize,
    /// Where in the video it is, in seconds.
    pub seconds: f64,
}

/// Shows `each` the keyframes of a rendition the server made, one at a time: the picture the
/// video shows every KEYFRAME_SECONDS, from its first, which is where `encode_video` put a
/// keyframe whatever the file that was sent had. Only those are decoded, so this costs a
/// small part of what making the rendition did. What checks a video against a list of
/// pictures reads them. Ends, and stops the program, with the first thing `each` returns.
///
/// Each is at the rendition's size, or, of a rendition with a side longer than `max_side`,
/// brought down to `max_side` by `max_side` whatever its shape was. The last picture may come
/// twice.
pub async fn keyframes_of<T>(
    tools: &Tools,
    rendition: &Rendition,
    max_side: i64,
    halt: &Halt,
    mut each: impl FnMut(Keyframe<'_>) -> Option<T>,
) -> Result<Option<T>> {
    halt.check()?;
    let (w, h) = if rendition.width > max_side || rendition.height > max_side {
        (max_side, max_side)
    } else {
        (rendition.width, rendition.height)
    };
    let (width, height) = (usize::try_from(w).unwrap_or(0), usize::try_from(h).unwrap_or(0));
    let mut asked = args(&["-nostdin", "-hide_banner", "-loglevel", "error"]);
    // Only the keyframes are decoded, and one picture is taken for each KEYFRAME_SECONDS, which is how far apart they are.
    asked.extend([
        "-skip_frame".to_owned(),
        "nokey".to_owned(),
        "-i".to_owned(),
        rendition.path.to_string_lossy().into_owned(),
    ]);
    asked.extend(args(&["-map", "0:v:0", "-an", "-sn", "-dn", "-vf"]));
    asked.push(format!("fps=1/{KEYFRAME_SECONDS},scale={w}:{h}:flags=lanczos"));
    asked.extend(args(&["-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]));

    let program = &tools.ffmpeg;
    let mut child = Command::new(program)
        .args(&asked)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|err| unstarted(program, &err))?;
    let mut out = child.stdout.take().context("ffmpeg has no output to read")?;
    let mut err = child.stderr.take().context("ffmpeg has no errors to read")?;
    // What it says of an error is read as it is written, so that it never waits to write it.
    let said = tokio::spawn(async move {
        let mut written = Vec::new();
        let _ = err.read_to_end(&mut written).await;
        written
    });

    let mut frame = vec![0_u8; width * height * 3];
    let mut index = 0_i64;
    let reading = async {
        loop {
            match out.read_exact(&mut frame).await {
                Ok(_) => {}
                // The end of its output, with whatever was left of a picture it never finished.
                Err(err) if err.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
                Err(err) => return Err(anyhow::Error::from(err).context("could not read the pictures ffmpeg wrote")),
            }
            #[allow(clippy::cast_precision_loss)]
            let seconds = (index * KEYFRAME_SECONDS) as f64;
            if let Some(found) = each(Keyframe {
                pixels: &frame,
                width,
                height,
                seconds,
            }) {
                return Ok(Some(found));
            }
            index += 1;
            // Hashing a picture is some milliseconds of work: the process's other work gets a turn between two.
            tokio::task::yield_now().await;
        }
    };
    let read = tokio::select! {
        biased;
        why = halt.halted() => Err(why.error()),
        read = reading => read,
    };
    match read {
        // Whoever stops reading before the end stops the program.
        Ok(Some(found)) => {
            let _ = child.kill().await;
            Ok(Some(found))
        }
        Ok(None) => {
            let status = child.wait().await.with_context(|| format!("{} could not be waited for", basename(program)))?;
            if status.success() {
                Ok(None)
            } else {
                Err(failure(program, status, &said.await.unwrap_or_default()))
            }
        }
        Err(err) => {
            let _ = child.kill().await;
            Err(err)
        }
    }
}

/// Takes the picture a video is shown by before it plays, as a JPEG, at `out`: a frame `at`
/// seconds in, no larger than `short` on its shorter side. From a rendition the server made,
/// so it is upright, and says nothing of where it is from.
pub async fn poster_of(tools: &Tools, rendition: &Rendition, at: f64, short: i64, out: &Path, halt: &Halt) -> Result<()> {
    let side = even(short.min(rendition.width).min(rendition.height));
    let mut asked = args(&["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-ss"]);
    asked.extend([format!("{at:.3}"), "-i".to_owned(), rendition.path.to_string_lossy().into_owned()]);
    asked.extend(args(&["-map", "0:v:0", "-frames:v", "1", "-map_metadata", "-1", "-vf"]));
    asked.push(if rendition.width >= rendition.height {
        format!("scale=-2:{side}")
    } else {
        format!("scale={side}:-2")
    });
    asked.extend(args(&[
        "-c:v",
        "mjpeg",
        "-q:v",
        "4",
        "-pix_fmt",
        "yuvj420p",
        "-fflags",
        "+bitexact",
        "-flags:v",
        "+bitexact",
        "-f",
        "image2",
    ]));
    asked.push(out.to_string_lossy().into_owned());
    run(&tools.ffmpeg, &asked, halt, None).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn rendition(short: i64, long: i64, bitrate: i64) -> Rendition {
        Rendition {
            short,
            name: rendition_name(short),
            path: PathBuf::from(format!("/tmp/{short}.mp4")),
            width: long,
            height: short,
            size: 1,
            bitrate,
        }
    }

    #[test]
    fn makes_a_video_in_the_sizes_it_is_large_enough_for() {
        let heights = [1080, 720, 480, 240];
        assert_eq!(rendition_sizes(1920, 1080, &heights), [1080, 720, 480, 240]);
        // Upright: its shorter side is its width.
        assert_eq!(rendition_sizes(720, 1280, &heights), [720, 480, 240]);
        assert_eq!(rendition_sizes(640, 361, &heights), [240]);
        // Smaller than all of them: its own size, made even.
        assert_eq!(rendition_sizes(320, 181, &heights), [180]);
        assert_eq!(rendition_sizes(3840, 2160, &[720]), [720]);
        assert_eq!(rendition_sizes(1280, 720, &[720, 721, 480, 481]), [720, 480]);
        assert_eq!(
            (rendition_name(720), rendition_name(64), rendition_name(1080)),
            ("720p".to_owned(), "064p".to_owned(), "1080p".to_owned())
        );
    }

    #[test]
    fn lists_the_renditions_of_a_stream_largest_first() {
        let playlist = master_playlist(&[rendition(720, 1280, 2_928_000), rendition(240, 426, 528_000)]);
        assert_eq!(
            playlist.split('\n').collect::<Vec<_>>(),
            [
                "#EXTM3U",
                "#EXT-X-VERSION:6",
                "#EXT-X-INDEPENDENT-SEGMENTS",
                "#EXT-X-STREAM-INF:BANDWIDTH=2928000,RESOLUTION=1280x720",
                "720p.m3u8",
                "#EXT-X-STREAM-INF:BANDWIDTH=528000,RESOLUTION=426x240",
                "240p.m3u8",
                "",
            ]
        );
    }

    #[test]
    fn reads_what_ffprobe_says_a_video_is() {
        let said = json!({
            "format": { "duration": "12.500000", "tags": { "Major_Brand": "isom", "location": "+52.5+013.4/" } },
            "streams": [
                { "codec_type": "video", "disposition": { "attached_pic": 1 }, "width": 600, "height": 600 },
                { "codec_type": "audio", "tags": { "language": "eng" } },
                {
                    "codec_type": "video", "width": 1920, "height": 1080, "avg_frame_rate": "30000/1001", "r_frame_rate": "30/1",
                    "side_data_list": [{ "side_data_type": "Display Matrix", "rotation": -90 }], "tags": { "handler_name": "Core Media" }
                },
            ],
        });
        let video = probed(&said.to_string()).unwrap();
        // On its side with a rotation: shown upright.
        assert_eq!((video.width, video.height, video.duration, video.audio), (1080, 1920, 12.5, true));
        assert!((video.fps - 29.97).abs() < 0.001);
        assert_eq!(
            video.tags.iter().map(|(name, value)| (name.as_str(), value.as_str())).collect::<Vec<_>>(),
            [
                ("handler_name", "Core Media"),
                ("language", "eng"),
                ("location", "+52.5+013.4/"),
                ("major_brand", "isom")
            ]
        );

        let refused = |said: Value| probed(&said.to_string()).unwrap_err().downcast::<VideoError>().unwrap().0;
        assert_eq!(refused(json!({ "streams": [{ "codec_type": "audio" }] })), "the file has no video in it");
        assert_eq!(
            refused(json!({ "streams": [{ "codec_type": "video", "disposition": { "attached_pic": 1 }, "width": 9, "height": 9 }] })),
            "the file has no video in it"
        );
        assert_eq!(
            refused(json!({ "streams": [{ "codec_type": "video", "width": 0, "height": 720 }] })),
            "the video's picture has no size (0x720)"
        );
        assert_eq!(
            refused(json!({ "streams": [{ "codec_type": "video", "width": 16384, "height": 720 }] })),
            "the video's picture is too large (16384x720); the most is 8192 pixels a side"
        );
        assert_eq!(
            refused(json!({ "streams": [{ "codec_type": "video", "width": 1280, "height": 720 }] })),
            "the video has no length"
        );
        assert_eq!(
            probed("not json").unwrap_err().downcast::<VideoError>().unwrap().0,
            "ffprobe could not describe the file"
        );
        // The length of its picture, where the file gives none of its own; a rate that is no fraction; a tag that turns it.
        let video = probed(&json!({ "streams": [{ "codec_type": "video", "width": 640, "height": 360, "duration": "3.2", "avg_frame_rate": "0/0", "r_frame_rate": "25", "tags": { "rotate": "90" } }] }).to_string()).unwrap();
        assert_eq!(
            (video.width, video.height, video.duration, video.fps, video.audio),
            (360, 640, 3.2, 25.0, false)
        );
    }

    #[test]
    fn finds_an_encoder_in_the_list_ffmpeg_gives_of_its_own() {
        let encoders = "Encoders:\n V..... = Video\n ------\n V....D libx264              libx264 H.264 / AVC\n A....D aac                  AAC (Advanced Audio Coding)\n V....D libx264rgb           libx264 H.264 RGB\n";
        assert!(has_encoder(encoders, "libx264") && has_encoder(encoders, "aac"));
        assert!(!has_encoder(encoders, "libx265") && !has_encoder(encoders, "H.264") && !has_encoder(encoders, "Video"));
        assert!(!has_encoder("libx264 is not here\n", "libx264"));
    }

    #[test]
    fn keeps_the_end_of_what_a_program_said_of_an_error() {
        assert_eq!(tail(b"  moov atom not found\n"), "moov atom not found");
        let long = format!("{}the end", "x".repeat(5000));
        let kept = tail(long.as_bytes());
        assert_eq!(kept.chars().count(), ERROR_CHARS);
        assert!(kept.ends_with("the end"));
    }
}
