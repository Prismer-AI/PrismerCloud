import { copyFileSync, mkdirSync } from 'node:fs';
import { defineConfig } from 'tsup';

export default defineConfig([
  {
    // environment-contract / environment-stream (eaas-gate-a Task 12) ride the
    // main entry group: plain TS with zero extra dependencies, no bundling or
    // copy hooks needed (unlike the pkf subpath).
    entry: ['src/index.ts', 'src/webhook.ts', 'src/environment-contract.ts', 'src/environment-stream.ts'],
    format: ['cjs', 'esm'],
    dts: true,
  },
  {
    entry: ['src/cli.ts'],
    format: ['cjs'],
    banner: { js: '#!/usr/bin/env node' },
    noExternal: ['@prismer/pkf'],
    // playwright is the OPTIONAL headless-Chromium PDF adapter — resolved at
    // run time (typed error when absent), never bundled.
    external: ['playwright', 'playwright-core', '@prismer/workspace-ui'],
  },
  {
    // product209/15 PKF-D2 — the pkf subpath bundles @prismer/pkf so the
    // tarball is self-contained (no @prismer/pkf import survives in the output).
    entry: ['src/pkf.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    noExternal: ['@prismer/pkf'],
    external: ['@prismer/workspace-ui'],
    onSuccess: async () => {
      mkdirSync('dist', { recursive: true });
      copyFileSync(
        'node_modules/@prismer/pkf/schema/pkf-frontmatter.schema.json',
        'dist/pkf-schema.json',
      );
    },
  },
]);
