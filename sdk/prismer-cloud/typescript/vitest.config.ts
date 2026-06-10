import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
  },
});
