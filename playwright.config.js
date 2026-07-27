import { defineConfig } from '@playwright/test';

// Playwright config for the /club smoke. Drives a real Chromium against the
// Vite dev server. Kept separate from Vitest (which only globs *.test.js) by
// using the `.spec.js` suffix in `tests/e2e/`.
//
// Cold-start budget: a fresh Vite dev server needs ~30s to come up and the
// first /club hit then transforms the full three.js module graph (~30–60s
// on a CI box). The first test sets a 180s test timeout; we mirror that on
// the webServer health check so playwright doesn't kill the server before
// the cold transform finishes and bring down the next two tests with it.
export default defineConfig({
	testDir: 'tests/e2e',
	// 300s, not 120s: the a11y floor spec runs axe over every top-30 page, and
	// axe's colour-contrast pass is O(rendered nodes). /marketplace renders a
	// ~77-card grid and legitimately takes ~4.3 min against the dev server
	// (on-demand module transforms), so 120s timed it out as a phantom failure.
	timeout: 300_000,
	retries: 1,
	fullyParallel: false,
	use: {
		baseURL: 'http://localhost:3000',
		headless: true,
		screenshot: 'only-on-failure',
		video: 'retain-on-failure',
		trace: 'retain-on-failure',
	},
	webServer: {
		command: 'npm run dev',
		url: 'http://localhost:3000',
		timeout: 180_000,
		reuseExistingServer: !process.env.CI,
		stdout: 'pipe',
		stderr: 'pipe',
	},
});
