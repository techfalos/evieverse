import type { ImageType } from './image.js';
import type { PostType } from './posts.js';
import type { BytesOwner, ContentStore, StagedBytes, StoredBytes } from './storage/index.js';

/** Where uploads are spooled (the system's temp directory if not set), and how large one can be. */
export interface UploadLimits {
  tmpPath?: string;
  maxUploadBytes: number;
}

/**
 * A post's bytes, wherever they wait to be stored: in a temp file here, or in the content store,
 * where the client put them with a link from POST /uploads.
 */
export interface PostBytes {
  /** In bytes. Of bytes in the content store, as last seen: `stage` and `place` return what was stored. */
  size: number;
  /**
   * For an image post: which image the bytes are, read from the bytes themselves, and the bytes to
   * store, which are the image without its metadata (see stripImage). 400 if they aren't an image
   * the server takes. These bytes are then released by the ones returned.
   */
  image(): Promise<{ type: ImageType; file: PostBytes }>;
  /**
   * The SHA-256, in hex, of the bytes `stage` stores: what a post's meta file keeps of its file, and
   * what says a file sent as an update is the one the content has. Null for a video or audio file
   * sent with an upload link: it is copied within the content store where that can be, not stored
   * from a file here, and reading it to hash it would bring it through this process.
   */
  hash(): Promise<string | null>;
  /**
   * The path of the temp file here that holds the bytes `stage` stores, for what reads them before
   * they are stored: a trust plugin that looks at an image (see trustImage), and what makes an
   * avatar of one (standardAvatar in src/profile.ts). An image sent with
   * an upload link is fetched to one when this is first asked for, as `hash` fetches it. Null for
   * bytes that never come through this process: a video or audio file sent with an upload link.
   */
  local(): Promise<string | null>;
  /**
   * Writes the bytes as `of`'s, over the ones it had, and returns their size as stored. For what
   * no compactor writes, which is an ad's image and a profile's splash image: a post's file and
   * a comment's are staged.
   */
  place(content: ContentStore, of: BytesOwner, mimeType: string): Promise<StoredBytes>;
  /**
   * Stages the bytes for the write `writeId` (see stagedKey), and returns where they wait and
   * their size as stored: the file of a post or of a comment, which the compactor makes theirs
   * once the write is committed. A request that doesn't commit deletes what it staged.
   */
  stage(content: ContentStore, writeId: string, mimeType: string): Promise<StagedBytes>;
  /**
   * Call when the request is over. `stored`: the server now holds the post, so its upload can go.
   * Otherwise an upload in the content store is kept, for the request to be sent again (once
   * the limit on posts a minute has room for it, say); the store expires what nobody comes back for.
   */
  release(stored?: boolean): Promise<void>;
}

/** A request's file: a multipart part spooled to a temp file, or an upload already in the content store. */
export interface Upload {
  file: PostBytes;
  filename: string | null;
  mimeType: string;
}

/** What a request says of its post, beside its files. */
export interface PostFields {
  type: PostType;
  text?: string;
  url?: string;
  /** The alternative text of an image post's one image, which only an image post says. */
  alt?: string;
}

/**
 * One file as a request sends it, with what the request says of it: an upload (a multipart part,
 * or a file put in the content store with a link from POST /uploads), or the file inline in
 * `content`. An image, video or audio post has one; an image post of several images has one for
 * each, in the order of the images.
 */
export interface SentFile {
  upload?: Upload;
  /** The file inline, as `contentEncoding` says; read only where there is no upload. */
  content?: string;
  contentEncoding: 'utf8' | 'base64';
  /** The content type it is sent as, over the upload's own. */
  contentType?: string;
  /** Its name, where the upload has none. */
  filename?: string;
  /** An image's alternative text: what describes it to those who can't see it. Only an image has one. */
  alt?: string;
}

/**
 * A file of a post as it is stored: its bytes, the name it was sent with, and its content type.
 * An image that was sent with an alternative text has it in `alt`, without the spaces around it.
 */
export interface PostFile {
  file: PostBytes;
  filename: string | null;
  mimeType: string;
  alt?: string;
}

/** The image or video a comment comes with, and its bytes; an image with its alternative text, if it was sent with one. */
export interface CommentFile {
  kind: 'image' | 'video';
  file: PostBytes;
  filename: string | null;
  mimeType: string;
  alt?: string;
}
