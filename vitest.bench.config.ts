import { defineConfig } from 'vitest/config';

/**
 * The benchmark (`npm run bench`), which writes BENCHMARKS.md. It has a configuration of its own
 * so that `npm test`, which runs the files of vitest.config.ts, never runs it. `npm run bench`
 * runs it in Docker (bench/run.mjs), where the server it measures is: run from here, it stops
 * at once and says so.
 */
export default defineConfig({
  test: {
    include: ['bench/**/*.test.ts'],
    // A run is as long as its loads: minutes, and more with a longer BENCH_DURATION_SECONDS.
    testTimeout: 60 * 60_000,
    // It says what it is doing as it does it.
    disableConsoleIntercept: true,
  },
});
