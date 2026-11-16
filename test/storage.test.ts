import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOperator, isNotFound, readObject, streamObject } from '../src/storage/opendal.js';

const drain = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'evieverse-storage-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// A local store is read by Node and any other through OpenDAL (src/storage/opendal.ts). `memory` is the other here.
describe.each([
  { store: 'a local fs store', operator: () => createOperator('fs', { root: dir }) },
  { store: 'a store of another kind', operator: () => createOperator('memory', {}) },
])('reading objects from $store', ({ operator }) => {
  it('reads what was written, whole, whatever its size', async () => {
    const op = operator();
    // Nothing, a summary's few hundred bytes, and more than a stream gives in one piece.
    for (const size of [0, 310, 300_000]) {
      const bytes = randomBytes(size);
      await op.write(`content/${size}`, bytes);
      expect((await readObject(op, `content/${size}`))?.equals(bytes), `${size} bytes, read`).toBe(true);
      expect((await drain(await streamObject(op, `content/${size}`))).equals(bytes), `${size} bytes, streamed`).toBe(true);
    }
  });

  it('reads the new object once one is written over', async () => {
    const op = operator();
    await op.write('content/a.meta.json', 'short');
    await op.write('content/a.meta.json', 'longer than it was');
    expect((await readObject(op, 'content/a.meta.json'))?.toString()).toBe('longer than it was');
  });

  it('has null for an object that is not there, and a stream of one fails as not found', async () => {
    const op = operator();
    expect(await readObject(op, 'content/none')).toBeNull();
    // OpenDAL may only find out when the stream is read.
    const failure = await streamObject(op, 'content/none').then(drain).then(
      () => null,
      (err: unknown) => err,
    );
    expect(isNotFound(failure)).toBe(true);
  });
});

describe('reading objects from a local fs store', () => {
  it('reads many at once', async () => {
    const op = createOperator('fs', { root: dir });
    const blobs = Array.from({ length: 300 }, () => randomBytes(310));
    await Promise.all(blobs.map((blob, i) => op.write(`summaries/20000/${i}`, blob)));
    const read = await Promise.all(blobs.map((_, i) => readObject(op, `summaries/20000/${i}`)));
    expect(read.every((blob, i) => blob?.equals(blobs[i]!))).toBe(true);
  });

  it('refuses a key that leads out of the store', async () => {
    const op = createOperator('fs', { root: join(dir, 'store') });
    await createOperator('fs', { root: dir }).write('outside', 'not the store\'s');
    await expect(readObject(op, '../outside')).rejects.toThrow('not an object of the store');
    await expect(streamObject(op, '../outside')).rejects.toThrow('not an object of the store');
  });
});
