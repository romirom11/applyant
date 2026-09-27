import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Browser and daemon tests launch real processes.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
});
