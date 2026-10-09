import { defineConfig } from 'vitest/config';

// the lane and resilience tests each run a mock exchange and child processes; one file at a time keeps them honest
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 300_000,
    include: ['test/**/*.test.ts'],
  },
});
