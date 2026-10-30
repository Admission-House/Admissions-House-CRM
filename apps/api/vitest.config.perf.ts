import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => ({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['test/perf/**/*.perf-spec.ts'],
    // .env holds the local database settings these tests need.
    env: { ...loadEnv(mode, process.cwd(), ''), NODE_ENV: 'test', LOG_LEVEL: 'silent', SWEEP_INTERVAL_SEC: '0', INTAKE_RETRY_INTERVAL_SEC: '0', FOLLOWUP_REMINDER_INTERVAL_SEC: '0', IMPORT_INTERVAL_SEC: '0', RECORDING_INTERVAL_SEC: '0', RECORDING_ALLOW_INSECURE: 'true', STORAGE_DIR: './.tmp-storage' },
    // These tests use the real database, so they run one file at a time.
    fileParallelism: false,
    disableConsoleIntercept: true,
    testTimeout: 600_000,
    hookTimeout: 30_000,
  },
}));
