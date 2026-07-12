import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: false,
  // Ship a single self-contained CLI file so `npm i -g` needs no runtime
  // resolution of the sibling SDK; viem/ws/commander stay external (installed
  // as dependencies).
  noExternal: ['hoodchain'],
  external: ['viem', 'ws', 'commander'],
  banner: { js: '#!/usr/bin/env node' },
})
