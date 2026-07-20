import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'data-server': 'src/data-server.ts',
    'trading-server': 'src/trading-server.ts',
    keygen: 'src/keygen.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  banner: { js: '' },
})
