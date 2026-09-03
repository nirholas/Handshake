import { defineConfig } from '@playwright/test';
import { randomBytes } from 'node:crypto';

/**
 * The home lane's own Playwright config.
 *
 * It is separate from playwright.config.js on purpose. The lane's journeys need
 * a real API process and a real Home Assistant behind the dev server, and the
 * rest of the e2e suite must not pay for that: a spec about /club has no
 * business booting a house.
 *
 *   npm run test:home:e2e
 *
 * Secrets below are generated per run and are LOCAL ONLY. They encrypt rows
 * this run creates in the database it is pointed at and are thrown away with
 * the process, so nothing here can decrypt a production credential and nothing
 * production wrote can be read by this run.
 */
// Dedicated ports, and no server reuse. Other agents run their own `npm run
// dev` on :3000 in this worktree, and reusing one is not a smaller version of
// this stack: its /api proxy points at PRODUCTION, so the run silently tests
// the wrong API and reports "No API route matches /api/home" as if the handler
// were missing. Own the ports or fail loudly.
const API_PORT = Number(process.env.HOME_E2E_API_PORT) || 8099;
const WEB_PORT = Number(process.env.HOME_E2E_WEB_PORT) || 3020;
const APP_ORIGIN = `http://localhost:${WEB_PORT}`;

const localSecrets = {
	JWT_SECRET: process.env.HOME_E2E_JWT_SECRET || randomBytes(32).toString('hex'),
	WALLET_ENCRYPTION_KEY: process.env.HOME_E2E_ENC_KEY || randomBytes(32).toString('hex'),
	APP_ORIGIN,
	ISSUER: APP_ORIGIN,
	MCP_RESOURCE: `${APP_ORIGIN}/api/mcp`,
	JWT_KID: 'home-e2e',
	NODE_ENV: 'development',
	// The house this lane drives is a container on loopback, and the URL guard
	// refuses private addresses unless a non-production process opts in. Without
	// this every journey fails at connect with "127.0.0.1 is a private address",
	// which reads as a product bug and is a missing flag.
	HOME_ALLOW_LOCAL_INSTANCE: '1',
};

export default defineConfig({
	testDir: 'tests/e2e',
	testMatch: /home-.*\.spec\.js$/,
	globalSetup: './tests/e2e/home-global-setup.js',
	// A journey that drives a real house through a real API is not fast, and a
	// tight timeout here would produce exactly the phantom failures this lane
	// cannot afford. Every wait inside a spec is still a wait on a condition.
	timeout: 240_000,
	// Retries train people to ignore a suite that guards a door: a journey that
	// only passes on the second attempt has told us something, and hiding it is
	// how the finding gets lost.
	retries: 0,
	fullyParallel: false,
	workers: 1,
	use: {
		baseURL: APP_ORIGIN,
		headless: true,
		screenshot: 'only-on-failure',
		video: 'retain-on-failure',
		trace: 'retain-on-failure',
	},
	webServer: [
		{
			// The same handlers Cloud Run runs, against the same database.
			command: `node --env-file=.env.local server/index.mjs`,
			// /api/version, not /api/home: the home endpoint answers an anonymous GET
			// with 401, and Playwright waits out the whole timeout rather than
			// treating that as ready. /api/version returns 200 and proves the same
			// thing, that the route table is loaded and handlers are mounted.
			url: `http://127.0.0.1:${API_PORT}/api/version`,
			timeout: 180_000,
			reuseExistingServer: false,
			stdout: 'pipe',
			stderr: 'pipe',
			env: { ...localSecrets, PORT: String(API_PORT) },
		},
		{
			command: `npx vite --port ${WEB_PORT} --strictPort`,
			url: APP_ORIGIN,
			timeout: 240_000,
			reuseExistingServer: false,
			stdout: 'pipe',
			stderr: 'pipe',
			env: { DEV_API_PROXY: `http://127.0.0.1:${API_PORT}` },
		},
	],
});
