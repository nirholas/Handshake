import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'verify/index': 'src/verify/index.ts',
    'widget/index': 'src/widget/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  platform: 'neutral',
  // `node:sqlite` is imported through an indirect specifier in
  // src/verify/ledger.ts so esbuild cannot strip its `node:` prefix (it has no
  // bare builtin alias). `node:crypto` / `node:events` alias fine bare.
  external: ['viem', 'hoodchain', 'hood-connect', 'node:sqlite', 'node:crypto', 'node:events'],
})
