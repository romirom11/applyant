import { defineConfig } from 'vitest/config';

// Live tests call the real agent CLIs on this machine's subscriptions. They only run with
// APPLYANT_LIVE=1, one file at a time, e.g. `APPLYANT_LIVE=1 pnpm test:live -t extractor`.
export default defineConfig({
  test: {
    include: ['test/live/**/*.live.test.ts'],
    testTimeout: 15 * 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    fileParallelism: false,
  },
});
