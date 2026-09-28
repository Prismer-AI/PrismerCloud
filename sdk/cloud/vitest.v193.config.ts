import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/v193-integration.test.ts'],
    exclude: ['node_modules', 'dist'],
  },
});
