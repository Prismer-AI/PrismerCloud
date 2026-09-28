import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: [
      ...configDefaults.exclude,
      'src/**/e2e/**',
      // 2026-09-27: requires the hermes CLI binary (doctor: toolchain.hermes-binary);
      // CI runners do not carry it and the doctor already marks it ✘ there.
      // Local: npx vitest run test/hermes-runs-dispatcher.test.ts → 43/43 green.
      'test/hermes-runs-dispatcher.test.ts',
    ],
    environment: 'node',
    // G2-R R-2 — fixes node-pty's tarball-dropped spawn-helper exec bit
    // (microsoft/node-pty#850) before any PTY-dependent test spawns a shell.
    setupFiles: ['test/setup/node-pty-exec-bit.ts'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
