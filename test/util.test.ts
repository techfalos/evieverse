import { describe, expect, it } from 'vitest';
import { allDone, mapLimit } from '../src/util.js';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('running several things at once', () => {
  it('mapLimit runs so many at a time, over every item', async () => {
    let running = 0;
    let most = 0;
    const done: number[] = [];
    await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      most = Math.max(most, ++running);
      await wait(5);
      running--;
      done.push(n);
    });
    expect(most).toBe(3);
    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('mapLimit waits for what is under way before it throws the first failure, and starts nothing more', async () => {
    const started: number[] = [];
    const ended: number[] = [];
    let thrown = false;
    const run = mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      started.push(n);
      if (n === 1) {
        await wait(10);
        throw new Error('the first failed');
      }
      await wait(60);
      ended.push(n);
    }).catch((err: unknown) => {
      thrown = true;
      return err;
    });

    // The first has failed, and the second is still under way: nothing is thrown yet.
    await wait(30);
    expect([thrown, started, ended]).toEqual([false, [1, 2], []]);
    expect(await run).toEqual(new Error('the first failed'));
    expect([started, ended]).toEqual([[1, 2], [2]]);
  });

  it('allDone waits for every task before it throws the first failure among them', async () => {
    const ended: string[] = [];
    const slow = wait(40).then(() => ended.push('slow'));
    const failing = wait(5).then(() => Promise.reject(new Error('one failed')));
    const failingLater = wait(20).then(() => Promise.reject(new Error('another failed')));
    await expect(allDone([slow, failing, failingLater])).rejects.toThrow('one failed');
    expect(ended).toEqual(['slow']);
    await expect(allDone([wait(1), wait(2)])).resolves.toBeUndefined();
  });
});
