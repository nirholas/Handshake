import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  minify: true,
  treeshake: true,
  sourcemap: true,
  // viem is a peer dependency and hoodchain is a runtime dependency; keeping
  // both external is what holds hood-js's own bundle under the size budget.
  external: ['viem', 'hoodchain'],
})
