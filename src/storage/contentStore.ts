import { createReadStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Operator } from 'opendal';
import type { Config } from '../config.js';
import { commentMediaKey } from './commentStore.js';
import { createOperator, isNotFound, readObject, streamObject } from './opendal.js';
import { UploadTooLargeError } from './spool.js';

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
   * it with its summary: `preview`, `mimeType` and `aiGenerated` are the original's, as the
   * reposter's client sent them, and the content's bytes are the original's address.
   */
  origin?: Origin;
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

export const contentKey = (contentId: string) => `content/${contentId}`;
const metaKey = (contentId: string) => `content/${contentId}.meta.json`;
/**
 * Where a client puts a file itself, with the link POST /uploads gives, before /store makes it a
 * post's. Under the user's id, so nobody stores another user's upload. The bucket should expire
 * what is left under `uploads/` after a day: uploads never stored, or stored by a request that failed.
 */
export const uploadKey = (userId: string, uploadId: string) => `uploads/${userId}/${uploadId}`;

/** Where the image of an image ad is kept (src/monetization.ts): apart from posts, as an ad is no post. */
export const adImageKey = (adId: string) => `ads/${adId}`;

/**
 * Whose bytes a file in the store is: a post's, named by the post's id, those of the image or
 * video a comment came with, named by the comment and the post it is on, or the image of an ad,
 * named by the ad. They are written, read and linked to the same way; only where they are kept
 * differs.
 */
export type BytesOwner = string | { postId: string; commentId: string } | { adId: string };
const bytesKey = (of: BytesOwner) =>
  typeof of === 'string' ? contentKey(of) : 'adId' in of ? adImageKey(of.adId) : commentMediaKey(of.postId, of.commentId);

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
 * Uploaded bytes and the meta file of each piece of content, the bytes of the images and videos
 * that comments come with, and the images of ads, on any Apache OpenDAL backend (fs, s3, gcs,
 * azblob, sftp, webdav, gdrive, onedrive, dropbox, hdfs, ...).
 */
export class ContentStore {
  private readonly op: Operator;
  private readonly signedUrlSeconds: number;
  private presignSupported = true;
  private presignWriteSupported = true;

  constructor(cfg: Config['storage']['content']) {
    this.op = createOperator(cfg.scheme, cfg.options);
    this.signedUrlSeconds = cfg.signedUrlSeconds;
  }

  async putFile(of: BytesOwner, localPath: string, mimeType: string): Promise<void> {
    const writer = await this.op.writer(bytesKey(of), { contentType: mimeType });
    await pipeline(createReadStream(localPath), writer.createWriteStream());
  }

  async putMeta(meta: ContentMeta): Promise<void> {
    await this.op.write(metaKey(meta.contentId), JSON.stringify(meta), { contentType: 'application/json' });
  }

  async getMeta(contentId: string): Promise<ContentMeta | null> {
    const meta = await readObject(this.op, metaKey(contentId));
    return meta && (JSON.parse(meta.toString('utf8')) as ContentMeta);
  }

  /** The size of the content's bytes as the store holds them, and their content type where it keeps one (fs doesn't). */
  async stat(of: BytesOwner): Promise<{ size: number; contentType: string | null }> {
    const stat = await this.op.stat(bytesKey(of));
    return { size: Number(stat.contentLength ?? 0), contentType: stat.contentType || null };
  }

  async stream(of: BytesOwner): Promise<Readable> {
    return streamObject(this.op, bytesKey(of));
  }

  async remove(contentId: string): Promise<void> {
    await Promise.all([
      this.op.delete(contentKey(contentId)).catch(() => {}),
      this.op.delete(metaKey(contentId)).catch(() => {}),
    ]);
  }

  /** Deletes the image of an ad. One that isn't there is no error: a text ad has none. */
  async removeAdImage(adId: string): Promise<void> {
    await this.op.delete(adImageKey(adId)).catch(() => {});
  }

  /**
   * A short-lived link to upload a file with, or null when the backend can't presign (fs, sftp,
   * webdav, ...). The link can't hold the client to a size or a content type: adoptUpload checks
   * the one and sets the other.
   */
  async presignUpload(userId: string, uploadId: string, mimeType: string): Promise<UploadLink | null> {
    if (!this.presignWriteSupported) return null;
    // Tried rather than asked of capability(): azblob signs links with an account key yet says it can't.
    try {
      const { method, url, headers } = await this.op.presignWrite(uploadKey(userId, uploadId), this.signedUrlSeconds);
      // The client's HTTP library sets Host itself; browsers refuse to be told.
      const sent = Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'host'));
      return { method, url, headers: { ...sent, 'content-type': mimeType } };
    } catch {
      this.presignWriteSupported = false;
      return null;
    }
  }

  /** An upload's size and the content type it was sent with (null where the backend keeps none), or null if there is none. */
  async statUpload(userId: string, uploadId: string): Promise<{ size: number; contentType: string | null } | null> {
    try {
      const stat = await this.op.stat(uploadKey(userId, uploadId));
      return { size: Number(stat.contentLength ?? 0), contentType: stat.contentType || null };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /**
   * Makes an upload a piece of content's bytes, over the ones it had, or the image or video of a
   * comment, and returns their size as stored. Copied within the backend where it can and the
   * upload was sent with the content's type, else through this process. Throws UploadTooLargeError
   * if the bytes are more than `maxBytes`.
   *
   * Whoever holds the upload link can replace the upload until the link expires, so its size is
   * checked again here, before anything is written, and once more on the copy, where no client can
   * write. A copy that turns out too large is deleted: only a client that swapped its upload for a
   * larger one in that moment gets there, and what it loses is the bytes of its own post.
   */
  async adoptUpload(userId: string, uploadId: string, of: BytesOwner, mimeType: string, maxBytes: number): Promise<StoredBytes> {
    const from = uploadKey(userId, uploadId);
    const to = bytesKey(of);
    const upload = await this.op.stat(from);
    if (Number(upload.contentLength ?? 0) > maxBytes) throw new UploadTooLargeError(maxBytes);
    const sent = upload.contentType || null;
    try {
      if (this.op.capability().copy && (sent === null || sent === mimeType)) {
        const copied = await this.op.copy(from, to).then(
          () => true,
          () => false,
        );
        if (copied) {
          const size = Number((await this.op.stat(to)).contentLength ?? 0);
          if (size > maxBytes) throw new UploadTooLargeError(maxBytes);
          return { size };
        }
      }
      const writer = await this.op.writer(to, { contentType: mimeType });
      return await this.measure(from, maxBytes, writer.createWriteStream());
    } catch (err) {
      if (err instanceof UploadTooLargeError) await this.op.delete(to).catch(() => {});
      throw err;
    }
  }

  /** The first `bytes` bytes of an upload, which must be that long. */
  async uploadHead(userId: string, uploadId: string, bytes: number): Promise<Buffer> {
    return this.op.read(uploadKey(userId, uploadId), { offset: 0n, size: BigInt(bytes) });
  }

  /**
   * An upload's bytes, for a caller that makes them a piece of content's itself (an image's are
   * stored without their metadata; see stripImage). The stream fails with UploadTooLargeError once
   * it is past `maxBytes`: whoever holds the upload link can replace the upload at any time.
   */
  async streamUpload(userId: string, uploadId: string, maxBytes: number): Promise<Readable> {
    const source = await streamObject(this.op, uploadKey(userId, uploadId));
    let size = 0;
    return Readable.from(
      (async function* () {
        try {
          for await (const chunk of source as AsyncIterable<Buffer>) {
            size += chunk.length;
            if (size > maxBytes) throw new UploadTooLargeError(maxBytes);
            yield chunk;
          }
        } finally {
          source.destroy();
        }
      })(),
    );
  }

  async removeUpload(userId: string, uploadId: string): Promise<void> {
    await this.op.delete(uploadKey(userId, uploadId)).catch(() => {});
  }

  /** Copies an object to `into`, counting its bytes on the way. */
  private async measure(key: string, maxBytes: number, into: NodeJS.WritableStream): Promise<StoredBytes> {
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) return cb(new UploadTooLargeError(maxBytes));
        cb(null, chunk);
      },
    });
    await pipeline(await streamObject(this.op, key), meter, into);
    return { size };
  }

  /** A short-lived direct download URL, or null when the backend can't presign (fs, sftp, webdav, ...). */
  async signedUrl(of: BytesOwner): Promise<string | null> {
    if (!this.presignSupported) return null;
    if (!this.op.capability().presignRead) {
      this.presignSupported = false;
      return null;
    }
    try {
      return (await this.op.presignRead(bytesKey(of), this.signedUrlSeconds)).url;
    } catch {
      this.presignSupported = false;
      return null;
    }
  }
}
