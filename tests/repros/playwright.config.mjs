import { defineConfig } from '@playwright/test';

// Playwright config for compiled reproductions.
//
// Repros live outside the main `tests/e2e` suite on purpose. A reproduction is
// RED by definition until its bug is fixed, so folding them into the default run
// would mean `npm test` fails for every open bug report. That is a defensible
// policy for a team that wants it, and a terrible default for everyone else, so
// they get their own config and their own command:
//
//   npx playwright test -c tests/repros/playwright.config.mjs
//   npm run feedback:repro -- <report-id> --run
//
// Each spec carries its own absolute goto URL (the compiler bakes in the origin
// the replay was requested for), so no baseURL and no webServer are configured
// here: point a repro anywhere by passing --base to the CLI.
export default defineConfig({
	testDir: '.',
	timeout: 60_000,
	// A repro is evidence, not a flaky check. Retrying would blur exactly the
	// signal it exists to give.
	retries: 0,
	fullyParallel: false,
	use: {
		headless: true,
		screenshot: 'only-on-failure',
		video: 'retain-on-failure',
		trace: 'retain-on-failure',
	},
});
