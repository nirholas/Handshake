import { defineConfig } from 'tsup'

export default defineConfig([
  // npm entry points: core (framework-free), react, wagmi
  {
    entry: {
      index: 'src/index.ts',
      'react/index': 'src/react/index.ts',
      'wagmi/index': 'src/wagmi/index.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    external: ['react', 'wagmi', 'viem', 'hoodchain'],
  },
  // Browser bundle for the docs site (GitHub Pages has no bundler).
  // Everything is inlined; `ws` stays external because the hoodchain feed
  // module (unused here) is the only place that touches it and it is
  // tree-shaken out of this bundle.
  {
    entry: { 'hood-connect': 'src/docs-entry.ts' },
    format: ['iife'],
    globalName: 'HoodConnect',
    platform: 'browser',
    sourcemap: false,
    minify: true,
    outDir: 'dist/docs',
    noExternal: [/.*/],
    external: ['ws'],
  },
])
