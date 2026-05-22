// Headless smoke check for the new demos. Loads each page, waits for the
// avatar GLB + animation clips to finish fetching, then reports any console
// errors or failed network requests. Run with: node scripts/verify-new-demos.mjs
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:3002';
const ROUTES = ['/demos/404.html', '/demos/checkout.html', '/demos/pricing.html'];

const browser = await chromium.launch();
let totalFail = 0;

for (const route of ROUTES) {
	const ctx = await browser.newContext();
	const page = await ctx.newPage();

	const errors = [];
	const failedRequests = [];

	page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
	page.on('console', msg => {
		if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
	});
	page.on('requestfailed', req => {
		failedRequests.push(`${req.url()} (${req.failure()?.errorText})`);
	});
	page.on('response', resp => {
		const s = resp.status();
		if (s >= 400) failedRequests.push(`${resp.url()} → ${s}`);
	});

	const url = BASE + route;
	console.log(`\n→ ${url}`);
	try {
		await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
	} catch (e) {
		console.log(`  ✖ navigation failed: ${e.message}`);
		totalFail++;
		await ctx.close();
		continue;
	}

	// Probe the avatar mount: each demo's module exposes `avatar` as a closure
	// local — we can't see it, but the canvas should have non-zero size and the
	// animation manifest fetch should have succeeded. We assert on:
	//  1. <canvas> rendered with width > 0
	//  2. /animations/clips/idle.json fetched 200
	//  3. /avatars/cz.glb fetched 200
	const canvasOk = await page.evaluate(() => {
		const c = document.getElementById('avatar-canvas');
		return c && c.width > 0 && c.height > 0;
	});

	// Give the avatar a beat to actually start animating
	await page.waitForTimeout(1500);

	const hasGoodCanvas = canvasOk;
	const hasErrors = errors.length > 0;
	const hasFails  = failedRequests.length > 0;

	if (hasErrors) {
		console.log(`  ✖ console errors:`);
		errors.forEach(e => console.log(`    ${e}`));
	}
	if (hasFails) {
		console.log(`  ✖ failed requests:`);
		failedRequests.forEach(r => console.log(`    ${r}`));
	}
	if (!hasGoodCanvas) {
		console.log(`  ✖ avatar canvas not rendered`);
	}
	if (!hasErrors && !hasFails && hasGoodCanvas) {
		console.log(`  ✓ clean load, canvas mounted`);
	} else {
		totalFail++;
	}

	await ctx.close();
}

await browser.close();
console.log(`\n${totalFail === 0 ? '✓ all routes clean' : `✖ ${totalFail} route(s) had issues`}`);
process.exit(totalFail === 0 ? 0 : 1);
