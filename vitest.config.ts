import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['test/setup/no-network.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Silence Citepath's stderr logger in tests unless a test opts in.
    env: { CITEPATH_LOG_LEVEL: 'silent' },
  },
});
