import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Exclude standalone test runners that use process.exit (not vitest-compatible)
    exclude: [
      'test/sdk-integration.test.ts',
      'node_modules/**',
    ],
  },
});
