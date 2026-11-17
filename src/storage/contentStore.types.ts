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
   */
  sha256?: string;
  aiGenerated: boolean;
  /**
   * Whether the post takes comments, which its publisher says at /store. Absent: it doesn't. The
   * comments themselves are objects of their own (see CommentStore), and stay when this is turned off.
   */
  comments?: boolean;
  /** As written; read it with previewOf, which links a file to where its bytes are read. */
  preview: Preview;
  /** The whole text of a text post, or an image's, video's or audio's caption. */
  text?: string;
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
 */
export type Preview =
  | { kind: 'text'; text: string }
  | { kind: 'image' | 'video' | 'audio'; url: string; text?: string }
  | { kind: 'link'; url: string };

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
