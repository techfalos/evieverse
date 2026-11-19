import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { ProbedVideo, Rendition, VideoFrame, VideoTools } from './ffmpeg.types.js';

/**
 * What the server does to a video with ffmpeg (see createVideoWorker): reads what it is, makes
 * it an MP4 that plays anywhere, cuts that into the segments of an HLS stream, and takes a
 * picture of it. ffmpeg and ffprobe are programs of their own, which the process that runs the
 * worker has to have (the server's image does): nothing of them is part of this app.
 *
 * A file a user sent is read as what it is, and as nothing else. A playlist, a script, or a
 * list of files to join is a "video" to ffmpeg too, and one that names other files or URLs
 * would have the server read them. So only the containers real videos come in are read
 * (CONTAINERS), and nothing is opened but files on the local disk (PROTOCOLS), which is the one
 * the worker put there.
 */

/**
 * The containers a video is read from, as ffmpeg names its demuxers: MP4, MOV and 3GP (`mov`),
 * Matroska and WebM, AVI, MPEG-TS and MPEG-PS, ASF/WMV, FLV and Ogg. Any other file is refused
 * unread, whatever its name says: no playlists (hls, concat), no scripts, no pictures, no text.
 */
const CONTAINERS = 'mov,matroska,webm,avi,mpegts,mpeg,asf,flv,ogg';

/** What ffmpeg may open: files on the local disk, and nothing over a network. */
const PROTOCOLS = 'file';

/** The options every read of a file a user sent is made with (see the top of this file). */
const SAFE_INPUT = ['-protocol_whitelist', PROTOCOLS, '-format_whitelist', CONTAINERS];

/** The longest side a video's picture may have, in pixels: 8K. A file that claims more is refused before a frame of it is decoded. */
const MAX_SIDE = 8192;

/** The most pictures a second a processed video shows: one that has more (a phone's slow motion) is made with this many. */
const MAX_FPS = 60;

/** How often a processed video has a keyframe, in seconds: every rendition at the same times, so a player changes between them at any segment. */
const KEYFRAME_SECONDS = 2;

/** How long a segment of the stream is, in seconds: Apple's recommendation, and a multiple of KEYFRAME_SECONDS. */
const SEGMENT_SECONDS = 6;

/** The bits a second a processed video's sound takes: AAC, stereo. */
const AUDIO_BITRATE = 128_000;

/** How much of what ffmpeg wrote of an error is kept, in characters: the end of it, which is where it says what failed. */
const ERROR_CHARS = 2000;

/**
 * The most bits a second a rendition's picture takes, by its shorter side: the first whose side
 * it reaches. The encoder aims at a quality (CRF), not at these, so a still picture takes far
 * less; they are what holds a busy one to what a connection of that class carries.
 */
const BITRATES: [short: number, bitrate: number][] = [
  [2160, 16_000_000],
  [1440, 9_000_000],
  [1080, 5_000_000],
  [720, 2_800_000],
  [480, 1_400_000],
  [360, 800_000],
  [0, 400_000],
];

/**
 * A file that is no video the server can process: not one at all, one in a container or with a
 * picture it doesn't read, one that is broken, or one too large. Sending it again fails again,
 * so the worker gives it up at once, where any other failure is tried again.
 */
export class VideoError extends Error {
  override name = 'VideoError';
}

/** Runs one of the programs, and returns what it wrote to its output. Stopped, with `signal`'s reason, when that aborts. */
function run(program: string, args: string[], { signal, cwd }: { signal?: AbortSignal; cwd?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, signal, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      err = (err + chunk.toString('utf8')).slice(-ERROR_CHARS);
    });
    child.on('error', (cause) => reject(signal?.aborted ? (signal.reason ?? cause) : cause));
    child.on('close', (code, killed) => {
      if (code === 0) return resolve(Buffer.concat(out).toString('utf8'));
      if (signal?.aborted) return reject(signal.reason ?? new Error(`${basename(program)} was stopped`));
      // Killed by something else (the kernel, out of memory): nothing the file is to blame for.
      if (killed) return reject(new Error(`${basename(program)} was killed by ${killed}`));
      reject(new VideoError(`${basename(program)} failed (${code}): ${err.trim() || 'it said nothing'}`));
    });
  });
}

/**
 * Runs one of the programs, and gives what it writes to its output as it writes it, in pieces
 * of `size` bytes each: the pictures of a video, one at a time, so that no more than one is
 * held. It ends when the program does, and fails as `run` fails if the program did. Whoever
 * stops reading before the end stops the program.
 */
async function* pieces(program: string, args: string[], size: number, signal?: AbortSignal): AsyncGenerator<Buffer> {
  const child = spawn(program, args, { signal, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (chunk: Buffer) => {
    err = (err + chunk.toString('utf8')).slice(-ERROR_CHARS);
  });
  const closed = new Promise<{ code: number | null; killed: NodeJS.Signals | null; cause?: Error }>((resolve) => {
    let cause: Error | undefined;
    child.on('error', (failure) => {
      cause = failure;
      // A program that never started has no `close` to wait for.
      if (child.pid === undefined) resolve({ code: null, killed: null, cause });
    });
    child.on('close', (code, killed) => resolve({ code, killed, cause }));
  });
  let ended = false;
  try {
    let held: Buffer = Buffer.alloc(0);
    try {
      for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
        held = held.length ? Buffer.concat([held, chunk]) : chunk;
        let at = 0;
        for (; held.length - at >= size; at += size) yield held.subarray(at, at + size);
        held = held.subarray(at);
      }
    } catch (failure) {
      // The output of a program that was stopped ends as it likes: what stopped it is what is said.
      if (!signal?.aborted) throw failure;
    }
    const { code, killed, cause } = await closed;
    ended = true;
    if (code === 0) return;
    if (signal?.aborted) throw signal.reason ?? cause ?? new Error(`${basename(program)} was stopped`);
    if (cause) throw cause;
    if (killed) throw new Error(`${basename(program)} was killed by ${killed}`);
    throw new VideoError(`${basename(program)} failed (${code}): ${err.trim() || 'it said nothing'}`);
  } finally {
    if (!ended) {
      child.kill('SIGKILL');
      await closed;
    }
  }
}

/**
 * What the process lacks to process videos with, as a sentence to log; null if it has all of
 * it: ffprobe, and an ffmpeg that encodes H.264 (libx264) and AAC and writes HLS.
 */
export async function missingTools({ ffmpegPath, ffprobePath }: VideoTools): Promise<string | null> {
  try {
    await run(ffprobePath, ['-version']);
  } catch {
    return `ffprobe was not found ("${ffprobePath}")`;
  }
  let encoders: string;
  try {
    encoders = await run(ffmpegPath, ['-hide_banner', '-encoders']);
  } catch {
    return `ffmpeg was not found ("${ffmpegPath}")`;
  }
  for (const encoder of ['libx264', 'aac']) {
    if (!new RegExp(`^\\s*[A-Z.]{6}\\s+${encoder}\\s`, 'm').test(encoders)) return `ffmpeg ("${ffmpegPath}") was built without the ${encoder} encoder`;
  }
  return null;
}

/** A number ffprobe gave as text; 0 for none, or for what isn't one. */
const number = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/** A rate ffprobe gave as a fraction ("30000/1001"); 0 for none. */
function rate(value: unknown): number {
  const [n, d = '1'] = String(value ?? '').split('/');
  const fps = number(n) / (number(d) || 1);
  return Number.isFinite(fps) ? fps : 0;
}

/** The tags of what ffprobe described, by their names in lower case. */
const tagsOf = (of: { tags?: Record<string, unknown> } | undefined): [string, string][] => Object.entries(of?.tags ?? {}).map(([name, value]) => [name.toLowerCase(), String(value)]);

/**
 * Reads what a video file is (see ProbedVideo). `sent` is for a file a user sent, which is read
 * with care (see the top of this file); a file the server made is read as it is. Throws
 * VideoError for a file that isn't a video the server can process.
 */
export async function probeVideo({ ffprobePath }: VideoTools, path: string, { sent = false, signal }: { sent?: boolean; signal?: AbortSignal } = {}): Promise<ProbedVideo> {
  const said = await run(ffprobePath, ['-v', 'error', ...(sent ? SAFE_INPUT : []), '-show_format', '-show_streams', '-of', 'json', path], { signal });
  let probed: { format?: { duration?: string; tags?: Record<string, unknown> }; streams?: Record<string, unknown>[] };
  try {
    probed = JSON.parse(said);
  } catch {
    throw new VideoError('ffprobe could not describe the file');
  }
  const streams = probed.streams ?? [];
  // Not a cover picture, which a sound file has as a "video" of one frame.
  const picture = streams.find((s) => s.codec_type === 'video' && (s.disposition as Record<string, number> | undefined)?.attached_pic !== 1);
  if (!picture) throw new VideoError('the file has no video in it');
  const sound = streams.find((s) => s.codec_type === 'audio');

  const [w, h] = [number(picture.width), number(picture.height)];
  if (w < 2 || h < 2) throw new VideoError(`the video's picture has no size (${w}x${h})`);
  if (w > MAX_SIDE || h > MAX_SIDE) throw new VideoError(`the video's picture is too large (${w}x${h}); the most is ${MAX_SIDE} pixels a side`);
  // A phone films upright as a picture on its side with a rotation, which a player, and ffmpeg as it encodes, makes.
  const sides = (picture.side_data_list as { rotation?: unknown }[] | undefined) ?? [];
  const rotation = number(sides.find((side) => side.rotation !== undefined)?.rotation ?? (picture.tags as Record<string, unknown> | undefined)?.rotate);
  const turned = Math.abs(Math.round(rotation / 90)) % 2 === 1;

  const duration = number(probed.format?.duration) || number(picture.duration);
  if (duration <= 0) throw new VideoError('the video has no length');
  return {
    width: turned ? h : w,
    height: turned ? w : h,
    duration,
    fps: rate(picture.avg_frame_rate) || rate(picture.r_frame_rate),
    audio: sound !== undefined,
    tags: Object.fromEntries([...tagsOf(probed.format), ...tagsOf(picture), ...tagsOf(sound)]),
  };
}

/** The shorter side of a picture made `short` pixels, or as near under it as is even: H.264 takes no odd size. */
const even = (short: number) => Math.max(2, Math.floor(short / 2) * 2);

/** The name of a rendition among a video's files, by its shorter side: `720p`, `064p` (see MEDIA_FILE, which is what serves them). */
export const renditionName = (short: number) => `${String(short).padStart(3, '0')}p`;

/**
 * The sizes to make a video in, largest first, as the shorter sides of their pictures: each of
 * `heights` that the video is at least as large as, and never a size larger than it is. A video
 * smaller than all of them is made in its own size.
 */
export function renditionSizes({ width, height }: Pick<ProbedVideo, 'width' | 'height'>, heights: number[]): number[] {
  const short = even(Math.min(width, height));
  const sizes = [...new Set(heights.map(even).filter((h) => h <= short))].sort((a, b) => b - a);
  return sizes.length ? sizes : [short];
}

/**
 * Makes a video an MP4 of H.264 and AAC, with its picture's shorter side `short` pixels:
 * what every browser and phone plays. Written to `out`. The MP4 says nothing of where, when
 * or with what the video was made: none of the file's metadata is copied (its tags, its
 * chapters, its subtitles and its data tracks, where a phone keeps the place it was filmed
 * at), and the encoder's own name is left out. What makes it play well:
 *
 * - its index is at its start (`faststart`), so it plays as it downloads;
 * - its picture is 8 bits of 4:2:0, the one form every decoder reads, and upright, with the
 *   rotation the file asked for made;
 * - it has a keyframe every KEYFRAME_SECONDS, at the same times in every size, so a stream
 *   changes between sizes at any segment;
 * - its bitrate is held to what its size is given (BITRATES).
 *
 * `source` is the file as the user sent it, already probed. Throws VideoError for one ffmpeg
 * can't decode.
 */
export async function encodeVideo(tools: VideoTools, source: string, video: ProbedVideo, short: number, out: string, signal?: AbortSignal): Promise<Rendition> {
  const [, bitrate] = BITRATES.find(([side]) => short >= side)!;
  const filters = [
    // The shorter side as asked, the other in proportion, to an even number.
    video.width >= video.height ? `scale=-2:${short}` : `scale=${short}:-2`,
    ...(video.fps > MAX_FPS ? [`fps=${MAX_FPS}`] : []),
    'format=yuv420p',
  ];
  await run(
    tools.ffmpegPath,
    [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      ...SAFE_INPUT, '-i', source,
      // Its first picture and, if it has any, its first sound: no subtitles, no data, no attachments.
      '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
      '-map_metadata', '-1', '-map_chapters', '-1',
      '-vf', filters.join(','),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-maxrate', String(bitrate), '-bufsize', String(bitrate * 2),
      '-profile:v', short > 480 ? 'high' : 'main', '-pix_fmt', 'yuv420p',
      '-force_key_frames', `expr:gte(t,n_forced*${KEYFRAME_SECONDS})`, '-sc_threshold', '0',
      '-c:a', 'aac', '-b:a', String(AUDIO_BITRATE), '-ac', '2', '-ar', '48000',
      // Nothing of the program that made it, either.
      '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact',
      '-movflags', '+faststart', '-f', 'mp4', out,
    ],
    { signal },
  );
  const made = await probeVideo(tools, out, { signal });
  return { short, name: renditionName(short), path: out, width: made.width, height: made.height, size: (await stat(out)).size, bitrate: bitrate + (made.audio ? AUDIO_BITRATE : 0) };
}

/**
 * Cuts a rendition into the segments of an HLS stream, beside it: `<name>_00000.ts` and so on,
 * each SEGMENT_SECONDS long, and the playlist that lists them, `<name>.m3u8`. Nothing is
 * encoded again: the segments are the MP4's picture and sound as they are.
 */
export async function segmentVideo({ ffmpegPath }: VideoTools, { path, name }: Pick<Rendition, 'path' | 'name'>, signal?: AbortSignal): Promise<void> {
  await run(
    ffmpegPath,
    [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-i', basename(path),
      '-map', '0', '-c', 'copy', '-map_metadata', '-1',
      '-fflags', '+bitexact',
      '-f', 'hls', '-hls_time', String(SEGMENT_SECONDS), '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments',
      '-hls_segment_filename', `${name}_%05d.ts`, `${name}.m3u8`,
    ],
    // In the folder itself, so the playlist names its segments by their names alone: they are served from beside it.
    { signal, cwd: dirname(path) },
  );
}

/**
 * The master playlist of a video's stream: its renditions, largest first, each with the most
 * bits a second it takes and the size of its picture, which is what a player picks one by, as
 * its connection and its screen allow. It names each rendition's playlist by its name alone:
 * they are served from beside it.
 */
export function masterPlaylist(renditions: Rendition[]): string {
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    ...renditions.flatMap((r) => [`#EXT-X-STREAM-INF:BANDWIDTH=${r.bitrate},RESOLUTION=${r.width}x${r.height}`, `${r.name}.m3u8`]),
    '',
  ].join('\n');
}

/**
 * The keyframes of a rendition the server made, one at a time, as pixels: the picture the video
 * shows every KEYFRAME_SECONDS, from its first, which is where encodeVideo put a keyframe
 * whatever the file that was sent had. Only those are decoded, so this costs a small part of
 * what making the rendition did. What checks a video against a list of pictures reads them
 * (see checkVideo in src/plugins/trust/pdq/video.ts).
 *
 * Each is 3 bytes a pixel (red, green, blue), row after row, at the rendition's size, or, of a
 * rendition with a side longer than `maxSide`, brought down to `maxSide` by `maxSide`
 * whatever its shape was. The last picture may come twice.
 */
export async function* keyframesOf({ ffmpegPath }: VideoTools, { path, width, height }: Pick<Rendition, 'path' | 'width' | 'height'>, maxSide: number, signal?: AbortSignal): AsyncGenerator<VideoFrame> {
  const [w, h] = width > maxSide || height > maxSide ? [maxSide, maxSide] : [width, height];
  const args = [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    // Only the keyframes are decoded, and one picture is taken for each KEYFRAME_SECONDS, which is how far apart they are.
    '-skip_frame', 'nokey', '-i', path,
    '-map', '0:v:0', '-an', '-sn', '-dn',
    '-vf', `fps=1/${KEYFRAME_SECONDS},scale=${w}:${h}:flags=lanczos`,
    '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1',
  ];
  let index = 0;
  for await (const pixels of pieces(ffmpegPath, args, w * h * 3, signal)) yield { pixels, width: w, height: h, seconds: index++ * KEYFRAME_SECONDS };
}

/**
 * Takes the picture a video is shown by before it plays, as a JPEG, at `out`: a frame `at`
 * seconds in, no larger than `short` on its shorter side. From a rendition the server made,
 * so it is upright, and says nothing of where it is from.
 */
export async function posterOf({ ffmpegPath }: VideoTools, { path, width, height }: Pick<Rendition, 'path' | 'width' | 'height'>, at: number, short: number, out: string, signal?: AbortSignal): Promise<void> {
  const side = even(Math.min(short, width, height));
  await run(
    ffmpegPath,
    [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', at.toFixed(3), '-i', path,
      '-map', '0:v:0', '-frames:v', '1', '-map_metadata', '-1',
      '-vf', width >= height ? `scale=-2:${side}` : `scale=${side}:-2`,
      '-c:v', 'mjpeg', '-q:v', '4', '-pix_fmt', 'yuvj420p', '-fflags', '+bitexact', '-flags:v', '+bitexact',
      '-f', 'image2', out,
    ],
    { signal },
  );
}
