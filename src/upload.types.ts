import type { ImageType } from './image.js';
import type { PostType } from './posts.js';
import type { BytesOwner, ContentStore, StoredBytes } from './storage/index.js';

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
  /** In bytes. Of bytes in the content store, as last seen: `place` returns what was stored. */
  size: number;
  /**
   * For an image post: which image the bytes are, read from the bytes themselves, and the bytes to
   * store, which are the image without its metadata (see stripImage). 400 if they aren't an image
   * the server takes. These bytes are then released by the ones returned.
   */
  image(): Promise<{ type: ImageType; file: PostBytes }>;
  /**
   * The SHA-256, in hex, of the bytes `place` stores: what a post's meta file keeps of its file, and
   * what says a file sent as an update is the one the content has. Null for a video or audio file
   * sent with an upload link: it is copied within the content store where that can be, not stored
   * from a file here, and reading it to hash it would bring it through this process.
   */
  hash(): Promise<string | null>;
  /** Writes the bytes as the content's, over the ones it had, or as a comment's image or video, and returns their size as stored. */
  place(content: ContentStore, of: BytesOwner, mimeType: string): Promise<StoredBytes>;
  /**
   * Call when the request is over. `stored`: the server now holds the post, so its upload can go.
   * Otherwise an upload in the content store is kept, for the request to be sent again (with a
   * challenge solved, say); the store expires what nobody comes back for.
   */
  release(stored?: boolean): Promise<void>;
}

/** A request's file: a multipart part spooled to a temp file, or an upload already in the content store. */
export interface Upload {
  file: PostBytes;
  filename: string | null;
  mimeType: string;
}

/** What a request says of its post, beside an uploaded file. */
export interface PostFields {
  type: PostType;
  text?: string;
  url?: string;
  /** An image's, video's or audio's file, inline. */
  content?: string;
  contentEncoding: 'utf8' | 'base64';
  contentType?: string;
  filename?: string;
}

/** The image or video a comment comes with, and its bytes. */
export interface CommentFile {
  kind: 'image' | 'video';
  file: PostBytes;
  filename: string | null;
  mimeType: string;
}
