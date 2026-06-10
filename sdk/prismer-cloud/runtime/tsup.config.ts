import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/bin/prismer.ts',
  },
  format: ['esm', 'cjs'],
  // Type defs only for the library entry — CLI consumers don't import its types.
  dts: { entry: 'src/index.ts' },
  clean: true,
  // Disabled for published tarballs — sourcemaps balloon package size and
  // leak project-relative source paths. Re-enable locally via `tsup --sourcemap`
  // if you need to debug a release build.
  sourcemap: false,
  target: 'node20',
  splitting: false,
  outDir: 'dist',
  // Native module: better-sqlite3 ships .node binaries per platform; require it
  // from node_modules at runtime, never bundle.
  external: ['better-sqlite3'],
});
