import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'bin/hood-launch.ts',
    'cli-auto': 'bin/hood-auto.ts',
    'api-server': 'src/api/server.ts',
  },
  format: ['esm', 'cjs'],
  dts: { entry: 'src/index.ts' },
  sourcemap: true,
  clean: true,
  target: 'node20',
  external: ['viem', 'hoodchain', 'zod'],
  banner: { js: '' },
})
