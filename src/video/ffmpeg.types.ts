/** Where the programs that read and write videos are, as `video` in the settings names them: by a path, or by a name the PATH has. */
export interface VideoTools {
  ffmpegPath: string;
  ffprobePath: string;
}

/** What ffprobe says of a video file (see probeVideo). */
export interface ProbedVideo {
  /** The picture's size as it is shown, in pixels: with the rotation the file asks for made. */
  width: number;
  height: number;
  /** How long it plays, in seconds. */
  duration: number;
  /** How many pictures a second it shows, as nearly as the file says; 0 where it doesn't say. */
  fps: number;
  /** Whether it has sound. */
  audio: boolean;
  /** What the file says of itself besides: its tags, and those of its picture and its sound, by their names in lower case. What a processed file is checked to have none of. */
  tags: Record<string, string>;
}

/** One size a video is made in (see encodeVideo): named by the shorter side of its picture, as "720p" is. */
export interface Rendition {
  /** The shorter side of its picture, in pixels. */
  short: number;
  /** Its name among the video's files: `720p`, and `064p` for one under a hundred pixels. */
  name: string;
  /** The MP4 that was made, on the local disk. */
  path: string;
  /** Its picture's size, in pixels. */
  width: number;
  height: number;
  /** The file's size in bytes. */
  size: number;
  /** The most bits a second its picture and its sound take, which the encoder was held to: what a player picks a rendition by. */
  bitrate: number;
}
