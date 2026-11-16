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
  preview: Preview;
  tags: string[];
  createdAt: string;
  /** Federated content only; it has no bytes here. */
  origin?: Origin;
}

export type Preview = { kind: 'text'; text: string } | { kind: 'media'; url: string };

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
