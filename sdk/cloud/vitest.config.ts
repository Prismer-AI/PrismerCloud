import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@prismer/aip-sdk': resolve(__dirname, '../aip/typescript/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'test/**/*.test.ts'],
    // Default package tests are hermetic. Live suites have credentials/server
    // prerequisites and standalone scripts own process.exit; collecting any of
    // them here makes `npm test` either environment-dependent or runner-invalid.
    exclude: [
      'node_modules',
      'dist',
      'tests/integration.test.ts',
      'tests/integration/**/*.test.ts',
      'test/v193-integration.test.ts',
      'test/sdk-integration.test.ts',
    ],
  },
});
