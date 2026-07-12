import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Live suites are opted into explicitly (test:live / test:swap) so `npm test`
    // stays hermetic and fast.
    exclude: ['**/node_modules/**', '**/*.live.test.ts', 'tests/trading-swap.live.test.ts'],
  },
})
