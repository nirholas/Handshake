/**
 * /spatial-mcp actually renders. The runtime half of the guard.
 *
 * tests/directory-page-refs.test.js catches a page that ASKS for the wrong path.
 * It cannot catch a page that asks correctly and still shows nothing, which is how
 * this one failed twice over:
 *
 *   1. the demo imported './spatial-renderer.js', which resolves against the site
 *      root on the slash-less clean URL, so the renderer 404'd and both frames
 *      fell through to the fallback;
 *   2. once that was fixed, the demo GLB (a three.js npm sample path) had gone
 *      404 upstream, so the frames stayed empty anyway.
 *
 * A dead asset is invisible to any static check and to any test that only asserts
 * a 200 on the page. So this spec loads the real page and demands evidence: a
 * <model-viewer> per stage, its GLB actually loaded, the designed fallback absent,
 * the validator reporting conformance on screen, and no request on the page ending
 * >= 400. Both URL forms are exercised, because the two differ only in the base
 * directory the browser resolves against, which is the entire bug class.
 *
 * Fidelity: nothing is stubbed. The page fetches its real GLBs from their real
 * hosts, exactly as a visitor would. That is deliberate. A stubbed asset cannot
 * tell us the asset is gone, and being told is the point of the spec.
 */

import { test, expect } from '@playwright/test';

// The route is `"/spatial-mcp/?"`, so both of these serve the same file with a
// DIFFERENT base directory. Any relative reference works on one and breaks on the
// other, which is why both are non-negotiable here.
const URL_FORMS = ['/spatial-mcp', '/spatial-mcp/'];

const STAGES = [
	{ id: 'stage-native', conf: 'conf-native', label: 'three.ws forge_free artifact' },
	{ id: 'stage-foreign', conf: 'conf-foreign', label: 'foreign tool result, transformed' },
];

// Vite's HMR socket cannot reach the dev server through a proxied port (Codespaces,
// any remote container), which surfaces as a failed ws request and an uncaught
// "WebSocket closed without opened." Both are dev-server plumbing that does not
// exist in the built page. The analytics loader under /ingest is the third
// exemption: in dev it is a vite proxy to PostHog's asset host, which
// intermittently answers 500 from a remote container, and the page is designed
// to run without analytics (the snippet fails silently), so its outage is not a
// rendering failure this spec guards. Anything else a visitor's browser could
// hit counts as a failure.
const DEV_SERVER_NOISE = /^ws|\/@vite\/|\/ingest\//;
const DEV_SERVER_ERROR = /WebSocket closed without opened/;

/** Collect every response that failed, plus uncaught page errors. */
function watchFailures(page) {
	const failures = [];
	page.on('response', (r) => {
		if (r.status() >= 400 && !DEV_SERVER_NOISE.test(r.url())) failures.push(`HTTP ${r.status()} ${r.url()}`);
	});
	page.on('pageerror', (e) => {
		if (DEV_SERVER_ERROR.test(e.message)) return;
		failures.push(`pageerror: ${e.message}`);
	});
	page.on('requestfailed', (r) => {
		if (DEV_SERVER_NOISE.test(r.url())) return;
		failures.push(`requestfailed: ${r.url()} ${r.failure()?.errorText || ''}`);
	});
	return failures;
}

for (const urlForm of URL_FORMS) {
	test(`spatial-mcp renders every stage at ${urlForm}`, async ({ page }) => {
		test.setTimeout(180_000);
		const failures = watchFailures(page);

		await page.goto(urlForm, { waitUntil: 'load' });

		for (const stage of STAGES) {
			const viewer = page.locator(`#${stage.id} model-viewer`);
			await expect(viewer, `${stage.label}: no <model-viewer> was created`).toHaveCount(1);

			// The renderer's designed fallback. Its presence means the payload was
			// unusable, which is precisely the state that shipped.
			await expect(
				page.locator(`#${stage.id} .spatial-empty`),
				`${stage.label}: fell back instead of rendering`,
			).toHaveCount(0);

			// A viewer element proves the artifact was accepted. Only `loaded` proves
			// the GLB behind it exists and decoded.
			// 60s: the success path settles in ~3s locally, so this is headroom for a
			// cold CI box on a multi-megabyte GLB, not a wait we expect to use. Keeping
			// it tight matters because this is the assertion a dead asset trips, and a
			// failing test should say so quickly.
			await expect
				.poll(() => viewer.evaluate((el) => el.loaded === true), {
					message: `${stage.label}: GLB never finished loading`,
					timeout: 60_000,
				})
				.toBe(true);

			await expect(viewer).toHaveAttribute('camera-controls', '');

			// The page's conformance claim, as rendered by the real validator.
			await expect(page.locator(`#${stage.conf}`)).toContainText('conformant, 0 errors');
		}

		// The checker starts populated and self-validating, so it is load-bearing UI.
		await expect(page.locator('#check-report')).toContainText('conformant, 0 errors');
		await expect(page.locator('#stage-check model-viewer')).toHaveCount(1);

		expect(failures, `failed requests on ${urlForm}`).toEqual([]);
	});
}

test('the checker names the offending field on a broken payload', async ({ page }) => {
	test.setTimeout(180_000);
	await page.goto('/spatial-mcp', { waitUntil: 'load' });

	await page.locator('[data-preset="broken"]').click();

	const report = page.locator('#check-report');
	// Actionable diagnostics, not a boolean: every rule class names its own path.
	await expect(report).toContainText('scene.glbUrl');
	await expect(report).toContainText('spatialMcpVersion');
	await expect(report).toContainText('kind');
	await expect(report).toContainText('camera.autoRotate');
	await expect(report).toContainText('ar.supported');
	// The data-minimization lint runs on every payload; the broken preset leaks
	// an internal id and a price on purpose so the privacy findings are visible.
	await expect(report).toContainText('meta.session_id');
	await expect(report).toContainText('meta.price_usd');
	await expect(report).not.toContainText('conformant, 0 errors');

	// An unusable payload gets the designed fallback, never a blank frame.
	await expect(page.locator('#stage-check .spatial-empty')).toHaveCount(1);
	await expect(page.locator('#stage-check')).toHaveAttribute('data-spatial-state', 'empty');
});

// The other way a frame goes blank: the payload is conformant but the asset
// behind it is unreachable (host down, CORS missing, a dead CDN path). A
// visitor must get told what failed and be able to retry without reloading,
// so this blocks every GLB, demands the designed error state on every stage,
// then lifts the block and proves the retry button renders the scene.
test('an unreachable GLB gets a designed error state, and its retry renders the scene', async ({ page }) => {
	test.setTimeout(180_000);
	let blocked = true;
	await page.route(/\.glb(\?|$)/, (route) => (blocked ? route.abort() : route.continue()));

	await page.goto('/spatial-mcp', { waitUntil: 'load' });

	for (const stage of STAGES) {
		const error = page.locator(`#${stage.id} .spatial-error`);
		await expect(error, `${stage.label}: no error state after the GLB fetch failed`).toBeVisible({
			timeout: 60_000,
		});
		await expect(error).toContainText('could not be loaded');
		await expect(error.locator('.spatial-retry')).toBeVisible();
		await expect(page.locator(`#${stage.id} model-viewer`)).toHaveCount(0);
		await expect(page.locator(`#${stage.id}`)).toHaveAttribute('data-spatial-state', 'error');
	}

	blocked = false;
	await page.locator('#stage-native .spatial-retry').click();
	const viewer = page.locator('#stage-native model-viewer');
	await expect(viewer).toHaveCount(1);
	await expect
		.poll(() => viewer.evaluate((el) => el.loaded === true), {
			message: 'retry did not load the GLB once the network came back',
			timeout: 60_000,
		})
		.toBe(true);
	await expect(page.locator('#stage-native')).toHaveAttribute('data-spatial-state', 'ready');
	await expect(page.locator('#stage-native .spatial-loading')).toHaveCount(0);
	await expect(page.locator('#stage-native .spatial-error')).toHaveCount(0);
});
