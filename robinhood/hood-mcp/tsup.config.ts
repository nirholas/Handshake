import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'data-server': 'src/data-server.ts',
    'trading-server': 'src/trading-server.ts',
  },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  dts: { entry: { index: 'src/index.ts' } },
  sourcemap: true,
  clean: true,
  splitting: false,
  // The two server entries are executables — prepend a shebang so they run
  // directly via `npx hood-mcp` without a wrapper.
  banner: ({ format }) => (format === 'esm' ? { js: '#!/usr/bin/env node' } : {}),
})
