/**
 * /irl discovery + location-privacy — Playwright e2e (task 07).
 *
 * Locks the headline privacy invariant end-to-end in a real browser: agents are
 * discovered ONLY by being physically near them. There is no roster, no map, and
 * the client must never hold the coordinates of an out-of-range agent — even one
 * the server (wrongly) hands it.
 *
 * Hermetic by construction: /api/irl/pins is routed to deterministic rows and the
 * fix-token mint is stubbed, so no live DB, RPC, or socket is touched. A tiny
 * DEV-only seam (window.__irlE2E, src/irl.js) drives the REAL proximity reconcile
 * (loadNearbyPins → the asymmetric ENTER/EXIT hysteresis band) against a fixed GPS
 * and reads back exactly what the client is holding — so the assertions exercise the
 * production discovery path, not a test double of it.
 *
 * Coverage:
 *   • zero pins        → the designed empty state ("be the first to pin here")
 *   • served-but-far   → an out-of-range pin is NEVER rendered or held
 *   • walk into range  → the in-range pin spawns and renders
 *   • mixed response   → only the in-range pin survives; the far coordinate is
 *                        provably absent from client state (the privacy assertion)
 *   • no console errors anywhere in the flow
 */

import { test, expect } from '@playwright/test';

// The viewer's fixed origin. A precision-6 cell somewhere ordinary (downtown SF).
const VIEWER = { lat: 37.7749, lng: -122.4194 };

// A nearby pin row in the shape /api/irl/pins returns. Coordinates are filled per
// test from the viewer origin + a metres offset so the distance is exact.
function pinRow(id, lat, lng, name) {
	return {
		id,
		lat,
		lng,
		heading: 0,
		avatar_url: '/avatars/default.glb',
		avatar_name: name,
		caption: '',
		x402_endpoint: null,
		agent_id: null,
		placed_at: '2026-01-01T00:00:00Z',
		view_count: 0,
		room_id: null,
		rel_east_m: null,
		rel_north_m: null,
		origin_lat: null,
		origin_lng: null,
		origin_yaw_deg: null,
		gps_accuracy_m: 8,
		altitude_m: null,
		anchor_source: null,
		avatar_version: 0,
	};
}

// Offset (north/east metres) → a coordinate, mirroring the seam's own helper so the
// spec can plant a pin at an exact distance without booting the app first.
function offset(lat, lng, north, east) {
	const mLat = 110540;
	const mLng = 111320 * Math.cos(lat * (Math.PI / 180));
	return { lat: lat + north / mLat, lng: lng + east / mLng };
}

// Install hermetic routes: the nearby read serves whatever `served()` returns now
// (so a test can change the response between polls), and the fix-token mint is a
// no-op stub. Returns a setter the test drives.
async function installRoutes(page) {
	let served = [];
	// Only the nearby read (query form) — never /api/irl/pins/mine.
	await page.route(/\/api\/irl\/pins\?/, (route) =>
		route.fulfill({ json: { pins: served } }),
	);
	await page.route('**/api/irl/fix-token', (route) =>
		route.fulfill({ json: { token: 'e2e-fix', expires_in: 300 } }),
	);
	return (rows) => { served = rows; };
}

// Boot /irl and wait for the app + its DEV e2e seam to be live (proves WebGL came
// up and irl.js evaluated). The first cold hit transforms the full three.js graph.
async function bootIrl(page) {
	await page.goto('/irl');
	await page.waitForFunction(() => !!window.__irlE2E, null, { timeout: 90_000 });
}

// Collect console errors, ignoring dev-server noise (Vite HMR websocket can't reach
// the forwarded test origin in headless Codespaces — not a product bug).
function trackConsoleErrors(page) {
	const errors = [];
	page.on('console', (m) => {
		if (m.type() !== 'error') return;
		const t = m.text();
		if (/websocket|hmr|wss:|vite|favicon|net::ERR/i.test(t)) return;
		// A 401 resource line from a signed-out auth/session probe is the browser
		// echoing an EXPECTED response (dev /api proxies to prod; no session in a
		// fresh context). Only this spec's own /api/irl/* surface stays fatal.
		if (/status of 401/i.test(t) && !/\/api\/irl\//i.test(m.location()?.url || '')) return;
		errors.push(t);
	});
	page.on('pageerror', (err) => {
		if (/websocket|hmr|wss:/i.test(err.message)) return;
		errors.push(`pageerror: ${err.message}`);
	});
	return errors;
}

test.describe('/irl discovery + location privacy', () => {
	test('out-of-range hidden, in-range renders, empty state, no console errors', async ({ page }) => {
		test.setTimeout(120_000);
		const errors = trackConsoleErrors(page);
		const setServed = await installRoutes(page);

		await bootIrl(page);
		await page.evaluate((v) => window.__irlE2E.setGps(v.lat, v.lng), VIEWER);

		// (c) Zero pins → designed empty state, never a blank void.
		setServed([]);
		await page.evaluate(() => window.__irlE2E.poll());
		expect(await page.evaluate(() => window.__irlE2E.nearby())).toEqual([]);
		const badge = page.locator('#irl-nearby-badge');
		await expect(badge).toHaveClass(/is-empty/);
		await expect(badge).toContainText(/be the first to pin here/i);

		// (a) A served pin 200 m away — far past the 40 m ENTER gate — is NEVER
		// rendered and never enters client state. Even if the server leaks a far row,
		// the client band refuses it.
		const far = offset(VIEWER.lat, VIEWER.lng, 200, 0);
		setServed([pinRow('pin-far', far.lat, far.lng, 'Faraway')]);
		await page.evaluate(() => window.__irlE2E.poll());
		expect(await page.evaluate(() => window.__irlE2E.nearby())).toEqual([]);
		await expect(badge).toHaveClass(/is-empty/);

		// (b) Walk into range: the same agent is now 10 m away (inside ENTER) → it
		// crosses the gate, spawns, and renders.
		const near = offset(VIEWER.lat, VIEWER.lng, 10, 0);
		setServed([pinRow('pin-near', near.lat, near.lng, 'Closeby')]);
		await page.evaluate(() => window.__irlE2E.poll());
		const held = await page.evaluate(() => window.__irlE2E.nearby());
		expect(held).toHaveLength(1);
		expect(held[0].id).toBe('pin-near');
		expect(held[0].rendered).toBe(true);
		expect(held[0].distance).toBeLessThanOrEqual(40);
		await expect(badge).toContainText(/1 nearby/);

		// (d) The whole flow ran without a single console error from our code.
		expect(errors).toEqual([]);
	});

	test('privacy: a mixed response keeps only the in-range pin — the far coordinate never reaches the client', async ({ page }) => {
		test.setTimeout(120_000);
		const errors = trackConsoleErrors(page);
		const setServed = await installRoutes(page);

		await bootIrl(page);
		await page.evaluate((v) => window.__irlE2E.setGps(v.lat, v.lng), VIEWER);

		// The server returns BOTH an in-range pin (8 m) and a far one (300 m) in the
		// same payload — the exact shape a roster leak would take. The client must
		// keep only the in-range pin; the far coordinate must be absent everywhere.
		const near = offset(VIEWER.lat, VIEWER.lng, 8, 0);
		const far = offset(VIEWER.lat, VIEWER.lng, 300, 0);
		setServed([
			pinRow('pin-in', near.lat, near.lng, 'InRange'),
			pinRow('pin-out', far.lat, far.lng, 'OutOfRange'),
		]);
		await page.evaluate(() => window.__irlE2E.poll());

		const held = await page.evaluate(() => window.__irlE2E.nearby());
		// Exactly one pin — the in-range one — is held.
		expect(held).toHaveLength(1);
		expect(held[0].id).toBe('pin-in');

		// The far pin's id and coordinate are provably absent from the client's pin
		// state. We serialize the whole held set and assert the out-of-range latitude
		// (a value the client would only have if it stored the far row) never appears.
		const serialized = JSON.stringify(held);
		expect(serialized).not.toContain('pin-out');
		expect(serialized).not.toContain(String(far.lat));

		// And the DOM agrees: a label for the out-of-range agent was never mounted.
		expect(await page.locator('text=OutOfRange').count()).toBe(0);

		expect(errors).toEqual([]);
	});
});
