import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/bin/prismer.ts',
  },
  format: ['esm', 'cjs'],
  // product209/15 PKF-D2: the staged @prismer/pkf is BUNDLED so the
  // published tarball never carries an unresolved package import. The staged
  // copy in node_modules is populated by the prebuild (stage-pkf-core.cjs).
  noExternal: ['@prismer/pkf'],
  // Type defs only for the library entry — CLI consumers don't import its types.
  dts: { entry: 'src/index.ts' },
  clean: true,
  // Disabled for published tarballs — sourcemaps balloon package size and
  // leak project-relative source paths. Re-enable locally via `tsup --sourcemap`
  // if you need to debug a release build.
  sourcemap: false,
  target: 'node22',
  // ESM chunks keep turn probes from loading unrelated CLI dependencies.
  // Runtime bundles ship the complete dist directory, including these chunks.
  splitting: true,
  outDir: 'dist',
  // Native module: better-sqlite3 ships .node binaries per platform; require it
  // from node_modules at runtime, never bundle.
  external: ['better-sqlite3', 'ioredis', 'mysql2', 'mysql2/promise'],
});
