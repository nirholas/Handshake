import { defineConfig } from 'vitest/config'

// Live tests hit the real Robinhood API and need real credentials.
// They are excluded from `npm test` on purpose.
export default defineConfig({
  test: {
    include: ['tests/**/*.live.test.ts'],
    testTimeout: 120_000,
  },
})
