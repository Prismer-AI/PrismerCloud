import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration.test.ts', 'tests/integration/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
  },
});
