import { createReadStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Operator } from 'opendal';
import type { Config } from '../config.js';
import { commentMediaKey } from './commentStore.js';
import type { ContentMeta, StoredBytes, UploadLink } from './contentStore.types.js';
import { createOperator, isNotFound, readObject, streamObject } from './opendal.js';
import { UploadTooLargeError } from './spool.js';

/** Where a post's bytes are kept: an image's, video's or audio's file, a text post's text, or a link's URL. */
export const contentKey = (contentId: string) => `content/${contentId}`;
/** Where a post's meta file is kept (see ContentMeta): beside its bytes, as JSON. */
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
/** Where the bytes of `of` are kept: with the posts', with the comments of the post it is on, or with the ads' images. */
const bytesKey = (of: BytesOwner) =>
  typeof of === 'string' ? contentKey(of) : 'adId' in of ? adImageKey(of.adId) : commentMediaKey(of.postId, of.commentId);

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
      return { method, url, headers: { ...Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'host')), 'content-type': mimeType } };
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
      if (
        this.op.capability().copy &&
        (sent === null || sent === mimeType) &&
        (await this.op.copy(from, to).then(
          () => true,
          () => false,
        ))
      ) {
        const size = Number((await this.op.stat(to)).contentLength ?? 0);
        if (size > maxBytes) throw new UploadTooLargeError(maxBytes);
        return { size };
      }
      return await this.measure(from, maxBytes, (await this.op.writer(to, { contentType: mimeType })).createWriteStream());
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
    await pipeline(
      await streamObject(this.op, key),
      new Transform({
        transform(chunk: Buffer, _enc, cb) {
          size += chunk.length;
          if (size > maxBytes) return cb(new UploadTooLargeError(maxBytes));
          cb(null, chunk);
        },
      }),
      into,
    );
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
