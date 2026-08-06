import { test, expect } from '@playwright/test';

// The hosted embodiment embed (pages/embodiment/embed.html) is the page the
// persona widget iframes into ChatGPT. Its param parsing, its persona resolve,
// and its failure surface had no test that actually loaded the page: the engine
// beneath it is unit-tested (tests/embodiment-*.test.js) and its wiring is
// string-checked (tests/api/embodiment-embed-page.test.js), but nothing proved
// the page boots, mounts a body, and paints a designed state when it cannot.
//
// This drives a real Chromium against the dev server, which is the only way to
// exercise a page whose entry point is an ES module: jsdom does not execute
// `<script type="module">` at all.
//
// Fidelity: the GLB is a real model this repo serves (public/avatars/fox.glb),
// loaded over the real network by the real GLTFLoader. Only /api/mcp3d/persona
// is fulfilled at the Playwright route layer, because a durable persona id is
// per-deployment DB state, not something a test box has.

const FOX = '/avatars/fox.glb';
const PERSONA_ID = 'persona_e2e_probe';

/** Fulfil the durable-persona lookup with a real, servable body. */
function stubPersona(page, body, status = 200) {
	return page.route(
		(url) => url.pathname === '/api/mcp3d/persona',
		(route) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }),
	);
}

// The Vite dev server's HMR client opens a WebSocket that Chromium tears down on
// navigation, which surfaces as a pageerror from the harness rather than from the
// page under test. It does not exist in the built asset the embed ships as.
const DEV_SERVER_NOISE = /WebSocket closed without opened/i;

/** Collect page errors so a "designed" state can be proven free of crashes. */
function watchErrors(page) {
	const errors = [];
	page.on('pageerror', (err) => {
		const message = String(err?.message || err);
		if (!DEV_SERVER_NOISE.test(message)) errors.push(message);
	});
	return errors;
}

test.describe('embodiment embed page', () => {
	test('a direct glb + name mounts the stage, names the agent, and settles into idle', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(`/embodiment/embed?glb=${encodeURIComponent(FOX)}&name=Fox%20Prime`, {
			waitUntil: 'domcontentloaded',
		});

		// The overlay mounts immediately and the name is applied before any load.
		const overlay = page.locator('#stage-root .emb');
		await expect(overlay).toBeAttached({ timeout: 120_000 });
		await expect(page.locator('[data-name]')).toHaveText('Fox Prime');

		// The stage really renders: a WebGL canvas is in the DOM with real size.
		const canvas = page.locator('#stage-root canvas');
		await expect(canvas).toBeVisible({ timeout: 120_000 });
		const box = await canvas.boundingBox();
		expect(box.width).toBeGreaterThan(0);
		expect(box.height).toBeGreaterThan(0);

		// Loading skeleton gives way to the live status plate once the GLB lands.
		await expect(page.locator('[data-plate]')).toBeVisible({ timeout: 120_000 });
		await expect(page.locator('[data-state]')).toHaveText('Listening');
		await expect(page.locator('[data-error]')).toBeHidden();
		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('a persona id resolves through /api/mcp3d/persona and renders the resolved name', async ({ page }) => {
		await stubPersona(page, { id: PERSONA_ID, glb_url: FOX, name: 'Resolved Persona' });
		const requested = [];
		page.on('request', (r) => {
			if (r.url().includes('/api/mcp3d/persona')) requested.push(r.url());
		});

		await page.goto(`/embodiment/embed?persona=${PERSONA_ID}`, { waitUntil: 'domcontentloaded' });

		await expect(page.locator('[data-name]')).toHaveText('Resolved Persona', { timeout: 120_000 });
		await expect(page.locator('#stage-root canvas')).toBeVisible({ timeout: 120_000 });
		await expect(page.locator('[data-plate]')).toBeVisible({ timeout: 120_000 });
		await expect(page.locator('[data-error]')).toBeHidden();

		expect(requested.length).toBe(1);
		expect(requested[0]).toContain(`id=${PERSONA_ID}`);
		// The on-chain identity poll is opt-in, so a plain body never fires it.
		expect(requested.some((u) => u.includes('persona-identity'))).toBe(false);
	});

	test('an unresolvable persona paints the designed error state with a retry, not a blank void', async ({ page }) => {
		const errors = watchErrors(page);
		await stubPersona(page, { error: 'not_found' }, 404);

		await page.goto('/embodiment/embed?persona=persona_does_not_exist', { waitUntil: 'domcontentloaded' });

		const error = page.locator('[data-error]');
		await expect(error).toBeVisible({ timeout: 120_000 });
		await expect(error.locator('h3')).toHaveText("This avatar didn't load");
		await expect(page.locator('[data-error-msg]')).toContainText('Could not load this persona.');
		// Actionable: the retry control is present and clickable.
		await expect(page.locator('[data-retry]')).toBeVisible();
		// The skeleton is dismissed rather than spinning forever behind the error.
		await expect(page.locator('[data-skel]')).toBeHidden();
		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('a GLB that cannot be fetched falls back to the stage error state', async ({ page }) => {
		await page.route('**/avatars/missing.glb', (route) => route.fulfill({ status: 404, body: 'not found' }));

		await page.goto('/embodiment/embed?glb=%2Favatars%2Fmissing.glb&name=Ghost', { waitUntil: 'domcontentloaded' });

		await expect(page.locator('[data-error]')).toBeVisible({ timeout: 120_000 });
		await expect(page.locator('[data-error-msg]')).toContainText('Could not load this avatar.');
	});

	test('no glb and no persona renders the minimal designed notice', async ({ page }) => {
		await page.goto('/embodiment/embed', { waitUntil: 'domcontentloaded' });

		await expect(page.locator('body')).toContainText('No persona or GLB URL supplied.', { timeout: 120_000 });
		await expect(page.locator('#stage-root canvas')).toHaveCount(0);
	});

	test('the state param drives the body into the requested state after load', async ({ page }) => {
		// `thinking` is the one requested state that holds (speaking settles back
		// to idle when the utterance ends), so it is what a wire assertion can pin.
		await page.goto(`/embodiment/embed?glb=${encodeURIComponent(FOX)}&name=Fox%20Prime&state=thinking`, {
			waitUntil: 'domcontentloaded',
		});

		await expect(page.locator('[data-plate]')).toBeVisible({ timeout: 120_000 });
		await expect(page.locator('[data-state]')).toHaveText('Thinking', { timeout: 120_000 });
	});
});
