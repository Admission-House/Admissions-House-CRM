import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.spec.ts'],
    env: { NODE_ENV: 'test' },
    // One worker per processor (8 here) loads the whole application eight times at once and fills a small machine's memory.
    maxWorkers: 3,
  },
});
