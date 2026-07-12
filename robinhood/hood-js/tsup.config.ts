import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  minify: true,
  treeshake: true,
  sourcemap: true,
  // Hoist the default export onto module.exports so `require('hood-js')` yields
  // the `hood` facade directly (named type exports still ride along).
  cjsInterop: true,
  // viem is a peer dependency and hoodchain is a runtime dependency; keeping
  // both external is what holds hood-js's own bundle under the size budget.
  external: ['viem', 'hoodchain'],
})
