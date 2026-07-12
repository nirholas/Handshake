import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'react/index': 'src/react/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  target: 'node20',
  // Keep peers external so core installs light and optional deps stay optional.
  external: ['viem', 'ws', 'hoodchain', 'better-sqlite3', 'react', 'react/jsx-runtime'],
})
