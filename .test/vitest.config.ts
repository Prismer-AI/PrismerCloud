import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    globals: true,
    reporters: ['verbose'],
  },
  resolve: {
    alias: {
      '@prismer/sdk': path.resolve(__dirname, '../sdk/prismer-cloud/typescript/src/index'),
      '@prismer/aip-sdk': path.resolve(__dirname, '../sdk/aip/typescript/src/index'),
    },
  },
});
