/**
 * /irl Talk + View in AR on a discovered pin (Playwright e2e).
 *
 * The walk-up moment: a visitor taps an agent standing near them and (1) holds a
 * conversation with it, (2) can stand it on their own floor in AR. Both live in
 * the pin sheet (src/irl/pin-talk.js, src/irl/pin-ar.js). This spec drives the
 * REAL sheet code in a real browser through the DEV-only window.__irlE2E seam and
 * hermetic routes: the nearby read serves one in-range pin, /api/chat answers with
 * a canned SSE stream, TTS answers with a real (silent) WAV so playback succeeds,
 * and the interaction log is captured so the `talk` event is asserted rather than
 * assumed.
 *
 * Coverage:
 *   - the sheet leads with Talk and View in AR for a stranger's pin
 *   - Talk opens the panel with the designed empty state, focus lands on the mic
 *   - a typed turn renders the visitor's line, streams the reply into the log,
 *     and posts exactly one `talk` interaction for the conversation
 *   - a second turn posts no second `talk` row
 *   - closing the sheet ends the conversation (panel hidden, no further audio)
 *   - View in AR on a non-AR device over http is an honest status line, never a
 *     dead button or a thrown error
 *   - no console errors anywhere in the flow
 */

import { test, expect } from '@playwright/test';

const VIEWER = { lat: 37.7749, lng: -122.4194 };

function pinRow(id, lat, lng, name) {
	return {
		id, lat, lng, heading: 0,
		avatar_url: '/avatars/default.glb',
		avatar_name: name,
		caption: 'Ask me about the pier',
		x402_endpoint: null,
		agent_id: null,
		placed_at: '2026-01-01T00:00:00Z',
		view_count: 0,
		room_id: null, rel_east_m: null, rel_north_m: null,
		origin_lat: null, origin_lng: null, origin_yaw_deg: null,
		gps_accuracy_m: 8, altitude_m: null, anchor_source: null, avatar_version: 0,
	};
}

function offset(lat, lng, north, east) {
	const mLat = 110540;
	const mLng = 111320 * Math.cos(lat * (Math.PI / 180));
	return { lat: lat + north / mLat, lng: lng + east / mLng };
}

// A valid 16-bit mono PCM WAV of `seconds` silence, so the TTS lane returns audio
// the browser can actually decode and play (an empty blob would fire onerror).
function silentWav(seconds = 0.25, rate = 8000) {
	const samples = Math.round(seconds * rate);
	const buf = Buffer.alloc(44 + samples * 2);
	buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples * 2, 4); buf.write('WAVE', 8);
	buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
	buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
	buf.write('data', 36); buf.writeUInt32LE(samples * 2, 40);
	return buf;
}

function sse(events) {
	return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

async function installRoutes(page) {
	const chat = [];          // bodies posted to /api/chat
	const interactions = [];  // bodies posted to /api/irl/interactions
	await page.route('**/api/**', (route) => route.fulfill({ status: 204, body: '' }));
	await page.route(/\/api\/irl\/pins\?/, (route) => {
		const near = offset(VIEWER.lat, VIEWER.lng, 6, 0);
		route.fulfill({ json: { pins: [pinRow('pin-talk', near.lat, near.lng, 'Nova')] } });
	});
	await page.route('**/api/irl/fix-token', (route) => route.fulfill({ json: { token: 'e2e-fix', expires_in: 300 } }));
	await page.route('**/api/irl/agent-card**', (route) => route.fulfill({ json: { card: {
		agent: { id: null, name: 'Nova', bio: 'Guide to the waterfront.', thumbnail_url: null, profile_url: null },
		reputation: { available: false },
		services: [],
		x402_endpoint: null,
	} } }));
	await page.route('**/api/irl/interactions', (route) => {
		interactions.push(route.request().postDataJSON());
		route.fulfill({ json: { ok: true, id: 'ix', type: 'view' } });
	});
	await page.route('**/api/chat', (route) => {
		chat.push(route.request().postDataJSON());
		route.fulfill({
			status: 200,
			headers: { 'content-type': 'text/event-stream' },
			body: sse([{ type: 'chunk', text: 'Hi there, welcome to ' }, { type: 'chunk', text: 'the pier.' }, { type: 'done', reply: 'Hi there, welcome to the pier.' }]),
		});
	});
	await page.route('**/api/tts/**', (route) => route.fulfill({
		status: 200, headers: { 'content-type': 'audio/wav' }, body: silentWav(),
	}));
	return { chat, interactions };
}

function trackConsoleErrors(page) {
	const errors = [];
	page.on('console', (m) => {
		if (m.type() !== 'error') return;
		const t = m.text();
		if (/websocket|hmr|wss:|vite|favicon|net::ERR|Outdated Optimize Dep/i.test(t)) return;
		if (/status of 401/i.test(t) && !/\/api\/irl\//i.test(m.location()?.url || '')) return;
		errors.push(t);
	});
	page.on('pageerror', (err) => {
		if (/websocket|hmr|wss:/i.test(err.message)) return;
		errors.push(`pageerror: ${err.message}`);
	});
	return errors;
}

test.describe('/irl pin sheet: Talk + View in AR', () => {
	test('a visitor talks to a discovered agent and can reach its AR view', async ({ page }) => {
		test.setTimeout(150_000);
		const errors = trackConsoleErrors(page);
		const seen = await installRoutes(page);

		// A returning visitor: the first-run permission dialog, the discovery
		// explainer and the location disclosure are all already answered, so no
		// modal scrim sits over the sheet. Permissions are marked denied because
		// headless Chromium has no camera or GPS; the seam supplies the fix below.
		await page.addInitScript(() => {
			localStorage.setItem('irl_onboarded_v1', JSON.stringify({ camera: 'denied', motion: 'denied', location: 'denied', ts: Date.now() }));
			localStorage.setItem('irl_discovery_explained_v1', '1');
			localStorage.setItem('irl_location_disclosed_v1', '1');
		});
		await page.goto('/irl');
		await page.waitForFunction(() => !!window.__irlE2E, null, { timeout: 90_000 });
		await page.evaluate((v) => window.__irlE2E.setGps(v.lat, v.lng), VIEWER);
		await page.evaluate(() => window.__irlE2E.poll());
		expect(await page.evaluate(() => window.__irlE2E.nearby())).toHaveLength(1);

		// Tap the agent (through the seam: same openPinSheet the label click runs).
		expect(await page.evaluate(() => window.__irlE2E.openSheet('pin-talk'))).toBe(true);
		const sheet = page.locator('#irl-sheet');
		await expect(sheet).toHaveClass(/is-open/);
		await expect(page.locator('#irl-sheet-name')).toHaveText('Nova');

		// The card leads with Talk and View in AR, for a stranger's pin.
		const talkBtn = page.locator('#irl-sheet-talk');
		const arBtn = page.locator('#irl-sheet-ar');
		await expect(talkBtn).toBeVisible();
		await expect(arBtn).toBeVisible();
		await expect(arBtn).toHaveText('View in AR');
		await expect(talkBtn).toHaveAttribute('aria-expanded', 'false');

		// Open the conversation: designed empty state, mic focused.
		await talkBtn.click();
		const panel = page.locator('#irl-talk');
		await expect(panel).toBeVisible();
		await expect(talkBtn).toHaveAttribute('aria-expanded', 'true');
		await expect(page.locator('#irl-talk-log .irl-talk-empty')).toContainText(/Nova is listening/);
		await expect(page.locator('#irl-talk-hold')).toBeFocused();

		// A typed turn: the visitor's line renders, the reply streams in, and the
		// conversation's opening line is logged once as a `talk` interaction.
		await page.fill('#irl-talk-input', 'Where am I?');
		await page.locator('#irl-talk-form').evaluate((f) => f.requestSubmit());
		await expect(page.locator('#irl-talk-log .irl-talk-msg.is-user')).toHaveText('Where am I?');
		await expect(page.locator('#irl-talk-log .irl-talk-msg.is-agent .irl-talk-text')).toHaveText('Hi there, welcome to the pier.', { timeout: 20_000 });
		await expect(page.locator('#irl-talk-log .irl-talk-who')).toHaveText('Nova');
		expect(seen.chat).toHaveLength(1);
		expect(seen.chat[0].message).toBe('Where am I?');
		// An anonymous pin never fabricates an agentId; the persona rides system_prompt.
		expect(seen.chat[0].agentId).toBeUndefined();
		expect(seen.chat[0].system_prompt).toMatch(/You are Nova, a 3D AI agent standing at a real place/);
		expect(seen.chat[0].system_prompt).toMatch(/Ask me about the pier/);
		await expect.poll(() => seen.interactions.filter((i) => i.type === 'talk').length).toBe(1);
		expect(seen.interactions.find((i) => i.type === 'talk').pinId).toBe('pin-talk');

		// A second turn is the same conversation: no second `talk` row.
		await expect.poll(() => page.evaluate(() => document.querySelector('#irl-talk').dataset.state), { timeout: 20_000 }).toBe('idle');
		await page.fill('#irl-talk-input', 'Thanks!');
		await page.locator('#irl-talk-form').evaluate((f) => f.requestSubmit());
		await expect(page.locator('#irl-talk-log .irl-talk-msg.is-user')).toHaveCount(2);
		await expect(page.locator('#irl-talk-log .irl-talk-msg.is-agent')).toHaveCount(2, { timeout: 20_000 });
		expect(seen.chat).toHaveLength(2);
		expect(seen.chat[1].history.some((h) => h.content === 'Where am I?')).toBe(true);
		expect(seen.interactions.filter((i) => i.type === 'talk')).toHaveLength(1);

		// View in AR on a device with no AR surface, served over http: the honest
		// status line (the launcher only accepts https models), never a dead button.
		await arBtn.click();
		await expect(page.locator('#irl-status')).toContainText(/can't be opened in the AR viewer/i);
		await expect(sheet).toHaveClass(/is-open/);

		// Closing the sheet ends the conversation.
		await page.locator('#irl-sheet-close').click();
		await expect(sheet).not.toHaveClass(/is-open/);
		await expect(panel).toBeHidden();

		// Re-opening the same pin starts fresh (the empty state is back).
		await page.evaluate(() => window.__irlE2E.openSheet('pin-talk'));
		await talkBtn.click();
		await expect(page.locator('#irl-talk-log .irl-talk-empty')).toBeVisible();
		await expect(page.locator('#irl-talk-log .irl-talk-msg')).toHaveCount(0);

		expect(errors).toEqual([]);
	});
});
