import type { Mention } from '../mentions.types.js';

/**
 * What describes a piece of content's bytes, kept in a file beside them rather than in the
 * database: an update overwrites both.
 */
export interface ContentMeta {
  contentId: string;
  mimeType: string;
  /** Of the bytes, as stored. */
  size: number;
  /**
   * The SHA-256 of an image's, video's or audio's bytes as stored, in hex: what an update's file is
   * compared by, so that the file the content already has isn't stored again. Absent on a text or
   * link post, which is compared by what it says; on a video or audio file sent with an upload
   * link, which is copied within the content store, not stored from a file here; and in a meta
   * file written before the server kept one. A file is then stored whenever it is sent.
   *
   * Of a video the server has processed (see Preview.video) it is the hash of the file as it
   * was sent, not of the MP4 that is stored: the file an update sends is the one to tell from
   * it, and one that is the same is not processed again.
   */
  sha256?: string;
  /**
   * On an image post of more than one image: every image, in the order the post has them. The
   * first is the one `mimeType`, `size` and `sha256` describe, and whose bytes are the post's;
   * each one after it is a file of its own beside those (see ContentStore). Absent on a post of
   * one image, and on a repost of a post on another server, whose images are the original's to
   * describe (its preview says how many).
   */
  images?: StoredImage[];
  aiGenerated: boolean;
  /**
   * Whether the post takes comments, which its publisher says at /store. Absent: it doesn't. The
   * comments themselves are objects of their own (see CommentStore), and stay when this is turned off.
   */
  comments?: boolean;
  /**
   * The post's title: one line of plain text, MAX_TITLE_CHARS at most, which its publisher gave
   * it at /store. Absent on a post that has none. On a repost of a post on another server it is
   * the original's, as its server attested it. It is kept whatever POST_TITLES says, and shown
   * only where titles are on (see shownTitle).
   */
  title?: string;
  /** As written; read it with previewOf, which links a file to where its bytes are read. */
  preview: Preview;
  /** The whole text of a text post, or an image's, video's or audio's caption. */
  text?: string;
  /**
   * The users `text` mentions, each with the name it has them by, in the order it first names
   * them: found when the text was written (see resolveMentions), and what the text, and its
   * preview, are read with (src/format.ts). Absent on a post that mentions nobody, and on a
   * repost of a post on another server, whose users aren't this server's.
   */
  mentions?: Mention[];
  /**
   * The content's hashtags: the ones its publisher gave it and, once the compactor has written them
   * in, the ones reposts gave it (see `reposts` in the database, which says which those are).
   */
  tags: string[];
  /** When the content was last written: posted, updated, reposted, or a hashtag removed from it. UTC epoch milliseconds. */
  updatedAt: number;
  /**
   * On a repost of a post that is on another server: the original. The content is then a link to
   * it with its summary: `preview`, `mimeType` and `aiGenerated` are the original's, as its
   * own server attested them when it was reposted, and the content's bytes are the original's address.
   */
  origin?: Origin;
  /**
   * With `origin`: when the original's server signed the attestation this summary is from, by
   * that server's clock, in UTC epoch milliseconds. A later attestation replaces the summary, and
   * one that is no later doesn't (POST /repost/refresh). Absent on an entry made before
   * attestations said when, which any attestation is later than.
   */
  originAttestedAt?: number;
}

/** One image of an image post of several, as its meta file describes it (see ContentMeta.images). */
export interface StoredImage {
  /** Which image it is, read from its bytes. */
  mimeType: string;
  /** Of its bytes, as stored. */
  size: number;
  /** The SHA-256 of its bytes as stored, in hex: what an update's image in its place is compared by. */
  sha256?: string;
}

/** The original of a repost of a post on another server: where it is read, and who published it there. */
export interface Origin {
  /** The original's address on its own server: https://other.example/content/<id>. Its bytes are read at this address + /raw. */
  url: string;
  /** Its publisher there, whom this server has no account of. */
  publisher: { userId: string; username: string };
}

/**
 * A post as feeds show it; its kind is the post's type (src/posts.ts). Text is cut to the first
 * FEED_PREVIEW_WORDS words; an image's, video's or audio's URL links to its bytes.
 *
 * `imageCount` is on an image post of more than one image, and says how many it has. `url` is
 * then the first, and each is read at `url` followed by its place among them, counted from 1
 * (see imageUrl): the second at `<url>/2`.
 *
 * `alt` is on an image post whose publisher described its images for those who can't see them:
 * the alternative text of each image, in the order of the images, '' for one that has none.
 * Absent where none has any.
 *
 * `video` is on a video post whose video the server has processed (compactor/src/video): what it is, and
 * where its poster image and its adaptive stream are read. `url` is then an MP4 that plays
 * anywhere. Absent on a video stored as it was sent: by a server that processes none, or before
 * this one did.
 */
export type Preview =
  | { kind: 'text'; text: string }
  | { kind: 'image' | 'video' | 'audio'; url: string; text?: string; imageCount?: number; alt?: string[]; video?: PreviewVideo }
  | { kind: 'link'; url: string };

/**
 * What a meta file and a summary keep of a video the server has processed (see Preview.video):
 * enough to lay out a player before anything of the video is read, and to find its files.
 */
export interface StoredVideo {
  /**
   * The id of this version of the video: its poster and the files of its stream are kept under
   * it (see ContentStore), and read at addresses that have it. An update with another video has
   * another id, so nothing a reader holds of the one before is ever mixed with it.
   */
  id: string;
  /** Of the picture as it is shown, in pixels: turned upright where the camera said it was held sideways. */
  width: number;
  height: number;
  /** In seconds. */
  duration: number;
}

/** A processed video as a preview gives it: what is stored of it, and the addresses built from that when it is read. */
export interface PreviewVideo extends StoredVideo {
  /** A JPEG of a frame near its start, to show before it plays. */
  poster: string;
  /** Its HLS master playlist: the video at several sizes, of which a player takes the one its connection carries. */
  hls: string;
}

/** How a client sends a file straight to the store: the request to make, with these headers and the file as its body. */
export interface UploadLink {
  method: string;
  url: string;
  headers: Record<string, string>;
}

/** A piece of content's bytes as the store holds them. */
export interface StoredBytes {
  size: number;
}

/**
 * The file a write came with, staged for the compactor (see stagedKey): where it waits, and its
 * size as stored there, which is the size the post's meta file, or the comment, then records.
 */
export interface StagedBytes extends StoredBytes {
  key: string;
}
