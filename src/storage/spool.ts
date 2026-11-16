import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class UploadTooLargeError extends Error {
  constructor(limit: number) {
    super(`Upload exceeds the maximum size of ${limit} bytes`);
  }
}

export interface SpooledFile {
  path: string;
  size: number;
  sha256: string;
  cleanup: () => Promise<void>;
}

/** Streams an upload to a local temp file while hashing it, enforcing a size limit. */
export async function spoolToTemp(
  body: Readable,
  tmpDir: string = join(tmpdir(), 'theuniverse'),
  maxBytes = Number.MAX_SAFE_INTEGER,
): Promise<SpooledFile> {
  await mkdir(tmpDir, { recursive: true });
  const path = join(tmpDir, `upload-${randomUUID()}`);
  const cleanup = () => rm(path, { force: true });
  const hash = createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > maxBytes) return cb(new UploadTooLargeError(maxBytes));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(body, meter, createWriteStream(path));
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
  return { path, size, sha256: hash.digest('hex'), cleanup };
}
