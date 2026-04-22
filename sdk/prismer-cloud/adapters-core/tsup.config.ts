import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  noExternal: ['@prismer/wire'],
  dts: true,
  clean: true,
  sourcemap: false,
});
