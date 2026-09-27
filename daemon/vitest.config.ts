import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Live tests spend subscription quota: `pnpm test:live` (vitest.live.config.ts).
    exclude: ['test/live/**', '**/node_modules/**'],
    // Browser and daemon tests launch real processes.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
});
