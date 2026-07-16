import { defineConfig } from '@playwright/test'

/**
 * Real-browser E2E: Chromium with the real MetaMask extension (installed and
 * onboarded by dappwright), driving the demo app against live mainnet 4663
 * reads. Extensions require a headed browser; on machines without a display
 * run `xvfb-run -a npm run test:e2e`. The demo must be built first
 * (`npm --prefix examples/demo run build`); the preview server starts
 * automatically below.
 */
export default defineConfig({
  testDir: '.',
  timeout: 240_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: '../test-results',
  webServer: {
    command: 'npm --prefix ../examples/demo run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
