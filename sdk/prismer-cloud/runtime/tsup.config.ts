import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    sourcemap: true,
  },
  {
    entry: ['src/bin/prismer.ts'],
    format: ['cjs'],
    dts: false,
    outDir: 'dist/bin',
    clean: false,
    sourcemap: false,
    banner: { js: '#!/usr/bin/env node' },
  },
]);
