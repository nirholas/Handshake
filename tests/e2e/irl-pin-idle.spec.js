/**
 * /irl pin idle animation — Playwright e2e for the "T-posed statue" regression.
 *
 * Pins used to mount their GLB in the authored bind pose and never move (the
 * carried avatar animated; placed agents did not). This spec drives the REAL
 * pin pipeline — proximity band → LOD full mount → per-pin retargeted idle
 * mixer — in a real browser and proves the placed agent's skeleton is actually
 * moving frame to frame.
 *
 * Hermetic like irl-discovery.spec.js: /api/irl/pins is routed to a
 * deterministic row (avatar = the committed /avatars/default.glb), the
 * fix-token mint is stubbed, and the DEV-only window.__irlE2E seam supplies
 * GPS + a one-shot reconcile + the pinAnim() liveness probe.
 */

import { test, expect } from '@playwright/test';

const VIEWER = { lat: 37.7749, lng: -122.4194 };

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

function offset(lat, lng, north, east) {
	const mLat = 110540;
	const mLng = 111320 * Math.cos(lat * (Math.PI / 180));
	return { lat: lat + north / mLat, lng: lng + east / mLng };
}

async function installRoutes(page) {
	let served = [];
	await page.route(/\/api\/irl\/pins\?/, (route) =>
		route.fulfill({ json: { pins: served } }),
	);
	await page.route('**/api/irl/fix-token', (route) =>
		route.fulfill({ json: { token: 'e2e-fix', expires_in: 300 } }),
	);
	return (rows) => { served = rows; };
}

async function bootIrl(page) {
	await page.goto('/irl');
	await page.waitForFunction(() => !!window.__irlE2E, null, { timeout: 90_000 });
}

function trackConsoleErrors(page) {
	const errors = [];
	page.on('console', (m) => {
		if (m.type() !== 'error') return;
		const t = m.text();
		if (/websocket|hmr|wss:|vite|favicon|net::ERR/i.test(t)) return;
		if (/status of 401/i.test(t) && !/\/api\/irl\//i.test(m.location()?.url || '')) return;
		errors.push(t);
	});
	page.on('pageerror', (err) => {
		if (/websocket|hmr|wss:/i.test(err.message)) return;
		errors.push(`pageerror: ${err.message}`);
	});
	return errors;
}

test.describe('/irl pin idle animation', () => {
	test('a placed agent mounts with a running idle mixer and its skeleton moves', async ({ page }) => {
		test.setTimeout(180_000);
		const errors = trackConsoleErrors(page);
		const setServed = await installRoutes(page);

		await bootIrl(page);
		await page.evaluate((v) => window.__irlE2E.setGps(v.lat, v.lng), VIEWER);

		// Plant one agent 8 m away — inside the ENTER gate AND the full-GLB LOD band
		// on every device tier, so enforceLOD mounts the skinned mesh.
		const near = offset(VIEWER.lat, VIEWER.lng, 8, 0);
		setServed([pinRow('pin-idle', near.lat, near.lng, 'Idler')]);
		await page.evaluate(() => window.__irlE2E.poll());

		// Wait for the full model to mount (GLB fetch + decode + idle clip fetch +
		// retarget). The tick loop's 4 Hz enforceLOD drives the queued load.
		await page.waitForFunction(
			() => window.__irlE2E.pinAnim('pin-idle').mounted,
			null,
			{ timeout: 60_000 },
		);

		const first = await page.evaluate(() => window.__irlE2E.pinAnim('pin-idle'));
		expect(first.animated).toBe(true);
		expect(first.clip).toBe('idle');
		expect(Array.isArray(first.bones)).toBe(true);
		expect(first.bones.length).toBeGreaterThan(0);

		// Sample the skeleton again after a few hundred ms of real frames. A statue
		// (the old behavior) returns byte-identical quaternions; a breathing agent
		// cannot.
		await page.waitForTimeout(600);
		const second = await page.evaluate(() => window.__irlE2E.pinAnim('pin-idle'));
		expect(second.mounted).toBe(true);
		expect(second.bones).not.toEqual(first.bones);

		expect(errors).toEqual([]);
	});
});
