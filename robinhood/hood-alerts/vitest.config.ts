import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // tests/live is opt-in (real network); `npm test` excludes it via its own
    // CLI --exclude, and `npm run test:live` targets it directly.
    exclude: ['node_modules/**'],
    testTimeout: 20_000,
  },
})
