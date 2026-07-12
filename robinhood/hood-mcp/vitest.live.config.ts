import { defineConfig } from 'vitest/config'

/** Config for the opt-in live suites (test:live, test:swap) — no exclusions. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
