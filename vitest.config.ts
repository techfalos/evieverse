import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Builds the compactor's binary, which the tests run.
    globalSetup: ['test/globalSetup.ts'],
    testTimeout: 20000,
  },
});
