import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    typecheck: {
      enabled: true,
      include: ['tests/**/*.test-d.ts'],
    },
  },
})
