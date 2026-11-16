import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { SpooledFile } from './spool.types.js';

export class UploadTooLargeError extends Error {
  /** `limit`: the most bytes an upload may be, which the response names in the request's language (http/errors.ts). */
  constructor(public readonly limit: number) {
    super(`Upload exceeds the maximum size of ${limit} bytes`);
  }
}

/** Streams an upload to a local temp file, enforcing a size limit. */
export async function spoolToTemp(
  body: Readable,
  tmpDir: string = join(tmpdir(), 'evieverse'),
  maxBytes = Number.MAX_SAFE_INTEGER,
): Promise<SpooledFile> {
  await mkdir(tmpDir, { recursive: true });
  const path = join(tmpDir, `upload-${randomUUID()}`);
  const cleanup = () => rm(path, { force: true });
  let size = 0;
  try {
    await pipeline(
      body,
      new Transform({
        transform(chunk: Buffer, _enc, cb) {
          size += chunk.length;
          if (size > maxBytes) return cb(new UploadTooLargeError(maxBytes));
          cb(null, chunk);
        },
      }),
      createWriteStream(path),
    );
  } catch (err) {
    await cleanup();
    // @fastify/multipart truncates instead of erroring when its own limit is hit.
    if ((body as { truncated?: boolean }).truncated) throw new UploadTooLargeError(maxBytes);
    throw err;
  }
  if ((body as { truncated?: boolean }).truncated) {
    await cleanup();
    throw new UploadTooLargeError(maxBytes);
  }
  return { path, size, cleanup };
}

/** The SHA-256 of a file's bytes, in hex. */
export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
