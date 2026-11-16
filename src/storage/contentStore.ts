import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Operator } from 'opendal';
import type { Config } from '../config.js';
import { createOperator, isNotFound } from './opendal.js';

/** What /content needs about one version without touching the database. */
export interface ContentMeta {
  contentId: string;
  version: number;
  mimeType: string;
  filename: string | null;
  size: number;
  sha256: string;
  /** Absent from meta files written before the AI flag existed, which counts as false. */
  aiGenerated?: boolean;
  /** As written; read it with previewOf, which reads previews written before post types too. */
  preview: Preview;
  /** The whole text of a text post, or an image's, video's or audio's caption. Absent on federated content, which only has its preview. */
  text?: string;
  tags: string[];
  createdAt: string;
  /** Federated content only; it has no bytes here. */
  origin?: Origin;
}

/**
 * A post as feeds show it; its kind is the post's type (src/posts.ts). Text is cut to the first
 * FEED_PREVIEW_WORDS words; an image's, video's or audio's URL links to its bytes.
 */
export type Preview =
  | { kind: 'text'; text: string }
  | { kind: 'image' | 'video' | 'audio'; url: string; text?: string }
  | { kind: 'link'; url: string };

/** Where federated content lives: the base URL of the server it was stored on, and its id and version there. */
export interface Origin {
  server: string;
  contentId: string;
  version: number;
}

export const contentKey = (contentId: string, version: number) => `content/${contentId}/${version}`;
const metaKey = (contentId: string, version: number) => `content/${contentId}/${version}.meta.json`;

/**
 * Uploaded bytes and per-version metadata, on any Apache OpenDAL backend
 * (fs, s3, gcs, azblob, sftp, webdav, gdrive, onedrive, dropbox, hdfs, ...).
 */
export class ContentStore {
  private readonly op: Operator;
  private readonly signedUrlSeconds: number;
  private presignSupported = true;

  constructor(cfg: Config['storage']['content']) {
    this.op = createOperator(cfg.scheme, cfg.options);
    this.signedUrlSeconds = cfg.signedUrlSeconds;
  }

  async putFile(contentId: string, version: number, localPath: string, mimeType: string): Promise<void> {
    const writer = await this.op.writer(contentKey(contentId, version), { contentType: mimeType });
    await pipeline(createReadStream(localPath), writer.createWriteStream());
  }

  async putMeta(meta: ContentMeta): Promise<void> {
    await this.op.write(metaKey(meta.contentId, meta.version), JSON.stringify(meta), { contentType: 'application/json' });
  }

  async getMeta(contentId: string, version: number): Promise<ContentMeta | null> {
    try {
      return JSON.parse((await this.op.read(metaKey(contentId, version))).toString('utf8')) as ContentMeta;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async stream(contentId: string, version: number): Promise<Readable> {
    return (await this.op.reader(contentKey(contentId, version))).createReadStream();
  }

  /** Copies a version's bytes to another version, within the backend where it can (S3's limit is 5 GB), else through this process. */
  async copy(contentId: string, from: number, to: number, mimeType: string): Promise<void> {
    if (this.op.capability().copy) {
      try {
        return await this.op.copy(contentKey(contentId, from), contentKey(contentId, to));
      } catch {}
    }
    const writer = await this.op.writer(contentKey(contentId, to), { contentType: mimeType });
    await pipeline(await this.stream(contentId, from), writer.createWriteStream());
  }

  async remove(contentId: string, version: number): Promise<void> {
    await Promise.all([
      this.op.delete(contentKey(contentId, version)).catch(() => {}),
      this.op.delete(metaKey(contentId, version)).catch(() => {}),
    ]);
  }

  /** A short-lived direct download URL, or null when the backend can't presign (fs, sftp, webdav, ...). */
  async signedUrl(contentId: string, version: number): Promise<string | null> {
    if (!this.presignSupported) return null;
    if (!this.op.capability().presignRead) {
      this.presignSupported = false;
      return null;
    }
    try {
      return (await this.op.presignRead(contentKey(contentId, version), this.signedUrlSeconds)).url;
    } catch {
      this.presignSupported = false;
      return null;
    }
  }
}
