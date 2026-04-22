import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts', 'src/webhook.ts'],
    format: ['cjs', 'esm'],
    dts: true,
  },
  {
    // cli.ts is a library module (no longer a bin) — emits CJS + dts so the
    // runtime package can `require('@prismer/sdk/cli').registerSdkCliCommands`.
    // Runtime's bundle is CJS so ESM is skipped to avoid interop surprises.
    entry: ['src/cli.ts'],
    format: ['cjs'],
    dts: true,
  },
]);
