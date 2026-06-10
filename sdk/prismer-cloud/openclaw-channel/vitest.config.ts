import { defineConfig } from 'vitest/config';

// Local config so this package's tests under tests/ are picked up.
// Without it, vitest inherits the project-root config whose include pattern
// (src/lib/__tests__/**) doesn't match anything in openclaw-channel.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
  },
});
